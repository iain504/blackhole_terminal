// POST /api/algo/backtest (Task 62) — run one backtest OR a grid-search
// parameter optimization for an algo strategy over real historical bars.
// Task 87 adds mode 'sweep' — one click tests EVERY strategy: each runs at
// its defaults plus an auto-built optimizer grid (defaults guaranteed in-grid)
// and the top X rows across all strategies are ranked for one-click apply.
//
// body: {
//   mode?: 'run' | 'optimize' | 'sweep'   (default 'run'; sweep ignores strategy)
//   symbol, timeframe ('1m'|'5m'|'15m'), strategy (AlgoStrategyId),
//   params: Record<string, number>,       base parameters
//   ranges?: { key, min, max, step }[]    (optimize mode — numeric params only)
//   days?: number                          calendar days of history
//   qty, tpMode, tpValue, slMode, slValue, maxTradesDay, rthOnly, flattenEod,
//   cooldownMin?: number                    (Task 70-c) no-entry minutes after a close (0..240, default 0)
//   requireNewSignal?: boolean              (Task 70-c) edge-triggered re-entry (default false)
//   slippageBps?: number                    (Task 84) adverse bps on market/stop fills (default 0)
//   feeBps?: number                         (Task 84) per-fill notional fee bps (default 0)
//   spreadBps?: number                      (Task 85) bid/ask spread bps — half charged per market fill (default 0)
//   sizingMode?: 'fixed'|'risk'             (Task 78) 'risk' = Risk-Money sizing (default 'fixed')
//   riskBasis?: 'usd'|'pct'                 (Task 78e) budget basis: dollars (default) or % of equity
//   riskMoney?: number                      (Task 78) dollars at risk per trade (required for risk+usd)
//   riskMoneyPct?: number                   (Task 78e) % of equity per trade (required for risk+pct)
//   capital?: number                       starting equity for % / DD metrics
//   minTrades?: number                     (optimize/sweep) minimum trades to score
//   topX?: number                          (sweep) how many winners to list (1..20, default 8)
// }
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { getBars } from '@/lib/alpaca'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import { isAlgoStrategyId, normalizeAlgoParams, ALGO_TIMEFRAMES, ALGO_MAX_DAYS, type AlgoTimeframe } from '@/lib/algo-strategies'
import {
  prepareSeries, runBacktest, optimizeBacktest, sweepStrategies,
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
  slippageBps?: number
  feeBps?: number
  spreadBps?: number
  sizingMode?: string
  riskBasis?: string
  riskMoney?: number | null
  riskMoneyPct?: number | null
  capital?: number
  minTrades?: number
  topX?: number
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await readJson<BacktestBody>(req)
    const mode = body.mode === 'optimize' || body.mode === 'sweep' ? body.mode : 'run'

    // sweep mode (Task 87) runs the WHOLE catalog — the caller's strategy (if
    // any) is only a placeholder for the shared config validation below; every
    // sweep candidate gets its own catalog params inside sweepStrategies().
    let strategy = body.strategy
    if (mode === 'sweep') strategy = isAlgoStrategyId(strategy) ? strategy : 'bb-reversion'
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
    // Task 78 — Risk Money sizing; Task 78e — budget basis ($ or % of equity).
    // risk+usd requires riskMoney > 0 · risk+pct requires riskMoneyPct > 0.
    const sizingMode = body.sizingMode === 'risk' ? 'risk' : 'fixed'
    const riskBasis = body.riskBasis === 'pct' ? 'pct' : 'usd'
    const riskMoneyRaw = Number(body.riskMoney)
    const riskMoney = Number.isFinite(riskMoneyRaw) && riskMoneyRaw > 0
      ? Math.min(10_000_000, riskMoneyRaw)
      : null
    const riskPctRaw = Number(body.riskMoneyPct)
    const riskMoneyPct = Number.isFinite(riskPctRaw) && riskPctRaw > 0
      ? Math.min(100, riskPctRaw)
      : null
    if (sizingMode === 'risk' && riskBasis === 'pct' && riskMoneyPct == null) {
      return NextResponse.json({ error: 'Risk % must be a positive number (percent of equity) when sizing mode is risk' }, { status: 400 })
    }
    if (sizingMode === 'risk' && riskBasis !== 'pct' && riskMoney == null) {
      return NextResponse.json({ error: 'Risk money must be a positive number when sizing mode is risk' }, { status: 400 })
    }

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
      sizingMode,
      riskBasis: sizingMode === 'risk' ? riskBasis : 'usd',
      riskMoney: sizingMode === 'risk' && riskBasis !== 'pct' ? riskMoney : null,
      riskMoneyPct: sizingMode === 'risk' && riskBasis === 'pct' ? riskMoneyPct : null,
      isCrypto: symbol.includes('/'),
      tpMode: body.tpMode === 'pct' ? 'pct' : 'none',
      tpValue: body.tpMode === 'pct' && Number(body.tpValue) > 0 ? Number(body.tpValue) : null,
      slMode: body.slMode === 'pct' ? 'pct' : 'none',
      slValue: body.slMode === 'pct' && Number(body.slValue) > 0 ? Number(body.slValue) : null,
      maxTradesDay,
      rthOnly: body.rthOnly !== false,
      flattenEod: body.flattenEod !== false,
      cooldownMin: Math.min(240, Math.max(0, Math.round(Number(body.cooldownMin) || 0))),
      requireNewSignal: body.requireNewSignal === true,
      // Task 84 — execution-cost model (bps, default 0 = frictionless)
      slippageBps: Math.min(500, Math.max(0, Math.round(Number(body.slippageBps) || 0))),
      feeBps: Math.min(500, Math.max(0, Math.round(Number(body.feeBps) || 0))),
      // Task 85 — bid/ask spread (bps, half charged per market fill)
      spreadBps: Math.min(500, Math.max(0, Math.round(Number(body.spreadBps) || 0))),
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

    if (mode === 'sweep') {
      const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
      const topX = Math.min(20, Math.max(1, Math.round(Number(body.topX) || 8)))
      const sweep = sweepStrategies(series, cfg, { minTrades, topX })
      return NextResponse.json({ sweep, meta })
    }

    const result = runBacktest(series, cfg)
    return NextResponse.json({ result, meta })
  } catch (e) {
    return handleError(e)
  }
}
