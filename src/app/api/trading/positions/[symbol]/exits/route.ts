import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { attachExitsToPosition, friendlyExitQtyError, resolveTradeMode } from '@/lib/trading'
import { getMarketHours } from '@/lib/market-hours'
import { isCryptoSymbol } from '@/lib/market-types'
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
    // v2.12.47 — extended-hours doctrine: a TP attached during pre/post must
    // be a RESTING EXTENDED-HOURS LIMIT (tif=day + extended_hours=true) or it
    // can never fill in the thin extended book — the regular-hours gtc limit
    // sits the whole session out. The SL leg stays a regular-session trigger
    // (stop legs cannot execute in extended hours AT ALL — Alpaca only
    // accepts limit orders there): the steward's local synthetic-SL monitor
    // covers the extended session, and the stop re-arms itself at the next
    // regular open. Fail-open: session unavailable → regular legs.
    let extendedTp = false
    let extendedNote: string | undefined
    if (!symbol.includes('/') && !isCryptoSymbol(symbol)) {
      try {
        const mh = await getMarketHours(['SPY'], user.id)
        const st = mh.hours['SPY']?.state
        if (st === 'pre' || st === 'post') {
          extendedTp = true
          extendedNote = `延長交易時段（${st === 'pre' ? 'Pre' : 'Post'}-market）：TP 限價腿以 extended_hours=true 掛出（本交易日有效，延時段可成交）；SL 腿仍為常規時段觸發，盤外由護倉合成 SL 監控`
        }
      } catch { /* session unavailable — regular legs */ }
    }
    const r = await attachExitsToPosition(user.id, mode, symbol, exits, { extendedTp })
    if (r.results.length === 0) {
      return NextResponse.json({ error: friendlyExitQtyError(r.errors.join('; ') || 'Attach failed') }, { status: 502 })
    }
    return NextResponse.json({
      mode,
      orders: r.results,
      oco: r.oco ?? false,
      warnings: r.errors.length ? r.errors : undefined,
      extendedNote,
    })
  } catch (e) {
    return handleError(e)
  }
}
