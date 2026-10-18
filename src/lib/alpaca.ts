// Alpaca market data client (server-side only).
// Stocks use v2/stocks/*; Crypto uses the DIFFERENT v1beta3/crypto/us/* API.
// When no API keys exist (env or per-user), all functions fall back to the
// deterministic demo simulator so the app always works.
import { db } from '@/lib/db'
import { decrypt } from '@/lib/crypt'
import {
  Bar, Quote, NewsItem, MarkerData, Timeframe, TIMEFRAMES,
  isCryptoSymbol,
} from './market-types'
import { simBars, simQuote, simNews, simMarkers } from './simulator'

const DATA_BASE = 'https://data.alpaca.markets'
const ALPACA_TIMEOUT_MS = 9000

export interface AlpacaKeys {
  keyId: string
  secret: string
}

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
}

export async function getAlpacaKeys(userId?: string): Promise<AlpacaKeys | null> {
  if (userId) {
    const user = await db.user.findUnique({ where: { id: userId } })
    const settings = (user?.settings as UserSettings | null) || null
    if (settings?.alpacaKeyIdEnc && settings?.alpacaSecretEnc) {
      const keyId = decrypt(settings.alpacaKeyIdEnc)
      const secret = decrypt(settings.alpacaSecretEnc)
      if (keyId && secret) return { keyId, secret }
    }
  }
  const envId = process.env.APCA_API_KEY_ID
  const envSecret = process.env.APCA_API_SECRET_KEY
  if (envId && envSecret) return { keyId: envId, secret: envSecret }
  return null
}

export async function hasAlpacaKeys(userId?: string): Promise<boolean> {
  return (await getAlpacaKeys(userId)) !== null
}

