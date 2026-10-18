import { NextResponse } from 'next/server'
import { getMarkers } from '@/lib/alpaca'
import { getYahooEarnings } from '@/lib/yahoo'
import { isCryptoSymbol } from '@/lib/market-types'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)

// GET /api/market/markers?symbol=AAPL&from=<sec>&to=<sec>
// Earnings: primary source yfinance (Yahoo quoteSummary — past quarters + next
// upcoming), Alpaca news-headline-derived dates only fill gaps. News: Alpaca.
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
    const user = await getSessionUser()
    const [mk, yahoo] = await Promise.all([
      getMarkers(symbol, from, to, user?.id),
      isCryptoSymbol(symbol)
        ? Promise.resolve({ events: [], source: 'yfinance' as const })
        : getYahooEarnings(symbol).catch(() => null),
    ])

    // merge earnings by day — yfinance wins, Alpaca fills days Yahoo missed.
    // Fake/demo Alpaca earnings never mix with real Yahoo ones; crypto pairs
    // have no earnings at all.
    const byDay = new Map<string, { ts: number; epsActual?: number | null; epsEstimate?: number | null; upcoming?: boolean }>()
    const crypto = isCryptoSymbol(symbol)
    if (!crypto) {
      for (const e of yahoo?.events ?? []) byDay.set(dayKey(e.ts), e)
      const alpacaUsable = !mk.demo || yahoo === null
      if (alpacaUsable) {
        for (const t of mk.earnings) {
          const k = dayKey(t)
          if (!byDay.has(k)) byDay.set(k, { ts: t })
        }
      }
    }
    const earningsInfo = [...byDay.values()].sort((a, b) => a.ts - b.ts)
    const earnings = earningsInfo.map((e) => e.ts)

    let earningsSource = 'none'
    if (crypto) earningsSource = 'crypto'
    else if (yahoo && yahoo.events.length > 0) earningsSource = 'yfinance'
    else if (earnings.length > 0) earningsSource = 'alpaca'

    return NextResponse.json({
      earnings,
      news: mk.news,
      newsItems: mk.newsItems ?? mk.news.map((ts) => ({ ts, title: '' })),
      earningsInfo,
      earningsSource,
      meta: { demo: mk.demo, reason: mk.reason },
    })
  } catch (e) {
    return handleError(e)
  }
}
