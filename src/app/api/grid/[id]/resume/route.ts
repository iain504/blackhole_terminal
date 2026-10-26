import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { computeGridStats } from '@/lib/grid-engine'
import { toDto } from '../../route'

export const dynamic = 'force-dynamic'

// POST /api/grid/[id]/resume (Task 18) — wake a SUSPENDED grid: status flips
// 'paused' → 'active'. The next 5s engine tick re-reads the row from the DB
// (the single source of truth) and resumes evaluating guards + orders with
// the lots it was paused with. No engine API call needed.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const grid = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
    if (!grid) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    if (grid.status !== 'paused') {
      return NextResponse.json(
        { error: `Only paused grids can be resumed — this grid is ${grid.status}` },
        { status: 409 },
      )
    }
    const upd = await db.gridTrade.updateMany({
      where: { id: grid.id, userId: user.id, status: 'paused' },
      data: {
        status: 'active',
        // the pause may have lasted long — clear any stale failure streak so
        // the grid gets a clean run of cycles before it can be parked
        state: (() => {
          const st = grid.state as { failCount?: number; lastError?: string } | null
          if (st && typeof st === 'object' && (st.failCount || st.lastError)) {
            return { ...st, failCount: 0, lastError: undefined } as object
          }
          return grid.state as object
        })(),
      },
    })
    if (upd.count === 0) {
      return NextResponse.json({ error: 'Grid state changed — retry' }, { status: 409 })
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
