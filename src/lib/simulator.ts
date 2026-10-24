// Deterministic demo data simulator. Used when no Alpaca API keys are available
// (either server env APCA_API_KEY_ID/APCA_API_SECRET_KEY or per-user keys).
// Data is seeded by symbol so charts are stable between reloads, and drifts
// slowly over time (5s buckets) so quotes feel live.
import {
  Bar, Quote, NewsItem, TIMEFRAMES, BASE_PRICES,
  isCryptoSymbol,
} from './market-types'

function hashSeed(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function basePriceFor(symbol: string): number {
  if (BASE_PRICES[symbol]) return BASE_PRICES[symbol]
  const rnd = mulberry32(hashSeed(symbol))
  return 20 + Math.floor(rnd() * 280)
}

/** Gaussian-ish random via Box-Muller. */
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

function stockMarketOpen(d: Date): boolean {
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  return hours >= 14.5 && hours < 21 // 9:30-16:00 ET ≈ 14:30-21:00 UTC
}

/**
 * Demo bars ending "now" (default) or at `endTs` (unix seconds) — the endTs
 * variant powers the chart's scroll-back pagination in demo mode (no keys).
 */
export function simBars(symbol: string, timeframe: keyof typeof TIMEFRAMES, barCount: number, endTs?: number): Bar[] {
  const tf = TIMEFRAMES[timeframe]
  const now = endTs ?? Math.floor(Date.now() / 1000)
  const lastOpen = Math.floor(now / tf.seconds) * tf.seconds
  const start = lastOpen - (barCount - 1) * tf.seconds
  const seed = hashSeed(`${symbol}|${timeframe}|v1`)
  const rnd = mulberry32(seed)
  const base = basePriceFor(symbol)
  // volatility per bar scaled by timeframe
  const vol = base * (0.0022 * Math.sqrt(tf.seconds / 300))
  const drift = base * 0.00004 * (rnd() - 0.45)

  const bars: Bar[] = []
  let price = base * (0.82 + rnd() * 0.1)
  const nowDate = new Date()
  for (let i = 0; i < barCount; i++) {
    const t = start + i * tf.seconds
    const barDate = new Date(t * 1000)
    // Stocks: skip weekends at any timeframe; crypto trades 24/7.
    const day = barDate.getUTCDay()
    if (!isCryptoSymbol(symbol) && (day === 0 || day === 6) && tf.seconds >= 86400) continue
    if (!isCryptoSymbol(symbol) && tf.seconds < 604800 && day === 0) continue
    // For intraday stock bars, flatten outside market hours (simple session model)
    const closed = !isCryptoSymbol(symbol) && tf.seconds < 86400 && !stockMarketOpen(barDate)
    const shock = tf.seconds >= 86400 ? 1.6 : 1
    // mean-reverting walk around base price keeps the series realistic
    const step = gauss(rnd) * vol * shock + drift + (base - price) * 0.012
    const open = price
    const close = Math.max(open + step, base * 0.05)
    const hi = Math.max(open, close) + Math.abs(gauss(rnd)) * vol * 0.5 * shock
    const lo = Math.min(open, close) - Math.abs(gauss(rnd)) * vol * 0.5 * shock
    const volume = closed ? 0 : Math.floor((0.4 + rnd()) * (isCryptoSymbol(symbol) ? 8000 : 5_000_000))
    if (closed && bars.length > 0) {
      // carry price forward without drawing a flat bar
      price = price * (1 + 0.0001 * (rnd() - 0.5))
      continue
    }
    bars.push({ time: t, open, high: hi, low: Math.max(lo, 0.01), close, volume })
    price = close
  }
  // Rescale the whole series so the last close equals the live quote price
  // (keeps continuity — no fake gap on the final bar). Historical chunks
  // (endTs in the past) skip this: their last close must stay where the
  // walk put it, not jump to today's price.
  if (bars.length > 0 && endTs == null) {
    const live = simLivePrice(symbol)
    const factor = live / bars[bars.length - 1].close
    if (isFinite(factor) && factor > 0 && Math.abs(Math.log(factor)) < 1.5) {
      for (const b of bars) {
        b.open *= factor
        b.high *= factor
        b.low *= factor
        b.close *= factor
      }
    }
  }
  return bars
}

/** Live price bucketed to 5s so polls show movement but stay stable within bucket. */
export function simLivePrice(symbol: string): number {
  const now5s = Math.floor(Date.now() / 5000)
  const day = Math.floor(Date.now() / 86400000)
  const rnd = mulberry32(hashSeed(`${symbol}|live|${day}`))
  // intraday random walk anchored at base
  const steps = 200
  let p = basePriceFor(symbol) * (0.97 + rnd() * 0.06)
  const vol = p * 0.0009
  for (let i = 0; i < steps; i++) p += gauss(rnd) * vol
  const tick = mulberry32(hashSeed(`${symbol}|tick|${now5s}`))
  return Math.max(p * (1 + (tick() - 0.5) * 0.0015), 0.01)
}

export function simQuote(symbol: string): Quote {
  const price = simLivePrice(symbol)
  const day = Math.floor(Date.now() / 86400000)
  const rnd = mulberry32(hashSeed(`${symbol}|day|${day}`))
  const prevClose = basePriceFor(symbol) * (0.97 + rnd() * 0.06)
  const change = price - prevClose
  const rnd2 = mulberry32(hashSeed(`${symbol}|ohlc|${day}`))
  const open = prevClose * (1 + (rnd2() - 0.5) * 0.008)
  const high = Math.max(price, open, prevClose) * (1 + rnd2() * 0.006)
  const low = Math.min(price, open, prevClose) * (1 - rnd2() * 0.006)
  const volume = Math.floor((0.5 + rnd2()) * (isCryptoSymbol(symbol) ? 50_000 : 40_000_000))
  // Task 85 — synthetic spread by price tier (majors ~1bp … penny-ish ~8bp)
  // so the demo quotes behave like a real top of book downstream
  const spb = price >= 1000 ? 0.0001 : price >= 100 ? 0.0002 : price >= 10 ? 0.0004 : 0.0008
  return {
    symbol,
    price,
    change,
    changePct: (change / prevClose) * 100,
    open, high, low,
    prevClose,
    volume,
    ts: Math.floor(Date.now() / 1000),
    bid: price * (1 - spb / 2),
    ask: price * (1 + spb / 2),
  }
}

const NEWS_TEMPLATES = [
  '{S} shares rise as analysts lift price target',
  'Why {S} is moving higher in afternoon trading',
  '{S} announces expanded buyback program',
  'Analysts reweigh {S} outlook after quarterly update',
  '{S} unveils new product line at annual event',
  'Institutional investors adjust stakes in {S}',
  '{S} options activity surges ahead of key catalyst',
  'What Wall Street expects from {S} next quarter',
  '{S} CEO discusses growth strategy in interview',
  'Sector rotation lifts {S} alongside peers',
  '{S} dips on profit-taking after strong run',
  'Technical breakout watch: {S} approaches key resistance',
]

export function simNews(symbol: string, limit: number): NewsItem[] {
  const rnd = mulberry32(hashSeed(`${symbol}|news`))
  const out: NewsItem[] = []
  const now = Date.now()
  for (let i = 0; i < limit; i++) {
    const tpl = NEWS_TEMPLATES[Math.floor(rnd() * NEWS_TEMPLATES.length)]
    const ts = now - i * (3600_000 * (2 + rnd() * 10)) - Math.floor(rnd() * 3600_000)
    out.push({
      id: `sim-${symbol}-${i}`,
      headline: tpl.replace('{S}', symbol),
      summary: `Demo mode article about ${symbol}. Add your Alpaca API keys in Settings to stream real market news.`,
      source: ['Benzinga', 'Reuters', 'Bloomberg', 'MarketWatch', 'Zacks'][Math.floor(rnd() * 5)],
      url: '#',
      ts: Math.floor(ts / 1000),
      symbols: [symbol],
    })
  }
  return out
}

/** Earnings dates: quarterly, ~25 days after quarter end; news: random spread. */
export function simMarkers(symbol: string, from: number, to: number): { earnings: number[]; news: number[] } {
  const rnd = mulberry32(hashSeed(`${symbol}|markers`))
  const earnings: number[] = []
  // quarterly points: Jan 25, Apr 25, Jul 25, Oct 25 each year
  const startYear = new Date(from * 1000).getUTCFullYear()
  const endYear = new Date(to * 1000).getUTCFullYear()
  for (let y = startYear; y <= endYear; y++) {
    for (const m of [0, 3, 6, 9]) {
      const t = Math.floor(Date.UTC(y, m, 25) / 1000)
      const jitter = Math.floor((rnd() - 0.5) * 5 * 86400)
      if (t + jitter >= from && t + jitter <= to) earnings.push(t + jitter)
    }
  }
  const news: number[] = []
  const span = to - from
  const count = Math.min(36, Math.max(6, Math.floor(span / 86400)))
  for (let i = 0; i < count; i++) {
    const t = Math.floor(from + rnd() * span)
    news.push(Math.floor(t / 3600) * 3600)
  }
  return { earnings, news: [...new Set(news)].sort((a, b) => a - b) }
}

function pctFor(symbol: string): { pct: number; price: number } {
  const q = simQuote(symbol)
  return { pct: q.changePct, price: q.price }
}
