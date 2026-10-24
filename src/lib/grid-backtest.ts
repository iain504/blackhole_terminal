// Task 10-a — grid backtest simulation: a PURE replay of grid-engine.ts
// crossing semantics over historical OHLC bars (paper parity — fees 0).
//
// Semantics mirrored from evaluateGrid() (read them side by side):
//   • bars[0] only SEEDS lastPrice (the engine's first evaluation seeds and
//     never trades); every following bar is evaluated with high/low/close.
//   • guards FIRST, SL before TP: long grids stop on bar.low ≤ slTrigger /
//     bar.high ≥ tpTrigger (closeOnStop → all lots closed AT the trigger, one
//     fill per lot); sell-only MIRRORS (short SL = bar.high ≥ slTrigger with
//     the close BUYING back, short TP = bar.low ≤ tpTrigger). Triggers come
//     from resolveGuards() — the SAME price/percent resolution the live engine
//     re-runs every tick.
//   • TP sells before entries (the engine frees capacity before adding lots,
//     'both' only): a lot bought at level i pays at level[i+1] ?? upperPrice
//     when lastPrice < target ≤ bar.high — sold AT the target.
//   • entries: level i crossed downward (lastPrice > level[i] ≥ bar.low), one
//     lot per level, bought AT the level. Lots freed by a TP sell in the SAME
//     bar can be re-bought (the engine behaves identically within a tick).
//     sell-only mirrors: level i crossed UPWARD (lastPrice < level[i] ≤
//     bar.high) → one SHORT lot sold AT the level, marked inverted.
//   • lastPrice = bar.close at the end of every bar; one curve point per bar
//     (realized + open marked at that close).
// Intrabar ambiguity is accepted by design: with only OHLC we cannot know
// whether the high or the low came first inside a bar — sells are evaluated
// before buys using high/low, matching the engine's sell-first tick order.
// After a guard stop NO further trades happen; open lots (closeOnStop=false)
// keep being marked to market at each bar close through the final bar.
//
// Stock sizing mirrors the engine's effectiveQty (whole-share floor).
import type { Bar } from '@/lib/market-types'
import {
  computeLevels, resolveGuards, guardStopText,
  type GridSpacing, type GridDirection,
} from '@/lib/grid-engine'

export interface GridBacktestConfig {
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: GridSpacing
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  /** 'price' | 'percent' */
  slBasis: string
  tpBasis: string
  closeOnStop: boolean
  /** crypto trades fractional size; stocks are floored to whole shares */
  isCrypto: boolean
  /** Task 10-g — absent reads as 'both'; 'sell' mirrors guards + entries */
  direction?: GridDirection | string | null
}

export interface GridBacktestFill {
  t: string
  side: 'buy' | 'sell'
  /** 'grid' | 'tp' | 'sl' | 'maxtp' — same reason vocabulary as GridFill */
  reason: string
  price: number
  qty: number
  pnl: number | null
}

export interface GridBacktestStats {
  realizedPnl: number
  openPnl: number
  totalPnl: number
  fillsCount: number
  buys: number
  sells: number
  /** % of sell fills with pnl > 0 (0 when no sells) — same convention as the live GridStats */
  winRate: number
  /** max peak-to-trough decline of the cumulative (realized + open-marked) pnl across curve points, in pnl currency units */
  maxDrawdown: number
  /** best / worst per-lot realized round-trip (0 when none) */
  bestTrade: number
  worstTrade: number
  openLots: number
  openQty: number
}

export interface GridBacktestResult {
  stopped: boolean
  stopReason: string | null
  stats: GridBacktestStats
  /** one point per bar, downsampled to ≤ CURVE_MAX_POINTS (even stride, first+last kept) */
  curve: { t: string; totalPnl: number }[]
  /** newest-first, capped to the most recent FILLS_MAX_POINTS */
  fills: GridBacktestFill[]
}

const CURVE_MAX_POINTS = 300
const FILLS_MAX_POINTS = 200

const fmtP = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4))
const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString()