async function alpacaFetch<T>(path: string, keys: AlpacaKeys): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALPACA_TIMEOUT_MS)
  try {
    const res = await fetch(`${DATA_BASE}${path}`, {
      headers: {
        'APCA-API-KEY-ID': keys.keyId,
        'APCA-API-SECRET-KEY': keys.secret,
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error(`Alpaca ${path} -> HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    console.error(`Alpaca ${path} failed:`, e instanceof Error ? e.message : e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------- Bars ----------

interface AlpacaBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

function mapBars(raw: AlpacaBar[] | undefined): Bar[] {
  if (!raw) return []
  return raw.map((b) => ({
    time: Math.floor(new Date(b.t).getTime() / 1000),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }))
}

/** Aggregate daily bars into weekly (Mon-anchored) or monthly buckets (crypto API lacks 1W/1M). */
function aggregateDaily(bars: Bar[], timeframe: '1W' | '1M'): Bar[] {
  const groups = new Map<string, Bar[]>()
  for (const b of bars) {
    const d = new Date(b.time * 1000)
    let key: string
    if (timeframe === '1W') {
      const day = (d.getUTCDay() + 6) % 7 // Mon=0
      const monday = new Date(d)
      monday.setUTCDate(d.getUTCDate() - day)
      key = monday.toISOString().slice(0, 10)
    } else {
      key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    }
    const arr = groups.get(key)
    if (arr) arr.push(b)
    else groups.set(key, [b])
  }
  const out: Bar[] = []
  for (const [, arr] of groups) {
    const first = arr[0]
    const last = arr[arr.length - 1]
    out.push({
      time: first.time,
      open: first.open,
      high: Math.max(...arr.map((b) => b.high)),
      low: Math.min(...arr.map((b) => b.low)),
      close: last.close,
      volume: arr.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

export async function getBars(
  symbol: string,
  timeframe: Timeframe,
  userId?: string,
): Promise<{ bars: Bar[]; demo: boolean }> {
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return { bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount), demo: true }
  }
  const tf = TIMEFRAMES[timeframe]
  const end = new Date()
  const start = new Date(end.getTime() - tf.barCount * tf.seconds * 1000)
  const startIso = start.toISOString().slice(0, 19) + 'Z'
  const endIso = end.toISOString().slice(0, 19) + 'Z'

  if (isCryptoSymbol(symbol)) {
    // Crypto API: v1beta3 — supports up to 1Day; aggregate 1W/1M from daily.
    const cryptoTf = timeframe === '1W' || timeframe === '1M' ? '1Day' : tf.alpaca
    const lookback = timeframe === '1W' || timeframe === '1M'
      ? Math.ceil(tf.barCount * 7 * tf.seconds / 86400) + 20
      : tf.barCount
    const s = new Date(Date.now() - lookback * 86400 * 1000).toISOString().slice(0, 19) + 'Z'
    const raw = await alpacaFetch<{ bars: Record<string, AlpacaBar[]> }>(
      `/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${cryptoTf}&start=${s}&end=${endIso}&limit=10000`,
      keys,
    )
    let bars = mapBars(raw?.bars?.[symbol])
    if (bars.length === 0) {
      return { bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount), demo: true }
    }
    if (timeframe === '1W' || timeframe === '1M') bars = aggregateDaily(bars, timeframe)
    return { bars, demo: false }
  }

  // Stocks API: v2/stocks/bars
  const raw = await alpacaFetch<{ bars: Record<string, AlpacaBar[]> }>(
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${tf.alpaca}&start=${startIso}&end=${endIso}` +
    `&limit=${Math.min(tf.barCount + 50, 10000)}&adjustment=splits&feed=iex`,
    keys,
  )
  const bars = mapBars(raw?.bars?.[symbol])
  if (bars.length === 0) {
    return { bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount), demo: true }
  }
  return { bars, demo: false }
}

// ---------- Quotes / Snapshots ----------

interface StockSnapshot {
  latestTrade?: { p: number; t: string }
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
  prevDailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
}
interface CryptoSnapshot {
  latestTrade?: { p: number; t: string }
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
  prevDailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
}

function snapshotToQuote(symbol: string, snap: StockSnapshot | CryptoSnapshot | undefined): Quote | null {
  if (!snap) return null
  const price = snap.latestTrade?.p ?? snap.dailyBar?.c
  const prevClose = snap.prevDailyBar?.c
  if (price == null || prevClose == null || prevClose === 0) return null
  const daily = snap.dailyBar
  return {
    symbol,
    price,
    change: price - prevClose,
    changePct: ((price - prevClose) / prevClose) * 100,
    open: daily?.o ?? prevClose,
    high: Math.max(daily?.h ?? price, price),
    low: Math.min(daily?.l ?? price, price),
    prevClose,
    volume: daily?.v ?? 0,
    ts: snap.latestTrade?.t ? Math.floor(new Date(snap.latestTrade.t).getTime() / 1000) : Math.floor(Date.now() / 1000),
  }
}

export async function getQuotes(symbols: string[], userId?: string): Promise<{ quotes: Quote[]; demo: boolean }> {
  if (symbols.length === 0) return { quotes: [], demo: false }
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return { quotes: symbols.map((s) => simQuote(s)), demo: true }
  }
  const stocks = symbols.filter((s) => !isCryptoSymbol(s))
  const cryptos = symbols.filter((s) => isCryptoSymbol(s))
  const quotes: Quote[] = []
  const jobs: Promise<void>[] = []

  if (stocks.length > 0) {
    // chunk to keep URLs short
    for (let i = 0; i < stocks.length; i += 30) {
      const chunk = stocks.slice(i, i + 30)
      jobs.push((async () => {
        const raw = await alpacaFetch<Record<string, StockSnapshot>>(
          `/v2/stocks/snapshots?symbols=${encodeURIComponent(chunk.join(','))}&feed=iex`,
          keys,
        )
        if (!raw) return
        for (const s of chunk) {
          const q = snapshotToQuote(s, raw[s])
          if (q) quotes.push(q)
        }
      })())
    }
  }
  if (cryptos.length > 0) {
    for (let i = 0; i < cryptos.length; i += 15) {
      const chunk = cryptos.slice(i, i + 15)
      jobs.push((async () => {
        const raw = await alpacaFetch<Record<string, CryptoSnapshot>>(
          `/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(chunk.join(','))}`,
          keys,
        )
        if (!raw) return
        for (const s of chunk) {
          const q = snapshotToQuote(s, raw[s])
          if (q) quotes.push(q)
        }
      })())
    }
  }
  await Promise.all(jobs)
  if (quotes.length === 0) {
    return { quotes: symbols.map((s) => simQuote(s)), demo: true }
  }
  // fill any missing with simulator to keep rows visible
  const have = new Set(quotes.map((q) => q.symbol))
  for (const s of symbols) {
    if (!have.has(s)) quotes.push({ ...simQuote(s), symbol: s })
  }
  return { quotes, demo: false }
}

// ---------- News ----------

interface AlpacaNewsItem {
  id: number
  headline: string
  summary: string
  author: string
  created_at: string
  updated_at: string
  url: string
  images: { size: string; url: string }[]
  symbols: string[]
  source: string
}

export async function getNews(symbol: string | null, limit: number, userId?: string): Promise<{ news: NewsItem[]; demo: boolean }> {
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return { news: simNews(symbol || 'MARKET', limit), demo: true }
  }
  const params = new URLSearchParams({ limit: String(Math.min(limit, 50)), sort: 'desc' })
  if (symbol && !isCryptoSymbol(symbol)) params.set('symbols', symbol)
  const raw = await alpacaFetch<{ news: AlpacaNewsItem[] }>(`/v1beta1/news?${params.toString()}`, keys)
  if (!raw || !raw.news || raw.news.length === 0) {
    return { news: simNews(symbol || 'MARKET', limit), demo: true }
  }
  const news = raw.news.map((n) => ({
    id: String(n.id),
    headline: n.headline,
    summary: n.summary,
    source: n.source || n.author || 'Alpaca',
    url: n.url,
    ts: Math.floor(new Date(n.created_at).getTime() / 1000),
    image: n.images?.find((i) => i.size === 'large')?.url || n.images?.[0]?.url,
    symbols: n.symbols || [],
  }))
  return { news, demo: false }
}

