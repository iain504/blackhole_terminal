import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import {
  placeOrderWithExits, placeTrailingStop, resolveTradeMode, ensureCryptoOcoSupervisor,
  friendlyExitQtyError, getOpenOrders, TradeMode,
} from '@/lib/trading'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { symbolSchema } from '@/lib/validation'

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

// GET /api/trading/orders?mode=paper&symbol=TSLA — OPEN orders (merged
// flat/nested/held-sweep view, same shape the Positions tab uses). The Trade
// Advisor polls this to keep its cancel button honest.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode: TradeMode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase() || undefined
    const r = await getOpenOrders(user.id, mode, symbol)
    return NextResponse.json({ mode, orders: Array.isArray(r.data) ? r.data : [], error: r.error ?? null })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/trading/orders — place entry (market/limit) with optional SL/TP,
// or a trailing-stop when trail_percent is given (side is used AS-IS: a SELL
// trailing stop trails BELOW the price — exit/protection for a long — and a
// BUY trailing stop trails ABOVE — short entry/cover).
export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Task 89 — first rate limit on the real-money path: an authenticated
    // loop used to be able to hammer Alpaca with orders (broker lockouts,
    // fat-finger bursts) with only buying power as a backstop.
    const rl = await rateLimit(`orders:${user.id}`, 30, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many order requests — retry in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }
    const body = await readJson<PlaceBody>(req)
    const symbol = (body.symbol || '').trim().toUpperCase()
    // Task 89 — the manual ticket is now held to the SAME validation standard
    // as every grid/algo path: charset-checked symbol, finite bounded qty,
    // positive limit price, bounded trail percent (Infinity used to stringify
    // straight through to the broker).
    if (!symbol || !symbolSchema.safeParse(symbol).success) {
      return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
    }
    if (body.side !== 'buy' && body.side !== 'sell') {
      return NextResponse.json({ error: 'symbol and side (buy/sell) required' }, { status: 400 })
    }
    const mode: TradeMode = await resolveTradeMode(user.id, body.mode)
    // keep the crypto complex-order emulation running (OCO attach + cleanup)
    ensureCryptoOcoSupervisor(user.id, mode)
    const qty = typeof body.qty === 'number' && Number.isFinite(body.qty) && body.qty > 0 && body.qty <= 1_000_000 ? body.qty : 0
    const notional = typeof body.notional === 'number' && Number.isFinite(body.notional) && body.notional > 0 ? body.notional : 0
    if (!qty && !notional) {
      return NextResponse.json({ error: 'qty (or notional) required — must be a positive number up to 1,000,000' }, { status: 400 })
    }
    if (body.type === 'limit' && !(typeof body.limit_price === 'number' && Number.isFinite(body.limit_price) && body.limit_price > 0)) {
      return NextResponse.json({ error: 'Limit price must be a positive number for limit orders' }, { status: 400 })
    }
    if (typeof body.take_profit === 'number' && (!Number.isFinite(body.take_profit) || body.take_profit <= 0)) {
      return NextResponse.json({ error: 'Take profit must be a positive number' }, { status: 400 })
    }
    if (typeof body.stop_loss === 'number' && (!Number.isFinite(body.stop_loss) || body.stop_loss <= 0)) {
      return NextResponse.json({ error: 'Stop loss must be a positive number' }, { status: 400 })
    }
    if (typeof body.trail_percent === 'number' && (!Number.isFinite(body.trail_percent) || body.trail_percent <= 0 || body.trail_percent > 100)) {
      return NextResponse.json({ error: 'Trail percent must be between 0 and 100' }, { status: 400 })
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
