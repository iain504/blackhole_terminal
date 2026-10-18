import { NextResponse } from 'next/server'
import { getBars } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { Timeframe, TIMEFRAMES } from '@/lib/market-types'

// GET /api/market/bars?symbol=AAPL&tf=1D
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase()
    const tfParam = (searchParams.get('tf') || '1D') as Timeframe
    const tf: Timeframe = TIMEFRAMES[tfParam] ? tfParam : '1D'
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
    const user = await getSessionUser()
    const { bars, demo, reason } = await getBars(symbol, tf, user?.id)
    return NextResponse.json({ bars, meta: { demo, reason } })
  } catch (e) {
    return handleError(e)
  }
}
