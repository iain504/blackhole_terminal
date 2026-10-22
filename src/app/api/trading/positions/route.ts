import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import {
  getPositions, getOpenOrders, getClosedOrders, resolveTradeMode, ensureCryptoOcoSupervisor,
  TradingOrder, TradingPosition, parseCryptoPlan,
} from '@/lib/trading'
import { matchFifo, resolveRunStrategyNames, type OpenLot } from '@/lib/trade-history'
import { ensureFillNotifier } from '@/lib/fill-notifier'
import { handleError } from '@/lib/api-helpers'

/** Chart symbol (AAPL, BTC/USD) -> trading symbol (AAPL, BTCUSD). */
function normSymbol(s: string): string {
  return s.replace('/', '').toUpperCase()
}

export interface ExitInfo {
  orderId: string
  kind: 'sl' | 'tp'
  stopPrice: number | null
  limitPrice: number | null
  trailPercent: number | null
  qty: string
  side: string
  type: string
  /** Alpaca status — 'held' = the ARMED sibling of a live OCO family */
  status: string
}

export interface PositionRow {
  symbol: string // chart-style symbol (BTC/USD for crypto)
  tradeSymbol: string
  qty: number
  qtyAvailable: number
  side: string
  avgEntry: number
  current: number
  upl: number
  uplPct: number
  assetClass: string
  /** entry fill time of the OLDEST still-open FIFO entry lot (null = unknown,
   * e.g. the entry fill predates the closed-orders window) */
  openedAt: string | null
  /** placement source decoded from that lot's client_order_id — absent when
   * no open lot was found (rendered as '—' like other unknown columns) */
  source?: 'manual' | 'algo'
  /** when source === 'algo': first 8 chars of the originating AlgoRun id */
  runRef?: string | null
  /** when source === 'algo': strategy display name (resolved from AlgoRun) */
  strategy?: string
}

/** An open ENTRY order (not yet — or not fully — filled) for the chart. */
export interface PendingOrderRow {
  orderId: string
  symbol: string // chart-style (crypto orders keep the slash)
  side: string
  type: string
  qty: number
  filledQty: number
  limitPrice: number | null
  status: string
  /** planned/attached take-profit price (bracket legs or the ttb- plan) */
  tpPrice: number | null
  /** planned/attached stop-loss price */
  slPrice: number | null
  /** true when TP/SL ride along (managed complex order) */
  managed: boolean
  /** placement source: algo entries carry a `ttr-` client_order_id */
  source: 'manual' | 'algo'
  /** strategy display name when source === 'algo' (resolved from AlgoRun) */
  strategy?: string
  createdAt: string | null
}

export interface PositionsResponse {
  mode: string
  positions: PositionRow[]
  exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }>
  pending: PendingOrderRow[]
  errors?: string[]
}

