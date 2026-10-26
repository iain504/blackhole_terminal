import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { resolveTradeMode } from '@/lib/trading'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { symbolSchema } from '@/lib/validation'
import {
  startGridTrade, ensureGridEngine, computeGridStats, validateGridConfig,
  isGridSpacing, isGridDirection, parseGridState, type GridSpacing,
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

export interface GridAutoPlanDto {
  center: number
  windowDays: number
  bars: number
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  direction: string
  qtyPerGrid: number
  maxSLPct: number
  maxTPPct: number
  slTriggerApprox: number
  tpTriggerApprox: number
  maxEndDays: number
  preset: string
  trendPct: number
  rangePct: number
  crossovers: number
  backtest: {
    totalPnl: number
    realizedPnl: number
    openPnl: number
    maxDrawdown: number
    fillsCount: number
    openLots: number
    winRate: number | null
    score: number
  }
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
  slBasis: string
  tpBasis: string
  direction: string
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
  /** Task 18 — auto-grid provenance (absent = manual grid) */
  auto: boolean
  autoPlan: GridAutoPlanDto | null
  autoEndAt: string | null
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
  slBasis: string
  tpBasis: string
  direction?: string | null
  closeOnStop: boolean
  status: string
  stopReason: string | null
  realizedPnl: number
  feePaid: number
  auto?: boolean
  autoPlan?: unknown
  autoEndAt?: Date | null
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
    slBasis: row.slBasis,
    tpBasis: row.tpBasis,
    direction: isGridDirection(row.direction) ? row.direction : 'both',
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
    auto: row.auto ?? false,
    autoPlan: (row.autoPlan ?? null) as GridAutoPlanDto | null,
    autoEndAt: row.autoEndAt?.toISOString() ?? null,
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
  slBasis?: string
  tpBasis?: string
  direction?: string
  closeOnStop?: boolean
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

/** 'price' | 'percent' guard basis — absent defaults to 'price' (legacy). */
export function parseGuardBasis(v: unknown): 'price' | 'percent' | null {
  if (v === undefined || v === null || v === '') return 'price'
  return v === 'price' || v === 'percent' ? v : null
}

export const round2 = (x: number) => Math.round(x * 100) / 100

// POST /api/grid — create + start a grid trade
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`grid:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many grid starts — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    ensureGridEngine() // lazy start (also resumes rows created before a restart)
    const body = await readJson<GridCreateBody>(req)

    const symRaw = String(body?.symbol ?? '').trim().toUpperCase()
    if (!symbolSchema.safeParse(symRaw).success) return bad('Invalid symbol')
    const symbol = symRaw

    const slBasis = parseGuardBasis(body?.slBasis)
    if (slBasis == null) return bad('slBasis must be "price" or "percent"')
    const tpBasis = parseGuardBasis(body?.tpBasis)
    if (tpBasis == null) return bad('tpBasis must be "price" or "percent"')
    // Task 10-g — grid direction ('both' default; validated again by the
    // shared validator together with the merged guards)
    const direction = body?.direction == null || body?.direction === '' ? 'both' : body.direction
    if (!isGridDirection(direction)) return bad('direction must be "both", "buy" or "sell"')

    const lowerPrice = Number(body?.lowerPrice)
    const upperPrice = Number(body?.upperPrice)
    if (!Number.isFinite(lowerPrice) || lowerPrice <= 0) return bad('Lower price must be a positive number')
    if (!Number.isFinite(upperPrice) || upperPrice <= lowerPrice) return bad('Upper price must be greater than the lower price')
    // server-side rounding to 2 decimals — the stored range, the guard checks
    // and the computed levels all use the SAME rounded values
    const lower = round2(lowerPrice)
    const upper = round2(upperPrice)

    const gridCount = Number(body?.gridCount)
    const spacing: GridSpacing = isGridSpacing(body?.spacing) ? body.spacing : 'arithmetic'
    const qtyPerGrid = Number(body?.qtyPerGrid)

    // whole-grid guards: optional, basis-aware ('price' = absolute prices that
    // must order strictly outside the range · 'percent' = 0 < maxSL ≤ 90 /
    // 0 < maxTP ≤ 1000 — resolved against the range edges by resolveGuards)
    let maxSL: number | null = null
    if (body?.maxSL != null && Number.isFinite(Number(body.maxSL))) maxSL = Number(body.maxSL)
    let maxTP: number | null = null
    if (body?.maxTP != null && Number.isFinite(Number(body.maxTP))) maxTP = Number(body.maxTP)

    // ONE shared validator for POST / PUT / backtest (grid-engine.ts) — keeps
    // the legacy 'price' 400s and adds the percent-basis rules
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
      isCrypto: symbol.includes('/'),
      direction,
    })
    if (invalid) return bad(invalid)

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
      lowerPrice: lower,
      upperPrice: upper,
      gridCount,
      spacing,
      qtyPerGrid,
      maxSL,
      maxTP,
      slBasis,
      tpBasis,
      direction,
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
