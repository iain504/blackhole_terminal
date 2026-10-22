// Support/Resistance auto-detection (Task 58).
//
// Given a series of OHLC bars (one timeframe), find horizontal price levels
// that price has TOUCHED (tested) at least `minTouches` times:
//   1. pivot highs/lows = local extremes in a ±window — each pivot is one
//      REJECTION: price came to the level and turned away. Flat shelves elect
//      their first bar (left-strict / right-tie comparison) so a sideways
//      base still counts.
//   2. pivot prices close together (within tolPct) are clustered into one
//      level (mean); the level's TOUCH COUNT = the number of pivots in the
//      cluster — i.e. how many separate tests the level survived.
//   3. levels keep only if touches >= minTouches; the side is judged from the
//      latest close (price above the level → it acts as support, below →
//      resistance).
//   4. strongest levels first (touches desc, then proximity to last price),
//      capped at maxLevels.

export interface SrBar {
  time: number
  high: number
  low: number
  close: number
}

export interface SrLevel {
  price: number
  touches: number
  side: 'support' | 'resistance'
}

export interface SrOptions {
  /** minimum touches (pivot rejections) for a level to qualify (default 3) */
  minTouches?: number
  /** max levels returned per timeframe (default 6) */
  maxLevels?: number
  /** pivot lookback bars each side (default 5) */
  pivotWindow?: number
  /** cluster width as a fraction of the level (default 0.008) */
  tolPct?: number
  /** reference price for support/resistance classification (defaults to the
   * last bar's close — pass the live quote so lagging intraday feeds don't
   * mislabel the sides) */
  refPrice?: number
}

export function detectSrLevels(bars: SrBar[], opts: SrOptions = {}): SrLevel[] {
  const minTouches = Math.max(1, Math.floor(opts.minTouches ?? 3))
  const maxLevels = Math.max(1, Math.floor(opts.maxLevels ?? 6))
  const w = Math.max(2, Math.floor(opts.pivotWindow ?? 5))
  const tolPct = opts.tolPct ?? 0.008
  if (bars.length < w * 2 + 3) return []
  const last = opts.refPrice ?? bars[bars.length - 1].close
  // 1) pivots — strict local extremes in a ±w window. Left side compares
  //    strictly (the FIRST bar of a flat shelf wins), right side allows ties
  //    (the rest of the shelf doesn't re-elect).
  const cand: number[] = []
  for (let i = w; i < bars.length - w; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - w; j <= i + w && (isHigh || isLow); j++) {
      if (j === i) continue
      if (j < i) {
        if (bars[j].high >= bars[i].high) isHigh = false
        if (bars[j].low <= bars[i].low) isLow = false
      } else {
        if (bars[j].high > bars[i].high) isHigh = false
        if (bars[j].low < bars[i].low) isLow = false
      }
    }
    if (isHigh) cand.push(bars[i].high)
    if (isLow) cand.push(bars[i].low)
  }
  if (cand.length === 0) return []

  // 2) cluster sorted pivot prices within tolPct of the running cluster mean;
  //    the touch count IS the cluster size (number of separate rejections)
  cand.sort((a, b) => a - b)
  const levels: SrLevel[] = []
  let group: number[] = [cand[0]]
  let groupSum = cand[0]
  const flush = () => {
    const price = groupSum / group.length
    if (group.length >= minTouches) {
      levels.push({ price, touches: group.length, side: last >= price ? 'support' : 'resistance' })
    }
  }
  for (let i = 1; i < cand.length; i++) {
    const mean = groupSum / group.length
    if ((cand[i] - mean) / mean <= tolPct) {
      group.push(cand[i])
      groupSum += cand[i]
    } else {
      flush()
      group = [cand[i]]
      groupSum = cand[i]
    }
  }
  flush()

  // 3) strongest first — more touches wins, then nearer to the current price
  levels.sort((a, b) => b.touches - a.touches || Math.abs(a.price - last) - Math.abs(b.price - last))
  return levels.slice(0, maxLevels)
}
