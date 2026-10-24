import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJsonSafe, drawingCreateSchema, zodBadRequest } from '@/lib/validation'
import { handleError } from '@/lib/api-helpers'

interface DrawingPoint {
  time?: number | null
  price: number
}

export interface DrawingDto {
  id: string
  symbol: string
  kind: string
  points: DrawingPoint[]
  color: string
  width: number
  meta: Record<string, unknown> | null
}

// GET /api/drawings?symbol=AAPL — drawings for symbol
export async function GET(req: Request) {
  try {
    const user = await requireUser()
    const { searchParams } = new URL(req.url)
    const symbol = (searchParams.get('symbol') || '').toUpperCase()
    if (!symbol) return NextResponse.json({ drawings: [] })
    const rows = await db.drawing.findMany({
      where: { userId: user.id, symbol },
      orderBy: { createdAt: 'asc' },
    })
    const drawings: DrawingDto[] = rows.map((d) => ({
      id: d.id,
      symbol: d.symbol,
      kind: d.kind,
      points: Array.isArray(d.points) ? (d.points as unknown as DrawingPoint[]) : [],
      color: d.color,
      width: d.width,
      meta: (d.meta as unknown as Record<string, unknown> | null) ?? null,
    }))
    return NextResponse.json({ drawings })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/drawings — create.
// Body parse-then-validated (zod): symbol charset, kind whitelist (matches the
// client's DrawingKind), point shape ({time, price, pane}), color hex, width
// 1..10, bounded meta — 400 'Invalid body' with the first issue message.
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const raw = await readJsonSafe(req)
    const parsed = drawingCreateSchema.safeParse(raw)
    if (!parsed.success) return zodBadRequest(parsed.error)
    const body = parsed.data
    const symbol = body.symbol.toUpperCase()
    const d = await db.drawing.create({
      data: {
        userId: user.id,
        symbol,
        kind: body.kind,
        points: body.points as unknown as Prisma.InputJsonValue,
        color: body.color || '#2962ff',
        width: body.width || 2,
        meta: body.meta ? (body.meta as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    })
    return NextResponse.json({
      drawing: {
        id: d.id, symbol: d.symbol, kind: d.kind,
        points: Array.isArray(d.points) ? (d.points as unknown as DrawingPoint[]) : [],
        color: d.color, width: d.width,
        meta: (d.meta as unknown as Record<string, unknown> | null) ?? null,
      } satisfies DrawingDto,
    })
  } catch (e) {
    return handleError(e)
  }
}
