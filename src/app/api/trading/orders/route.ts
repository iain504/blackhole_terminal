import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import {
  placeOrderWithExits, placeTrailingStop, resolveTradeMode, ensureCryptoOcoSupervisor,
  friendlyExitQtyError, TradeMode,
} from '@/lib/trading'
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
// or a trailing-stop when trail_percent is given (side is used AS-IS: a SELL
// trailing stop trails BELOW the price — exit/protection for a long — and a
// BUY trailing stop trails ABOVE — short entry/cover).
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
    // keep the crypto complex-order emulation running (OCO attach + cleanup)
    ensureCryptoOcoSupervisor(user.id, mode)
    const qty = typeof body.qty === 'number' && body.qty > 0 ? body.qty : 0
    if (!qty && !(typeof body.notional === 'number' && body.notional > 0)) {
      return NextResponse.json({ error: 'qty (or notional) required' }, { status: 400 })
    }

    // Trailing-stop order — stocks only (Alpaca crypto rejects trailing_stop).
    // The side is NOT flipped: the order is exactly the side the user picked
    // (the ticket used to silently turn a "Buy" into a SELL trailing stop).
    if (typeof body.trail_percent === 'number' && body.trail_percent > 0) {
      if (symbol.includes('/')) {
        return NextResponse.json({ error: 'Trailing stops are not supported for crypto — use a stop_limit SL instead' }, { status: 422 })
      }
      const r = await placeTrailingStop(user.id, mode, {
        symbol,
        side: body.side,
        qty,
        trail_percent: body.trail_percent,
      })
      // tradeFetch puts the PARSED ERROR BODY (e.g. {code:40310000,message:
      // "cannot open a short sell while a long buy order is open"}) into
      // `data` on non-2xx — a bare truthiness check would report a rejected
      // trailing stop as success (200 with the error inside orders[]).
      const errBody = r.data as { code?: number; message?: string } | null
      if (!r.data || r.error || errBody?.code != null) {
        return NextResponse.json(
          { error: friendlyExitQtyError(r.error || errBody?.message || 'Trailing stop failed'), status: r.status },
          { status: r.status || 502 },
        )
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
      return NextResponse.json({ error: friendlyExitQtyError(r.errors[0]), mode }, { status: 422 })
    }
    return NextResponse.json({ mode, orders: r.results, errors: r.errors, splitNote: r.splitNote })
  } catch (e) {
    return handleError(e)
  }
}
