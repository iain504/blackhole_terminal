import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

interface PatchBody {
  price?: number
  direction?: string
  color?: string
  status?: string // 'active' | 'paused'
  note?: string
}

// PATCH /api/alerts/[id] — edit value / color / pause / resume
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await readJson<PatchBody>(req)
    const a = await db.alert.findFirst({ where: { id, userId: user.id } })
    if (!a) return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
    const data: Record<string, unknown> = {}
    if (typeof body.price === 'number' && isFinite(body.price)) {
      data.price = body.price
      data.status = 'active'
      data.triggeredAt = null
    }
    if (body.direction === 'above' || body.direction === 'below') {
      data.direction = body.direction
      data.lastSide = body.direction === 'above' ? 'below' : 'above'
      data.status = 'active'
      data.triggeredAt = null
    }
    if (typeof body.color === 'string') data.color = body.color
    if (body.status === 'active' || body.status === 'paused') data.status = body.status
    if (typeof body.note === 'string') data.note = body.note.slice(0, 200)
    const updated = await db.alert.update({ where: { id }, data })
    return NextResponse.json({
      alert: {
        id: updated.id, symbol: updated.symbol, price: updated.price, direction: updated.direction,
        color: updated.color, status: updated.status, note: updated.note,
        triggeredAt: updated.triggeredAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
      },
    })
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
