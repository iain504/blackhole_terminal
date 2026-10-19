import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { toDto } from '../route'

interface PatchBody {
  price?: number
  direction?: string
  color?: string
  status?: string // 'active' | 'paused'
  note?: string
}

// PATCH /api/alerts/[id] — edit value / color / pause / resume.
// Editing the level or direction re-arms the alarm (status active, triggeredAt
// cleared). Price alerts seed lastSide to the opposite side (legacy immediate
// semantics); indicator alarms reset lastSide to null so the next check just
// records the current side and only a REAL crossing afterwards fires.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await readJson<PatchBody>(req)
    const a = await db.alert.findFirst({ where: { id, userId: user.id } })
    if (!a) return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
    const isPrice = a.kind === 'price'
    const data: Record<string, unknown> = {}
    if (typeof body.price === 'number' && isFinite(body.price)) {
      data.price = isPrice ? body.price : Math.min(100, Math.max(0, body.price))
      data.status = 'active'
      data.triggeredAt = null
      data.lastSide = isPrice ? (a.direction === 'above' ? 'below' : 'above') : null
    }
    if (body.direction === 'above' || body.direction === 'below') {
      data.direction = body.direction
      data.lastSide = isPrice ? (body.direction === 'above' ? 'below' : 'above') : null
      data.status = 'active'
      data.triggeredAt = null
    }
    if (typeof body.color === 'string') data.color = body.color
    if (body.status === 'active' || body.status === 'paused') {
      data.status = body.status
      if (body.status === 'active' && !isPrice && a.status === 'triggered') {
        // resuming a triggered indicator alarm re-arms it from the current side
        data.lastSide = null
        data.triggeredAt = null
      }
    }
    if (typeof body.note === 'string') data.note = body.note.slice(0, 200)
    const updated = await db.alert.update({ where: { id }, data })
    return NextResponse.json({ alert: toDto(updated) })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/alerts/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const a = await db.alert.findFirst({ where: { id, userId: user.id } })
    if (!a) return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
    await db.alert.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
