import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { resolveTradeMode } from '@/lib/trading'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { symbolSchema } from '@/lib/validation'
import { GRID_BUNDLE_MAX } from '@/lib/grid-setup'
import {
  startGridTrade, ensureGridEngine, computeGridStats, validateGridConfig,
  isGridSpacing, isGridDirection, type GridSpacing,
} from '@/lib/grid-engine'
import { parseGuardBasis, round2, toDto } from '../route'

export const dynamic = 'force-dynamic'

// POST /api/grid/bulk — Task 10-l "Import all": create MANY grid trades from
// one imported bundle in a single call. Mirrors POST /api/grid's validation
// per setup, but rates a BUNDLE (5/min) instead of a single start, so a 20-grid
// import never trips the per-start limiter. Every setup is validated
// independently — one invalid row never blocks the rest; the response reports
// per-item results so the UI can render exactly what happened.
//
// Body: { setups: [{ symbol, lowerPrice, upperPrice, gridCount, spacing,
//          qtyPerGrid, maxSL, slBasis, maxTP, tpBasis, direction, closeOnStop }, …] }
// Resp: { results: [{ index, symbol, ok, id?, error? }], created, failed }

interface BulkSetupBody {
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

interface BulkResultItem {
  index: number
  symbol: string
  ok: boolean
  id?: string
  error?: string
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`gridbulk:${user.id}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many bundle imports — retry in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }
    ensureGridEngine()

    const body = await readJson<{ setups?: BulkSetupBody[] }>(req)
    const raw = Array.isArray(body?.setups) ? body!.setups! : []
    if (raw.length === 0) {
      return NextResponse.json({ error: 'No setups in the bundle' }, { status: 400 })
    }
    if (raw.length > GRID_BUNDLE_MAX) {
      return NextResponse.json(
        { error: `Too many setups (${raw.length}) — the limit is ${GRID_BUNDLE_MAX}` },
        { status: 400 },
      )
    }

    // Broker/mode gates — same contract as the single-start route, checked ONCE
    // up front so a blocked import fails loudly instead of 50 times.
    if (!(await hasAlpacaKeys(user.id))) {
      return NextResponse.json(
        { error: 'No Alpaca keys — add them in Settings first (grids place real paper/live orders)' },
        { status: 400 },
      )
    }
    const mode = await resolveTradeMode(user.id)
    if (mode === 'live') {
      return NextResponse.json(
        { error: 'Refusing to start grid trades in LIVE mode — switch the trade mode to paper' },
        { status: 400 },
      )
    }

    const results: BulkResultItem[] = []
    let created = 0
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i] ?? {}
      const symRaw = String(s.symbol ?? '').trim().toUpperCase()
      try {
        if (!symbolSchema.safeParse(symRaw).success) {
          results.push({ index: i, symbol: symRaw || '(missing)', ok: false, error: 'Invalid symbol' })
          continue
        }
        const symbol = symRaw
        const slBasis = parseGuardBasis(s.slBasis)
        const tpBasis = parseGuardBasis(s.tpBasis)
        if (slBasis == null || tpBasis == null) {
          results.push({ index: i, symbol, ok: false, error: 'slBasis/tpBasis must be "price" or "percent"' })
          continue
        }
        const direction = s.direction == null || s.direction === '' ? 'both' : s.direction
        if (!isGridDirection(direction)) {
          results.push({ index: i, symbol, ok: false, error: 'direction must be "both", "buy" or "sell"' })
          continue
        }
        const lowerPrice = Number(s.lowerPrice)
        const upperPrice = Number(s.upperPrice)
        const lower = round2(lowerPrice)
        const upper = round2(upperPrice)
        if (!Number.isFinite(lowerPrice) || lower <= 0) {
          results.push({ index: i, symbol, ok: false, error: 'Lower price must be a positive number' })
          continue
        }
        if (!Number.isFinite(upperPrice) || upper <= lower) {
          results.push({ index: i, symbol, ok: false, error: 'Upper price must be greater than the lower price' })
          continue
        }
        const gridCount = Number(s.gridCount)
        const spacing: GridSpacing = isGridSpacing(s.spacing) ? s.spacing : 'arithmetic'
        const qtyPerGrid = Number(s.qtyPerGrid)
        let maxSL: number | null = null
        if (s.maxSL != null && Number.isFinite(Number(s.maxSL))) maxSL = Number(s.maxSL)
        let maxTP: number | null = null
        if (s.maxTP != null && Number.isFinite(Number(s.maxTP))) maxTP = Number(s.maxTP)

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
        if (invalid) {
          results.push({ index: i, symbol, ok: false, error: invalid })
          continue
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
          closeOnStop: s.closeOnStop !== false,
        })
        results.push({
          index: i,
          symbol,
          ok: true,
          id: toDto(grid, computeGridStats(grid, [])).id,
        })
        created++
      } catch (err) {
        // one bad setup (e.g. broker rejection) never blocks the rest
        results.push({
          index: i,
          symbol: symRaw || '(missing)',
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 200) : 'Create failed',
        })
      }
    }

    return NextResponse.json(
      { results, created, failed: raw.length - created },
      { status: created > 0 ? 201 : 400 },
    )
  } catch (e) {
    return handleError(e)
  }
}
