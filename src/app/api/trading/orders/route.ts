import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { placeOrderWithExits, placeTrailingStop, resolveTradeMode, TradeMode } from '@/lib/trading'
import { readJson, handleError } from '@/lib/api-helpers'

interface PlaceBody {
  mode?: string
  symbol: string
  side: 'buy' | 'sell'
  qty?: number
  notional?: number
  type?: 'market' | 'limit'
  limit_price?: number
  time_in_force?: 'gtc' | 'day'
  take_profit?: number
  stop_loss?: number
  trail_percent?: number
}

// POST /api/trading/orders — place entry (market/limit) with optional SL/TP,
// or a trailing-stop exit when trail_percent is given.
export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await readJson<PlaceBody>(req)
    const symbol = (body.symbol || '').trim().toUpperCase()
    if (!symbol || (body.side !== 'buy' && body.side !== 'sell')) {
      return NextResponse.json({ error: 'symbol and side (buy/sell) required' }, { status: 400 })
    }
    const mode: TradeMode = await resolveTradeMode(user.id, body.mode)
    const qty = typeof body.qty === 'number' && body.qty > 0 ? body.qty : 0
    if (!qty && !(typeof body.notional === 'number' && body.notional > 0)) {
      return NextResponse.json({ error: 'qty (or notional) required' }, { status: 400 })
    }

    // Trailing-stop exit order (close side) — stocks only.
    if (typeof body.trail_percent === 'number' && body.trail_percent > 0) {
      const exitSide = body.side === 'buy' ? 'sell' : 'buy'
      const r = await placeTrailingStop(user.id, mode, {
        symbol,
        side: exitSide,
        qty,
        trail_percent: body.trail_percent,
      })
      if (!r.data) {
        return NextResponse.json({ error: r.error || 'Trailing stop failed', status: r.status }, { status: r.status || 502 })
      }
      return NextResponse.json({ mode, orders: [r.data], errors: [] })
    }

    const r = await placeOrderWithExits(user.id, mode, {
      symbol,
      side: body.side,
      qty,
      type: body.type,
      limit_price: body.limit_price,
      time_in_force: body.time_in_force,
      take_profit: body.take_profit,
      stop_loss: body.stop_loss,
    })
    if (r.results.length === 0 && r.errors.length > 0) {
      return NextResponse.json({ error: r.errors[0], mode }, { status: 422 })
    }
    return NextResponse.json({ mode, orders: r.results, errors: r.errors, splitNote: r.splitNote })
  } catch (e) {
    return handleError(e)
  }
}
