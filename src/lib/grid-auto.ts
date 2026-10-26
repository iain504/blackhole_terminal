// Task 18 — Auto Grid analyzer: decide per symbol whether a grid trade makes
// sense RIGHT NOW, and if so produce the exact setup + the reasons.
//
// Pure module (no DB / network) — the route fetches the bars once via the
// shared backtest machinery and feeds them here. The decision reuses
// optimizeGridConfig (the engine-parity sweep) so the chosen config is the
// SAME one /api/grid/optimize would hand the dialog, and the backtest numbers
// match what "Run backtest" would report for it.
//
// Decision ladder (deterministic + explainable, first failure wins):
//   1. insufficient history          (< 60 usable bars)
//   2. no usable price               (last close ≤ 0)
//   3. no sweep activity             (zero simulated fills across ALL widths × counts)
//   4. strong one-way trend          (|window drift| > TREND_MAX_PCT — grids
//                                    harvest oscillation, a breakout rides
//                                    through the range and strands lots)
//   5. risk-adjusted score ≤ 0       (totalPnl − 0.5 × maxDrawdown over the
//                                    window — a money-losing backtest never
//                                    auto-starts)
//   6. otherwise START with the sweep winner + preset guards + a planned end.
//
// End conditions (what "when to end" means, shown everywhere the plan is):
//   - whole-grid SL: lower × (1 − maxSL%) — percent basis, resolved every tick
//   - whole-grid TP: upper × (1 + maxTP%)
//   - planned end: the engine force-stops the grid at now ≥ autoEndAt
import type { Bar } from '@/lib/market-types'
import { optimizeGridConfig, OPT_WIDTHS_PCT, OPT_COUNTS, type GridOptCandidate } from '@/lib/grid-optimize'

export type GridAutoPreset = 'conservative' | 'balanced' | 'aggressive'

/** Whole-grid guards per preset — percent of the range edges (resolved every
 * engine tick, so a later manual edit re-arms them automatically). */
export const AUTO_PRESETS: Record<GridAutoPreset, { maxSLPct: number; maxTPPct: number; label: string }> = {
  conservative: { maxSLPct: 5, maxTPPct: 6, label: 'Conservative — tight guards (SL 5% / TP 6%)' },
  balanced: { maxSLPct: 8, maxTPPct: 10, label: 'Balanced — default guards (SL 8% / TP 10%)' },
  aggressive: { maxSLPct: 12, maxTPPct: 15, label: 'Aggressive — wide guards (SL 12% / TP 15%)' },
}

export const isGridAutoPreset = (v: unknown): v is GridAutoPreset =>
  v === 'conservative' || v === 'balanced' || v === 'aggressive'

/** Window drift beyond this % (either way) vetoes the grid. */
export const TREND_MAX_PCT = 25

/** Sweep needs this many usable closed bars to say anything honest. */
export const MIN_BARS = 60

export interface GridAutoPlan {
  center: number
  windowDays: number
  bars: number
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: 'arithmetic'
  direction: 'both'
  qtyPerGrid: number
  maxSLPct: number
  maxTPPct: number
  /** resolved guard triggers at plan time (percent basis, re-armed every tick) */
  slTriggerApprox: number
  tpTriggerApprox: number
  /** planned engine stop (days from start) */
  maxEndDays: number
  preset: GridAutoPreset
  /** regime metrics over the window */
  trendPct: number
  rangePct: number
  crossovers: number
  /** the engine-parity backtest evidence for the chosen config */
  backtest: {
    totalPnl: number
    realizedPnl: number
    openPnl: number
    maxDrawdown: number
    fillsCount: number
    openLots: number
    winRate: number
    score: number
  }
}

