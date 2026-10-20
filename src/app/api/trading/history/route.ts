import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode } from '@/lib/trading'
import { matchClosedTrades } from '@/lib/trade-history'
import { handleError } from '@/lib/api-helpers'

// GET /api/trading/history?mode=paper&limit=100 — realized round-trip trades
// (FIFO-matched from the broker's filled closed orders) with realized P&L.
// Powers the Positions tab "Trade history" group.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const limitRaw = Number(searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(300, Math.round(limitRaw)) : 100

    const r = await getClosedOrders(user.id, mode, 500)
    if (!r.data) {
      // no keys configured is a quiet empty state (same convention as fills)
      if (r.error === 'no-keys') {
        return NextResponse.json({ mode, trades: [], configured: false })
      }
      return NextResponse.json({ error: r.error || 'Closed orders fetch failed' }, { status: r.status || 502 })
    }
    const orderList = Array.isArray(r.data) ? r.data : []
    const trades = matchClosedTrades(orderList, limit)
    return NextResponse.json({ mode, trades, configured: true })
  } catch (e) {
    return handleError(e)
  }
}
