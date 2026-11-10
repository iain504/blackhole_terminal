// AI Trade — EdgeZero adviser shared types + chart snapshot math.
//
// The EdgeZero endpoint is OpenAI-compatible (chat/completions). All upstream
// calls happen in the backend routes (src/app/api/ai-trade/*) — the browser
// only ever talks to those routes, so the API key stays server-side. This
// file is safe to import from client code: no env reads here (the routes read
// AI_TRADE_BASE_URL / AI_TRADE_API_KEY themselves).

import type { Bar } from '@/lib/market-types'
import { detectSrLevels } from '@/lib/sr'

/** Models offered by the EdgeZero edge (whitelist — the route rejects others). */
export const AI_TRADE_MODELS = [
  { id: 'edge0-8b', title: 'Edge0 8B · 快', hint: 'fast lane · ~24 tok/s' },
  { id: 'edge0-35b', title: 'Edge0 35B · 深', hint: 'deep lane · ~16 tok/s' },
] as const

export type AiTradeModel = (typeof AI_TRADE_MODELS)[number]['id']

export const AI_TRADE_DEFAULT_MODEL: AiTradeModel = 'edge0-8b'

export function isAiTradeModel(m: unknown): m is AiTradeModel {
  return typeof m === 'string' && AI_TRADE_MODELS.some((x) => x.id === m)
}

// ---- chat wire types (browser ⇔ our route) --------------------------------

export interface AiChatMsg {
  role: 'user' | 'assistant'
  content: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  model?: string
  usage?: { prompt: number; completion: number }
  error?: string
}

export interface AiHealthResponse {
  ok: boolean
  models?: { id: string; title?: string }[]
  error?: string
}

// ---- chart snapshot (browser-side math → text for the prompt) -------------
// The chart popover computes these numbers from the bars ALREADY loaded in the
// chart (barsRef) — no extra market fetches, works offline of the quote lane.

export interface ChartSnapshot {
  symbol: string
  timeframe: string
  livePrice: number | null
  barCount: number
  lastClose: number
  changePct: number // over the analysed window
  high: number
  low: number
  atrPct: number | null // ATR(14) as % of last close
  sma20: number | null
  sma50: number | null
  rsi14: number | null
  volRatio: number | null // last bar volume vs 20-bar average
  // v2.12.19 — the model complained the snapshot lacked MACD-class momentum
  // and volume distribution, and asked for higher-timeframe confirmation.
  macdLine: number | null // EMA12 − EMA26
  macdSignal: number | null // EMA9 of the MACD line
  macdHist: number | null // line − signal
  macdHistRising: boolean | null // histogram expanding (last > previous)
  upDownVolRatio: number | null // up-bar volume ÷ down-bar volume (last 20 bars)
  volTrendPct: number | null // (avg vol last 5 ÷ avg 20 − 1) × 100
  htf: HigherTfContext | null // synthetic 4× timeframe trend context
  // v2.12.32 — WIN-RATE CONTEXT PACK (structure + volatility state): where the
  // price sits inside the window range, the nearest tested S/R levels, and the
  // longer-horizon ATR — stops/targets anchored to STRUCTURE beat arbitrary
  // ATR multiples, and chop/expansion state separates trend trades from
  // mean-reversion coin flips.
  rangePosPct: number | null // 0 = at window low, 100 = at window high
  srSupport: number | null // nearest tested level BELOW the price
  srSupportPct: number | null // distance to it, % (positive = below)
  srSupportTouches: number | null // how many pivot rejections elected it
  srResistance: number | null // nearest tested level ABOVE the price
  srResistancePct: number | null // distance to it, % (positive = above)
  srResistanceTouches: number | null
  atrPct50: number | null // ATR(50) as % of price — compare with atrPct (14)
}

export interface HigherTfContext {
  label: string // e.g. "4×1h"
  barCount: number
  changePct: number
  sma20: number | null
  sma50: number | null
  rsi14: number | null
}

function ema(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  const k = 2 / (n + 1)
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n // SMA seed
  for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k)
  return e
}

/** MACD(12,26,9): returns [line, signal, histogram, histogramRising] on closes. */
function macd(closes: number[]): { line: number | null; signal: number | null; hist: number | null; histRising: boolean | null } {
  const out = { line: null as number | null, signal: null as number | null, hist: null as number | null, histRising: null as boolean | null }
  if (closes.length < 35) return out // 26 + 9 signal history — don't hand-wave it
  const k12 = 2 / 13
  const k26 = 2 / 27
  let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26
  const macdSeries: number[] = []
  macdSeries.push(e12 - e26)
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12)
    e26 = closes[i] * k26 + e26 * (1 - k26)
    macdSeries.push(e12 - e26)
  }
  const sig = ema(macdSeries, 9)
  const line = macdSeries[macdSeries.length - 1]
  out.line = line
  out.signal = sig
  if (sig != null) {
    out.hist = line - sig
    if (macdSeries.length >= 2) {
      const prevLine = macdSeries[macdSeries.length - 2]
      // EMA9 one step back — recompute cheaply instead of storing the series
      const sigPrev = ema(macdSeries.slice(0, -1), 9)
      if (sigPrev != null) out.histRising = line - sig > prevLine - sigPrev
    }
  }
  return out
}

