import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { closePositionFull, resolveTradeMode } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

// DELETE /api/trading/positions/[symbol]?mode=paper — market-close a position.
// Crypto symbols use the trading form (BTCUSD); slash form also accepted.
// Exit (SL/TP) orders for the symbol are cancelled first — they reserve the
// crypto balance and would otherwise starve the liquidation order.
export async function DELETE(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { symbol: raw } = await params
    const symbol = decodeURIComponent(raw)
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const { close, canceledExits } = await closePositionFull(user.id, mode, symbol)
    if (!close.data && close.status !== 204) {
      return NextResponse.json({ error: close.error || 'Close failed' }, { status: close.status || 502 })
    }
    return NextResponse.json({ ok: true, mode, order: close.data, canceledExits })
  } catch (e) {
    return handleError(e)
  }
}
