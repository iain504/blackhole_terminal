// Closed-trade matching — turns the broker's stream of individual order
// fills into ROUND-TRIP trades with realized P&L.
//
// Alpaca reports orders, not trades: a bracket entry fills as one order and
// its TP/SL fill as two more, a manual market close is yet another order.
// This module runs a classic FIFO lot matcher per symbol over the FILLED
// closed orders (oldest first): each fill either opens a lot (position
// increase) or closes the oldest opposing lot(s). Every matched
// (entry-lot, exit-fill) slice becomes one ClosedTrade with side-aware
// realized P&L (long: exit−entry · short: entry−exit).
//
// The same matcher serves both consumers:
//  - /api/trading/history         → the Positions tab "Trade history" group
//  - /api/strategies/history      → per-strategy realized P&L attribution
//    (a fire's entry orderId appears in trade.orderIds → trade belongs to it)
import type { TradingOrder } from '@/lib/trading'
import type { ClosedTrade } from '@/lib/market-types'

/** Chart-style display symbol: Alpaca crypto already carries the slash. */
function displaySymbol(o: Pick<TradingOrder, 'symbol' | 'asset_class'>): string {
  if (o.symbol.includes('/')) return o.symbol
  if (o.asset_class === 'crypto') return o.symbol.replace(/USD$/, '/USD')
  return o.symbol
}

interface Lot {
  side: string // 'buy' | 'sell' (the ENTRY side)
  qty: number
  price: number
  time: string // ISO fill time
  orderId: string
  groupId: string | null
}

const EPS = 1e-9

/** Trim binary-float residue from qty arithmetic (0.000453760000000009 → 0.00045376). */
function cleanQty(n: number): number {
  return Number(n.toPrecision(10))
}

/**
 * FIFO-match filled orders into round-trip trades.
 * @param orders raw broker orders (any status mix — only filled ones are used)
 * @param max cap on returned trades (newest first)
 */
export function matchClosedTrades(orders: TradingOrder[], max = 200): ClosedTrade[] {
  const filled = orders
    .filter(
      (o) =>
        o.status === 'filled' &&
        o.filled_at != null &&
        o.filled_avg_price != null &&
        Number.isFinite(parseFloat(o.filled_avg_price)) &&
        parseFloat(o.filled_qty || '0') > 0,
    )
    .sort(
      (a, b) =>
        new Date(a.filled_at as string).getTime() - new Date(b.filled_at as string).getTime(),
    )

  const lots = new Map<string, Lot[]>() // per symbol FIFO queue
  const trades: ClosedTrade[] = []
  let seq = 0

  for (const o of filled) {
    const exitPrice = parseFloat(o.filled_avg_price as string)
    let remaining = parseFloat(o.filled_qty)
    const q = lots.get(o.symbol) ?? []

    // close the oldest opposing lots first
    while (remaining > EPS && q.length > 0 && q[0].side !== o.side) {
      const lot = q[0]
      const take = Math.min(lot.qty, remaining)
      const long = lot.side === 'buy'
      const pnl = (long ? exitPrice - lot.price : lot.price - exitPrice) * take
      const exitAt = o.filled_at as string
      const entryAt = lot.time
      trades.push({
        id: `${lot.orderId}:${o.id}:${seq++}`,
        symbol: displaySymbol(o),
        side: long ? 'long' : 'short',
        qty: cleanQty(take),
        entryPrice: lot.price,
        exitPrice,
        entryAt,
        exitAt,
        pnl,
        pnlPct: lot.price > 0 ? (pnl / (lot.price * take)) * 100 : 0,
        durationMs: Math.max(0, new Date(exitAt).getTime() - new Date(entryAt).getTime()),
        entryOrderId: lot.orderId,
        exitOrderIds: [o.id],
        orderIds: [lot.orderId, o.id],
        groupIds: [lot.groupId, o.group_id ?? null].filter((g): g is string => !!g),
      })
      lot.qty = cleanQty(lot.qty - take)
      remaining = cleanQty(remaining - take)
      if (lot.qty <= EPS) q.shift()
    }

    // whatever remains increases the position → new lot
    if (remaining > EPS) {
      q.push({
        side: o.side,
        qty: remaining,
        price: exitPrice,
        time: o.filled_at as string,
        orderId: o.id,
        groupId: o.group_id ?? null,
      })
    }
    if (q.length > 0) lots.set(o.symbol, q)
    else lots.delete(o.symbol)
  }

  // newest exits first (the list was built oldest-first)
  return trades
    .sort((a, b) => new Date(b.exitAt).getTime() - new Date(a.exitAt).getTime())
    .slice(0, max)
}

/**
 * Index trades by every order id they involve, so a strategy fire's entry
 * orderId resolves to the round-trip(s) it produced.
 */
export function indexTradesByOrder(trades: ClosedTrade[]): Map<string, ClosedTrade[]> {
  const byOrder = new Map<string, ClosedTrade[]>()
  for (const t of trades) {
    for (const id of t.orderIds) {
      const list = byOrder.get(id)
      if (list) list.push(t)
      else byOrder.set(id, [t])
    }
  }
  return byOrder
}
