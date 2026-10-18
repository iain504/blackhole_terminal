import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import {
  getPositions, getOpenOrders, resolveTradeMode, ensureCryptoOcoSupervisor,
  TradingOrder, TradingPosition,
} from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

/** Chart symbol (AAPL, BTC/USD) -> trading symbol (AAPL, BTCUSD). */
function normSymbol(s: string): string {
  return s.replace('/', '').toUpperCase()
}

/** Decode the crypto OCO plan encoded by trading.ts in a `ttb-…` client_order_id. */
function parsePlanFromClientId(clientOrderId: string | undefined | null): { tp: number | null; sl: number | null } | null {
  const m = /^ttb-[a-z](?:-tp(\d+))?(?:-sl(\d+))?-/.exec(clientOrderId || '')
  if (!m) return null
  const dec = (s: string | undefined) => (s ? parseInt(s, 10) / 1e6 : 0)
  const tp = dec(m[1])
  const sl = dec(m[2])
  return { tp: tp > 0 ? tp : null, sl: sl > 0 ? sl : null }
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

    const [posRes, ordRes] = await Promise.all([
      getPositions(user.id, mode),
      getOpenOrders(user.id, mode, symbolParam || undefined),
    ])
    const errors: string[] = []
    if (posRes.error && posRes.error !== 'no-keys') errors.push(posRes.error)
    if (ordRes.error && ordRes.error !== 'no-keys') errors.push(ordRes.error)

    // A failed fetch (401 on live with paper-only keys, network error) returns
    // an error OBJECT — only treat real arrays as data or the .filter below
    // crashes the whole route.
    const positions: TradingPosition[] = Array.isArray(posRes.data) ? posRes.data : []
    const orders: TradingOrder[] = Array.isArray(ordRes.data) ? ordRes.data : []

    const rows: PositionRow[] = positions
      .filter((p) => !symbolParam || normSymbol(p.symbol) === normSymbol(symbolParam))
      .map((p) => ({
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
      }))

    // Map open exit orders (SL/TP legs) onto positions by symbol.
    const exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }> = {}
    const byTradeSym = new Map(rows.map((r) => [normSymbol(r.tradeSymbol), r]))
    const visit = (o: TradingOrder) => {
      const key = normSymbol(o.symbol)
      if (byTradeSym.has(key)) {
        const bucket = exits[key] || {}
        const sideOppositeLong = o.side === 'sell'
        if ((o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop') && sideOppositeLong) {
          bucket.sl = {
            orderId: o.id,
            kind: 'sl',
            stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
            limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
            trailPercent: o.trail_percent ? parseFloat(o.trail_percent) : null,
            qty: o.qty,
            side: o.side,
            type: o.type,
          }
        } else if (o.type === 'limit' && sideOppositeLong) {
          bucket.tp = {
            orderId: o.id,
            kind: 'tp',
            stopPrice: null,
            limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
            trailPercent: null,
            qty: o.qty,
            side: o.side,
            type: o.type,
          }
        }
        exits[key] = bucket
      }
    }
    for (const o of orders) {
      visit(o)
      for (const leg of o.legs || []) visit(leg)
    }

    // ---- pending (unfilled) ENTRY orders for the chart ----
    // Bracket parents (stocks) carry their TP/SL as legs; crypto entries
    // carry the planned TP/SL in the client_order_id (`ttb-…`, decoded here).
    // Excluded: legs of other orders, our managed `tte-` exit legs, and —
    // when a position exists — orders on the OPPOSITE side (those already
    // classify as SL/TP exits above).
    const legIds = new Set<string>(orders.flatMap((o) => (o.legs || []).map((l) => l.id)))
    const pending: PendingOrderRow[] = []
    for (const o of orders) {
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
      const plan = parsePlanFromClientId(o.client_order_id)
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
        createdAt: o.created_at,
      })
    }

    return NextResponse.json({ mode, positions: rows, exits, pending, errors: errors.length ? errors : undefined })
  } catch (e) {
    return handleError(e)
  }
}
