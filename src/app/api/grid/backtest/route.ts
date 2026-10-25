// POST /api/grid/backtest (Task 10-a) — replay a grid config over REAL
// historical bars: a pure paper-parity simulation of grid-engine.ts crossing
// semantics (fees 0 — see src/lib/grid-backtest.ts). Uses the EXACT bars
// machinery of the algo backtest (shared fetchBacktestBars: Short-TTL deep
// cache + Binance/Alpaca feeds) — when the fetcher falls back to the demo
// feed the route fails honestly with 400, NEVER fake results.
//
// body: {
//   symbol, lowerPrice, upperPrice, gridCount, spacing, qtyPerGrid,
//   maxSL?, maxTP?,            — whole-grid guards (number | absent)
//   slBasis?, tpBasis?,        — 'price' | 'percent' (default 'price')
//   direction?,                — 'both' | 'buy' | 'sell' (Task 10-g, default 'both')
//   closeOnStop?,              — default true
//   days?                      — 1..365 calendar days (default 30)
// }
//
// Crossing granularity by window length: days≤14 → '15m', ≤60 → '1h', else
// '1D' (then clamped by the per-timeframe history caps the algo backtest uses).
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { symbolSchema } from '@/lib/validation'
import { ALGO_MAX_DAYS } from '@/lib/algo-strategies'
import { fetchBacktestBars } from '@/lib/backtest-history'
import { validateGridConfig, isGridSpacing, isGridDirection, type GridSpacing } from '@/lib/grid-engine'
import { simulateGridBacktest, type GridBacktestConfig } from '@/lib/grid-backtest'
import { parseGuardBasis, round2 } from '../route'

export const dynamic = 'force-dynamic'

interface GridBacktestBody {
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
  days?: number
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

// per-timeframe history caps — '15m' inherits the algo backtest's cap, the
// coarser timeframes are bounded by the request's own 365-day ceiling
const GRID_TF_MAX_DAYS: Record<'15m' | '1h' | '1D', number> = {
  '15m': ALGO_MAX_DAYS['15m'],
  '1h': 365,
  '1D': 365,
}

const TF_SEC: Record<'15m' | '1h' | '1D', number> = { '15m': 900, '1h': 3600, '1D': 86400 }

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`grid-bt:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many grid backtests — retry in ${rl.retryAfterSec}s`, retryAfterSec: rl.retryAfterSec },
        { status: 429 },
      )
    }
    const body = await readJson<GridBacktestBody>(req)

    const symRaw = String(body?.symbol ?? '').trim().toUpperCase()
    if (!symbolSchema.safeParse(symRaw).success) return bad('Invalid symbol')
    const symbol = symRaw

    const slBasis = parseGuardBasis(body?.slBasis)
    if (slBasis == null) return bad('slBasis must be "price" or "percent"')
    const tpBasis = parseGuardBasis(body?.tpBasis)
    if (tpBasis == null) return bad('tpBasis must be "price" or "percent"')
    const direction = body?.direction == null || body?.direction === '' ? 'both' : body.direction
    if (!isGridDirection(direction)) return bad('direction must be "both", "buy" or "sell"')

    const lowerPrice = Number(body?.lowerPrice)
    const upperPrice = Number(body?.upperPrice)
    if (!Number.isFinite(lowerPrice) || lowerPrice <= 0) return bad('Lower price must be a positive number')
    if (!Number.isFinite(upperPrice) || upperPrice <= lowerPrice) return bad('Upper price must be greater than the lower price')
    // server-side rounding to 2 decimals — validated + simulated on the SAME
    // rounded values the create route would store
    const lower = round2(lowerPrice)
    const upper = round2(upperPrice)

    const gridCount = Number(body?.gridCount)
    const spacing: GridSpacing = isGridSpacing(body?.spacing) ? body.spacing : 'arithmetic'
    const qtyPerGrid = Number(body?.qtyPerGrid)

    let maxSL: number | null = null
    if (body?.maxSL != null && Number.isFinite(Number(body.maxSL))) maxSL = Number(body.maxSL)
    let maxTP: number | null = null
    if (body?.maxTP != null && Number.isFinite(Number(body.maxTP))) maxTP = Number(body.maxTP)

    // SAME shared validator as POST /api/grid + PUT /api/grid/[id]
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

    const closeOnStop = body?.closeOnStop !== false

    // window → crossing granularity → per-timeframe day clamp
    const daysReq = Math.min(365, Math.max(1, Math.round(Number(body?.days) || 30)))
    const timeframe = daysReq <= 14 ? '15m' : daysReq <= 60 ? '1h' : '1D'
    const days = Math.min(daysReq, GRID_TF_MAX_DAYS[timeframe])

    // ---- history: the algo backtest's machinery verbatim (honest demo 400) ----
    const hist = await fetchBacktestBars(symbol, timeframe, user.id, days)
    if (!hist.ok) return bad(hist.error)
    const bars = hist.bars

    const sim = simulateGridBacktest(
      {
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
        isCrypto: symbol.includes('/'),
        direction,
      } satisfies GridBacktestConfig,
      bars,
    )

    return NextResponse.json({
      symbol,
      days,
      timeframe,
      bars: bars.length,
      started: new Date(bars[0].time * 1000).toISOString(),
      ended: new Date((bars[bars.length - 1].time + TF_SEC[timeframe]) * 1000).toISOString(),
      stopped: sim.stopped,
      stopReason: sim.stopReason,
      stats: sim.stats,
      curve: sim.curve,
      fills: sim.fills,
    })
  } catch (e) {
    return handleError(e)
  }
}
