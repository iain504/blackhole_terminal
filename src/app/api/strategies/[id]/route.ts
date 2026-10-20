import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { toDto } from '../route'

interface PatchBody {
  status?: string // 'armed' | 'paused'
  repeat?: boolean
  qty?: number
  tpMode?: string
  tpValue?: number | null
  slMode?: string
  slValue?: number | null
}

// pct values are PERCENT magnitudes (2 = 2%)
const clampPct = (v: number) => Math.min(100, Math.max(0.01, v))

// PATCH /api/strategies/[id] — pause / re-arm / edit action side of a rule.
// Re-arming (from triggered/failed/paused → armed) resets lastSide to null so
// the next check just records the current side and only a REAL crossing
// afterwards fires (same semantics as indicator alarms).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await readJson<PatchBody>(req)
    const r = await db.strategyRule.findFirst({ where: { id, userId: user.id } })
    if (!r) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if (body.status === 'armed' || body.status === 'paused') {
      data.status = body.status
      if (body.status === 'armed') {
        // fresh crossing memory on every re-arm
        data.lastSide = null
        data.triggeredAt = null
        data.fireNote = null
      }
    }
    if (typeof body.repeat === 'boolean') data.repeat = body.repeat
    if (typeof body.qty === 'number' && body.qty > 0 && Number.isFinite(body.qty)) data.qty = body.qty
    if (body.tpMode === 'none' || body.tpMode === 'price' || body.tpMode === 'pct') {
      data.tpMode = body.tpMode
      if (body.tpMode === 'none') data.tpValue = null
      else if (body.tpValue != null && Number.isFinite(body.tpValue)) {
        data.tpValue = body.tpMode === 'pct' ? clampPct(body.tpValue) : body.tpValue
      }
    }
    if (body.slMode === 'none' || body.slMode === 'price' || body.slMode === 'pct') {
      data.slMode = body.slMode
      if (body.slMode === 'none') data.slValue = null
      else if (body.slValue != null && Number.isFinite(body.slValue)) {
        data.slValue = body.slMode === 'pct' ? clampPct(body.slValue) : body.slValue
      }
    }

    const updated = await db.strategyRule.update({ where: { id }, data })
    return NextResponse.json({ strategy: toDto(updated) })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/strategies/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const r = await db.strategyRule.findFirst({ where: { id, userId: user.id } })
    if (!r) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 })
    await db.strategyRule.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
