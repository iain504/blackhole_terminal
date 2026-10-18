import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { closePosition, resolveTradeMode } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

// DELETE /api/trading/positions/[symbol]?mode=paper — market-close a position.
// Crypto symbols use the trading form (BTCUSD); slash form also accepted.
export async function DELETE(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { symbol: raw } = await params
    const symbol = decodeURIComponent(raw)
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const r = await closePosition(user.id, mode, symbol)
    if (!r.data && r.status !== 204) {
      return NextResponse.json({ error: r.error || 'Close failed' }, { status: r.status || 502 })
    }
    return NextResponse.json({ ok: true, mode, order: r.data })
  } catch (e) {
    return handleError(e)
  }
}
