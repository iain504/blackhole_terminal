// Multi-timeframe (MTF) mechanics for the Swing lane (Backtest Revamp v2.2.0,
// spec §1.3) — PURE functions, no side effects, no I/O, client-safe.
//
// The swing backtest replays ENTRY-timeframe bars and confirms every decision
// against HIGHER timeframes that are AGGREGATED from the same bars by exact
// UTC time bucketing. The one hard correctness rule is NO LOOKAHEAD:
//   • an entry bar opened at time t may only read HTF bars that are already
//     CLOSED — htfIndexAt() returns the last completed bucket (the bucket
//     containing t is still forming, so its index minus one is the newest
//     usable one);
//   • a pivot (swing high/low) only becomes usable at `confirmedAt` =
//     extremeIdx + lookback — the `lookback` bars AFTER the extreme must have
//     closed before the pivot is provably an extreme (no future peeking).
// Weekly buckets (604800s) use the offset key Math.floor((time + 4·86400) /
// 604800) — the FROZEN contract formula ("epoch Thursday → Monday offset");
// aggregateBars and htfIndexAt share it so buckets and index mapping always
// agree, whatever weekday the boundary lands on.
import type { Bar } from '@/lib/market-types'

const WEEK_SEC = 604800
const WEEK_OFFSET_SEC = 4 * 86400

/**
 * Aggregate bars into a higher timeframe by UTC time bucketing (exact, no
 * lookahead). Bars must be ascending by time. group key =
 * Math.floor(time / targetSec) — for the weekly target (604800) the key is
 * Math.floor((time + 4·86400) / 604800). o = first open, h = max high,
 * l = min low, c = last close, v = sum volume, time = bucket open time.
 * Sparse buckets (weekends / session gaps) simply don't exist in the output —
 * indices stay dense and contiguous.
 */
export function aggregateBars(bars: Bar[], targetSec: number): Bar[] {
  if (!(targetSec > 0) || bars.length === 0) return []
  const weekly = targetSec === WEEK_SEC
  const out: Bar[] = []
  let curKey = Number.NaN
  let cur: Bar | null = null
  for (const b of bars) {
    const key = weekly
      ? Math.floor((b.time + WEEK_OFFSET_SEC) / WEEK_SEC)
      : Math.floor(b.time / targetSec)
    if (cur == null || key !== curKey) {
      if (cur != null) out.push(cur)
      curKey = key
      cur = {
        time: weekly ? key * WEEK_SEC - WEEK_OFFSET_SEC : key * targetSec,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }
    } else {
      if (b.high > cur.high) cur.high = b.high
      if (b.low < cur.low) cur.low = b.low
      cur.close = b.close
      cur.volume += b.volume
    }
  }
  if (cur != null) out.push(cur)
  return out
}

/**
 * Last COMPLETED HTF bar index for an LTF bar opened at time t (−1 = none yet).
 * BINARY SEARCH over the aggregated series itself — a bucket NUMBER from the
 * epoch formula is NOT an array index: the aggregated series starts at the
 * data's first bucket (not bucket 0) and skips sparse buckets (holidays,
 * weekends), so floor(t/htfSec) − 1 can point anywhere (for crypto 1h→1D it
 * is ≈ 20,600 against a ~500-element array — the old formula-clamp design
 * would have read the NEWEST bar for every decision, a massive lookahead).
 * The search key `open + htfSec <= t` selects exactly the bars that have
 * CLOSED by t: the bucket CONTAINING t has open ≤ t < open + htfSec, so it
 * can never match, and the bucket before it closes exactly at the containing
 * bucket's open — lookahead-free by construction, sparse buckets included.
 */
export function htfIndexAt(ltfTime: number, htfBars: Bar[], htfSec: number): number {
  const len = htfBars.length
  if (!(htfSec > 0) || len === 0) return -1
  let lo = 0
  let hi = len - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (htfBars[mid].time + htfSec <= ltfTime) {
      res = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return res
}

/** One confirmed swing extreme on a series. `confirmedAt` = HTF bar index
 *  where the pivot became KNOWN (extremeIdx + lookback) — consumers must gate
 *  on htfIdx >= confirmedAt so a decision can never use a pivot that needed
 *  future bars to prove itself. `time` = the extreme bar's open time. */
export interface Pivot { price: number; time: number; confirmedAt: number }

/**
 * Pivot swing highs/lows on a (HTF) series. Swing high at j: high[j] >= the
 * highs of j±1..lookback (ties allowed); swing low mirrored. A pivot is
 * CONFIRMED only at index j + lookback (no lookahead) — pivots whose
 * confirmation index falls past the end of the data are not returned (they
 * were never provable). Keeps the most recent `maxCount` of each side so the
 * level set stays bounded on deep history.
 */
export function pivotLevels(bars: Bar[], lookback: number, maxCount: number): { highs: Pivot[]; lows: Pivot[] } {
  const lb = Math.max(1, Math.round(lookback))
  const keep = Math.max(1, Math.round(maxCount))
  const n = bars.length
  const highs: Pivot[] = []
  const lows: Pivot[] = []
  for (let j = lb; j < n - lb; j++) {
    const b = bars[j]
    let isHigh = true
    let isLow = true
    for (let d = 1; d <= lb; d++) {
      // strict > / < on the neighbors: EQUAL extremes keep the pivot (ties)
      if (bars[j - d].high > b.high || bars[j + d].high > b.high) isHigh = false
      if (bars[j - d].low < b.low || bars[j + d].low < b.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) highs.push({ price: b.high, time: b.time, confirmedAt: j + lb })
    if (isLow) lows.push({ price: b.low, time: b.time, confirmedAt: j + lb })
  }
  return { highs: highs.slice(-keep), lows: lows.slice(-keep) }
}

/**
 * Nearest confirmed support below px / resistance above px among pivots with
 * confirmedAt <= htfIdx. 'below' → the HIGHEST pivot price ≤ px (closest
 * support under the price) · 'above' → the LOWEST pivot price ≥ px (closest
 * resistance over it). Ties resolve to the most recent pivot. Returns null
 * when no confirmed pivot qualifies.
 */
export function nearestLevel(pivots: Pivot[], px: number, dir: 'below' | 'above', htfIdx: number): Pivot | null {
  let best: Pivot | null = null
  for (const p of pivots) {
    if (p.confirmedAt > htfIdx) continue
    if (dir === 'below') {
      if (p.price <= px && (best == null || p.price >= best.price)) best = p
    } else {
      if (p.price >= px && (best == null || p.price <= best.price)) best = p
    }
  }
  return best
}
