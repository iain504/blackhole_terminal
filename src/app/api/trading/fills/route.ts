import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode, TradingOrder } from '@/lib/trading'
import { ensureFillNotifier } from '@/lib/fill-notifier'
import { handleError } from '@/lib/api-helpers'

export interface FillRow {
  id: string
  symbol: string
  side: string
  qty: number
  price: number | null
  type: string
  filledAt: string
}

// GET /api/trading/fills?mode=paper&since=<ISO> — recently FILLED orders,
// used by the client to fire sound + toast notifications.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const sinceRaw = searchParams.get('since') || ''
    const since = sinceRaw ? new Date(sinceRaw).getTime() : 0

    const r = await getClosedOrders(user.id, mode, 30)
    if (!r.data) {
      // no keys configured is a quiet no-op for the poller
      if (r.error === 'no-keys') return NextResponse.json({ mode, fills: [], configured: false })
      return NextResponse.json({ error: r.error || 'Fills fetch failed' }, { status: r.status || 502 })
    }
    // A failed fetch (401/403, network) resolves to an error OBJECT — only a
    // real array may be filtered or the poller 500s every tick.
    const orderList: TradingOrder[] = Array.isArray(r.data) ? r.data : []
    if (orderList.length === 0 && r.error && r.error !== 'no-keys') {
      return NextResponse.json({ mode, fills: [], configured: true, error: r.error })
    }
    const fills: FillRow[] = orderList
      .filter((o) => o.status === 'filled' && o.filled_at && new Date(o.filled_at).getTime() >= since)
      .map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        qty: parseFloat(o.filled_qty) || parseFloat(o.qty) || 0,
        price: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
        type: o.type,
        filledAt: o.filled_at as string,
      }))
    return NextResponse.json({ mode, fills, configured: true })
  } catch (e) {
    return handleError(e)
  }
}
