import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

export interface AlertDto {
  id: string
  symbol: string
  price: number
  direction: string
  color: string
  status: string
  note: string | null
  triggeredAt: string | null
  createdAt: string
}

// GET /api/alerts — all alerts for user
export async function GET() {
  try {
    const user = await requireUser()
    const rows = await db.alert.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
    const alerts: AlertDto[] = rows.map((a) => ({
      id: a.id, symbol: a.symbol, price: a.price, direction: a.direction,
      color: a.color, status: a.status, note: a.note,
      triggeredAt: a.triggeredAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    }))
    return NextResponse.json({ alerts })
  } catch (e) {
    return handleError(e)
  }
}

interface CreateBody {
  symbol: string
  price: number
  direction?: string // 'above' | 'below'
  color?: string
  note?: string
}

// POST /api/alerts — create
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<CreateBody>(req)
    const symbol = (body.symbol || '').toUpperCase()
    if (!symbol || typeof body.price !== 'number' || !isFinite(body.price)) {
      return NextResponse.json({ error: 'symbol and numeric price required' }, { status: 400 })
    }
    const direction = body.direction === 'below' ? 'below' : 'above'
    const count = await db.alert.count({ where: { userId: user.id } })
    if (count >= 100) return NextResponse.json({ error: 'Alert limit reached (100)' }, { status: 400 })
    const a = await db.alert.create({
      data: {
        userId: user.id, symbol, price: body.price, direction,
        color: body.color || '#f59e0b', note: body.note?.slice(0, 200) || null,
        lastSide: direction === 'above' ? 'below' : 'above',
      },
    })
    return NextResponse.json({
      alert: {
        id: a.id, symbol: a.symbol, price: a.price, direction: a.direction,
        color: a.color, status: a.status, note: a.note,
        triggeredAt: null, createdAt: a.createdAt.toISOString(),
      } satisfies AlertDto,
    })
  } catch (e) {
    return handleError(e)
  }
}