// GET /api/trading/positions?mode=paper&symbol=BTC/USD
// Returns open positions + their attached SL/TP exit orders (for chart lines).
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const symbolParam = (searchParams.get('symbol') || '').trim()
    // keep the crypto complex-order emulation running (OCO attach + cleanup)
    ensureCryptoOcoSupervisor(user.id, mode)
    // keep the Telegram fill/position-close watcher's cursor advancing
    ensureFillNotifier(user.id, mode)

    const posRes = await getPositions(user.id, mode)
    const errors: string[] = []
    if (posRes.error && posRes.error !== 'no-keys') errors.push(posRes.error)

    // A failed fetch (401 on live with paper-only keys, network error) returns
    // an error OBJECT — only treat real arrays as data or the .filter below
    // crashes the whole route.
    const positions: TradingPosition[] = Array.isArray(posRes.data) ? posRes.data : []

    // Symbols with live positions drive the held-leg recovery sweep in
    // getOpenOrders (the armed SL leg of a FILLED bracket is invisible to a
    // status=open query). ORDER symbols keep the crypto slash (BTC/USD) while
    // POSITION symbols drop it (BTCUSD) — pass the order-symbol form.
    const heldSymbols = [...new Set(positions.map((p) => (p.asset_class === 'crypto' ? (p.symbol.includes('/') ? p.symbol : `${p.symbol.replace(/USD$/, '')}/USD`) : p.symbol)))]
    const chartKey = symbolParam ? normSymbol(symbolParam) : null
    const sweepSymbols = chartKey ? heldSymbols.filter((s) => normSymbol(s) === chartKey) : heldSymbols

    // Open orders + filled closed orders in PARALLEL: exits/pending come from
    // the open list; the FIFO matcher (trade-history) walks the closed fills
    // to find each position's still-open entry lot → openedAt + source.
    const [ordRes, closedRes] = await Promise.all([
      getOpenOrders(user.id, mode, symbolParam || undefined, sweepSymbols),
      getClosedOrders(user.id, mode, 500),
    ])
    if (ordRes.error && ordRes.error !== 'no-keys') errors.push(ordRes.error)
    if (closedRes.error && closedRes.error !== 'no-keys') errors.push(closedRes.error)
    const orders: TradingOrder[] = Array.isArray(ordRes.data) ? ordRes.data : []
    const closedOrders: TradingOrder[] = Array.isArray(closedRes.data) ? closedRes.data : []
    // max=0: closed TRADES are not needed here — only the open lots per symbol
    const openLots = matchFifo(closedOrders, 0).openLots
    // Task 79 — FIFO lot keys keep the crypto slash (ORDER symbols are
    // 'BTC/USD') while POSITION symbols drop it ('BTCUSD'), so the direct
    // `openLots.get(p.symbol)` lookup missed EVERY crypto position and their
    // source degraded to unknown/Manual even for algo-placed entries. Index
    // the lots by the normalized key (slash stripped, uppercased) so both
    // spellings resolve to the same bucket.
    const openLotsByNorm = new Map<string, OpenLot[]>()
    for (const [sym, lots] of openLots) openLotsByNorm.set(normSymbol(sym), lots)

    const rows: PositionRow[] = positions
      .filter((p) => !symbolParam || normSymbol(p.symbol) === normSymbol(symbolParam))
      .map((p) => {
        // OLDEST still-open FIFO entry lot for this symbol → when the position
        // was opened + who placed it (ttb-… manual · ttr-… algo run). Lookup is
        // normalized (Task 79) so crypto 'BTCUSD' positions find 'BTC/USD' lots.
        const lot = openLotsByNorm.get(normSymbol(p.symbol))?.[0]
        const lotPlan = lot ? parseCryptoPlan(lot.clientOrderId) : null
        return {
          symbol: p.symbol.includes('/') ? p.symbol : p.asset_class === 'crypto' ? p.symbol.replace(/USD$/, '/USD') : p.symbol,
          tradeSymbol: p.symbol,
          qty: parseFloat(p.qty) || 0,
          qtyAvailable: parseFloat(p.qty_available) || 0,
          side: p.side,
          avgEntry: parseFloat(p.avg_entry_price) || 0,
          current: parseFloat(p.current_price) || 0,
          upl: parseFloat(p.unrealized_pl) || 0,
          uplPct: (parseFloat(p.unrealized_plpc) || 0) * 100,
          assetClass: p.asset_class,
          openedAt: lot?.entryTime ?? null,
          ...(lot ? { source: lotPlan?.runRef ? ('algo' as const) : ('manual' as const) } : {}),
          runRef: lotPlan?.runRef ?? null,
        }
      })

    // Map open exit orders (SL/TP legs) onto positions by symbol.
    const exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }> = {}
    const byTradeSym = new Map(rows.map((r) => [normSymbol(r.tradeSymbol), r]))
    // Legs nested under a NOT-yet-filled parent belong to a PENDING entry
    // family — they are future legs, not exits of the open position (a held
    // leg OPPOSITE its parent's side marks exactly that case). Held legs of
    // FILLED families are armed OCO siblings — real exits. The same leg can
    // ALSO appear flat (top-level, no parent) in the merged order list: the
    // pendingFamilyLegIds set keeps that shape from being double-counted as
    // an exit of an older position on the same symbol.
    const pendingFamilyLegIds = new Set<string>()
    for (const o of orders) {
      if (o.status === 'filled') continue
      for (const leg of o.legs || []) pendingFamilyLegIds.add(leg.id)
    }
    const visit = (o: TradingOrder, parent?: TradingOrder) => {
      if (o.status === 'held') {
        if (!parent) {
          // Flat held leg: the armed sibling of a FILLED bracket/OCO family
          // (recovered by the held-leg sweep) — a real exit. Skip it only
          // when it also nests under an open UNFILLED parent (pending entry).
          if (pendingFamilyLegIds.has(o.id)) return
        } else if (parent.status !== 'filled' && parent.side !== o.side) {
          // Held leg under an unfilled parent on the OPPOSITE side = pending
          // entry's future leg. (A held leg on the SAME side as its parent is
          // the armed sibling of a live OCO EXIT — Alpaca keeps the stop_loss
          // leg `held` while the take_profit leg works — and IS a real exit.)
          return
        }
      }
      const key = normSymbol(o.symbol)
      if (byTradeSym.has(key)) {
        const bucket = exits[key] || {}
        // exits ride the side OPPOSITE the position: a long exits with SELL
        // orders, a SHORT exits with BUY orders (side-aware fix — a short's
        // buy-side TP/SL used to be invisible)
        const posSide = byTradeSym.get(key)!.side
        const isExitSide = posSide === 'short' ? o.side === 'buy' : o.side === 'sell'
        if ((o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop') && isExitSide) {
          bucket.sl = {
            orderId: o.id,
            kind: 'sl',
            stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
            limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
            trailPercent: o.trail_percent ? parseFloat(o.trail_percent) : null,
            qty: o.qty,
            side: o.side,
            type: o.type,
            status: o.status,
          }
        } else if (o.type === 'limit' && isExitSide) {
          bucket.tp = {
            orderId: o.id,
            kind: 'tp',
            stopPrice: null,
            limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
            trailPercent: null,
            qty: o.qty,
            side: o.side,
            type: o.type,
            status: o.status,
          }
        }
        exits[key] = bucket
      }
    }
    for (const o of orders) {
      visit(o)
      for (const leg of o.legs || []) visit(leg, o)
    }

    // ---- pending (unfilled) ENTRY orders for the chart ----
    // Bracket parents (stocks) carry their TP/SL as legs; entries placed by
    // this terminal carry the planned TP/SL in the client_order_id (`ttb-`/
    // `ttr-`, decoded here — `ttr-` also marks the order as an ALGO entry).
    // Excluded: legs of other orders, our managed `tte-` exit legs, and —
    // when a position exists — orders on the OPPOSITE side (those already
    // classify as SL/TP exits above).
    const legIds = new Set<string>(orders.flatMap((o) => (o.legs || []).map((l) => l.id)))
    // batch-resolve algo run refs → strategy names: pending rows AND position
    // open lots share ONE resolver (trade-history) so labels stay consistent
    const pendingPlans = orders.map((o) => ({ o, plan: parseCryptoPlan(o.client_order_id) }))
    const pendingRefs = [...new Set(pendingPlans.map(({ plan }) => plan?.runRef).filter((x): x is string => !!x))]
    const lotRefs = rows.map((r) => r.runRef).filter((x): x is string => !!x)
    const stratNames = await resolveRunStrategyNames([...new Set([...lotRefs, ...pendingRefs])])
    // attach strategy names to algo-attributed positions
    const enrichedRows = rows.map((r) =>
      r.source === 'algo' && r.runRef ? { ...r, strategy: stratNames.get(r.runRef) ?? 'Algo' } : r,
    )
    const pending: PendingOrderRow[] = []
    for (const { o, plan } of pendingPlans) {
      if (legIds.has(o.id)) continue
      if ((o.client_order_id || '').startsWith('tte-')) continue
      const key = normSymbol(o.symbol)
      if (symbolParam && key !== normSymbol(symbolParam)) continue
      const pos = byTradeSym.get(key)
      // an order on the opposite side of the position is an EXIT (already
      // mapped above); position side is long/short, order side is buy/sell
      const entrySide = pos ? (pos.side === 'long' ? 'buy' : 'sell') : null
      if (pos && o.side !== entrySide) continue
      let tpPrice: number | null = null
      let slPrice: number | null = null
      for (const leg of o.legs || []) {
        if (leg.side === o.side) continue
        if (leg.type === 'limit' && leg.limit_price) tpPrice = parseFloat(leg.limit_price)
        if ((leg.type === 'stop' || leg.type === 'stop_limit') && leg.stop_price) slPrice = parseFloat(leg.stop_price)
      }
      if (plan) {
        if (plan.tp != null) tpPrice = plan.tp
        if (plan.sl != null) slPrice = plan.sl
      }
      pending.push({
        orderId: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        qty: parseFloat(o.qty) || 0,
        filledQty: parseFloat(o.filled_qty) || 0,
        limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
        status: o.status,
        tpPrice,
        slPrice,
        managed: Boolean(plan) || (o.legs?.length ?? 0) > 0,
        source: plan?.runRef ? 'algo' : 'manual',
        strategy: plan?.runRef ? stratNames.get(plan.runRef) : undefined,
        createdAt: o.created_at,
      })
    }

    return NextResponse.json({ mode, positions: enrichedRows, exits, pending, errors: errors.length ? errors : undefined })
  } catch (e) {
    return handleError(e)
  }
}
