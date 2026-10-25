// Algo strategy quality toolkit (Task 12) — shared indicator + gate math used
// by BOTH the backtest engine (src/lib/backtest.ts decide()) and the live algo
// engine (src/lib/algo-engine.ts evalStrategy()). One implementation per
// formula keeps the PARITY CONTRACT: the backtest and the live runner must
// veto exactly the same entries on the same data.
//
// Implements the uploaded improvement plan (upload/algo_improvement.txt):
//   • P0 regime/trend filter  — 200-SMA directional gate + Wilder ADX chop gate
//   • P1 half-life gate       — rolling OU regression on the deviation from
//                               SMA(50): entries only while the deviation is
//                               actually mean-reverting fast enough
//   • P1 dynamic costs        — ATR%-series consumed by the backtest's
//                               vol-scaled slippage (see backtest.ts)
//   • P2 Monte Carlo          — bootstrap of the trade sequence for honest
//                               confidence intervals
//
// FAIL-OPEN RULE: when a gate cannot be evaluated (insufficient history —
// NaN inputs), it PASSES. A thin bar window must never freeze a strategy;
// the gate only vetoes when it has positive evidence.

// fixed gate constants (deliberately NOT free parameters — the improvement
// plan caps free parameters per strategy at 3–4; these stay hardcoded)
export const REGIME_TREND_SMA = 200 // trend-gate SMA length (P0)
export const ADX_PERIOD = 14 // Wilder ADX period (P0)
export const HL_LOOKBACK = 240 // rolling OLS window for the half-life (P1)
export const HL_SMA_PERIOD = 50 // deviation basis: close − SMA(50)
export const HL_MIN_POINTS = 60 // fewer regression points → NaN (fail-open)
export const ATR_PERIOD = 14 // Wilder ATR period for vol-scaled slippage

/** Minimal structural bar — accepts both the chart Bar and the engine BarRow. */
export interface RegimeBar {
  high: number
  low: number
  close: number
}

// ---------------------------------------------------------------------------
// Wilder ADX — trend-strength oscillator 0..100 (NaN before the first valid
// index: needs 2×period−1 bars of seed). ADX ≥ ~25 = trending (bad for mean
// reversion), ADX < ~25 = chop / range (the MR regime).
// ---------------------------------------------------------------------------

