// Binance public REST API client (server-side only).
// FREE, no API key required — used as the PRIMARY source for crypto quotes and
// bars so charts, watchlists, the heatmap and the landing tickers show REAL
// crypto data even for visitors who have not saved their Alpaca API keys yet.
// Falls back to Alpaca crypto (if keys exist) and finally the demo simulator.
import { Bar, Quote, Timeframe, TIMEFRAMES } from './market-types'

// Primary REST host + public market-data mirror. api.binance.com intermittently
// answers HTTP 418/429 (IP rate-limit waves in datacenter ranges) — the mirror
// `data-api.binance.vision` serves the SAME public market-data paths with laxer
// limits, so every request falls over to it before giving up.
const BASES = ['https://api.binance.com', 'https://data-api.binance.vision']
const TIMEOUT_MS = 6000
// sticky working base (short TTL so the primary is re-tried periodically)
let activeBase = BASES[0]
let activeBaseAt = 0
const BASE_STICKY_MS = 10 * 60 * 1000
/** Circuit-breaker gate (see binanceFetch): while set, all Binance calls no-op. */
let binanceBannedUntil = 0

/** 'BTC/USD' -> 'BTCUSDT' (Binance quotes USD pairs as USDT), 'ETH/EUR' -> 'ETHEUR'. */
export function toBinanceSymbol(symbol: string): string | null {
  const m = /^([A-Z0-9]{2,10})\/([A-Z]{2,6})$/.exec(symbol)
  if (!m) return null
  const quote = m[2] === 'USD' ? 'USDT' : m[2]
  return `${m[1]}${quote}`
}

