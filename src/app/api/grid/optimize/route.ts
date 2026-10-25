// POST /api/grid/optimize (Task 10-g) — auto-optimize a grid's range + level
// count: fetch the requested window ONCE with the shared backtest bars
// machinery, then sweep width × count around the current close through the
// engine-parity sim (src/lib/grid-optimize.ts). The response's best config is
// exactly what POST /api/grid would accept — the dialog just fills the form
// and the server re-validates on submit as always.
//
// Guards (maxSL/maxTP) are intentionally NOT swept — sizing and risk stays
// the user's decision; only the range + level count are optimized.
//
// body: { symbol, qtyPerGrid, direction?, spacing?, days? }
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { symbolSchema } from '@/lib/validation'
import { ALGO_MAX_DAYS } from '@/lib/algo-strategies'
import { fetchBacktestBars } from '@/lib/backtest-history'
import { isGridDirection, isGridSpacing, type GridSpacing } from '@/lib/grid-engine'
import { optimizeGridConfig } from '@/lib/grid-optimize'

export const dynamic = 'force-dynamic'

interface GridOptimizeBody {
  symbol?: string
  qtyPerGrid?: number
  direction?: string
  spacing?: string
  days?: number
}

// window → crossing granularity — SAME mapping the backtest route uses so the
// optimize preview and the follow-up "Run backtest" see the same bars
const GRID_TF_MAX_DAYS: Record<'15m' | '1h' | '1D', number> = {
  '15m': ALGO_MAX_DAYS['15m'],
  '1h': 365,
  '1D': 365,
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`grid-opt:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many optimize runs — retry in ${rl.retryAfterSec}s`, retryAfterSec: rl.retryAfterSec },
        { status: 429 },
      )
    }
    const body = await readJson<GridOptimizeBody>(req)

    const symRaw = String(body?.symbol ?? '').trim().toUpperCase()
    if (!symbolSchema.safeParse(symRaw).success) return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
    const symbol = symRaw
    const isCrypto = symbol.includes('/')

    const qtyPerGrid = Number(body?.qtyPerGrid)
    if (!Number.isFinite(qtyPerGrid) || qtyPerGrid <= 0) {
      return NextResponse.json({ error: 'Quantity per grid must be a positive number' }, { status: 400 })
    }
    if (!isCrypto && qtyPerGrid < 1) {
      return NextResponse.json(
        { error: 'Stocks require a whole-number quantity per grid (min 1) — crypto supports fractional sizes' },
        { status: 400 },
      )
    }
    const rawDirection = body?.direction == null || body?.direction === '' ? 'both' : body.direction
    if (!isGridDirection(rawDirection)) {
      return NextResponse.json({ error: 'direction must be "both", "buy" or "sell"' }, { status: 400 })
    }
    const direction = rawDirection
    const spacing: GridSpacing = isGridSpacing(body?.spacing) ? body.spacing : 'arithmetic'

    const daysReq = Math.min(365, Math.max(1, Math.round(Number(body?.days) || 30)))
    const timeframe = daysReq <= 14 ? '15m' : daysReq <= 60 ? '1h' : '1D'
    const days = Math.min(daysReq, GRID_TF_MAX_DAYS[timeframe])

    // ---- history: the shared machinery verbatim (honest demo 400) ----
    const hist = await fetchBacktestBars(symbol, timeframe, user.id, days)
    if (!hist.ok) return NextResponse.json({ error: hist.error }, { status: 400 })
    const bars = hist.bars
    const last = bars[bars.length - 1]
    const center = Number(last?.close)
    if (!Number.isFinite(center) || center <= 0) {
      return NextResponse.json({ error: 'No usable price in the history window' }, { status: 400 })
    }

    const result = optimizeGridConfig({ center, isCrypto, direction, spacing, qtyPerGrid, bars })
    if (!result.best) {
      return NextResponse.json(
        { error: `No grid activity for ${symbol} in the last ${days} days — set the range manually or pick another symbol` },
        { status: 400 },
      )
    }

    return NextResponse.json({
      symbol,
      days,
      timeframe,
      bars: bars.length,
      center: result.center,
      tried: result.tried,
      best: result.best,
      runners: result.runners,
    })
  } catch (e) {
    return handleError(e)
  }
}
