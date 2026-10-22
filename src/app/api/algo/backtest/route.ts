// POST /api/algo/backtest (Task 62) — run one backtest OR a grid-search
// parameter optimization for an algo strategy over real historical bars.
//
// body: {
//   mode?: 'run' | 'optimize'            (default 'run')
//   symbol, timeframe ('1m'|'5m'|'15m'), strategy (AlgoStrategyId),
//   params: Record<string, number>,       base parameters
//   ranges?: { key, min, max, step }[]    (optimize mode — numeric params only)
//   days?: number                          calendar days of history
//   qty, tpMode, tpValue, slMode, slValue, maxTradesDay, rthOnly, flattenEod,
//   cooldownMin?: number                    (Task 70-c) no-entry minutes after a close (0..240, default 0)
//   requireNewSignal?: boolean              (Task 70-c) edge-triggered re-entry (default false)
//   capital?: number                       starting equity for % / DD metrics
//   minTrades?: number                     (optimize) minimum trades to score
// }
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { getBars } from '@/lib/alpaca'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import { isAlgoStrategyId, normalizeAlgoParams, ALGO_TIMEFRAMES, ALGO_MAX_DAYS, type AlgoTimeframe } from '@/lib/algo-strategies'
import {
  prepareSeries, runBacktest, optimizeBacktest,
  type BacktestConfig, type OptimizeRange,
} from '@/lib/backtest'

export const dynamic = 'force-dynamic'

const MAX_BARS = 120_000

/**
 * Short-TTL cache for backtest history — a deep window (730d crypto ≈ 86k bars)
 * takes 6–35s to paginate from the feeds, and the tune→re-run→optimize loop
 * would otherwise re-pay that on EVERY request. Historical bars are immutable
 * except the newest (the forming bar is dropped per request anyway), so 2min
 * staleness is invisible to the replay. Bounded to 12 entries (~50MB worst).
 */
const BARS_TTL_MS = 120_000
const barsCache = new Map<string, { at: number; res: Awaited<ReturnType<typeof getBars>> }>()

async function getBarsCached(symbol: string, tf: Timeframe, userId: string, days: number) {
  const key = `${userId}|${symbol}|${tf}|${days}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.res
  const res = await getBars(symbol, tf, userId, { lookbackDays: days })
  barsCache.set(key, { at: Date.now(), res })
  if (barsCache.size > 12) {
    const oldest = [...barsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) barsCache.delete(oldest[0])
  }
  return res
}

interface BacktestBody {
  mode?: string
  symbol?: string
  timeframe?: string
  strategy?: string
  params?: unknown
  ranges?: unknown
  days?: number
  qty?: number
  tpMode?: string
  tpValue?: number | null
  slMode?: string
  slValue?: number | null
  maxTradesDay?: number
  rthOnly?: boolean
  flattenEod?: boolean
  cooldownMin?: number
  requireNewSignal?: boolean
  capital?: number
  minTrades?: number
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await readJson<BacktestBody>(req)

    const strategy = body.strategy
    if (!isAlgoStrategyId(strategy)) {
      return NextResponse.json({ error: 'Unknown strategy' }, { status: 400 })
    }
    const tf = ALGO_TIMEFRAMES.includes(body.timeframe as AlgoTimeframe) ? (body.timeframe as AlgoTimeframe) : null
    if (!tf) {
      return NextResponse.json({ error: 'Timeframe must be one of 1m / 5m / 15m' }, { status: 400 })
    }
    const symbol = String(body.symbol ?? '').trim().toUpperCase()
    if (!symbol || !/^[A-Z0-9./:-]{1,15}$/.test(symbol)) {
      return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
    }
    const days = Math.min(ALGO_MAX_DAYS[tf], Math.max(1, Math.round(Number(body.days) || 30)))
    const qty = Number(body.qty)
    if (!(qty > 0)) {
      return NextResponse.json({ error: 'Quantity must be > 0' }, { status: 400 })
    }
    const capital = Math.max(100, Math.min(100_000_000, Number(body.capital) || 10000))
    const maxTradesDay = Math.min(200, Math.max(1, Math.round(Number(body.maxTradesDay) || 3)))

    // ---- fetch the history (same source the live engine polls; TTL-cached) ----
    const res = await getBarsCached(symbol, tf as Timeframe, user.id, days)
    let bars = Array.isArray(res.bars) ? res.bars : []
    if (res.demo || bars.length < 80) {
      return NextResponse.json(
        { error: res.demo ? 'No live historical data for this symbol (demo feed) — cannot backtest' : `Not enough history (${bars.length} bars) — widen the period or pick a smaller timeframe` },
        { status: 400 },
      )
    }
    // drop the FORMING bar (never a decision bar in the live engine either)
    const tfSec = TIMEFRAMES[tf as Timeframe].seconds
    const nowSec = Math.floor(Date.now() / 1000)
    while (bars.length > 0 && bars[bars.length - 1].time + tfSec > nowSec) bars = bars.slice(0, -1)
    if (bars.length < 80) {
      return NextResponse.json({ error: 'Not enough closed bars in range' }, { status: 400 })
    }
    // hard compute cap — keep the most recent bars
    if (bars.length > MAX_BARS) bars = bars.slice(bars.length - MAX_BARS)

    // ACTUAL coverage — the feed may return less history than requested (per-
    // feed bar caps, brand-new listings). Report the real window so the UI can
    // say "data Jul 9 → Oct 21" instead of pretending the requested period.
    const fromT = bars[0].time
    const toT = bars[bars.length - 1].time
    const coveredDays = Math.max(1, Math.round((nowSec - fromT) / 86400))

    const cfg: BacktestConfig = {
      strategy,
      params: normalizeAlgoParams(strategy, body.params),
      qty: symbol.includes('/') ? qty : Math.max(1, Math.floor(qty)),
      tpMode: body.tpMode === 'pct' ? 'pct' : 'none',
      tpValue: body.tpMode === 'pct' && Number(body.tpValue) > 0 ? Number(body.tpValue) : null,
      slMode: body.slMode === 'pct' ? 'pct' : 'none',
      slValue: body.slMode === 'pct' && Number(body.slValue) > 0 ? Number(body.slValue) : null,
      maxTradesDay,
      rthOnly: body.rthOnly !== false,
      flattenEod: body.flattenEod !== false,
      cooldownMin: Math.min(240, Math.max(0, Math.round(Number(body.cooldownMin) || 0))),
      requireNewSignal: body.requireNewSignal === true,
      capital,
    }

    const series = prepareSeries(bars)
    const meta = {
      symbol,
      timeframe: tf,
      days,
      bars: series.n,
      from: fromT,
      to: toT,
      coveredDays,
      source: res.source ?? 'alpaca',
      dataCapped: coveredDays < days - 3,
    }

    if (body.mode === 'optimize') {
      const ranges = Array.isArray(body.ranges) ? (body.ranges as OptimizeRange[]) : []
      const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
      const optimize = optimizeBacktest(series, cfg, ranges, { minTrades })
      if (optimize.totalCombos === 0) {
        return NextResponse.json({ error: 'No valid optimize ranges — tick at least one parameter and set min < max' }, { status: 400 })
      }
      return NextResponse.json({ optimize, meta })
    }

    const result = runBacktest(series, cfg)
    return NextResponse.json({ result, meta })
  } catch (e) {
    return handleError(e)
  }
}
