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

/**
 * Task 18-b — per-symbol position sizing for Auto Grid.
 *   • fixed    — legacy: the SAME qty per grid level on every symbol. On a
 *                $400 stock vs a $4 stock the money behind a full grid then
 *                differs 100× — the exact complaint this mode now fixes.
 *   • equityPct — risk-money sizing: every symbol's grid gets the SAME
 *                ALLOCATION (pct% of account equity) as its worst-case money
 *                behind (qty × price × gridCount). qtyPerGrid is DERIVED per
 *                symbol after the sweep picks the best config:
 *                qty = (equity × pct/100) / (center × gridCount).
 *                The sweep itself is qty-invariant (every fill is
 *                qty × price-delta, so PnL/DD/score scale linearly and the
 *                ranking never changes) — the chosen range/levels are exactly
 *                what a fixed-qty sweep would pick, then the money metrics
 *                are rescaled to the resolved qty.
 *                Stocks floor to whole shares (the validator's floor); when
 *                the allocation cannot fund even 1 share/level the symbol is
 *                SKIPPED with the minimum % needed instead of silently
 *                over-deploying — TSLA at 8 levels needs ≥ (price×8/equity)%.
 *                Crypto floors to 8 decimals and needs ≥ $1 notional/level
 *                (the broker's minimum order size).
 */
export type GridAutoSizing =
  | { mode: 'fixed'; qty: number }
  | { mode: 'equityPct'; pct: number; equity: number }

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
  /** RESOLVED qty per level for THIS symbol (equityPct mode derives it) */
  qtyPerGrid: number
  maxSLPct: number
  maxTPPct: number
  /** resolved guard triggers at plan time (percent basis, re-armed every tick) */
  slTriggerApprox: number
  tpTriggerApprox: number
  /** planned engine stop (days from start) */
  maxEndDays: number
  preset: GridAutoPreset
  /** sizing mode this plan was built with ('fixed' when absent on old rows) */
  sizing?: 'fixed' | 'equityPct'
  /** equityPct mode only — the inputs + resolution the qty came from */
  sizingPct?: number
  equityAtPlan?: number
  /** equityPct mode: the allocation target (equity × pct/100). The worst-case
   *  money behind can differ slightly (whole-share floors round DOWN). */
  allocation?: number
  /** worst-case money behind the FULL grid at plan time: qty × center × gridCount
   *  (both modes — this is the number that used to differ 10–100× across symbols) */
  moneyBehind?: number
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
/** floor to 8 decimals (the crypto order pipeline's precision) */
const floor8 = (n: number) => Math.floor(n * 1e8) / 1e8
/** smallest whole-share/whole-qty money behind: qty × price × levels */
const moneyBehindOf = (qty: number, center: number, count: number) => round2(qty * center * count)

/** Alpaca's per-order minimum NOTIONAL for crypto (a smaller level order
 *  would be rejected live — say so at plan time instead). */
