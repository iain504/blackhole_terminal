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
//   maxNotionalX?: number                   (Task 3-d) buying-power cap: max position notional =
//                                           capital × maxNotionalX (0.1..10, default 1 = no leverage)
//   oosFraction?: number                    (Task 3-d, sweep) walk-forward: tune on the first (1-f)
//                                           of bars, re-run winners untouched on the tail (0..0.5, default 0)
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
import { rateLimit } from '@/lib/rate-limit'
import {
  prepareSeries, runBacktest, optimizeBacktest, sweepStrategies,
  type BacktestConfig, type OptimizeRange,
} from '@/lib/backtest'
import { memoryGuard, memoryGuardResponse } from '@/lib/mem-guard'

export const dynamic = 'force-dynamic'

const MAX_BARS = 120_000

// Task 3-d — in-process concurrency guard: one backtest AT A TIME per user
// (each run holds ~50MB of bars + a full sim; parallel runs OOM the box).
// ALWAYS released in the finally block inside POST().
const runningBacktests = new Set<string>()

/** Task 3-d — wire format for the equity curve: ≤500 points (stride + first/last). */
function downsampleEquity(equity: { t: number; equity: number }[]): { t: number; equity: number }[] {
  if (equity.length <= 500) return equity
  // stride over n-1 gaps with max-1 slots so first + last + stride points
  // always fit within 500
  const stride = Math.ceil((equity.length - 1) / 499)
  const out = equity.filter((_, i) => i % stride === 0)
  const last = equity[equity.length - 1]
  if (last && out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Short-TTL cache for backtest history — a deep window (730d crypto ≈ 86k bars)
 * takes 6–35s to paginate from the feeds, and the tune→re-run→optimize loop
 * would otherwise re-pay that on EVERY request. Historical bars are immutable
 * except the newest (the forming bar is dropped per request anyway), so 2min
 * staleness is invisible to the replay. Task 9-l: bounded to 6 entries
 * (~60-80MB worst) — this cache duplicates the global bars-cache, and on the
 * 1.8GB-heap dev box every retained MB is sweep headroom.
 */
const BARS_TTL_MS = 120_000
const BARS_CACHE_MAX = 6
const barsCache = new Map<string, { at: number; res: Awaited<ReturnType<typeof getBars>> }>()

async function getBarsCached(symbol: string, tf: Timeframe, userId: string, days: number) {
  // Task 9-p — NEVER retain a 1m window (30d ≈ 43k bars): the tune→re-run
  // loop's refetch for 1m costs a couple of seconds, the retained window
  // costs tens of MB of heap for minutes. This cache duplicated the global
  // bars-cache — the double retention is exactly what killed the box on
  // repeated 1m backtests.
  if (tf === '1m') return getBars(symbol, tf, userId, { lookbackDays: days })
  const key = `${userId}|${symbol}|${tf}|${days}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.res
  const res = await getBars(symbol, tf, userId, { lookbackDays: days })
  barsCache.set(key, { at: Date.now(), res })
  if (barsCache.size > BARS_CACHE_MAX) {
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
  maxNotionalX?: number
  oosFraction?: number
  capital?: number
  minTrades?: number
  topX?: number
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    // Task 3-d — per-user throttle: 6 runs / minute (CPU-heavy endpoint).
    const rl = rateLimit(`bt:${user.id}`, 6, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many backtests — retry in ${rl.retryAfterSec}s`, retryAfterSec: rl.retryAfterSec },
        { status: 429 },
      )
    }
    // Task 3-d — one backtest at a time per user; the guard ALWAYS releases.
    if (runningBacktests.has(user.id)) {
      return NextResponse.json({ error: 'A backtest is already running' }, { status: 429 })
    }
    runningBacktests.add(user.id)
    try {
      return await handleBacktest(req, user.id)
    } finally {
      runningBacktests.delete(user.id)
    }
  } catch (e) {
    return handleError(e)
  }
}

async function handleBacktest(req: NextRequest, userId: string): Promise<NextResponse> {
  try {
    // Task 9-p — gate EVERY mode (plain runs included): a deep 1m window is
    // the heaviest single allocation in the app and 'run' used to be the one
    // ungated entry (optimize/sweep gated after the fetch). Refusing to start
    // on a hot heap is a 503; starting is a dead server.
    const memGate = memoryGuard(0.7)
    if (!memGate.ok) {
      return NextResponse.json(memoryGuardResponse(memGate), { status: 503, headers: { 'retry-after': '60' } })
    }
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
    const res = await getBarsCached(symbol, tf as Timeframe, userId, days)
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
      // Task 3-d — buying-power cap (0.1..10, default 1 = max 1× capital per position)
      maxNotionalX: Number.isFinite(Number(body.maxNotionalX)) && Number(body.maxNotionalX) > 0
        ? Math.min(10, Math.max(0.1, Number(body.maxNotionalX)))
        : 1,
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
      // Task 9-l — heap guard: a grid search cannot downsize mid-flight, and
      // over the heap ceiling it kills the PROCESS (fatal OOM), so refuse
      // politely while the heap is hot instead of dying.
      const mem = memoryGuard(0.7)
      if (!mem.ok) {
        return NextResponse.json(memoryGuardResponse(mem), { status: 503, headers: { 'retry-after': '60' } })
      }
      const ranges = Array.isArray(body.ranges) ? (body.ranges as OptimizeRange[]) : []
      const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
      const optimize = optimizeBacktest(series, cfg, ranges, { minTrades })
      if (optimize.totalCombos === 0) {
        return NextResponse.json({ error: 'No valid optimize ranges — tick at least one parameter and set min < max' }, { status: 400 })
      }
      return NextResponse.json({ optimize, meta })
    }

    if (mode === 'sweep') {
      // Task 9-l — heap guard (see optimize branch): the all-strategies sweep
      // is the heaviest request in the app — hundreds of sims × IS/OOS series
      // copies. When the heap is already near its cap this is a fatal-OOM
      // sentence; a 503 the UI can surface is strictly better.
      const mem = memoryGuard(0.7)
      if (!mem.ok) {
        return NextResponse.json(memoryGuardResponse(mem), { status: 503, headers: { 'retry-after': '60' } })
      }
      const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
      const topX = Math.min(20, Math.max(1, Math.round(Number(body.topX) || 8)))
      // Task 3-d — walk-forward fraction (0..0.5, default 0 = off)
      const oosFraction = Number.isFinite(Number(body.oosFraction))
        ? Math.min(0.5, Math.max(0, Number(body.oosFraction)))
        : 0
      const sweep = sweepStrategies(series, cfg, { minTrades, topX, oosFraction })
      return NextResponse.json({
        sweep,
        meta: { ...meta, mtmDD: true, skippedShorts: sweep.skippedShorts ?? 0 },
      })
    }

    const result = runBacktest(series, cfg)
    // Task 3-d — equity curve for the wire: downsampled to ≤500 points
    // (stride + first/last kept; the point-per-trade array is never shipped)
    const wire = { ...result, equity: downsampleEquity(result.equity) }
    return NextResponse.json({
      result: wire,
      meta: { ...meta, mtmDD: true, skippedShorts: result.metrics.skippedShorts ?? 0 },
    })
  } catch (e) {
    return handleError(e)
  }
}
