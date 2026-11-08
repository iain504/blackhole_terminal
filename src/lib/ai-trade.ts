// AI Trade — EdgeZero adviser shared types + chart snapshot math.
//
// The EdgeZero endpoint is OpenAI-compatible (chat/completions). All upstream
// calls happen in the backend routes (src/app/api/ai-trade/*) — the browser
// only ever talks to those routes, so the API key stays server-side. This
// file is safe to import from client code: no env reads here (the routes read
// AI_TRADE_BASE_URL / AI_TRADE_API_KEY themselves).

import type { Bar } from '@/lib/market-types'

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
  return {
    symbol,
    timeframe,
    livePrice,
    barCount: win.length,
    lastClose: last,
    changePct: first > 0 ? ((last - first) / first) * 100 : 0,
    high: win.length ? Math.max(...win.map((b) => b.high)) : 0,
    low: win.length ? Math.min(...win.map((b) => b.low)) : 0,
    atrPct: atrPct(win),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes),
    volRatio: volAvg && volAvg > 0 ? vols[vols.length - 1] / volAvg : null,
  }
}

/** Human-readable block pasted into the prompt as grounding data. */
export function snapshotToText(s: ChartSnapshot): string {
  const n = (v: number | null, d = 2, suf = '') =>
    v == null || !Number.isFinite(v) ? 'n/a' : `${v.toFixed(d)}${suf}`
  return [
    `symbol: ${s.symbol} · timeframe: ${s.timeframe}`,
    `bars analysed: ${s.barCount} · live price: ${s.livePrice ?? n(s.lastClose)}`,
    `last close: ${n(s.lastClose, 4)} · window change: ${n(s.changePct)}%`,
    `window high/low: ${n(s.high, 4)} / ${n(s.low, 4)}`,
    `ATR(14): ${n(s.atrPct)}% of price`,
    `SMA20 / SMA50: ${n(s.sma20, 4)} / ${n(s.sma50, 4)}`,
    `RSI(14): ${n(s.rsi14, 1)}`,
    `volume vs 20-bar avg: ${n(s.volRatio)}×`,
  ].join('\n')
}
