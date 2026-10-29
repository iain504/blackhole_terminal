// Technical indicators for the chart — pure functions, no dependencies.
//
// All functions take an array of bars (chronological) and return arrays
// ALIGNED with the input (null during the warm-up window), so points map
// 1:1 onto chart series data ({ time, value }).

export interface BarInput {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface LinePoint {
  time: number
  value: number
}

export interface IndicatorSettings {
  vwap: { enabled: boolean }
  sma: { enabled: boolean; period: number }
  ema: { enabled: boolean; period: number }
  bb: { enabled: boolean; period: number; mult: number }
  rsi: { enabled: boolean; period: number }
  macd: { enabled: boolean; fast: number; slow: number; signal: number }
}

// VWAP defaults ON — the day-trading community's #1 intraday tool (trend
// filter: long above / short below; dynamic support/resistance).
export const DEFAULT_INDICATORS: IndicatorSettings = {
  vwap: { enabled: true },
  sma: { enabled: true, period: 20 },
  ema: { enabled: true, period: 50 },
  bb: { enabled: false, period: 20, mult: 2 },
  rsi: { enabled: false, period: 14 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
}

const clampInt = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)))

/** Validate + clamp a (possibly corrupt / stale localStorage) settings object. */
export function normalizeIndicators(raw: unknown): IndicatorSettings {
  const d = DEFAULT_INDICATORS
  const o = (raw ?? {}) as Partial<IndicatorSettings>
  return {
    vwap: {
      enabled: Boolean(o.vwap?.enabled ?? d.vwap.enabled),
    },
    sma: {
      enabled: Boolean(o.sma?.enabled ?? d.sma.enabled),
      period: clampInt(o.sma?.period ?? d.sma.period, 2, 500),
    },
    ema: {
      enabled: Boolean(o.ema?.enabled ?? d.ema.enabled),
      period: clampInt(o.ema?.period ?? d.ema.period, 2, 500),
    },
    bb: {
      enabled: Boolean(o.bb?.enabled ?? d.bb.enabled),
      period: clampInt(o.bb?.period ?? d.bb.period, 2, 500),
      mult: Math.min(10, Math.max(0.5, Number(o.bb?.mult ?? d.bb.mult) || d.bb.mult)),
    },
    rsi: {
      enabled: Boolean(o.rsi?.enabled ?? d.rsi.enabled),
      period: clampInt(o.rsi?.period ?? d.rsi.period, 2, 200),
    },
    macd: {
      enabled: Boolean(o.macd?.enabled ?? d.macd.enabled),
      fast: clampInt(o.macd?.fast ?? d.macd.fast, 1, 200),
      slow: clampInt(o.macd?.slow ?? d.macd.slow, 2, 400),
      signal: clampInt(o.macd?.signal ?? d.macd.signal, 1, 200),
    },
  }
}

const LS_KEY = 'tt.indicators.v1'

export function loadIndicators(): IndicatorSettings {
  if (typeof window === 'undefined') return DEFAULT_INDICATORS
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_INDICATORS
    return normalizeIndicators(JSON.parse(raw))
  } catch {
    return DEFAULT_INDICATORS
  }
}

export function saveIndicators(s: IndicatorSettings) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch { /* private mode etc. */ }
}

// ------------------------------- core math ---------------------------------

/** Simple moving average. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (period < 1) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (period < 1 || values.length < period) return out
  const k = 2 / (period + 1)
  let prev = 0
  for (let i = 0; i < period; i++) prev += values[i]
  prev /= period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/**
 * Bollinger bands: SMA(mid) ± mult × population standard deviation of the
 * same window (TradingView's default "stdev" basis).
 */
export function bollinger(
  values: number[],
  period: number,
  mult: number,
): { upper: (number | null)[]; mid: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(values, period)
  const upper: (number | null)[] = new Array(values.length).fill(null)
  const lower: (number | null)[] = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]
    if (m == null) continue
    let acc = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - m
      acc += d * d
    }
    const sd = Math.sqrt(acc / period)
    upper[i] = m + mult * sd
    lower[i] = m - mult * sd
  }
  return { upper, mid, lower }
}

