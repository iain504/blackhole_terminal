import { NextResponse } from 'next/server'
import { getMarkers } from '@/lib/alpaca'
import { getYahooEarnings } from '@/lib/yahoo'
import { isCryptoSymbol } from '@/lib/market-types'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

// GET /api/market/markers?symbol=AAPL&from=<sec>&to=<sec>
// Earnings: ONLY REAL DATES ever make the axis —
//   • upcoming consensus date from Yahoo (calendarEvents, keyless)
//   • past report days from Alpaca news with STRICT report-day headlines
//     (loose "earnings" matching used to plant fake [E] markers on preview /
//     analysis news days — the "many wrong dates" bug)
// News ⚡ markers: Alpaca news timestamps.
//
// Small memory cache: the paginated Alpaca news scan costs a few requests,
// and markers barely change — 10min TTL keeps symbol-switching snappy.
interface CacheEntry {
  at: number
  payload: Record<string, unknown>
}
const CACHE_TTL = 10 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase()
    const now = Math.floor(Date.now() / 1000)
    const from = parseInt(searchParams.get('from') || String(now - 86400 * 400), 10)
    const to = parseInt(searchParams.get('to') || String(now + 86400 * 30), 10)
    if (!symbol) {
      return NextResponse.json({
        earnings: [], news: [], newsItems: [], earningsInfo: [], earningsSource: 'none',
        meta: { demo: false },
      })
    }
    const cacheKey = `${symbol}|${from}|${to}`
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_TTL) return NextResponse.json(hit.payload)
    const user = await getSessionUser()
    const [mk, yahoo] = await Promise.all([
      getMarkers(symbol, from, to, user?.id),
      isCryptoSymbol(symbol)
        ? Promise.resolve({ upcoming: null, source: 'yfinance' as const })
        : getYahooEarnings(symbol).catch(() => null),
    ])

    // Merge: Alpaca strict report days (past) + Yahoo upcoming. Simulated /
    // demo Alpaca earnings never mix with real Yahoo ones; crypto pairs have
    // no earnings at all.
    const crypto = isCryptoSymbol(symbol)
    const byDay = new Map<string, { ts: number; upcoming?: boolean }>()
    if (!crypto) {
      const alpacaUsable = !mk.demo || yahoo === null
      if (alpacaUsable) {
        for (const t of mk.earnings) byDay.set(dayKey(t), { ts: t })
      }
      if (yahoo?.upcoming) {
        byDay.set(dayKey(yahoo.upcoming.ts), { ts: yahoo.upcoming.ts, upcoming: true })
      }
    }
    const earningsInfo = [...byDay.values()].sort((a, b) => a.ts - b.ts)
    const earnings = earningsInfo.map((e) => e.ts)

    let earningsSource = 'none'
    if (crypto) earningsSource = 'crypto'
    else if (yahoo?.upcoming && earnings.some((t) => !yahoo.upcoming || t !== yahoo.upcoming.ts)) earningsSource = 'yfinance+alpaca'
    else if (yahoo?.upcoming) earningsSource = 'yfinance'
    else if (earnings.length > 0) earningsSource = 'alpaca'

    const payload = {
      earnings,
      news: mk.news,
      newsItems: mk.newsItems ?? mk.news.map((ts) => ({ ts, title: '' })),
      earningsInfo,
      earningsSource,
      meta: { demo: mk.demo, reason: mk.reason },
    }
    cache.set(cacheKey, { at: Date.now(), payload })
    if (cache.size > 200) {
      const cutoff = Date.now() - CACHE_TTL
      for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k)
    }
    return NextResponse.json(payload)
  } catch (e) {
    return handleError(e)
  }
}

const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)