async function binanceFetch<T>(path: string): Promise<T | null> {
  // Circuit breaker: Binance responds 418 (IP auto-ban) / 429 (weight limit)
  // when we poll too fast — retrying every 15s per open chart KEEPS the ban
  // alive. After a ban signal, go quiet for 5 minutes (quotes fall back to
  // Alpaca snapshots; charts fall back to Alpaca bars) instead of hammering.
  if (Date.now() < binanceBannedUntil) return null
  // start from the sticky base (re-try the primary every 10min) and fall over
  // to the remaining bases on rate-limit / hard errors
  const bases = Date.now() - activeBaseAt < BASE_STICKY_MS
    ? [activeBase, ...BASES.filter((b) => b !== activeBase)]
    : [...BASES]
  for (const base of bases) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${base}${path}`, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        // 4xx that won't change with another host (bad symbol etc.) — stop early
        console.error(`Binance ${base}${path} -> HTTP ${res.status}`)
        if (res.status === 418 || res.status === 429) binanceBannedUntil = Date.now() + 5 * 60_000
        if (res.status >= 400 && res.status < 500 && res.status !== 418 && res.status !== 429) return null
        continue
      }
      const data = (await res.json()) as T
      activeBase = base
      activeBaseAt = Date.now()
      return data
    } catch (e) {
      console.error(`Binance ${base}${path} failed:`, e instanceof Error ? e.message : e)
      continue
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

// ---------------- in-memory caches (shared per server instance) -------------

interface CacheEntry<T> {
  at: number
  data: T
}
const QUOTE_TTL_MS = 5_000
const BARS_TTL_MS = 15_000
const quoteCache = new Map<string, CacheEntry<Quote[]>>()
const barsCache = new Map<string, CacheEntry<Bar[] | null>>()

// ------------------------------ 24h tickers ---------------------------------

interface BinanceTicker {
  symbol: string
  lastPrice: string
  priceChange: string
  priceChangePercent: string
  openPrice: string
  highPrice: string
  lowPrice: string
  volume: string
  closeTime: number
}

const num = (v: string | undefined): number => (v == null ? 0 : Number.parseFloat(v) || 0)

/**
 * Batch crypto quotes from Binance's free /api/v3/ticker/24hr endpoint.
 * Returns quotes only for symbols that resolved (missing ones fall through to
 * the caller's Alpaca/demo path). Cached 5s to absorb polling bursts.
 */
export async function getBinanceQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return []
  const cacheKey = [...symbols].sort().join(',')
  const hit = quoteCache.get(cacheKey)
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.data

  const pairs = symbols.map(toBinanceSymbol)
  const valid = pairs.filter((p): p is string => p != null)
  if (valid.length === 0) return []

  // Binance expects a URL-encoded JSON array for multi-symbol requests; chunk
  // to keep the query string comfortably short.
  const out: Quote[] = []
  for (let i = 0; i < valid.length; i += 25) {
    const chunk = valid.slice(i, i + 25)
    const data = await binanceFetch<BinanceTicker[]>(
      `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(chunk))}`,
    )
    if (!data) continue
    const byPair = new Map(data.map((t) => [t.symbol, t]))
    symbols.forEach((sym, si) => {
      const pair = pairs[si]
      if (!pair) return
      const t = byPair.get(pair)
      if (!t) return
      const price = num(t.lastPrice)
      const change = num(t.priceChange)
      const prevClose = price - change
      out.push({
        symbol: sym,
        price,
        change,
        changePct: num(t.priceChangePercent),
        open: num(t.openPrice) || prevClose,
        high: Math.max(num(t.highPrice), price),
        low: Math.min(num(t.lowPrice), price) || price,
        prevClose: prevClose || num(t.openPrice),
        volume: num(t.volume),
        ts: Math.floor((t.closeTime || Date.now()) / 1000),
      })
    })
  }
  quoteCache.set(cacheKey, { at: Date.now(), data: out })
  return out
}

// ------------------------------- klines (bars) ------------------------------

/** Our timeframe -> Binance kline interval (1M means MONTHLY on Binance). */
const KLINE_INTERVAL: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1W': '1w',
  '1M': '1M',
}

type Kline = [number, string, string, string, string, string, ...unknown[]]

/**
 * OHLCV bars from Binance's free /api/v3/klines endpoint (limit max 1000 —
 * every configured barCount fits). Returns [] when Binance is unreachable.
 * `endTimeMs` (optional) fetches the chunk of klines ENDING just before that
 * instant — powers the chart's scroll-back pagination (older history).
 * Cached 15s keyed by symbol+tf(+endTime) (multi-pane grids poll this a lot).
 */
export async function getBinanceBars(symbol: string, timeframe: Timeframe, endTimeMs?: number, lookbackDays?: number): Promise<Bar[]> {
  const pair = toBinanceSymbol(symbol)
  if (!pair) return []
  const tf = TIMEFRAMES[timeframe]
  // lookbackDays (S/R analyzer) pages BACKWARD through klines up to 10k bars;
  // the default stays a single most-recent 1000-bar page (chart scroll-back)
  const target = lookbackDays != null
    ? Math.min(Math.max(1, Math.ceil((lookbackDays * 86400) / tf.seconds)), 10000)
    : 1000
  const cacheKey = lookbackDays != null
    ? `${symbol}|${timeframe}|lb${lookbackDays}`
    : endTimeMs ? `${symbol}|${timeframe}|b${endTimeMs}` : `${symbol}|${timeframe}`
  const hit = barsCache.get(cacheKey)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.data ?? []

  const mapKlines = (data: Kline[]): Bar[] =>
    data.map((k) => ({
      time: Math.floor(k[0] / 1000), // kline open time (ms) -> seconds
      open: num(k[1] as string),
      high: num(k[2] as string),
      low: num(k[3] as string),
      close: num(k[4] as string),
      volume: num(k[5] as string),
    }))

  let acc: Bar[] = []
  // endTime is inclusive on kline OPEN time — subtract 1ms so the candle that
  // opens exactly at `end` (already on the chart / previous page) is excluded.
  let end = endTimeMs != null ? endTimeMs - 1 : undefined
  const maxPages = lookbackDays != null ? 12 : 1
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ symbol: pair, interval: KLINE_INTERVAL[timeframe], limit: '1000' })
    if (end != null) q.set('endTime', String(end))
    const data = await binanceFetch<Kline[]>(`/api/v3/klines?${q.toString()}`)
    if (!data || !Array.isArray(data) || data.length === 0) break
    const bars = mapKlines(data)
    acc = [...bars, ...acc] // each page is OLDER — prepend
    if (acc.length >= target || data.length < 1000) break // enough / history exhausted
    end = bars[0].time * 1000 // next page ends strictly before the oldest bar
  }
  if (acc.length === 0) {
    barsCache.set(cacheKey, { at: Date.now(), data: null })
    return []
  }
  const seen = new Set<number>()
  const clean = acc
    .filter((b) => b.close > 0)
    .filter((b) => {
      if (seen.has(b.time)) return false
      seen.add(b.time)
      return true
    })
    .sort((a, b) => a.time - b.time)
  barsCache.set(cacheKey, { at: Date.now(), data: clean })
  // endTime-keyed entries accumulate as the user scrolls back — prune stale ones
  if (barsCache.size > 64) {
    const now = Date.now()
    for (const [k, v] of barsCache) {
      if (now - v.at > BARS_TTL_MS) barsCache.delete(k)
    }
  }
  return clean
}
