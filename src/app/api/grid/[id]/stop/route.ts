import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { stopGridTrade, computeGridStats } from '@/lib/grid-engine'
import { toDto } from '../../route'

export const dynamic = 'force-dynamic'

// POST /api/grid/[id]/stop — manual stop (respects the grid's closeOnStop)
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const owned = await db.gridTrade.findFirst({ where: { id, userId: user.id }, select: { id: true } })
    if (!owned) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    await stopGridTrade(user.id, id, { reason: 'manual_close' })
    const grid = await db.gridTrade.findUnique({ where: { id } })
    if (!grid) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    const fills = await db.gridFill.findMany({
      where: { gridTradeId: grid.id, userId: user.id },
      orderBy: { ts: 'desc' },
      take: 200,
    })
    return NextResponse.json({ grid: toDto(grid, computeGridStats(grid, fills)) })
  } catch (e) {
    return handleError(e)
  }
}
