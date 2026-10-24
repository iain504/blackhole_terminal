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
import { parseCryptoPlan } from '@/lib/trading'
import type { ClosedTrade } from '@/lib/market-types'
import { db } from '@/lib/db'
import { ALGO_STRATEGIES } from '@/lib/algo-strategies'

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
  clientOrderId: string | null // carries the ttb-/ttr-/ttg- source tag
}

const EPS = 1e-9

/** Decode the placement source from the ENTRY order's client_order_id —
 * `ttr-` (algo run, runRef = first 8 of the AlgoRun id), `ttg-` (grid, Task
 * 10-k, gridRef = first 8 of the GridTrade id) vs `ttb-`/external (manual).
 * The strategy NAME is resolved server-side where the DB lives. */
function sourceOf(entryClientOrderId: string | null): Pick<ClosedTrade, 'source' | 'runRef'> {
  const plan = parseCryptoPlan(entryClientOrderId)
  if (plan?.gridRef) return { source: 'grid', runRef: null }
  if (plan?.runRef) return { source: 'algo', runRef: plan.runRef }
  return { source: 'manual', runRef: null }
}

/** An entry fill that survives the FIFO walk — one lot of a LIVE position.
 * Exposed so /api/trading/positions can attach `openedAt` (oldest lot) and
 * the Manual/Algo/Grid source decoded from the lot's client_order_id. */
export interface OpenLot {
  side: string // entry side: 'buy' | 'sell'
  qty: number
  price: number
  entryTime: string // ISO fill time of the entry
  orderId: string
  clientOrderId: string | null // carries the ttb-/ttr-/ttg- source tag
}

export interface FifoMatch {
  trades: ClosedTrade[]
  /** remaining open entry lots per symbol, OLDEST first ([0] = oldest lot) */
  openLots: Map<string, OpenLot[]>
}

/** Trim binary-float residue from qty arithmetic (0.000453760000000009 → 0.00045376). */
function cleanQty(n: number): number {
  return Number(n.toPrecision(10))
}

/**
 * FIFO-match filled orders into round-trip trades AND report the still-open
 * entry lots per symbol (the same walk — open lots are simply what remains
 * in the FIFO queues when the fills run out, so closed trades and live
 * positions always agree).
 * @param orders raw broker orders (any status mix — only filled ones are used)
 * @param max cap on returned trades (newest first); 0 = lots only
 */
export function matchFifo(orders: TradingOrder[], max = 200): FifoMatch {
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
        ...sourceOf(lot.clientOrderId),
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
        clientOrderId: o.client_order_id ?? null,
      })
    }
    if (q.length > 0) lots.set(o.symbol, q)
    else lots.delete(o.symbol)
  }

  // whatever is left in the queues is still OPEN — one or more live lots per
  // symbol, oldest first (the walk always closes the oldest opposing lot)
  const openLots = new Map<string, OpenLot[]>()
  for (const [sym, q] of lots) {
    if (q.length > 0) {
      openLots.set(
        sym,
        q.map((l) => ({
          side: l.side,
          qty: l.qty,
          price: l.price,
          entryTime: l.time,
          orderId: l.orderId,
          clientOrderId: l.clientOrderId,
        })),
      )
    }
  }

  // newest exits first (the list was built oldest-first)
  return {
    trades: trades
      .sort((a, b) => new Date(b.exitAt).getTime() - new Date(a.exitAt).getTime())
      .slice(0, max),
    openLots,
  }
}

/**
 * FIFO-match filled orders into round-trip trades.
 * @param orders raw broker orders (any status mix — only filled ones are used)
 * @param max cap on returned trades (newest first)
 */
export function matchClosedTrades(orders: TradingOrder[], max = 200): ClosedTrade[] {
  return matchFifo(orders, max).trades
}

/** Resolve algo run refs (8-char AlgoRun id prefixes) → strategy display
 * names. SHARED by /api/trading/history + /api/trading/positions so closed
 * trades, pending orders and open positions label `ttr-` entries identically.
 * Removed runs → 'Algo (run removed)'; DB hiccups degrade to 'Algo'. */
export async function resolveRunStrategyNames(refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const ref of refs) {
    try {
      const run = await db.algoRun.findFirst({ where: { id: { startsWith: ref } }, select: { strategy: true } })
      out.set(ref, run ? (ALGO_STRATEGIES as Record<string, { name: string }>)[run.strategy]?.name ?? 'Algo' : 'Algo (run removed)')
    } catch {
      out.set(ref, 'Algo')
    }
  }
  return out
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