/** Up-bar vs down-bar volume balance + short-vs-average volume trend (last 20 bars). */
function volumeProfile(bars: Bar[]): { upDownRatio: number | null; trendPct: number | null } {
  const win = bars.slice(-20)
  if (win.length < 5) return { upDownRatio: null, trendPct: null }
  let up = 0
  let down = 0
  for (const b of win) {
    const v = Number.isFinite(b.volume) ? b.volume : 0
    if (b.close >= b.open) up += v
    else down += v
  }
  const avgN = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const vols = win.map((b) => (Number.isFinite(b.volume) ? b.volume : 0))
  const avgAll = avgN(vols)
  const avgLast5 = avgN(vols.slice(-5))
  return {
    upDownRatio: down > 0 ? up / down : up > 0 ? Infinity : null,
    trendPct: avgAll > 0 ? ((avgLast5 / avgAll - 1) * 100) : null,
  }
}

/** Aggregate bars into synthetic 4× timeframe OHLCV (trend context, not trade-grade data). */
function aggregateBars(bars: Bar[], factor = 4): Bar[] {
  const out: Bar[] = []
  const src = bars.slice(-factor * 60) // → up to 60 synthetic bars
  for (let i = src.length % factor; i + factor <= src.length; i += factor) {
    const g = src.slice(i, i + factor)
    out.push({
      time: g[0].time,
      open: g[0].open,
      high: Math.max(...g.map((b) => b.high)),
      low: Math.min(...g.map((b) => b.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((a, b) => a + (Number.isFinite(b.volume) ? b.volume : 0), 0),
    })
  }
  return out
}

function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  let s = 0
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i]
  return s / n
}

/** Wilder RSI on the close series (classic smoothing, last value). */
function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgG = gain / n
  let avgL = loss / n
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgG = (avgG * (n - 1) + Math.max(d, 0)) / n
    avgL = (avgL * (n - 1) + Math.max(-d, 0)) / n
  }
  if (avgL === 0) return 100
  const rs = avgG / avgL
  return 100 - 100 / (1 + rs)
}

/** Average true range (simple average of the last n TRs) as % of price. */
function atrPct(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null
  let s = 0
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]
    const pc = bars[i - 1].close
    s += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  }
  const atr = s / n
  const last = bars[bars.length - 1].close
  return last > 0 ? (atr / last) * 100 : null
}

export const CHART_WINDOW = 120 // bars analysed in the snapshot

export function buildChartSnapshot(
  bars: Bar[],
  symbol: string,
  timeframe: string,
  livePrice: number | null,
): ChartSnapshot {
  const win = bars.slice(-CHART_WINDOW)
  const closes = win.map((b) => b.close)
  const last = closes[closes.length - 1] ?? 0
  const first = closes[0] ?? last
  const vols = win.map((b) => (Number.isFinite(b.volume) ? b.volume : 0))
  const volAvg = sma(vols, 20)
  const m = macd(closes)
  const vp = volumeProfile(win)
  // higher-TF trend context: aggregate the loaded bars into a synthetic 4× TF
  const htfBars = bars.length >= 40 ? aggregateBars(bars) : []
  const htfCloses = htfBars.map((b) => b.close)
  const htf: HigherTfContext | null = htfBars.length >= 20
    ? {
        label: `4×${timeframe}`,
        barCount: htfBars.length,
        changePct: htfCloses[0] > 0 ? ((htfCloses[htfCloses.length - 1] - htfCloses[0]) / htfCloses[0]) * 100 : 0,
        sma20: sma(htfCloses, 20),
        sma50: sma(htfCloses, 50),
        rsi14: rsi(htfCloses),
      }
    : null
  // v2.12.32 — structure + volatility context
  const wHigh = win.length ? Math.max(...win.map((b) => b.high)) : 0
  const wLow = win.length ? Math.min(...win.map((b) => b.low)) : 0
  const rangePosPct = wHigh > wLow ? ((last - wLow) / (wHigh - wLow)) * 100 : null
  // pivot S/R on the analysed window (minTouches 2 — 120 bars don't always
  // elect 3-touch walls, and a 2-touch level is still real structure)
  const ref = livePrice ?? last
  const levels = win.length >= 15
    ? detectSrLevels(
        win.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })),
        { minTouches: 2, maxLevels: 6, pivotWindow: 5, refPrice: ref },
      )
    : []
  const sup = levels.filter((l) => l.side === 'support').sort((a, b) => b.price - a.price)[0] ?? null
  const res = levels.filter((l) => l.side === 'resistance').sort((a, b) => a.price - b.price)[0] ?? null
  return {
    symbol,
    timeframe,
    livePrice,
    barCount: win.length,
    lastClose: last,
    changePct: first > 0 ? ((last - first) / first) * 100 : 0,
    high: wHigh,
    low: wLow,
    atrPct: atrPct(win),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes),
    volRatio: volAvg && volAvg > 0 ? vols[vols.length - 1] / volAvg : null,
    macdLine: m.line,
    macdSignal: m.signal,
    macdHist: m.hist,
    macdHistRising: m.histRising,
    upDownVolRatio: vp.upDownRatio,
    volTrendPct: vp.trendPct,
    htf,
    rangePosPct,
    srSupport: sup?.price ?? null,
    srSupportPct: sup && ref > 0 ? ((ref - sup.price) / ref) * 100 : null,
    srSupportTouches: sup?.touches ?? null,
    srResistance: res?.price ?? null,
    srResistancePct: res && ref > 0 ? ((res.price - ref) / ref) * 100 : null,
    srResistanceTouches: res?.touches ?? null,
    atrPct50: atrPct(win, 50),
  }
}