/** Same stride+first/last downsample the algo equity curve uses (≤300 here). */
function downsampleCurve(pts: { t: number; totalPnl: number }[]): { t: number; totalPnl: number }[] {
  if (pts.length <= CURVE_MAX_POINTS) return pts
  const stride = Math.ceil((pts.length - 1) / (CURVE_MAX_POINTS - 1))
  const out = pts.filter((_, i) => i % stride === 0)
  const last = pts[pts.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Replay a grid config over `bars` (chronological, closed bars). Throws only
 * on an invalid config (validate with validateGridConfig first — the routes do).
 */
export function simulateGridBacktest(cfg: GridBacktestConfig, bars: Bar[]): GridBacktestResult {
  if (bars.length === 0) throw new Error('No bars to simulate')
  const levels = computeLevels(cfg.lowerPrice, cfg.upperPrice, cfg.gridCount, cfg.spacing)
  const sellGrid = cfg.direction === 'sell'
  const buyOnly = cfg.direction === 'buy'
  const { slTrigger, tpTrigger } = resolveGuards({
    maxSL: cfg.maxSL,
    maxTP: cfg.maxTP,
    slBasis: cfg.slBasis,
    tpBasis: cfg.tpBasis,
    lowerPrice: cfg.lowerPrice,
    upperPrice: cfg.upperPrice,
    direction: cfg.direction ?? 'both',
  })

  interface SimLot { levelIndex: number; qty: number; entryPrice: number }
  let lots: SimLot[] = []
  let lastPrice = bars[0].close // seed — bar 0 itself is never traded (engine parity)
  let realized = 0
  const fills: GridBacktestFill[] = []
  const curveRaw: { t: number; totalPnl: number }[] = [{ t: bars[0].time, totalPnl: 0 }]
  let stopped = false
  let stopReason: string | null = null

  const qtyFor = () => (cfg.isCrypto ? cfg.qtyPerGrid : Math.floor(cfg.qtyPerGrid))
  // short lots (sell-only) mark INVERTED: (entry − price)
  const markPnl = (px: number) =>
    lots.reduce((acc, l) => acc + (sellGrid ? (l.entryPrice - px) : (px - l.entryPrice)) * l.qty, 0)

  for (let bi = 1; bi < bars.length; bi++) {
    const bar = bars[bi]

    if (!stopped) {
      // ---- guards FIRST (SL before TP — same order as evaluateGrid);
      // sell-only fires mirrored (short SL above, short TP below) ----
      const slHit = slTrigger != null && (sellGrid ? bar.high >= slTrigger : bar.low <= slTrigger)
      const tpHit = tpTrigger != null && (sellGrid ? bar.low <= tpTrigger : bar.high >= tpTrigger)
      if (slHit) {
        stopped = true
        stopReason = guardStopText('sl', cfg.slBasis, cfg.maxSL ?? 0, slTrigger)
        if (cfg.closeOnStop) {
          // the close-all IS the stop close — one fill per lot at the trigger
          for (const lot of lots) {
            const pnl = sellGrid
              ? (lot.entryPrice - slTrigger) * lot.qty
              : (slTrigger - lot.entryPrice) * lot.qty
            realized += pnl
            fills.push({ t: iso(bar.time), side: sellGrid ? 'buy' : 'sell', reason: 'sl', price: slTrigger, qty: lot.qty, pnl })
          }
          lots = []
        } else {
          stopReason += ' — open grid positions left running (close-on-stop disabled)'
        }
      } else if (tpHit) {
        stopped = true
        stopReason = guardStopText('maxtp', cfg.tpBasis, cfg.maxTP ?? 0, tpTrigger)
        if (cfg.closeOnStop) {
          for (const lot of lots) {
            const pnl = sellGrid
              ? (lot.entryPrice - tpTrigger) * lot.qty
              : (tpTrigger - lot.entryPrice) * lot.qty
            realized += pnl
            fills.push({ t: iso(bar.time), side: sellGrid ? 'buy' : 'sell', reason: 'maxtp', price: tpTrigger, qty: lot.qty, pnl })
          }
          lots = []
        } else {
          stopReason += ' — open grid positions left running (close-on-stop disabled)'
        }
      }
    }

    if (!stopped) {
      // ---- TP sells BEFORE entries (engine order) — 'both' ONLY: a lot
      // bought at level i pays at level[i+1] ?? upperPrice when
      // lastPrice < target ≤ bar.high, sold AT target
      if (!sellGrid && !buyOnly && lots.length > 0) {
        for (const lot of [...lots]) {
          const target = levels[lot.levelIndex + 1] ?? cfg.upperPrice
          if (!(lastPrice < target && bar.high >= target)) continue
          const pnl = (target - lot.entryPrice) * lot.qty
          realized += pnl
          fills.push({ t: iso(bar.time), side: 'sell', reason: 'tp', price: target, qty: lot.qty, pnl })
          lots = lots.filter((l) => l !== lot)
        }
      }
      // ---- level entries: one lot per level
      //   both/buy: downward crossing (lastPrice > level ≥ bar.low) → BUY at
      //   the level · sell: UPWARD crossing (lastPrice < level ≤ bar.high) →
      //   SELL at the level (short lot). A level freed by a TP above CAN
      //   re-enter this bar (engine parity).
      for (let i = 0; i < levels.length; i++) {
        const level = levels[i]
        if (sellGrid) {
          if (!(lastPrice < level && bar.high >= level)) continue
        } else {
          if (!(lastPrice > level && bar.low <= level)) continue
        }
        if (lots.some((l) => l.levelIndex === i)) continue
        const q = qtyFor()
        if (!(q > 0)) continue // whole-share floor rounded a tiny stock qty to 0
        lots.push({ levelIndex: i, qty: q, entryPrice: level })
        fills.push({ t: iso(bar.time), side: sellGrid ? 'sell' : 'buy', reason: 'grid', price: level, qty: q, pnl: null })
      }
    }

    // even after a guard stop: keep marking (closeOnStop=false lots run to the
    // final bar close) and keep the curve spanning the whole window
    lastPrice = bar.close
    curveRaw.push({ t: bar.time, totalPnl: realized + markPnl(lastPrice) })
  }

  const openPnl = markPnl(lastPrice)
  const totalPnl = realized + openPnl
  const sellPnls = fills.filter((f) => f.side === 'sell' && typeof f.pnl === 'number').map((f) => f.pnl as number)
  const wins = sellPnls.filter((p) => p > 0).length
  // best/worst per-lot realized round-trip — 0 only when NO round-trip happened
  // (all-losing batches still report their least-bad trade as bestTrade)
  const best = sellPnls.length > 0 ? Math.max(...sellPnls) : 0
  const worst = sellPnls.length > 0 ? Math.min(...sellPnls) : 0
  // max peak-to-trough decline of the cumulative marked pnl across curve points
  let peak = curveRaw.length > 0 ? curveRaw[0].totalPnl : 0
  let maxDrawdown = 0
  for (const p of curveRaw) {
    if (p.totalPnl > peak) peak = p.totalPnl
    const dd = peak - p.totalPnl
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  return {
    stopped,
    stopReason,
    stats: {
      realizedPnl: realized,
      openPnl,
      totalPnl,
      fillsCount: fills.length,
      buys: fills.filter((f) => f.side === 'buy').length,
      sells: fills.filter((f) => f.side === 'sell').length,
      winRate: sellPnls.length > 0 ? (wins / sellPnls.length) * 100 : 0,
      maxDrawdown,
      bestTrade: best,
      worstTrade: worst,
      openLots: lots.length,
      openQty: lots.reduce((acc, l) => acc + l.qty, 0),
    },
    curve: downsampleCurve(curveRaw).map((p) => ({ t: iso(p.t), totalPnl: Math.round(p.totalPnl * 100) / 100 })),
    // newest-first (same convention as the live grid fills list), most recent 200
    fills: (fills.length > FILLS_MAX_POINTS ? fills.slice(-FILLS_MAX_POINTS) : fills.slice()).reverse(),
  }
}

/** Debug helper used by the unit checks — human-readable sim summary. */
export function describeGridBacktest(r: GridBacktestResult): string {
  return `stopped=${r.stopped} reason=${r.stopReason ?? '-'} realized=${fmtP(r.stats.realizedPnl)} open=${fmtP(r.stats.openPnl)} total=${fmtP(r.stats.totalPnl)} fills=${r.stats.fillsCount} (B${r.stats.buys}/S${r.stats.sells}) winRate=${r.stats.winRate.toFixed(1)}% maxDD=${fmtP(r.stats.maxDrawdown)} best=${fmtP(r.stats.bestTrade)} worst=${fmtP(r.stats.worstTrade)} openLots=${r.stats.openLots}`
}
