import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJsonSafe, drawingPatchSchema, zodBadRequest } from '@/lib/validation'
import { handleError } from '@/lib/api-helpers'

// PATCH /api/drawings/[id] — move/resize/recolor after draw.
// Body parse-then-validated (zod); present fields are applied exactly as before
// (points replace, color/width update, meta null clears — meta !== undefined).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const raw = await readJsonSafe(req)
    const parsed = drawingPatchSchema.safeParse(raw)
    if (!parsed.success) return zodBadRequest(parsed.error)
    const body = parsed.data
    const d = await db.drawing.findFirst({ where: { id, userId: user.id } })
    if (!d) return NextResponse.json({ error: 'Drawing not found' }, { status: 404 })
    const data: Prisma.DrawingUpdateInput = {}
    if (body.points !== undefined) data.points = body.points as unknown as Prisma.InputJsonValue
    if (body.color !== undefined) data.color = body.color
    if (body.width !== undefined) data.width = body.width
    if (body.meta !== undefined) data.meta = body.meta ? (body.meta as unknown as Prisma.InputJsonValue) : Prisma.JsonNull
    const updated = await db.drawing.update({ where: { id }, data })
    return NextResponse.json({
      drawing: {
        id: updated.id, symbol: updated.symbol, kind: updated.kind,
        points: Array.isArray(updated.points) ? (updated.points as unknown as { time?: number | null; price: number }[]) : [],
        color: updated.color, width: updated.width,
        meta: (updated.meta as unknown as Record<string, unknown> | null) ?? null,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/drawings/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const d = await db.drawing.findFirst({ where: { id, userId: user.id } })
    if (!d) return NextResponse.json({ error: 'Drawing not found' }, { status: 404 })
    await db.drawing.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