/** Human-readable block pasted into the prompt as grounding data. */
export function snapshotToText(s: ChartSnapshot): string {
  const n = (v: number | null, d = 2, suf = '') =>
    v == null || !Number.isFinite(v) ? 'n/a' : `${v.toFixed(d)}${suf}`
  const lines = [
    `symbol: ${s.symbol} · timeframe: ${s.timeframe}`,
    `bars analysed: ${s.barCount} · live price: ${s.livePrice ?? n(s.lastClose)}`,
    `last close: ${n(s.lastClose, 4)} · window change: ${n(s.changePct)}%`,
    `window high/low: ${n(s.high, 4)} / ${n(s.low, 4)} · position in range: ${s.rangePosPct == null ? 'n/a' : `${n(s.rangePosPct, 0)}%`}`,
    `ATR(14): ${n(s.atrPct)}% of price${s.atrPct50 != null && s.atrPct != null ? (s.atrPct > s.atrPct50 ? ' (vol EXPANDING vs ATR50 ' + n(s.atrPct50) + '%)' : s.atrPct < s.atrPct50 * 0.8 ? ` (vol contracting vs ATR50 ${n(s.atrPct50)}%)` : ` (vs ATR50 ${n(s.atrPct50)}%)`) : ''}`,
    `SMA20 / SMA50: ${n(s.sma20, 4)} / ${n(s.sma50, 4)}`,
    `RSI(14): ${n(s.rsi14, 1)}`,
    `MACD(12,26,9): line ${n(s.macdLine, 4)} · signal ${n(s.macdSignal, 4)} · histogram ${n(s.macdHist, 4)}${s.macdHistRising == null ? '' : s.macdHistRising ? ' (hist expanding)' : ' (hist contracting)'}`,
    `volume: last vs 20-avg ${n(s.volRatio)}× · up/down-bar volume ${s.upDownVolRatio == null ? 'n/a' : s.upDownVolRatio === Infinity ? 'all up' : n(s.upDownVolRatio)} · 5-bar vs 20-avg trend ${s.volTrendPct == null ? 'n/a' : `${n(s.volTrendPct)}%`}`,
    `nearest S/R: support ${n(s.srSupport, 4)} (${n(s.srSupportPct)}% below, ${s.srSupportTouches ?? 'n/a'} touches) · resistance ${n(s.srResistance, 4)} (${n(s.srResistancePct)}% above, ${s.srResistanceTouches ?? 'n/a'} touches)`,
  ]
  if (s.htf) {
    lines.push(
      `higher-TF trend context (${s.htf.label} synthetic bars, ${s.htf.barCount}): change ${n(s.htf.changePct)}% · SMA20/SMA50 ${n(s.htf.sma20, 4)}/${n(s.htf.sma50, 4)}${s.htf.sma20 != null && s.htf.sma50 != null ? (s.htf.sma20 > s.htf.sma50 ? ' (above)' : ' (below)') : ''} · RSI(14) ${n(s.htf.rsi14, 1)}`,
    )
  }
  return lines.join('\n')
}
