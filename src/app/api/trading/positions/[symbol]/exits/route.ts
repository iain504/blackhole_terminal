import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { attachExitsToPosition, friendlyExitQtyError, resolveTradeMode } from '@/lib/trading'
import { handleError, readJson } from '@/lib/api-helpers'

interface AttachBody {
  mode?: string
  /** take-profit limit price */
  tp?: number
  /** stop-loss trigger price */
  sl?: number
}

// POST /api/trading/positions/[symbol]/exits — attach a TP and/or SL to an
// EXISTING open position (chart "+TP"/"+SL" chip drag / Positions-tab buttons).
// Stocks: order_class=oco when both legs are given (split-leg fallback);
// crypto: emulated split exit legs. Prices are precision-rounded server-side.
export async function POST(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { symbol: raw } = await params
    const symbol = decodeURIComponent(raw)
    const body = await readJson<AttachBody>(req)
    const mode = await resolveTradeMode(user.id, body.mode)
    const exits: { tp?: number; sl?: number } = {}
    if (typeof body.tp === 'number' && body.tp > 0) exits.tp = body.tp
    if (typeof body.sl === 'number' && body.sl > 0) exits.sl = body.sl
    if (Object.keys(exits).length === 0) {
      return NextResponse.json({ error: 'tp or sl price required' }, { status: 400 })
    }
    const r = await attachExitsToPosition(user.id, mode, symbol, exits)
    if (r.results.length === 0) {
      return NextResponse.json({ error: friendlyExitQtyError(r.errors.join('; ') || 'Attach failed') }, { status: 502 })
    }
    return NextResponse.json({
      mode,
      orders: r.results,
      oco: r.oco ?? false,
      warnings: r.errors.length ? r.errors : undefined,
    })
  } catch (e) {
    return handleError(e)
  }
}
