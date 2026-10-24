import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { computeGridStats } from '@/lib/grid-engine'
import { toDto, type GridFillDto } from '../route'

export const dynamic = 'force-dynamic'

// GET /api/grid/[id] — grid + its fills (latest 200, newest first) + stats
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const grid = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
    if (!grid) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    const fills = await db.gridFill.findMany({
      where: { gridTradeId: grid.id, userId: user.id },
      orderBy: { ts: 'desc' },
      take: 200,
    })
    const fillDtos: GridFillDto[] = fills.map((f) => ({
      id: f.id,
      levelIndex: f.levelIndex,
      side: f.side,
      reason: f.reason,
      price: f.price,
      qty: f.qty,
      pnl: f.pnl,
      fee: f.fee,
      orderId: f.orderId,
      note: f.note,
      ts: f.ts.toISOString(),
    }))
    return NextResponse.json({
      grid: toDto(grid, computeGridStats(grid, fills)),
      fills: fillDtos,
    })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/grid/[id] — remove a NON-active grid + its fills
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const grid = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
    if (!grid) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    if (grid.status === 'active') {
      return NextResponse.json({ error: 'Stop the grid first — active grids cannot be deleted' }, { status: 400 })
    }
    await db.gridFill.deleteMany({ where: { gridTradeId: grid.id } })
    await db.gridTrade.delete({ where: { id: grid.id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
