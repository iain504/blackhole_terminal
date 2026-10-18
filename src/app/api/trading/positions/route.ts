import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import {
  getPositions, getOpenOrders, resolveTradeMode, TradingOrder, TradingPosition,
} from '@/lib/trading'
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

export interface PositionsResponse {
  mode: string
  positions: PositionRow[]
  exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }>
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

    return NextResponse.json({ mode, positions: rows, exits, errors: errors.length ? errors : undefined })
  } catch (e) {
    return handleError(e)
  }
}