/**
 * Relative Strength Index with Wilder's smoothing.
 * First value at index `period` (needs `period` deltas).
 */
export function rsi(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (period < 1 || closes.length <= period) return out
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) avgGain += d
    else avgLoss -= d
  }
  avgGain /= period
  avgLoss /= period
  const write = (i: number) => {
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  write(period)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    write(i)
  }
  return out
}

export interface MacdResult {
  macd: (number | null)[]
  signal: (number | null)[]
  hist: (number | null)[]
}

/** MACD line (EMA fast − EMA slow), signal line (EMA of MACD), histogram. */
export function macd(closes: number[], fast: number, slow: number, signal: number): MacdResult {
  const n = closes.length
  const macdLine: (number | null)[] = new Array(n).fill(null)
  const sig: (number | null)[] = new Array(n).fill(null)
  const hist: (number | null)[] = new Array(n).fill(null)
  if (fast < 1 || slow <= fast || signal < 1 || n < slow + signal - 1) return { macd: macdLine, signal: sig, hist }
  const ef = ema(closes, fast)
  const es = ema(closes, slow)
  // compacted MACD values (start where both EMAs exist = index slow-1)
  const start = slow - 1
  const compacted: number[] = []
  for (let i = start; i < n; i++) {
    const f = ef[i]
    const s = es[i]
    if (f != null && s != null) {
      macdLine[i] = f - s
      compacted.push(f - s)
    }
  }
  const sigE = ema(compacted, signal)
  for (let j = 0; j < sigE.length; j++) {
    const v = sigE[j]
    if (v != null) {
      const idx = start + j
      sig[idx] = v
      const m = macdLine[idx]
      if (m != null) hist[idx] = m - v
    }
  }
  return { macd: macdLine, signal: sig, hist }
}

/**
 * Wilder ATR series (v1.96.0) — aligned with the input (null during warm-up),
 * same seeding convention as dayplan.atrWilder: seed = simple mean of the
 * first `period` true ranges, then Wilder smoothing ATR = (prev×(p−1)+TR)/p.
 * True Range = max(high−low, |high−prevClose|, |low−prevClose|).
 */
export function atrSeries(bars: BarInput[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  if (period < 1 || bars.length <= period) return out
  let atr = 0
  let prevClose = bars[0].close
  for (let i = 1; i <= period; i++) {
    const b = bars[i]
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
    atr += tr
    prevClose = b.close
  }
  atr /= period
  out[period] = Number.isFinite(atr) && atr > 0 ? atr : null
  for (let i = period + 1; i < bars.length; i++) {
    const b = bars[i]
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
    atr = (atr * (period - 1) + tr) / period
    prevClose = b.close
    out[i] = Number.isFinite(atr) && atr > 0 ? atr : null
  }
  return out
}

/** Latest Wilder ATR value over `bars` (null when the series has no warm-up). */
export function computeAtr(bars: BarInput[], period = 14): number | null {
  const s = atrSeries(bars, period)
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i]
    if (v != null) return v
  }
  return null
}

// --------------------------- chart-facing helpers ---------------------------

const zip = (bars: BarInput[], vals: (number | null)[]): LinePoint[] => {
  const out: LinePoint[] = []
  for (let i = 0; i < bars.length; i++) {
    const v = vals[i]
    if (v != null && Number.isFinite(v)) out.push({ time: bars[i].time, value: v })
  }
  return out
}

export interface OverlaySeries {
  vwap?: LinePoint[]
  sma?: LinePoint[]
  ema?: LinePoint[]
  bbUpper?: LinePoint[]
  bbMid?: LinePoint[]
  bbLower?: LinePoint[]
}

/**
 * Session-anchored VWAP (volume-weighted average price): cumulative
 * Σ(typicalPrice×volume) / Σ(volume), RESET at each session boundary so it
 * matches the platform-standard "daily VWAP" day traders trade against.
 * Session = UTC calendar day of the bar time: stocks from Alpaca are regular
 * hours only (one RTH session per UTC date), crypto trades a UTC day.
 */
