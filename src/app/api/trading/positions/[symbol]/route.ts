import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { closePositionFull, resolveTradeMode } from '@/lib/trading'
import { getMarketHours } from '@/lib/market-hours'
import { getQuotes } from '@/lib/alpaca'
import { isCryptoSymbol } from '@/lib/market-types'
import { EXTENDED_CLOSE_BAND_PCT } from '@/lib/ai-steward-disciplines'
import { handleError } from '@/lib/api-helpers'

// DELETE /api/trading/positions/[symbol]?mode=paper — market-close a position.
// Crypto symbols use the trading form (BTCUSD); slash form also accepted.
// Exit (SL/TP) orders for the symbol are cancelled first — they reserve the
// crypto balance and would otherwise starve the liquidation order.
//
// v2.12.29 — extended-hours discipline (user standing order): Alpaca's
// close-position endpoint submits a MARKET order, which during pre/post
// market is silently queued until the next regular session — a "close now"
// at 18:00 ET would leave the position exposed (and NAKED: its exits were
// just cancelled) for 16+ hours. When the US session is pre/post and a REAL
// quote resolves, the close is placed as a marketable LIMIT (quote ± 1.5% on
// the exit side, tif=day, extended_hours=true) so it executes in the
// extended session — closePositionFull resolves the position side and places
// accordingly (long→sell limits BELOW the quote, short→buy limits ABOVE),
// with the regular close as fallback. Crypto (24/7) is never gated.
export async function DELETE(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { symbol: raw } = await params
    const symbol = decodeURIComponent(raw)
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    let extendedRef: number | null = null
    let extendedNote: string | undefined
    if (!isCryptoSymbol(symbol) && !symbol.includes('/')) {
      try {
        const mh = await getMarketHours(['SPY'], user.id)
        const st = mh.hours['SPY']?.state
        if (st === 'pre' || st === 'post') {
          const { quotes } = await getQuotes([symbol], user.id)
          const ref = Number(quotes[0]?.price)
          if (Number.isFinite(ref) && ref > 0 && !quotes[0]?.sim) {
            extendedRef = ref
            const refStr = ref >= 100 ? ref.toFixed(2) : ref >= 1 ? ref.toFixed(3) : ref.toFixed(5)
            extendedNote = `延長交易時段（${st === 'pre' ? 'Pre' : 'Post'}-market）市價平倉會被擱置至下次開市 — 已自動轉為限價平倉（現價 ${refStr} ±${EXTENDED_CLOSE_BAND_PCT}%，本交易日有效）`
          }
        }
      } catch { /* session/quote unavailable — regular close path */ }
    }
    const { close, canceledExits, extendedClose } = await closePositionFull(
      user.id,
      mode,
      symbol,
      extendedRef != null ? { extendedRef, extendedBandPct: EXTENDED_CLOSE_BAND_PCT } : undefined,
    )
    if (!close.data && close.status !== 204) {
      // v2.12.3 — broker-auth 401 maps to 422 (never HTTP 401: the global
      // 401 watcher would log the user out mid-action).
      const brokerAuth = close.status === 401
      return NextResponse.json(
        {
          error: brokerAuth
            ? `Alpaca rejected the ${mode} API keys — update them in Settings → API keys.`
            : (close.error || 'Close failed'),
        },
        { status: brokerAuth ? 422 : (close.status || 502) },
      )
    }
    return NextResponse.json({ ok: true, mode, order: close.data, canceledExits, extendedNote: extendedClose ? extendedNote : undefined })
  } catch (e) {
    return handleError(e)
  }
}
