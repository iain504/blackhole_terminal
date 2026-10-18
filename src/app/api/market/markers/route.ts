import { NextResponse } from 'next/server'
import { getMarkers } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

// GET /api/market/markers?symbol=AAPL&from=<sec>&to=<sec> — earnings [E] + news timestamps
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase()
    const now = Math.floor(Date.now() / 1000)
    const from = parseInt(searchParams.get('from') || String(now - 86400 * 400), 10)
    const to = parseInt(searchParams.get('to') || String(now + 86400 * 30), 10)
    if (!symbol) return NextResponse.json({ earnings: [], news: [], meta: { demo: false } })
    const user = await getSessionUser()
    const { earnings, news, demo } = await getMarkers(symbol, from, to, user?.id)
    return NextResponse.json({ earnings, news, meta: { demo } })
  } catch (e) {
    return handleError(e)
  }
}
