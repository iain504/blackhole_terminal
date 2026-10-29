import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { Timeframe, TIMEFRAMES } from '@/lib/market-types'
import { barsFor } from '@/lib/bars-cache'
import { computeAtr } from '@/lib/indicators'

// GET /api/market/atr?symbol=BTC/USD&tf=1h[&period=14]
// The UI preview endpoint for ATR-mode TP/SL: returns the CURRENT Wilder
// ATR(14) plus the last close (ref price) so a ticket/drawer can show the
// exact trigger price a multiplier resolves to BEFORE submitting. Same math
// as the engines' resolution (src/lib/atr.ts → barsFor → computeAtr), demo
// bars included (atr:null + reason when the series is too short).
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase()
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
    const tfParam = (searchParams.get('tf') || '1h') as Timeframe
    const tf: Timeframe = TIMEFRAMES[tfParam] ? tfParam : '1h'
    const periodRaw = Number(searchParams.get('period'))
    // NOTE: Number(null) === 0 (not NaN) — treat absent/empty as the default
    const period = searchParams.get('period') && Number.isFinite(periodRaw)
      ? Math.min(200, Math.max(2, Math.round(periodRaw)))
      : 14
    const user = await getSessionUser()
    const entry = await barsFor(symbol, tf, user?.id || 'anonymous')
    const refPrice = entry.bars.length > 0 ? entry.bars[entry.bars.length - 1].close : null
    if (entry.bars.length <= period) {
      return NextResponse.json({
        atr: null,
        refPrice,
        tf,
        period,
        demo: entry.demo,
        error: 'insufficient_data',
        message: `Not enough ${tf} bars yet (${entry.bars.length} loaded, need > ${period})`,
      })
    }
    const atr = computeAtr(entry.bars, period)
    return NextResponse.json({
      atr,
      refPrice,
      tf,
      period,
      demo: entry.demo,
      at: entry.bars[entry.bars.length - 1].time,
      ...(atr == null ? { error: 'atr_unavailable', message: 'ATR could not be computed from the loaded bars' } : {}),
    })
  } catch (e) {
    return handleError(e)
  }
}
