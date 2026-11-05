import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode, isNoKeysError, TradingOrder } from '@/lib/trading'
import { describeAlpacaKeys } from '@/lib/alpaca'

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

// GET /api/trading/fills?mode=paper&since=<ISO>                      — recently FILLED
//   orders, used by the client to fire sound + toast notifications (default
//   limit 30, unchanged).
// GET /api/trading/fills?limit=500&symbol=AAPL                        — historical fills
//   for the chart's BUY/SELL markers (Task 32): up to 500 most recent filled
//   orders (Alpaca per-call max), optionally narrowed to one symbol (compare
//   is normalization-tolerant — "BTC/USD" matches "BTCUSD").
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const sinceRaw = searchParams.get('since') || ''
    const since = sinceRaw ? new Date(sinceRaw).getTime() : 0
    // Task 32 — optional deeper window + symbol filter for chart markers
    const limitRaw = parseInt(searchParams.get('limit') || '30', 10)
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 30, 1), 500)
    const normSymOf = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    const symFilter = normSymOf(searchParams.get('symbol') || '')

    const r = await getClosedOrders(user.id, mode, limit)
    if (!r.data) {
      // no keys configured is a quiet no-op for the poller
      if (isNoKeysError(r.error)) return NextResponse.json({ mode, fills: [], configured: false })
      // v2.12.2 — an engaged Alpaca 401 breaker must NOT surface as a raw HTTP
      // 401: the ROOT-LEVEL fill poller (2.5s after login, then every 12s)
      // runs through the client's global 401 watcher, so an upstream keys
      // rejection used to log the user out of the TERMINAL seconds after
      // sign-in — the exact "auto logout in 2 seconds" hosted report. Mirror
      // the positions route instead: 200 + structured authError, which the
      // poller ignores and Settings renders as the amber keys banner.
      if (r.status === 401) {
        const keysDesc = await describeAlpacaKeys(user.id, mode)
        return NextResponse.json({
          mode,
          fills: [],
          configured: true,
          authError: {
            mode,
            message: `${mode === 'live' ? 'LIVE' : 'Paper'} keys rejected by Alpaca — fill notifications and chart markers are paused until the keys are fixed (Settings → API keys). [using ${keysDesc}]`,
          },
        })
      }
      return NextResponse.json({ error: r.error || 'Fills fetch failed' }, { status: r.status || 502 })
    }
    // A failed fetch (401/403, network) resolves to an error OBJECT — only a
    // real array may be filtered or the poller 500s every tick.
    const orderList: TradingOrder[] = Array.isArray(r.data) ? r.data : []
    if (orderList.length === 0 && r.error && !isNoKeysError(r.error)) {
      return NextResponse.json({ mode, fills: [], configured: true, error: r.error })
    }
    const fills: FillRow[] = orderList
      .filter((o) => o.status === 'filled' && o.filled_at && new Date(o.filled_at).getTime() >= since)
      .filter((o) => !symFilter || normSymOf(String(o.symbol || '')) === symFilter)
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