// ---------- Markers (earnings via news scan + news timestamps) ----------

const EARNINGS_RE = /earnings|reports q[1-4]|quarterly results|q[1-4] (results|report|earnings)|fiscal.*(results|earnings)|reports (fourth|first|second|third)-?quarter/i

export async function getMarkers(symbol: string, from: number, to: number, userId?: string): Promise<MarkerData & { demo: boolean }> {
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return { ...simMarkers(symbol, from, to), demo: true }
  }
  const params = new URLSearchParams({
    symbols: isCryptoSymbol(symbol) ? '' : symbol,
    limit: '50',
    sort: 'desc',
    start: new Date(from * 1000).toISOString().slice(0, 19) + 'Z',
    end: new Date(to * 1000).toISOString().slice(0, 19) + 'Z',
  })
  if (!isCryptoSymbol(symbol)) params.set('symbols', symbol)
  else params.delete('symbols') // crypto news not symbol-filterable; use all
  const raw = await alpacaFetch<{ news: AlpacaNewsItem[] }>(`/v1beta1/news?${params.toString()}`, keys)
  if (!raw || !raw.news) {
    return { ...simMarkers(symbol, from, to), demo: true }
  }
  const earnings: number[] = []
  const news: number[] = []
  const seen = new Set<string>()
  for (const n of raw.news) {
    const ts = Math.floor(new Date(n.created_at).getTime() / 1000)
    if (ts < from || ts > to) continue
    news.push(ts)
    if (EARNINGS_RE.test(n.headline)) {
      const key = new Date(ts * 1000).toISOString().slice(0, 10)
      if (!seen.has(key)) {
        seen.add(key)
        earnings.push(ts)
      }
    }
  }
  // crypto has no earnings — drop for crypto symbols
  const finalEarnings = isCryptoSymbol(symbol) ? [] : earnings
  return { earnings: finalEarnings, news: news.slice(0, 40), demo: false }
}
