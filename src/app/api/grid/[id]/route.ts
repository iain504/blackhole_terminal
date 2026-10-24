import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import {
  computeGridStats, computeLevels, parseGridState, validateGridConfig,
} from '@/lib/grid-engine'
import { toDto, round2, type GridFillDto } from '../route'

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

// ---- PUT — edit a FLAT active grid (Task 10-a) -------------------------------

interface GridEditBody {
  lowerPrice?: number
  upperPrice?: number
  gridCount?: number
  spacing?: string
  qtyPerGrid?: number
  /** number = set · null = clear the guard · undefined = keep */
  maxSL?: number | null
  maxTP?: number | null
  slBasis?: string
  tpBasis?: string
  closeOnStop?: boolean
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })
const conflict = (error: string) => NextResponse.json({ error }, { status: 409 })

/**
 * PUT /api/grid/[id] — edit the config of an active grid that has NO open lots
 * (any subset of the create body; maxSL/maxTP accept null to CLEAR the guard).
 *
 * Relies on the engine's DB-as-truth loop: gridCycle re-reads ALL active rows
 * on EVERY 5s tick and resolveGuards() re-resolves the SL/TP triggers per tick,
 * so this PUT needs no engine API call — the next cycle evaluates with the new
 * config (levels snapshot is rebuilt here, state.lastPrice/lots are kept).
 *
 * The write is optimistic-locked on updatedAt: the engine persists its state
 * after EVERY evaluation, so an updatedAt change between our read and write
 * means the engine ticked in between — we re-read + retry (up to 3 attempts)
 * and only then 409, so a user edit never clobbers a freshly opened lot.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await readJson<GridEditBody>(req)
    let row = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
    if (!row) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    if (row.status !== 'active') return conflict('Only active grids can be edited')

    // ---- merge the submitted subset over the stored config ----
    if (body?.slBasis !== undefined && body.slBasis !== null && body.slBasis !== 'price' && body.slBasis !== 'percent') {
      return bad('slBasis must be "price" or "percent"')
    }
    if (body?.tpBasis !== undefined && body.tpBasis !== null && body.tpBasis !== 'price' && body.tpBasis !== 'percent') {
      return bad('tpBasis must be "price" or "percent"')
    }
    if (body?.closeOnStop !== undefined && body.closeOnStop !== null && typeof body.closeOnStop !== 'boolean') {
      return bad('closeOnStop must be a boolean')
    }
    if (body?.maxSL !== undefined && body.maxSL !== null && typeof body.maxSL !== 'number') {
      return bad('Max SL must be a number or null to clear it')
    }
    if (body?.maxTP !== undefined && body.maxTP !== null && typeof body.maxTP !== 'number') {
      return bad('Max TP must be a number or null to clear it')
    }

    const slBasis = (body?.slBasis ?? row.slBasis ?? 'price') as 'price' | 'percent'
    const tpBasis = (body?.tpBasis ?? row.tpBasis ?? 'price') as 'price' | 'percent'
    const lower = round2(Number(body?.lowerPrice ?? row.lowerPrice))
    const upper = round2(Number(body?.upperPrice ?? row.upperPrice))
    const gridCount = body?.gridCount !== undefined ? Number(body.gridCount) : row.gridCount
    const spacing = body?.spacing !== undefined ? String(body.spacing) : row.spacing
    const qtyPerGrid = body?.qtyPerGrid !== undefined ? Number(body.qtyPerGrid) : row.qtyPerGrid
    // undefined = keep · null = clear · number = set (validated below)
    const maxSL = body?.maxSL === undefined ? row.maxSL : body.maxSL === null ? null : Number(body.maxSL)
    const maxTP = body?.maxTP === undefined ? row.maxTP : body.maxTP === null ? null : Number(body.maxTP)
    const closeOnStop = body?.closeOnStop === undefined ? row.closeOnStop : body.closeOnStop

    // ---- re-validate the MERGED config with the SAME rules as POST ----
    const invalid = validateGridConfig({
      lowerPrice: lower,
      upperPrice: upper,
      gridCount,
      spacing,
      qtyPerGrid,
      maxSL,
      maxTP,
      slBasis,
      tpBasis,
      isCrypto: row.symbol.includes('/'),
    })
    if (invalid) return bad(invalid)
    const levels = computeLevels(lower, upper, gridCount, spacing as 'arithmetic' | 'geometric')

    // ---- apply (optimistic lock, see doc comment) ----
    let current = row
    let applied = false
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      const st = parseGridState(current.state)
      if (st.lots.length > 0) {
        return conflict('Grid has open lots — wait for them to close (or stop the grid) before editing')
      }
      const upd = await db.gridTrade.updateMany({
        where: { id: current.id, userId: user.id, status: 'active', updatedAt: current.updatedAt },
        data: {
          lowerPrice: lower,
          upperPrice: upper,
          gridCount,
          spacing,
          qtyPerGrid,
          maxSL,
          maxTP,
          slBasis,
          tpBasis,
          closeOnStop,
          // keep lastPrice + lots (empty — checked above); only the levels
          // snapshot is rebuilt, failCount/lastError reset to fresh
          state: { ...st, levels, failCount: 0, lastError: undefined } as unknown as object,
        },
      })
      if (upd.count > 0) {
        applied = true
        break
      }
      // engine (or another request) wrote between our read and write — re-check
      const again = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
      if (!again) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
      if (again.status !== 'active') return conflict('Only active grids can be edited')
      current = again
    }
    if (!applied) return conflict('Grid was updated by the engine during the edit — retry')

    const fresh = await db.gridTrade.findFirst({ where: { id, userId: user.id } })
    if (!fresh) return NextResponse.json({ error: 'Grid not found' }, { status: 404 })
    const fills = await db.gridFill.findMany({
      where: { gridTradeId: fresh.id, userId: user.id },
      orderBy: { ts: 'desc' },
      take: 200,
      select: { side: true, reason: true, levelIndex: true, price: true, qty: true, pnl: true },
    })
    return NextResponse.json({ grid: toDto(fresh, computeGridStats(fresh, fills)) })
  } catch (e) {
    return handleError(e)
  }
}
