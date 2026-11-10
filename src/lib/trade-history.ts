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
export function displaySymbolOf(o: Pick<TradingOrder, 'symbol' | 'asset_class'>): string {
  if (o.symbol.includes('/')) return o.symbol
  if (o.asset_class === 'crypto') return o.symbol.replace(/USD$/, '/USD')
  return o.symbol
}

/** internal alias (the FIFO walk uses it for trade rows) */
const displaySymbol = displaySymbolOf

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
 * 10-k, gridRef = first 8 of the GridTrade id), `tta-` (AI Trade Adviser,
 * v2.12.25) vs `ttb-`/external (manual).
 * The strategy NAME is resolved server-side where the DB lives. */
function sourceOf(entryClientOrderId: string | null): Pick<ClosedTrade, 'source' | 'runRef'> {
  const plan = parseCryptoPlan(entryClientOrderId)
  if (plan?.gridRef) return { source: 'grid', runRef: null }
  if (plan?.aiRef) return { source: 'ai', runRef: null }
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

/** v2.12.28 — FIFO queue key: slash-stripped uppercase symbol. The queues
 * used to key on the RAW order symbol, so a tape that spells the same asset
 * two ways ("BTC/USD" vs "BTCUSD" — Alpaca's echo has drifted across order
 * vintages/endpoints) split one position's fills into TWO queues: the entry
 * lot never met its exit, the round trip never closed, and every LATER exit
 * on that symbol paired with the stale lot — a same-day trade showing a
 * multi-day HELD was the visible symptom. Normalizing the key makes both
 * spellings one bucket; the display symbol still comes from the exit order. */
function queueKey(symbol: string): string {
  return symbol.replace('/', '').toUpperCase()
}

/**
 * FIFO-match filled orders into round-trip trades AND report the still-open
 * entry lots per symbol (the same walk — open lots are simply what remains
 * in the FIFO queues when the fills run out, so closed trades and live
 * positions always agree).
 * @param orders raw broker orders (any status mix — every REAL FILL counts: canceled/expired orders with a partial fill too)
 * @param max cap on returned trades (newest first); 0 = lots only
 */
export function matchFifo(orders: TradingOrder[], max = 200): FifoMatch {
  // v1.95.0 — match REAL FILLS, not 'filled' orders. The old filter dropped
  // any order whose final status wasn't 'filled', which erased whole trades:
  // an entry/exit that PARTIALLY filled and was then canceled (or expired,
  // done_for_day, replaced) carries a real fill (filled_qty > 0,
  // filled_avg_price, filled_at) but ends with status 'canceled'/'expired' —
  // the matcher never saw it, the opposing lot stayed open forever, and the
  // round trip was MISSING from history. An order with zero fill still
  // filters out (filled_qty 0 / no avg price / no fill time), so pure
  // cancels stay invisible exactly as before.
  //
  // v2.12.28 — HELD-BUG fix, layer 1: a fill with filled_qty > 0 but a NULL
  // filled_avg_price (a real Alpaca data quirk on some leg/crypto fills)
  // used to be dropped ENTIRELY — its opposing lot never closed and stayed
  // open forever, so every LATER exit on the symbol paired with that stale
  // lot: "same-day trade shows 7d HELD" was the visible symptom (the P&L of
  // the re-paired trades was wrong too). Such fills now stay in the walk
  // with a price fallback: limit_price → stop_price →, when the fill CLOSES
  // an opposing lot, the lot's own price (P&L contribution honestly 0 —
  // pairing and HELD stay correct). A fill that would OPEN a lot but has no
  // derivable price at all still drops (an unpriceable lot would wreck P&L).
  const filled = orders
    .filter(
      (o) =>
        o.filled_at != null &&
        parseFloat(o.filled_qty || '0') > 0,
    )
    .sort(
      (a, b) =>
        new Date(a.filled_at as string).getTime() - new Date(b.filled_at as string).getTime() ||
        // same-instant fills (a scalp closed within the same clock second, or
        // second-granularity feeds) must process the ENTRY first — otherwise
        // the exit sorts ahead of its own entry and mints an inverted short
        // trade. Older placement wins, then buy-before-sell as a last resort.
        new Date(a.created_at ?? a.filled_at as string).getTime() -
          new Date(b.created_at ?? b.filled_at as string).getTime() ||
        (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1),
    )

  const lots = new Map<string, Lot[]>() // per symbol FIFO queue
  const trades: ClosedTrade[] = []
  let seq = 0

  for (const o of filled) {
    // v2.12.28 — price fallback chain for the null-filled_avg_price rescue
    // (see the filter comment): broker avg → limit → stop; null = "real fill,
    // unpriceable from this order alone" — the close loop below prices it
    // from the lot it closes (honest 0 P&L) or the fill is dropped if it
    // would have to OPEN a lot.
    const avg = parseFloat(o.filled_avg_price ?? '')
    const fb = Number.isFinite(avg)
      ? avg
      : parseFloat(o.limit_price ?? '') || parseFloat(o.stop_price ?? '')
    const exitPrice = Number.isFinite(fb) && fb > 0 ? fb : null
    let remaining = parseFloat(o.filled_qty)
    const key = queueKey(o.symbol)
    const q = lots.get(key) ?? []

    // close the oldest opposing lots first
    while (remaining > EPS && q.length > 0 && q[0].side !== o.side) {
      const lot = q[0]
      const take = Math.min(lot.qty, remaining)
      const long = lot.side === 'buy'
      // unpriceable exit fill closes the lot at the lot's own price: the
      // pairing (and therefore HELD) stays truthful, P&L honestly 0
      const px = exitPrice ?? lot.price
      const pnl = (long ? px - lot.price : lot.price - px) * take
      const exitAt = o.filled_at as string
      const entryAt = lot.time
      trades.push({
        id: `${lot.orderId}:${o.id}:${seq++}`,
        symbol: displaySymbol(o),
        side: long ? 'long' : 'short',
        qty: cleanQty(take),
        entryPrice: lot.price,
        exitPrice: px,
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

    // whatever remains increases the position → new lot (needs a price —
    // an unpriceable fill can only ever CLOSE, never OPEN)
    if (remaining > EPS && exitPrice != null) {
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
    if (q.length > 0) lots.set(key, q)
    else lots.delete(key)
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
 * @param orders raw broker orders (any status mix — every REAL FILL counts: canceled/expired orders with a partial fill too)
 * @param max cap on returned trades (newest first)
 */
export function matchClosedTrades(orders: TradingOrder[], max = 200): ClosedTrade[] {
  return matchFifo(orders, max).trades
}

/** v2.12.28 — HELD-BUG fix, layer 2: WINDOW-TRUNCATION ghost lots. The
 * closed-orders tape is the newest N orders; when a position STRADDLES the
 * window boundary (its entry is older than the tape), the walk sees that
 * position's EXIT fill with no lot to close and mints a SYNTHETIC opposing
 * lot at the exit's price/time. That phantom then STEALS later real exits:
 * a same-day round trip pairs against the phantom (multi-day HELD + wrong
 * P&L) while the user's actual entry lot never closes. Detection: after the
 * walk, an open lot whose symbol has NO live position — or whose side
 * contradicts the live side — is a ghost the tape couldn't explain. Callers
 * widen the tape (older pages) and re-walk until every lot maps to a live
 * position or a cap is reached; a REAL short position (sell lot + short
 * side) is consistent and never flagged.
 * @param openLots matchFifo's open lots (keys are normed symbols)
 * @param positions the account's CURRENT live positions (raw broker shape)
 */
export function ghostLotSymbols(
  openLots: Map<string, OpenLot[]>,
  positions: { symbol: string; side: string }[],
): string[] {
  const byNorm = new Map<string, string>()
  for (const p of positions) byNorm.set(queueKey(p.symbol), p.side)
  const ghosts: string[] = []
  for (const [sym, lots] of openLots) {
    const lotSide = lots[0]?.side
    if (!lotSide) continue
    const posSide = byNorm.get(sym)
    if (!posSide) {
      ghosts.push(sym) // lot with NO live position at all — the tape missed its exit
      continue
    }
    // side contradiction: a buy lot under a short position (or vice versa)
    const lotLong = lotSide === 'buy'
    const posLong = posSide !== 'short'
    if (lotLong !== posLong) ghosts.push(sym)
  }
  return ghosts
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