export function computeVwap(bars: BarInput[]): LinePoint[] {
  const out: LinePoint[] = []
  let day = ''
  let cumPV = 0
  let cumV = 0
  for (const b of bars) {
    const d = new Date(b.time * 1000).toISOString().slice(0, 10)
    if (d !== day) {
      day = d
      cumPV = 0
      cumV = 0
    }
    const v = b.volume > 0 ? b.volume : 0
    cumPV += ((b.high + b.low + b.close) / 3) * v
    cumV += v
    if (cumV > 0) out.push({ time: b.time, value: cumPV / cumV })
  }
  return out
}

/** Price-chart overlay indicators (SMA / EMA / Bollinger). */
export function computeOverlays(bars: BarInput[], s: IndicatorSettings): OverlaySeries {
  const closes = bars.map((b) => b.close)
  const out: OverlaySeries = {}
  if (s.vwap.enabled) out.vwap = computeVwap(bars)
  if (s.sma.enabled) out.sma = zip(bars, sma(closes, s.sma.period))
  if (s.ema.enabled) out.ema = zip(bars, ema(closes, s.ema.period))
  if (s.bb.enabled) {
    const bb = bollinger(closes, s.bb.period, s.bb.mult)
    out.bbUpper = zip(bars, bb.upper)
    out.bbMid = zip(bars, bb.mid)
    out.bbLower = zip(bars, bb.lower)
  }
  return out
}

/** RSI oscillator points (0-100). */
export function computeRsi(bars: BarInput[], period: number): LinePoint[] {
  return zip(bars, rsi(bars.map((b) => b.close), period))
}

export interface MacdPoints {
  macd: LinePoint[]
  signal: LinePoint[]
  hist: { time: number; value: number; rising: boolean }[]
}

/** MACD oscillator points. `rising` colors the histogram bar. */
export function computeMacd(bars: BarInput[], fast: number, slow: number, signal: number): MacdPoints {
  const m = macd(bars.map((b) => b.close), fast, slow, signal)
  const hist: MacdPoints['hist'] = []
  for (let i = 0; i < bars.length; i++) {
    const v = m.hist[i]
    if (v == null || !Number.isFinite(v)) continue
    const prev = i > 0 ? m.hist[i - 1] : null
    hist.push({ time: bars[i].time, value: v, rising: prev != null ? v >= prev : v >= 0 })
  }
  return { macd: zip(bars, m.macd), signal: zip(bars, m.signal), hist }
}

/**
 * Bottom-strip layout for the oscillator panes (lightweight-charts v4 has no
 * real multi-pane support — oscillators are separate price scales squeezed
 * into stacked strips at the bottom of the pane). Stacked top→bottom:
 * price · volume · RSI · MACD.
 */
export interface StripMargins {
  price: { top: number; bottom: number }
  vol: { top: number; bottom: number }
  rsi?: { top: number; bottom: number }
  macd?: { top: number; bottom: number }
}

const VOL_H = 0.18
const OSC_H = 0.2

export function stripMargins(hasRsi: boolean, hasMacd: boolean): StripMargins {
  let used = 0
  const out: StripMargins = { price: { top: 0.1, bottom: 0 }, vol: { top: 0, bottom: 0 } }
  if (hasMacd) {
    out.macd = { top: 1 - used - OSC_H, bottom: used }
    used += OSC_H
  }
  if (hasRsi) {
    out.rsi = { top: 1 - used - OSC_H, bottom: used }
    used += OSC_H
  }
  out.vol = { top: 1 - used - VOL_H, bottom: used }
  out.price = { top: 0.1, bottom: used + VOL_H }
  return out
}

/** How many tail bars each enabled indicator needs (for tick updates). */
export function indicatorsActive(s: IndicatorSettings): number {
  let n = 0
  if (s.vwap.enabled) n++
  if (s.sma.enabled) n++
  if (s.ema.enabled) n++
  if (s.bb.enabled) n++
  if (s.rsi.enabled) n++
  if (s.macd.enabled) n++
  return n
}