export const CRYPTO_MIN_NOTIONAL = 1
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
  /** the sizing context the qty was resolved from (undefined = legacy fixed) */
  sizing?: GridAutoSizing
}): GridAutoPlan {
  const p = AUTO_PRESETS[opts.preset]
  const pctSizing = opts.sizing?.mode === 'equityPct' ? opts.sizing : null
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
    sizing: pctSizing ? 'equityPct' : 'fixed',
    ...(pctSizing
      ? {
          sizingPct: pctSizing.pct,
          equityAtPlan: round2(pctSizing.equity),
          allocation: round2((pctSizing.equity * pctSizing.pct) / 100),
        }
      : {}),
    moneyBehind: moneyBehindOf(opts.qtyPerGrid, opts.center, best.gridCount),
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
 * planned auto end. `sizing` decides how qtyPerGrid is resolved:
 *   • fixed — the given qty everywhere (legacy behavior, zero changes);
 *   • equityPct — the sweep runs on a REFERENCE qty of 1 (its ranking is
 *     qty-invariant: every fill is qty × price-delta so PnL/DD/score scale
 *     linearly), then qty is derived from the allocation vs the WINNER's
 *     price × levels, and the plan's money metrics are rescaled to it.
 *     Stocks that cannot fund 1 whole share/level are skipped honestly.
 * Pure — throws only on programmer error, never on data.
 */
export function analyzeGridForSymbol(input: {
  symbol: string
  bars: Bar[]
  windowDays: number
  sizing: GridAutoSizing
  preset: GridAutoPreset
  maxEndDays: number
}): GridAutoDecision {
  const { symbol, bars, windowDays, sizing, preset, maxEndDays } = input
  const isCrypto = symbol.includes('/')
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
  // equityPct sanity — the route guarantees a positive equity, but a stale
  // account between fetch and analysis must fail honestly, not divide by 0
  if (sizing.mode === 'equityPct' && (!(sizing.equity > 0) || !Number.isFinite(sizing.equity))) {
    return {
      symbol,
      decision: 'skip',
      reason: 'Account equity unavailable — % of equity sizing needs a readable broker account',
      details: [`${bars.length} bars · ${windowDays}d window requested`],
      plan: null,
    }
  }

  const metrics = regimeMetrics(bars, center)
  // the sweep's ranking is qty-invariant (linear money metrics) — a reference
  // qty of 1 in equityPct mode keeps the simulation cheap and the rescale exact
  const sweepQty = sizing.mode === 'fixed' ? sizing.qty : 1
  const sweep = optimizeGridConfig({
    center,
    isCrypto,
    direction: 'both',
    spacing: 'arithmetic',
    qtyPerGrid: sweepQty,
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

  // ---- resolve THIS symbol's qty from the sizing mode vs the winner ----
  let qtyPerGrid: number
  let best = sweep.best
  let sizingSkip: string | null = null
  if (sizing.mode === 'fixed') {
    qtyPerGrid = sizing.qty
  } else {
    const allocation = (sizing.equity * sizing.pct) / 100
    const rawQty = allocation / (center * best.gridCount)
    if (!isCrypto) {
      qtyPerGrid = Math.floor(rawQty)
      if (qtyPerGrid < 1) {
        const minPct = Math.ceil(((center * best.gridCount) / sizing.equity) * 100)
        sizingSkip =
          `${sizing.pct}% of equity ($${round2(allocation)}) cannot fund a whole-share ${symbol} grid — ` +
          `${best.gridCount} levels × $${round2(center)} needs ≥ $${round2(center * best.gridCount)} ` +
          `(≥ ${minPct}% of equity) for even 1 share per level`
        qtyPerGrid = 0
      }
    } else {
      qtyPerGrid = floor8(rawQty)
      if (!(qtyPerGrid > 0) || qtyPerGrid * center < CRYPTO_MIN_NOTIONAL) {
        const minPct = Math.max(0.1, Math.ceil(((CRYPTO_MIN_NOTIONAL * best.gridCount) / sizing.equity) * 1000) / 10)
        sizingSkip =
          `${sizing.pct}% of equity ($${round2(allocation)}) is below the broker minimum for ${symbol} — ` +
          `each of the ${best.gridCount} level orders needs ≥ $${CRYPTO_MIN_NOTIONAL} notional ` +
          `(≥ ${minPct}% of equity at this level count)`
        qtyPerGrid = 0
      }
    }
    if (qtyPerGrid > 0 && sweepQty !== qtyPerGrid) {
      // rescale the linear money metrics from the reference qty to the
      // resolved qty (fills/winRate/openLots are counts — unchanged)
      const k = qtyPerGrid / sweepQty
      best = {
        ...best,
        totalPnl: best.totalPnl * k,
        realizedPnl: best.realizedPnl * k,
        openPnl: best.openPnl * k,
        maxDrawdown: best.maxDrawdown * k,
        score: best.totalPnl * k - 0.5 * best.maxDrawdown * k,
      }
    }
  }

  const plan = planFromBest(best, {
    symbol,
    center,
    windowDays,
    bars: bars.length,
    qtyPerGrid: qtyPerGrid > 0 ? qtyPerGrid : sweepQty,
    preset,
    maxEndDays,
    metrics,
    sizing,
  })
  const moneyLine = `range ${plan.lowerPrice}–${plan.upperPrice} · ${plan.gridCount} levels · qty ${plan.qtyPerGrid}/grid`
  const btLine = `best of ${sweep.tried} configs: score ${plan.backtest.score} (P/L ${plan.backtest.totalPnl} − 0.5×DD ${plan.backtest.maxDrawdown}) · ${plan.backtest.fillsCount} fills · win ${plan.backtest.winRate == null ? '—' : `${Math.round(plan.backtest.winRate)}%`}`

  if (sizingSkip != null) {
    return {
      symbol,
      decision: 'skip',
      reason: sizingSkip,
      details: [...detailBullets(metrics, bars.length, windowDays), btLine, moneyLine],
      plan,
    }
  }

  if (Math.abs(metrics.trendPct) > TREND_MAX_PCT) {
    return {
      symbol,
      decision: 'skip',
      reason: `Strong one-way trend (${pct(metrics.trendPct)} over ${windowDays}d > ${TREND_MAX_PCT}%) — a mean-reversion grid would buy a falling knife / sell a breakout`,
      details: [...detailBullets(metrics, bars.length, windowDays), btLine, moneyLine],
      plan,
    }
  }

  if (plan.backtest.score <= 0) {
    return {
      symbol,
      decision: 'skip',
      reason: `Risk-adjusted backtest negative — the ${plan.backtest.fillsCount}-fill best config lost money over the window (score ${plan.backtest.score})`,
      details: [...detailBullets(metrics, bars.length, windowDays), btLine, moneyLine],
      plan,
    }
  }

  return {
    symbol,
    decision: 'start',
    reason: `Range-bound + active over ${windowDays}d — ${btLine}`,
    details: [
      ...detailBullets(metrics, bars.length, windowDays),
      moneyLine +
        (plan.moneyBehind != null
          ? ` · $${plan.moneyBehind} behind` +
            (plan.sizing === 'equityPct' && plan.sizingPct != null
              ? ` (${plan.sizingPct}% of $${plan.equityAtPlan} equity${plan.allocation != null && Math.abs(plan.allocation - plan.moneyBehind) > 0.01 ? `, target $${plan.allocation}` : ''})`
              : '')
          : ''),
      `ends at SL ${plan.slTriggerApprox} (−${plan.maxSLPct}% below lower) · TP ${plan.tpTriggerApprox} (+${plan.maxTPPct}% above upper) · or after ${maxEndDays}d`,
    ],
    plan,
  }
}
