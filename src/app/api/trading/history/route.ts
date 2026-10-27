import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode } from '@/lib/trading'
import { matchClosedTrades, resolveRunStrategyNames } from '@/lib/trade-history'
import { handleError } from '@/lib/api-helpers'

// GET /api/trading/history?mode=paper&limit=100 — realized round-trip trades
// (FIFO-matched from the broker's filled closed orders) with realized P&L.
// Powers the Positions tab "Trade history" group + the Performance Report.
// Each trade carries `source: 'manual' | 'algo' | 'grid'` (decoded from the
// entry order's client_order_id, Task 10-k) and, for algo trades, the
// resolved strategy name.
// Task 82 — optional `from`/`to` (ISO timestamps) filter the matched trades
// by EXIT time (the CLOSED column): the FIFO walk still runs over the whole
// recent closed-orders window, the date filter is applied BEFORE the limit
// so a narrow range isn't crowded out by newer trades. Ranges come from the
// client in the browser's timezone (local-midnight ISO).
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const limitRaw = Number(searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(300, Math.round(limitRaw)) : 100
    const fromMs = Date.parse(searchParams.get('from') || '')
    const toMs = Date.parse(searchParams.get('to') || '')

    const r = await getClosedOrders(user.id, mode, 500)
    if (!r.data) {
      // no keys configured is a quiet empty state (same convention as fills)
      if (r.error === 'no-keys') {
        return NextResponse.json({ mode, trades: [], configured: false })
      }
      return NextResponse.json({ error: r.error || 'Closed orders fetch failed' }, { status: r.status || 502 })
    }
    const orderList = Array.isArray(r.data) ? r.data : []
    // uncapped walk (large cap — 500 orders can't produce more): filter by
    // exit time FIRST, then cap, so a date range gets its full share
    const matched = matchClosedTrades(orderList, 1000).filter((t) => {
      const at = Date.parse(t.exitAt)
      if (!Number.isFinite(at)) return true // keep malformed-time trades out of the filter's blast radius
      if (Number.isFinite(fromMs) && at < fromMs) return false
      if (Number.isFinite(toMs) && at > toMs) return false
      return true
    })
    const trades = matched.slice(0, limit)
    // resolve algo run refs → strategy display names via the SHARED resolver
    // (refs are 8-char id prefixes so `startsWith` is unique in practice)
    const refs = [...new Set(trades.map((t) => t.runRef).filter((x): x is string => !!x))]
    const stratNames = await resolveRunStrategyNames(refs)
    const enriched = trades.map((t) =>
      t.source === 'algo' && t.runRef
        ? { ...t, strategy: stratNames.get(t.runRef) ?? 'Algo' }
        : t,
    )
    return NextResponse.json({ mode, trades: enriched, configured: true })
  } catch (e) {
    return handleError(e)
  }
}
