import { NextResponse } from 'next/server'
import { getNews } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

// GET /api/market/news?symbol=AAPL&limit=30
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const symbolParam = (searchParams.get('symbol') || '').trim().toUpperCase()
    const symbol = symbolParam === 'ALL' ? null : symbolParam || null
    const limit = Math.min(parseInt(searchParams.get('limit') || '25', 10) || 25, 50)
    const user = await getSessionUser()
    const { news, demo, reason } = await getNews(symbol, limit, user?.id)
    return NextResponse.json({ news, meta: { demo, reason } })
  } catch (e) {
    return handleError(e)
  }
}
