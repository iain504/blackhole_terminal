// v2.3.0 — Swing MTF evaluation for LIVE algo runs (spec §1.4, live unlock).
//
// The backtest swing lane (src/lib/backtest.ts) decides on PRECOMPUTED
// aggregates (trendPs / midRsiArr / rsiArr / pivHighs/pivLows) inside its
// replay loop. The live engine evaluates ONE closed bar per 15s cycle and
// only ever sees a rolling window, so this module recomputes the whole HTF
// ladder from that window on every eval — aggregateBars is O(n), live swing
// windows are ≤ ~2k bars, and one extra pass per cycle is nothing.
//
// Everything is built on the SAME pure mtf.ts helpers the backtest uses
// (aggregateBars · htfIndexAt · pivotLevels · nearestLevel) so both engines
// share one MTF mechanics contract:
//   • exact UTC bucketing (weekly = the FROZEN offset formula),
//   • htfIndexAt = last COMPLETED bucket → lookahead-free by construction,
//   • pivots only usable at confirmedAt = extremeIdx + lookback.
// The DECISION RULES below are byte-mirrors of backtest.ts — rawDecide's
// 'swing-pullback' / 'htf-level-bounce' branches plus the executor's
// SIDE-AWARE exits — so the engines stay probe-diffable (the backtest reads
// its own copies; a parity probe diffs both over the same bars).
//
// Live vs backtest, the one honest divergence: RSI windows. The backtest
// seeds Wilder RSI from the dataset start; the live window re-seeds from the
// window start. After ~3×period bars both converge to the same steady state
// — the exact argument the day lane already accepts for bb-reversion
// (backtest.ts lines ~517-522). The DEPTH budget below (swingLookbackDays)
// keeps the window comfortably past that horizon.
import { aggregateBars, htfIndexAt, nearestLevel, pivotLevels, type Pivot } from '@/lib/mtf'
import {
  isSwingTf, MTF_TREND_TF, MTF_MID_TF, SWING_TFS,
  type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { TIMEFRAMES, type Bar } from '@/lib/market-types'

export type SwingStrategyId = 'swing-pullback' | 'htf-level-bounce'

// seconds → swing tf label (the backtest builds the same map as TF_KEY_BY_SEC)
const SWING_KEY_BY_SEC: Partial<Record<number, AlgoTimeframe>> = {}
for (const tf of SWING_TFS) SWING_KEY_BY_SEC[TIMEFRAMES[tf].seconds] = tf

export interface SwingSetup {
  strategy: SwingStrategyId
  n: number // closed bars in the window
  entrySec: number
  entryKey: AlgoTimeframe | null // '1h'|'4h'|'1D' when the spacing matches a swing tf
  mtfEntryLabel: string
  mtfTrendLabel: string
  mtfMidLabel: string
  trendSec: number
  midSec: number
  trendAgg: Bar[]
  midAgg: Bar[]
  trendPs: Float64Array // trend closes prefix sums — smaAt is O(1)
  midRsi: Float64Array // Wilder RSI on the confirm series (NaN until index period)
  entryRsi: Float64Array | null // Wilder RSI on the entry series (swing-pullback only)
  pivHighs: Pivot[]
  pivLows: Pivot[]
  curKt: number // last COMPLETED trend bucket at the LAST bar's open time (−1 = none)
  curKm: number // last COMPLETED confirm bucket
  needTrend: number // trend buckets the guards require (starvation note)
}

export interface SwingDecision {
  entry: { side: 'buy' | 'sell'; reason: string } | null
  exit: string | null
  /** set when the HTF ladder is still warming up on this feed — honest
   *  zero-signal attribution (the v2.2.2 lesson: never starve silently) */
  note?: string
}

/**
 * History budget for a LIVE swing run, in CALENDAR days of entry-tf history
 * to request from the feed, so the HTF ladder can actually warm up: trend
 * buckets are what gate the first decision (kt ≥ trendLen, plus
 * pivotScan+lookback for htf-level-bounce), and buckets follow TRADING time —
 * the v2.2.2 lesson. Crypto prints buckets one-to-one with calendar days;
 * equities only print ~5/7 of the calendar (RTH sessions, weekends), so their
 * window is widened ×7/5. A +14d margin covers partial first/last buckets and
 * the mid-RSI warmup; the whole thing is capped at 3 years (the honest
 * starvation note covers anything a young listing can't satisfy).
 */
export function swingLookbackDays(
  entryTf: AlgoTimeframe,
  strategy: SwingStrategyId,
  params: Record<string, number>,
  isCrypto: boolean,
): number {
  const trendLen = Math.max(10, Math.round(params.trendSma ?? 50))
  const needTrend = strategy === 'htf-level-bounce'
    ? Math.max(trendLen, Math.max(20, Math.round(params.pivotScan ?? 60)) + Math.max(2, Math.round(params.pivotLookback ?? 3)))
    : trendLen
  const trendKey = isSwingTf(entryTf) ? MTF_TREND_TF[entryTf] : '1D'
  const trendSec = TIMEFRAMES[trendKey].seconds
  const rawDays = Math.ceil((needTrend * trendSec) / 86400)
  const calDays = isCrypto ? rawDays : Math.ceil((rawDays * 7) / 5)
  return Math.min(1095, Math.max(60, calDays + 14))
}

/**
 * Wilder RSI over a close series — the EXACT algorithm the backtest uses for
 * both the entry series (swing-pullback trigger/exit) and the confirm series
 * (seed at index `period`, NaN before). One pass, O(n).
 */
export function wilderRsiSeries(closes: number[], period: number): Float64Array {
  const arr = new Float64Array(closes.length).fill(Number.NaN)
  if (closes.length < 2 || period < 1) return arr
  let ag = 0
  let al = 0
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (i <= period) {
      if (d >= 0) ag += d
      else al -= d
      if (i === period) {
        ag /= period
        al /= period
        arr[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
      }
      continue
    }
    ag = (ag * (period - 1) + Math.max(0, d)) / period
    al = (al * (period - 1) + Math.max(0, -d)) / period
    arr[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
  }
  return arr
}

/**
 * Build the whole MTF ladder for a live eval from the closed-bar window.
 * Returns null when the window is too thin to derive the entry spacing
 * (< 3 bars — the day lane's `n < 5` guard analog; the cycle keeps polling).
 */
export function swingSetup(
  bars: Bar[],
  strategy: SwingStrategyId,
  params: Record<string, number>,
): SwingSetup | null {
  const n = bars.length
  if (n < 3) return null
  // entry-tf spacing — data-driven exactly like the backtest (min positive
  // delta across the first 61 gaps; degenerate feeds fall back to 3600)
  let entrySec = Number.POSITIVE_INFINITY
  for (let k = 1; k < Math.min(n, 61); k++) {
    const d = bars[k].time - bars[k - 1].time
    if (d > 0 && d < entrySec) entrySec = d
  }
  if (!Number.isFinite(entrySec) || !(entrySec > 0)) entrySec = 3600
  const entryKey = SWING_KEY_BY_SEC[entrySec] ?? null
  const mtfEntryLabel = entryKey ?? `${Math.round(entrySec / 60)}m`
  // FROZEN ladder for a recognized swing tf; anything else rides the 1h lane's
  // ladder (1D trend + 4h confirm) — identical fallback to the backtest.
  const swingKey = entryKey != null && isSwingTf(entryKey) ? entryKey : null
  const trendTf = swingKey != null ? MTF_TREND_TF[swingKey] : '1D'
  const midTf = swingKey != null ? MTF_MID_TF[swingKey] : '4h'
  const trendSec = TIMEFRAMES[trendTf].seconds
  const midSec = TIMEFRAMES[midTf].seconds
  const trendAgg = aggregateBars(bars, trendSec)
  const midAgg = aggregateBars(bars, midSec)
  // trend SMA via prefix sums — O(1) reads at the mapped HTF index
  const trendPs = new Float64Array(trendAgg.length + 1)
  for (let k = 0; k < trendAgg.length; k++) trendPs[k + 1] = trendPs[k] + trendAgg[k].close
  // confirm-TF Wilder RSI — period: the strategy's rsiPeriod when it defines
  // one, else the standard 14 (htf-level-bounce has no rsiPeriod param)
  const mRp = strategy === 'swing-pullback' ? Math.max(2, Math.round(params.rsiPeriod ?? 14)) : 14
  const midRsi = wilderRsiSeries(midAgg.map((b) => b.close), mRp)
  const entryRsi = strategy === 'swing-pullback'
    ? wilderRsiSeries(bars.map((b) => b.close), Math.max(2, Math.round(params.rsiPeriod ?? 14)))
    : null
  // htf-level-bounce — confirmed S/R pivots on the TREND series
  let pivHighs: Pivot[] = []
  let pivLows: Pivot[] = []
  if (strategy === 'htf-level-bounce') {
    const piv = pivotLevels(
      trendAgg,
      Math.max(2, Math.round(params.pivotLookback ?? 3)),
      Math.max(20, Math.round(params.pivotScan ?? 60)),
    )
    pivHighs = piv.highs
    pivLows = piv.lows
  }
  // lookahead-free HTF indices at the LAST closed bar's open time
  const curKt = htfIndexAt(bars[n - 1].time, trendAgg, trendSec)
  const curKm = htfIndexAt(bars[n - 1].time, midAgg, midSec)
  const trendLen = Math.max(10, Math.round(params.trendSma ?? 50))
  const needTrend = strategy === 'htf-level-bounce'
    ? Math.max(trendLen, Math.max(20, Math.round(params.pivotScan ?? 60)) + Math.max(2, Math.round(params.pivotLookback ?? 3)))
    : trendLen
  return {
    strategy, n, entrySec, entryKey,
    mtfEntryLabel, mtfTrendLabel: trendTf, mtfMidLabel: midTf,
    trendSec, midSec, trendAgg, midAgg, trendPs, midRsi, entryRsi,
    pivHighs, pivLows, curKt, curKm, needTrend,
  }
}

/**
 * Decide ONE closed bar (the engine's eval bar = the LAST bar of the window)
 * — entries byte-mirror backtest.ts rawDecide's swing branches; the side-aware
 * exits byte-mirror the backtest executor's step-4 swing exits. `pos` carries
 * the held side + entry anchor the backtest's executor state provides; null
 * while flat (exits then can't fire — swing-pullback's RSI exit still can
 * NOT either, it is side-aware by definition).
 */
export function swingDecide(
  setup: SwingSetup,
  bars: Bar[],
  i: number, // index of the bar being decided (the eval bar)
  params: Record<string, number>,
  pos: { side: 'long' | 'short'; entryPx: number } | null,
): SwingDecision {
  const starved = setup.curKt < 0 || setup.curKm < 0 || setup.curKt < setup.needTrend
  const note = starved
    ? `swing warmup: ${Math.max(0, setup.curKt)}/${setup.needTrend} ${setup.mtfTrendLabel} buckets — entries wait for more history`
    : undefined
  const c = bars[i].close

  if (setup.strategy === 'swing-pullback') {
    // ---- side-aware exit FIRST (the cycle resolves exits before entries) —
    // backtest executor: the entry-TF RSI recaptures (long) / falls back
    // below (short) the exit level
    if (pos != null && setup.entryRsi != null) {
      const rv = setup.entryRsi[i]
      if (Number.isFinite(rv)) {
        if (pos.side === 'long') {
          if (rv > (params.exitRsi ?? 65)) return { entry: null, exit: 'RSI recaptured exit level' }
        } else if (rv < 100 - (params.exitRsi ?? 65)) {
          return { entry: null, exit: 'RSI fell back below exit level' }
        }
      }
    }
    // ---- entry (backtest rawDecide 'swing-pullback') ----
    const rp = Math.max(2, Math.round(params.rsiPeriod ?? 14))
    if (i + 1 < rp + 2) return { entry: null, exit: null } // entry-TF RSI warmup
    const kt = setup.curKt
    const km = setup.curKm
    // needTrend == trendLen here (no pivots) — same guard as the backtest's
    // rawDecide AND its data-driven warmup
    if (kt < 0 || km < 0 || kt < setup.needTrend) return { entry: null, exit: null, note }
    const trendLen = Math.max(10, Math.round(params.trendSma ?? 50))
    const tPs = setup.trendPs
    const smaT = (tPs[kt + 1] - tPs[kt + 1 - trendLen]) / trendLen
    const tClose = setup.trendAgg[kt].close
    const trendUp = tClose > smaT
    const trendDown = tClose < smaT
    const midVal = setup.midRsi[km]
    const rsiMin = params.rsiMin ?? 40
    const rsiMax = params.rsiMax ?? 70
    const midOkLong = Number.isFinite(midVal) && midVal >= rsiMin && midVal <= rsiMax
    const midOkShort = Number.isFinite(midVal) && (100 - midVal) >= rsiMin && (100 - midVal) <= rsiMax
    const entryRsi = params.entryRsi ?? 40
    const entryRsiVal = setup.entryRsi ? setup.entryRsi[i] : Number.NaN
    const allowShort = (params.allowShort ?? 1) >= 1
    if (trendUp && midOkLong && Number.isFinite(entryRsiVal) && entryRsiVal < entryRsi) {
      return {
        entry: { side: 'buy', reason: `HTF ${setup.mtfTrendLabel} up · ${setup.mtfMidLabel} RSI ${midVal.toFixed(0)} · ${setup.mtfEntryLabel} RSI ${entryRsiVal.toFixed(0)}` },
        exit: null,
      }
    }
    if (allowShort && trendDown && midOkShort && Number.isFinite(entryRsiVal) && entryRsiVal > 100 - entryRsi) {
      return {
        entry: { side: 'sell', reason: `HTF ${setup.mtfTrendLabel} down · ${setup.mtfMidLabel} RSI ${midVal.toFixed(0)} · ${setup.mtfEntryLabel} RSI ${entryRsiVal.toFixed(0)}` },
        exit: null,
      }
    }
    return { entry: null, exit: null, note }
  }

  // ---- htf-level-bounce ----
  // side-aware exit: "exit at the next HTF level" — nearest CONFIRMED
  // swing-high above the entry anchor for longs (swing-low below for shorts),
  // taken when the eval bar closes through it. Recomputed each eval so
  // late-confirming pivots become valid targets too — still lookahead-free
  // (nearestLevel only reads pivots with confirmedAt ≤ kt).
  if (pos != null && setup.curKt >= 0) {
    if (pos.side === 'long') {
      const R = nearestLevel(setup.pivHighs, pos.entryPx, 'above', setup.curKt)
      if (R != null && c >= R.price) return { entry: null, exit: 'reached HTF resistance' }
    } else {
      const S = nearestLevel(setup.pivLows, pos.entryPx, 'below', setup.curKt)
      if (S != null && c <= S.price) return { entry: null, exit: 'reached HTF support' }
    }
  }
  // ---- entry (backtest rawDecide 'htf-level-bounce') ----
  // Guard at needTrend (max(trendLen, pivotScan+lookback)), NOT bare trendLen:
  // the backtest's data-driven warmup (v2.2.2) holds ALL decisions until the
  // trend series carries pivotScan+lookback buckets — every pivot inside the
  // scan window must be confirmable before the first entry. The live mirror
  // enforces the identical floor, otherwise early entries fire that the
  // backtest never saw (probe-swing-live caught exactly that).
  const kt = setup.curKt
  const km = setup.curKm
  if (kt < 0 || km < 0 || kt < setup.needTrend) return { entry: null, exit: null, note }
  const trendLen = Math.max(10, Math.round(params.trendSma ?? 50))
  const tPs = setup.trendPs
  const smaT = (tPs[kt + 1] - tPs[kt + 1 - trendLen]) / trendLen
  const tClose = setup.trendAgg[kt].close
  const trendUp = tClose > smaT
  const trendDown = tClose < smaT
  const midVal = setup.midRsi[km]
  const midThresh = params.midRsi ?? 50
  const allowShort = (params.allowShort ?? 1) >= 1
  const proxMax = params.proximityPct ?? 1.5
  // LONG — pullback INTO a confirmed swing-low support (price ABOVE the
  // level, within tolerance — not a breakdown through it)
  if (trendUp && Number.isFinite(midVal) && midVal > midThresh) {
    const sup = nearestLevel(setup.pivLows, c, 'below', kt)
    if (sup != null && c > sup.price) {
      const prox = ((c - sup.price) / sup.price) * 100
      if (prox <= proxMax) {
        return { entry: { side: 'buy', reason: `HTF support ${sup.price.toPrecision(6)} ±${prox.toFixed(2)}% · ${setup.mtfMidLabel} RSI ${midVal.toFixed(0)}` }, exit: null }
      }
    }
  }
  // SHORT mirrored at resistance (the LEVEL stays the denominator)
  if (allowShort && trendDown && Number.isFinite(midVal) && midVal < 100 - midThresh) {
    const res = nearestLevel(setup.pivHighs, c, 'above', kt)
    if (res != null && c < res.price) {
      const prox = ((res.price - c) / res.price) * 100
      if (prox <= proxMax) {
        return { entry: { side: 'sell', reason: `HTF resistance ${res.price.toPrecision(6)} ±${prox.toFixed(2)}% · ${setup.mtfMidLabel} RSI ${midVal.toFixed(0)}` }, exit: null }
      }
    }
  }
  return { entry: null, exit: null, note }
}
