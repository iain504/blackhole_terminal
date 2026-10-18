// Binance public REST API client (server-side only).
// FREE, no API key required — used as the PRIMARY source for crypto quotes and
// bars so charts, watchlists, the heatmap and the landing tickers show REAL
// crypto data even for visitors who have not saved their Alpaca API keys yet.
// Falls back to Alpaca crypto (if keys exist) and finally the demo simulator.
import { Bar, Quote, Timeframe, TIMEFRAMES } from './market-types'

const BASE = 'https://api.binance.com'
const TIMEOUT_MS = 6000

/** 'BTC/USD' -> 'BTCUSDT' (Binance quotes USD pairs as USDT), 'ETH/EUR' -> 'ETHEUR'. */
export function toBinanceSymbol(symbol: string): string | null {
  const m = /^([A-Z0-9]{2,10})\/([A-Z]{2,6})$/.exec(symbol)
  if (!m) return null
  const quote = m[2] === 'USD' ? 'USDT' : m[2]
  return `${m[1]}${quote}`
}

async function binanceFetch<T>(path: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      console.error(`Binance ${path} -> HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    console.error(`Binance ${path} failed:`, e instanceof Error ? e.message : e)
    return null
  } finally {
    clearTimeout(timer)
  }
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
export async function getBinanceBars(symbol: string, timeframe: Timeframe, endTimeMs?: number): Promise<Bar[]> {
  const cacheKey = endTimeMs ? `${symbol}|${timeframe}|b${endTimeMs}` : `${symbol}|${timeframe}`
  const hit = barsCache.get(cacheKey)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.data ?? []

  const pair = toBinanceSymbol(symbol)
  if (!pair) return []
  const tf = TIMEFRAMES[timeframe]
  const q = new URLSearchParams({
    symbol: pair,
    interval: KLINE_INTERVAL[timeframe],
    limit: '1000',
  })
  // Binance endTime is inclusive on kline OPEN time; subtract 1ms so the
  // candle that opens exactly at `endTimeMs` (already on the chart) is excluded.
  if (endTimeMs != null) q.set('endTime', String(endTimeMs - 1))
  const data = await binanceFetch<Kline[]>(`/api/v3/klines?${q.toString()}`)
  if (!data || !Array.isArray(data)) {
    barsCache.set(cacheKey, { at: Date.now(), data: null })
    return []
  }
  const bars: Bar[] = data.map((k) => ({
    time: Math.floor(k[0] / 1000), // kline open time (ms) -> seconds
    open: num(k[1] as string),
    high: num(k[2] as string),
    low: num(k[3] as string),
    close: num(k[4] as string),
    volume: num(k[5] as string),
  }))
  const clean = bars.filter((b) => b.close > 0)
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
