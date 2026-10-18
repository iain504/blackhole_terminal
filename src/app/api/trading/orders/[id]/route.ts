import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { replaceExitOrderSmart, replacePendingEntrySmart, cancelOrder, resolveTradeMode } from '@/lib/trading'
import { readJson, handleError } from '@/lib/api-helpers'

interface ReplaceBody {
  mode?: string
  /** asset is crypto — switches price rounding to 6/8dp (9dp limit) instead of penny ticks */
  crypto?: boolean
  stop_price?: number
  limit_price?: number
  trail_percent?: number
  // pending ENTRY edits (drag the dashed entry / (pend) TP / SL lines or edit
  // them from the Positions tab) — routed to replacePendingEntrySmart
  entry_limit?: number
  tp_price?: number
  sl_price?: number
}

// PATCH /api/trading/orders/[id] — replace SL/TP prices (chart line drag) or
// change a PENDING entry's limit/TP/SL (drag the dashed lines).
// Smart replace: PATCH with automatic paper/live host fallback (the drag used
// to hit the wrong host and silently never land), then cancel+re-place
// fallback for orders that refuse direct replacement (bracket OCO legs,
// crypto ttb- plan entries). Alpaca returns a replacement order with a NEW id.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const body = await readJson<ReplaceBody>(req)
    const mode = await resolveTradeMode(user.id, body.mode)
    const crypto = Boolean(body.crypto)

    // pending ENTRY edit (entry limit price / planned TP / planned SL)
    const entryPatch: { limit_price?: number; tp?: number; sl?: number } = {}
    if (typeof body.entry_limit === 'number' && body.entry_limit > 0) entryPatch.limit_price = body.entry_limit
    if (typeof body.tp_price === 'number' && body.tp_price > 0) entryPatch.tp = body.tp_price
    if (typeof body.sl_price === 'number' && body.sl_price > 0) entryPatch.sl = body.sl_price
    if (Object.keys(entryPatch).length > 0) {
      const r = await replacePendingEntrySmart(user.id, mode, id, { ...entryPatch, crypto })
      if (!r.data) {
        return NextResponse.json({ error: r.error || 'Update failed' }, { status: r.status || 502 })
      }
      return NextResponse.json({ mode: r.mode, order: r.data, method: r.method, note: r.note })
    }

    const patch: { stop_price?: number; limit_price?: number; trail_percent?: number; crypto?: boolean } = {}
    if (typeof body.stop_price === 'number' && body.stop_price > 0) patch.stop_price = body.stop_price
    if (typeof body.limit_price === 'number' && body.limit_price > 0) patch.limit_price = body.limit_price
    if (typeof body.trail_percent === 'number' && body.trail_percent > 0) patch.trail_percent = body.trail_percent
    patch.crypto = crypto
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing to replace' }, { status: 400 })
    }
    const r = await replaceExitOrderSmart(user.id, mode, id, patch)
    if (!r.data) {
      return NextResponse.json({ error: r.error || 'Replace failed' }, { status: r.status || 502 })
    }
    return NextResponse.json({ mode: r.mode, order: r.data, method: r.method, note: r.note })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/trading/orders/[id] — cancel an open exit order
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const r = await cancelOrder(user.id, mode, id)
    if (r.status !== 204 && r.status !== 200) {
      return NextResponse.json({ error: r.error || 'Cancel failed' }, { status: r.status || 502 })
    }
    return NextResponse.json({ ok: true, mode })
  } catch (e) {
    return handleError(e)
  }
}