export function adxSeries(bars: RegimeBar[], period: number = ADX_PERIOD): Float64Array {
  const n = bars.length
  const out = new Float64Array(n)
  out.fill(Number.NaN)
  if (n < 2 * period + 1) return out
  const dx = new Float64Array(n)
  let smTR = 0
  let smP = 0
  let smM = 0
  let adx = 0
  for (let i = 1; i < n; i++) {
    const h = bars[i].high
    const l = bars[i].low
    const pc = bars[i - 1].close
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    const up = h - bars[i - 1].high
    const dn = bars[i - 1].low - l
    const pdm = up > dn && up > 0 ? up : 0
    const mdm = dn > up && dn > 0 ? dn : 0
    if (i <= period) {
      smTR += tr
      smP += pdm
      smM += mdm
      if (i < period) continue
    } else {
      smTR = smTR - smTR / period + tr
      smP = smP - smP / period + pdm
      smM = smM - smM / period + mdm
    }
    const pDI = smTR > 0 ? (100 * smP) / smTR : 0
    const mDI = smTR > 0 ? (100 * smM) / smTR : 0
    const sum = pDI + mDI
    dx[i] = sum > 0 ? (100 * Math.abs(pDI - mDI)) / sum : 0
    if (i === 2 * period - 1) {
      // seed ADX with the mean of the first `period` DX values
      let s = 0
      for (let k = period; k <= 2 * period - 1; k++) s += dx[k]
      adx = s / period
      out[i] = adx
    } else if (i > 2 * period - 1) {
      adx = (adx * (period - 1) + dx[i]) / period
      out[i] = adx
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Half-life of mean reversion (P1) — rolling OLS of the Ornstein-Uhlenbeck
// fit  Δe_t = λ·e_{t−1}  over the last `lookback` points of the deviation
// series e = close − SMA(smaPeriod). half-life = −ln(2)/λ bars when λ < 0;
// Infinity when λ ≥ 0 (no reversion — trending); NaN when the window has too
// few points to judge (fail-open).
// ---------------------------------------------------------------------------

/** Core OLS on a ready-made deviation series (exported for exact tests).
 *  out[i] is the half-life estimate using the trailing `lookback` pairs up to
 *  index i. The window OLS is RECOMPUTED per bar instead of maintained with
 *  sliding sums: for reverting data the window's second moments can span many
 *  orders of magnitude, and add/remove sliding sums then cancel
 *  catastrophically (the rounding residue of the evicted large terms swamps
 *  the shrunken sum and bends the slope). The exact recompute is
 *  O(bars × lookback) ≈ 100ms for a 120k-bar backtest series — paid once per
 *  dataset in prepareSeries, never per optimizer combo. */
export function halfLifeFromDev(dev: number[], lookback: number = HL_LOOKBACK): Float64Array {
  const m = dev.length
  const out = new Float64Array(m)
  out.fill(Number.NaN)
  for (let i = 1; i < m; i++) {
    const start = Math.max(1, i - lookback + 1)
    let sX = 0
    let sY = 0
    let sXX = 0
    let sXY = 0
    let cnt = 0
    for (let k = start; k <= i; k++) {
      const x = dev[k - 1]
      const y = dev[k] - dev[k - 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      sX += x
      sY += y
      sXX += x * x
      sXY += x * y
      cnt++
    }
    if (cnt < HL_MIN_POINTS) continue
    const denom = cnt * sXX - sX * sX
    // relative collapse guard: an ABSOLUTE cutoff would wrongly NaN series
    // whose deviations are small in price terms (a 1e-6-scale spread is as
    // valid a mean-reversion signal as a 100-point one)
    if (denom > 1e-9 * cnt * sXX) {
      const lambda = (cnt * sXY - sX * sY) / denom
      out[i] = lambda < -1e-9 ? -Math.log(2) / lambda : Number.POSITIVE_INFINITY
    }
  }
  return out
}

/** Half-life series of the deviation close − SMA(smaPeriod). O(n) total. */
export function halfLifeSeries(
  closes: readonly number[],
  lookback: number = HL_LOOKBACK,
  smaPeriod: number = HL_SMA_PERIOD,
): Float64Array {
  const n = closes.length
  const dev = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += closes[i]
    if (i >= smaPeriod) sum -= closes[i - smaPeriod]
    const mean = i + 1 >= smaPeriod ? sum / smaPeriod : Number.NaN
    dev[i] = closes[i] - mean
  }
  return halfLifeFromDev(Array.from(dev), lookback)
}

// ---------------------------------------------------------------------------
// Regime gate (P0 + P1) — one veto function shared by both engines.
// ---------------------------------------------------------------------------

export interface RegimeCfg {
  regimeTrend: boolean // 200-SMA directional gate
  regimeAdx: boolean // ADX < adxMax chop gate
  adxMax: number
  hlGate: boolean // half-life ≤ hlMax bars gate
  hlMax: number
}

export function regimeCfgFromParams(params: Record<string, number>): RegimeCfg {
  return {
    regimeTrend: (params.regimeTrend ?? 0) >= 1,
    regimeAdx: (params.regimeAdx ?? 0) >= 1,
    adxMax: Number.isFinite(params.adxMax) ? params.adxMax : 25,
    hlGate: (params.hlGate ?? 0) >= 1,
    hlMax: Number.isFinite(params.hlMax) ? params.hlMax : 48,
  }
}

export const anyRegimeActive = (c: RegimeCfg): boolean => c.regimeTrend || c.regimeAdx || c.hlGate

/**
 * Veto an ENTRY signal when the regime contradicts it. Returns null when the
 * entry may fire, or a short human reason. Fail-open on NaN inputs.
 *   • trend: LONG only above the 200-SMA, SHORT only below (the classic P0 fix
 *     that stops mean-reversion from fighting a strong trend).
 *   • ADX: only when trend STRENGTH is below adxMax (chop — the MR regime).
 *   • half-life: only when the deviation reverts fast enough (finite, ≤ hlMax).
 */
export function regimeVeto(
  cfg: RegimeCfg,
  side: 'buy' | 'sell',
  close: number,
  trendSma: number | null, // null = insufficient history → fail-open
  adx: number, // NaN = fail-open
  hl: number, // NaN = fail-open · Infinity = trending (veto when gated)
): string | null {
  if (cfg.regimeTrend && trendSma != null && Number.isFinite(trendSma) && trendSma > 0) {
    if (side === 'buy' && !(close > trendSma)) return `below ${REGIME_TREND_SMA}-SMA`
    if (side === 'sell' && !(close < trendSma)) return `above ${REGIME_TREND_SMA}-SMA`
  }
  if (cfg.regimeAdx && Number.isFinite(adx) && adx >= cfg.adxMax) {
    return `trending (ADX ${adx.toFixed(0)} ≥ ${cfg.adxMax})`
  }
  if (cfg.hlGate && (hl === Number.POSITIVE_INFINITY || (Number.isFinite(hl) && hl > cfg.hlMax))) {
    // Infinity is NOT finite — it must be handled explicitly: a deviation
    // with λ ≥ 0 is TRENDING, the strongest possible veto evidence.
    return hl === Number.POSITIVE_INFINITY
      ? 'deviation not mean-reverting (half-life ∞)'
      : `half-life ${hl.toFixed(0)} bars > ${cfg.hlMax}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Wilder ATR% series + baseline — consumed by the backtest's vol-scaled
// slippage: impact scales with the CURRENT bar's ATR% relative to the
// dataset average, clamped to [0.5×, 3×] so a single spike cannot fabricate
// unlimited costs.
// ---------------------------------------------------------------------------

export function atrPctSeries(bars: RegimeBar[], period: number = ATR_PERIOD): { atrPct: Float64Array; base: number } {
  const n = bars.length
  const atrPct = new Float64Array(n)
  atrPct.fill(Number.NaN)
  if (n === 0) return { atrPct, base: 0 }
  let atr = bars[0].high - bars[0].low
  atrPct[0] = atr / bars[0].close
  let sum = atrPct[0]
  let cnt = 1
  for (let i = 1; i < n; i++) {
    const h = bars[i].high
    const l = bars[i].low
    const pc = bars[i - 1].close
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    atr = (atr * (period - 1) + tr) / period
    const v = bars[i].close > 0 ? atr / bars[i].close : Number.NaN
    atrPct[i] = v
    if (Number.isFinite(v)) {
      sum += v
      cnt++
    }
  }
  return { atrPct, base: cnt > 0 ? sum / cnt : 0 }
}

// ---------------------------------------------------------------------------
// Monte Carlo bootstrap (P2) — resample the realized trade sequence with
// replacement to estimate the distribution of the total return and the
// sequence-risk drawdown. Deterministic (seeded) so the UI never flickers.
// ---------------------------------------------------------------------------

export interface MonteCarloResult {
  iters: number
  trades: number
  netPctP5: number
  netPctP50: number
  netPctP95: number
  probLoss: number // share of resamples ending ≤ 0
  maxDDPctP50: number
  maxDDPctP95: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx]
}

/** Returns null when there is not enough trade data (< 10 trades) to mean
 *  anything — the UI then simply hides the block. */
export function monteCarloBootstrap(
  pnls: number[],
  capital: number,
  iters = 1000,
  seed = 20241212,
): MonteCarloResult | null {
  const n = pnls.length
  if (n < 10 || !(capital > 0) || iters < 1) return null
  const rnd = mulberry32(seed)
  const nets: number[] = new Array(iters)
  const dds: number[] = new Array(iters)
  for (let it = 0; it < iters; it++) {
    let eq = capital
    let peak = capital
    let maxDD = 0
    for (let k = 0; k < n; k++) {
      eq += pnls[(rnd() * n) | 0]
      if (eq > peak) peak = eq
      const dd = peak > 0 ? (peak - eq) / peak : 0
      if (dd > maxDD) maxDD = dd
    }
    nets[it] = ((eq - capital) / capital) * 100
    dds[it] = maxDD * 100
  }
  const netsS = [...nets].sort((a, b) => a - b)
  const ddsS = [...dds].sort((a, b) => a - b)
  let losses = 0
  for (const v of nets) if (v <= 0) losses++
  return {
    iters,
    trades: n,
    netPctP5: percentile(netsS, 0.05),
    netPctP50: percentile(netsS, 0.5),
    netPctP95: percentile(netsS, 0.95),
    probLoss: losses / iters,
    maxDDPctP50: percentile(ddsS, 0.5),
    maxDDPctP95: percentile(ddsS, 0.95),
  }
}