export interface GridAutoDecision {
  symbol: string
  decision: 'start' | 'skip'
  /** one-line human reason — shown in the report table + persisted */
  reason: string
  /** metric bullets backing the reason */
  details: string[]
  /** the chosen/swept setup — present whenever the sweep found a best config
   * (even for skips, so the user sees WHAT would have run) */
  plan: GridAutoPlan | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

function regimeMetrics(bars: Bar[], center: number): { trendPct: number; rangePct: number; crossovers: number } {
  const first = bars[0]?.close
  const last = bars[bars.length - 1]?.close
  const trendPct = Number.isFinite(first) && first > 0 && Number.isFinite(last) ? ((last - first) / first) * 100 : 0
  let hi = -Infinity
  let lo = Infinity
  let crossovers = 0
  let prevAbove: boolean | null = null
  for (const b of bars) {
    if (b.high > hi) hi = b.high
    if (b.low < lo) lo = b.low
    const above = b.close >= center
    if (prevAbove !== null && above !== prevAbove) crossovers++
    prevAbove = above
  }
  const rangePct = Number.isFinite(hi) && Number.isFinite(lo) && center > 0 ? ((hi - lo) / center) * 100 : 0
  return { trendPct: round2(trendPct), rangePct: round2(rangePct), crossovers }
}

function planFromBest(best: GridOptCandidate, opts: {
  symbol: string
  center: number
  windowDays: number
  bars: number
  qtyPerGrid: number
  preset: GridAutoPreset
  maxEndDays: number
  metrics: { trendPct: number; rangePct: number; crossovers: number }
}): GridAutoPlan {
  const p = AUTO_PRESETS[opts.preset]
  return {
    center: opts.center,
    windowDays: opts.windowDays,
    bars: opts.bars,
    lowerPrice: best.lowerPrice,
    upperPrice: best.upperPrice,
    gridCount: best.gridCount,
    spacing: 'arithmetic',
    direction: 'both',
    qtyPerGrid: opts.qtyPerGrid,
    maxSLPct: p.maxSLPct,
    maxTPPct: p.maxTPPct,
    slTriggerApprox: round2(best.lowerPrice * (1 - p.maxSLPct / 100)),
    tpTriggerApprox: round2(best.upperPrice * (1 + p.maxTPPct / 100)),
    maxEndDays: opts.maxEndDays,
    preset: opts.preset,
    trendPct: opts.metrics.trendPct,
    rangePct: opts.metrics.rangePct,
    crossovers: opts.metrics.crossovers,
    backtest: {
      totalPnl: round2(best.totalPnl),
      realizedPnl: round2(best.realizedPnl),
      openPnl: round2(best.openPnl),
      maxDrawdown: round2(best.maxDrawdown),
      fillsCount: best.fillsCount,
      openLots: best.openLots,
      winRate: best.winRate,
      score: round2(best.score),
    },
  }
}

/**
 * Analyze ONE symbol's bars → start/skip decision + plan. `windowDays` is the
 * calendar span the caller requested (for display); `maxEndDays` feeds the
 * planned auto end. Pure — throws only on programmer error, never on data.
 */
export function analyzeGridForSymbol(input: {
  symbol: string
  bars: Bar[]
  windowDays: number
  qtyPerGrid: number
  preset: GridAutoPreset
  maxEndDays: number
}): GridAutoDecision {
  const { symbol, bars, windowDays, qtyPerGrid, preset, maxEndDays } = input
  const detailBullets = (m: { trendPct: number; rangePct: number; crossovers: number }, n: number, days: number) => [
    `${n} bars · ${days}d window`,
    `drift ${pct(m.trendPct)} · range ${m.rangePct.toFixed(1)}% · ${m.crossovers} midline crossings`,
  ]

  if (bars.length < MIN_BARS) {
    return {
      symbol,
      decision: 'skip',
      reason: `Insufficient history — ${bars.length} usable bars (need ≥ ${MIN_BARS})`,
      details: [`${bars.length} bars · ${windowDays}d window requested`],
      plan: null,
    }
  }
  const center = Number(bars[bars.length - 1]?.close)
  if (!Number.isFinite(center) || center <= 0) {
    return {
      symbol,
      decision: 'skip',
      reason: 'No usable price in the history window',
      details: [`${bars.length} bars · ${windowDays}d window requested`],
      plan: null,
    }
  }

  const metrics = regimeMetrics(bars, center)
  const sweep = optimizeGridConfig({
    center,
    isCrypto: symbol.includes('/'),
    direction: 'both',
    spacing: 'arithmetic',
    qtyPerGrid,
    bars,
  })

  if (!sweep.best) {
    return {
      symbol,
      decision: 'skip',
      reason: `No grid activity — none of the ${sweep.tried} swept ranges (widths ${OPT_WIDTHS_PCT.join('/')}%, ${OPT_COUNTS.length} level counts) produced a single simulated fill in ${windowDays}d`,
      details: detailBullets(metrics, bars.length, windowDays),
      plan: null,
    }
  }

  const plan = planFromBest(sweep.best, { symbol, center, windowDays, bars: bars.length, qtyPerGrid, preset, maxEndDays, metrics })
  const btLine = `best of ${sweep.tried} configs: score ${plan.backtest.score} (P/L ${plan.backtest.totalPnl} − 0.5×DD ${plan.backtest.maxDrawdown}) · ${plan.backtest.fillsCount} fills · win ${plan.backtest.winRate == null ? '—' : `${Math.round(plan.backtest.winRate)}%`}`

  if (Math.abs(metrics.trendPct) > TREND_MAX_PCT) {
    return {
      symbol,
      decision: 'skip',
      reason: `Strong one-way trend (${pct(metrics.trendPct)} over ${windowDays}d > ${TREND_MAX_PCT}%) — a mean-reversion grid would buy a falling knife / sell a breakout`,
      details: [...detailBullets(metrics, bars.length, windowDays), btLine],
      plan,
    }
  }

  if (plan.backtest.score <= 0) {
    return {
      symbol,
      decision: 'skip',
      reason: `Risk-adjusted backtest negative — the ${plan.backtest.fillsCount}-fill best config lost money over the window (score ${plan.backtest.score})`,
      details: [...detailBullets(metrics, bars.length, windowDays), btLine],
      plan,
    }
  }

  return {
    symbol,
    decision: 'start',
    reason: `Range-bound + active over ${windowDays}d — ${btLine}`,
    details: [
      ...detailBullets(metrics, bars.length, windowDays),
      `range ${plan.lowerPrice}–${plan.upperPrice} · ${plan.gridCount} levels · qty ${plan.qtyPerGrid}/grid`,
      `ends at SL ${plan.slTriggerApprox} (−${plan.maxSLPct}% below lower) · TP ${plan.tpTriggerApprox} (+${plan.maxTPPct}% above upper) · or after ${maxEndDays}d`,
    ],
    plan,
  }
}
