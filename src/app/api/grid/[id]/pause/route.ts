import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { computeGridStats } from '@/lib/grid-engine'
import { toDto } from '../../route'

export const dynamic = 'force-dynamic'

// POST /api/grid/[id]/pause (Task 18) — SUSPEND an active grid: status flips
// to 'paused'. The engine tick queries status 'active' ONLY, so a paused grid
// places no orders and evaluates no guards — a full freeze, not a partial one.
// Open lots are kept untouched and resume as-is. Race-safe via the same
// conditional-update pattern the stop path uses (status must still be
// 'active' when we write — a concurrent guard stop wins and stays stopped).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const grid = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
    if (!grid) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    if (grid.status !== 'active') {
      return NextResponse.json(
        { error: `Only active grids can be paused — this grid is ${grid.status}` },
        { status: 409 },
      )
    }
    const upd = await db.gridTrade.updateMany({
      where: { id: grid.id, userId: user.id, status: 'active' },
      data: { status: 'paused' },
    })
    if (upd.count === 0) {
      return NextResponse.json({ error: 'Grid just stopped (guard or manual) — it can no longer be paused' }, { status: 409 })
    }
    const fresh = await db.gridTrade.findUnique({ where: { id: grid.id } })
    const fills = await db.gridFill.findMany({
      where: { gridTradeId: grid.id, userId: user.id },
      orderBy: { ts: 'desc' },
      take: 200,
    })
    return NextResponse.json({ grid: toDto(fresh!, computeGridStats(fresh!, fills)) })
  } catch (e) {
    return handleError(e)
  }
}
