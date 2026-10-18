import { NextResponse } from 'next/server'
import { getBars } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { Timeframe, TIMEFRAMES } from '@/lib/market-types'

// GET /api/market/bars?symbol=AAPL&tf=1D[&before=<unix seconds>]
// `before` fetches the chunk of history ENDING just before that instant —
// the chart calls it when the user scrolls past the oldest loaded bar.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase()
    const tfParam = (searchParams.get('tf') || '1D') as Timeframe
    const tf: Timeframe = TIMEFRAMES[tfParam] ? tfParam : '1D'
    const beforeRaw = Number(searchParams.get('before'))
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : undefined
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
    const user = await getSessionUser()
    const { bars, demo, reason, source } = await getBars(symbol, tf, user?.id, { before })
    return NextResponse.json({ bars, meta: { demo, reason, source, before: before ?? null } })
  } catch (e) {
    return handleError(e)
  }
}
