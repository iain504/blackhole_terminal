import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { resolveTradeMode } from '@/lib/trading'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { symbolSchema } from '@/lib/validation'
import {
  startGridTrade, ensureGridEngine, computeGridStats,
  isGridSpacing, parseGridState, type GridSpacing,
} from '@/lib/grid-engine'

export const dynamic = 'force-dynamic'

export interface GridFillDto {
  id: string
  levelIndex: number
  side: string
  reason: string
  price: number
  qty: number
  pnl: number | null
  fee: number
  orderId: string | null
  note: string | null
  ts: string
}

export interface GridLotDto {
  levelIndex: number
  qty: number
  entryPrice: number
}

export interface GridStatsDto {
  fillsCount: number
  buys: number
  sells: number
  openLots: number
  openQty: number
  openNotional: number | null
  realizedPnl: number
  unrealizedPnl: number | null
  totalPnl: number | null
  durationSec: number
  currentPrice: number | null
  winRate: number | null
  bestLevel: { levelIndex: number; pnl: number } | null
  worstLevel: { levelIndex: number; pnl: number } | null
  levels: number[]
}

export interface GridTradeDto {
  id: string
  symbol: string
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  closeOnStop: boolean
  status: string
  stopReason: string | null
  realizedPnl: number
  feePaid: number
  startedAt: string
  stoppedAt: string | null
  createdAt: string
  levels: number[]
  lastPrice: number | null
  lots: GridLotDto[]
  stats: GridStatsDto
}

/** Row + stats → the client DTO (state.levels / state.lots / lastPrice ride along). */
export function toDto(row: {
  id: string
  symbol: string
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  closeOnStop: boolean
  status: string
  stopReason: string | null
  realizedPnl: number
  feePaid: number
  state: unknown
  startedAt: Date
  stoppedAt: Date | null
  createdAt: Date
}, stats: GridStatsDto): GridTradeDto {
  const st = parseGridState(row.state)
  return {
    id: row.id,
    symbol: row.symbol,
    lowerPrice: row.lowerPrice,
    upperPrice: row.upperPrice,
    gridCount: row.gridCount,
    spacing: row.spacing,
    qtyPerGrid: row.qtyPerGrid,
    maxSL: row.maxSL,
    maxTP: row.maxTP,
    closeOnStop: row.closeOnStop,
    status: row.status,
    stopReason: row.stopReason,
    realizedPnl: row.realizedPnl,
    feePaid: row.feePaid,
    startedAt: row.startedAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    levels: st.levels,
    lastPrice: st.lastPrice,
    lots: st.lots,
    stats,
  }
}

// GET /api/grid — every grid (all statuses, newest first) + live stats
export async function GET() {
  try {
    const user = await requireUser()
    ensureGridEngine() // resume active grids after a server restart
    const rows = await db.gridTrade.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const fills = rows.length
      ? await db.gridFill.findMany({
          where: { userId: user.id, gridTradeId: { in: rows.map((r) => r.id) } },
          orderBy: { ts: 'desc' },
          take: 2000,
          select: { gridTradeId: true, side: true, reason: true, levelIndex: true, price: true, qty: true, pnl: true },
        })
      : []
    const byGrid = new Map<string, typeof fills>()
    for (const f of fills) {
      const list = byGrid.get(f.gridTradeId) ?? []
      list.push(f)
      byGrid.set(f.gridTradeId, list)
    }
    const grids = rows.map((r) => toDto(r, computeGridStats(r, byGrid.get(r.id) ?? [])))
    return NextResponse.json({ grids })
  } catch (e) {
    return handleError(e)
  }
}

interface GridCreateBody {
  symbol?: string
  lowerPrice?: number
  upperPrice?: number
  gridCount?: number
  spacing?: string
  qtyPerGrid?: number
  maxSL?: number | null
  maxTP?: number | null
  closeOnStop?: boolean
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

// POST /api/grid — create + start a grid trade
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const rl = rateLimit(`grid:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many grid starts — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    ensureGridEngine() // lazy start (also resumes rows created before a restart)
    const body = await readJson<GridCreateBody>(req)

    const symRaw = String(body?.symbol ?? '').trim().toUpperCase()
    if (!symbolSchema.safeParse(symRaw).success) return bad('Invalid symbol')
    const symbol = symRaw

    const lowerPrice = Number(body?.lowerPrice)
    const upperPrice = Number(body?.upperPrice)
    if (!Number.isFinite(lowerPrice) || lowerPrice <= 0) return bad('Lower price must be a positive number')
    if (!Number.isFinite(upperPrice) || upperPrice <= lowerPrice) return bad('Upper price must be greater than the lower price')

    const gridCount = Number(body?.gridCount)
    if (!Number.isInteger(gridCount) || gridCount < 2 || gridCount > 100) {
      return bad('Grid count must be an integer between 2 and 100')
    }
    const spacing: GridSpacing = isGridSpacing(body?.spacing) ? body.spacing : 'arithmetic'

    const qtyPerGrid = Number(body?.qtyPerGrid)
    if (!Number.isFinite(qtyPerGrid) || qtyPerGrid <= 0) return bad('Quantity per grid must be a positive number')
    // stocks are floored to whole shares by the broker pipeline (trading.ts) —
    // a fractional stock grid could never fill
    if (!symbol.includes('/') && qtyPerGrid < 1) {
      return bad('Stocks require a whole-number quantity per grid (min 1) — crypto supports fractional sizes')
    }

    // whole-grid guards: optional absolute prices with strict ordering
    let maxSL: number | null = null
    if (body?.maxSL != null && Number.isFinite(Number(body.maxSL))) {
      maxSL = Number(body.maxSL)
      if (maxSL <= 0) return bad('Max SL must be a positive price')
      if (maxSL >= lowerPrice) return bad('Max SL must be BELOW the lower price (it is the whole-grid hard floor)')
    }
    let maxTP: number | null = null
    if (body?.maxTP != null && Number.isFinite(Number(body.maxTP))) {
      maxTP = Number(body.maxTP)
      if (maxTP <= 0) return bad('Max TP must be a positive price')
      if (maxTP <= upperPrice) return bad('Max TP must be ABOVE the upper price (it is the whole-grid profit ceiling)')
    }

    // orders go through the same paper-broker pipeline as manual/algo orders
    if (!(await hasAlpacaKeys(user.id))) {
      return bad('No Alpaca keys — add them in Settings first (grids place real paper/live orders)')
    }
    const mode = await resolveTradeMode(user.id)
    if (mode === 'live') {
      return bad('Refusing to start grid trades in LIVE mode — switch the trade mode to paper')
    }

    const grid = await startGridTrade({
      userId: user.id,
      symbol,
      lowerPrice,
      upperPrice,
      gridCount,
      spacing,
      qtyPerGrid,
      maxSL,
      maxTP,
      closeOnStop: body?.closeOnStop !== false,
    })
    return NextResponse.json(
      { grid: toDto(grid, computeGridStats(grid, [])) },
      { status: 201 },
    )
  } catch (e) {
    return handleError(e)
  }
}
