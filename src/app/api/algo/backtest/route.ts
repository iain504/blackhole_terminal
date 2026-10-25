// POST /api/algo/backtest (Task 62) — run one backtest OR a grid-search
// parameter optimization for an algo strategy over real historical bars.
// Task 87 adds mode 'sweep' — one click tests EVERY strategy: each runs at
// its defaults plus an auto-built optimizer grid (defaults guaranteed in-grid)
// and the top X rows across all strategies are ranked for one-click apply.
// Task 12 (improvement plan) adds mode 'walkforward' — rolling/anchored
// walk-forward optimization with a pure hold-out tail — plus the Monte Carlo
// bootstrap on plain runs and the vol-scaled slippage cost model.
//
// Task 15 — BACKGROUND JOB MODEL for the heavy modes (optimize / sweep /
// walkforward). Those runs take minutes; as a synchronous request they were
// killed by proxy request timeouts (Render's edge ≈100s) → the browser saw a
// bare 502 with NO result, every time. Now:
//   • POST mode=run        → unchanged inline request (fast single sim)
//   • POST heavy mode      → validates nothing heavy, returns `202 { jobId }`
//     immediately and runs the work DETACHED in this process (see
//     src/lib/backtest-jobs.ts for the why)
//   • GET ?job=<id>        → poll: { status:'running', frac, stage } |
//     { status:'done', <same payload the inline POST used to return> } |
//     { status:'error', error }
// The single-flight guard (one heavy backtest per user) is shared by both
// paths via the jobs lib — inline runs and jobs can never stack.
//
// body: {
//   mode?: 'run' | 'optimize' | 'sweep' | 'walkforward'   (default 'run'; sweep ignores strategy)
//   symbol, timeframe ('1m'|'5m'|'15m'), strategy (AlgoStrategyId),
//   params: Record<string, number>,       base parameters
//   ranges?: { key, min, max, step }[]    (optimize/walkforward — numeric params only)
//   days?: number                          calendar days of history
//   qty, tpMode, tpValue, slMode, slValue, maxTradesDay, rthOnly, flattenEod,
//   cooldownMin?: number                    (Task 70-c) no-entry minutes after a close (0..240, default 0)
//   requireNewSignal?: boolean              (Task 70-c) edge-triggered re-entry (default false)
//   slippageBps?: number                    (Task 84) adverse bps on market/stop fills (default 0)
//   feeBps?: number                         (Task 84) per-fill notional fee bps (default 0)
//   spreadBps?: number                      (Task 85) bid/ask spread bps — half charged per market fill (default 0)
//   dynSlip?: boolean                       (Task 12) vol-scale the slippage impact by ATR% (default false)
//   sizingMode?: 'fixed'|'risk'             (Task 78) 'risk' = Risk-Money sizing (default 'fixed')
//   riskBasis?: 'usd'|'pct'                 (Task 78e) budget basis: dollars (default) or % of equity
//   riskMoney?: number                      (Task 78) dollars at risk per trade (required for risk+usd)
//   riskMoneyPct?: number                   (Task 78e) % of equity per trade (required for risk+pct)
//   maxNotionalX?: number                   (Task 3-d) buying-power cap: max position notional =
//                                           capital × maxNotionalX (0.1..10, default 1 = no leverage)
//   oosFraction?: number                    (Task 3-d, sweep) walk-forward: tune on the first (1-f)
//                                           of bars, re-run winners untouched on the tail (0..0.5, default 0)
//   folds?: number                          (Task 12, walkforward) 2..6 folds (default 3)
//   isFraction?: number                     (Task 12, walkforward) per-fold IS share 0.5..0.9 (default 0.7)
//   anchored?: boolean                      (Task 12, walkforward) expanding IS windows (default false)
//   holdoutFraction?: number                (Task 12, walkforward) pure hold-out tail 0..0.4 (default 0.2)
//   capital?: number                       starting equity for % / DD metrics
//   minTrades?: number                     (optimize/sweep/walkforward) minimum trades to score
//   topX?: number                          (sweep) how many winners to list (1..20, default 8)
// }
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { type Timeframe } from '@/lib/market-types'
import { isAlgoStrategyId, normalizeAlgoParams, ALGO_TIMEFRAMES, ALGO_MAX_DAYS, type AlgoTimeframe } from '@/lib/algo-strategies'
import { rateLimit } from '@/lib/rate-limit'
import {
  prepareSeries, runBacktest, optimizeBacktest, sweepStrategies, walkForward,
  type BacktestConfig, type OptimizeRange, type BacktestProgress,
} from '@/lib/backtest'
import { monteCarloBootstrap } from '@/lib/algo-regime'
import { memoryGuard, memoryGuardResponse } from '@/lib/mem-guard'
import {
  createBacktestJob, getBacktestJob, tryAcquireBacktestSlot, releaseBacktestSlot,
  completeJob, failJob, jobProgress,
} from '@/lib/backtest-jobs'

export const dynamic = 'force-dynamic'

const MAX_BARS = 120_000

/** Task 15 — heavy modes run detached as background jobs. */
const JOB_MODES = new Set(['optimize', 'sweep', 'walkforward'])

/** Task 15 — wire format for the equity curve: ≤500 points (stride + first/last). */
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
 *
 * Task 10-a — the cache + the demo/short-history/forming-bar gates were
 * EXTRACTED VERBATIM into src/lib/backtest-history.ts so the grid backtest
 * reuses the exact same machinery; the algo route's behavior is unchanged.
 */
import { fetchBacktestBars } from '@/lib/backtest-history'

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
  dynSlip?: boolean
  sizingMode?: string
  riskBasis?: string
  riskMoney?: number | null
  riskMoneyPct?: number | null
  maxNotionalX?: number
  oosFraction?: number
  folds?: number
  isFraction?: number
  anchored?: boolean
  holdoutFraction?: number
  capital?: number
  minTrades?: number
  topX?: number
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    // Task 3-d — per-user throttle: 6 runs / minute (CPU-heavy endpoint).
    const rl = await rateLimit(`bt:${user.id}`, 6, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many backtests — retry in ${rl.retryAfterSec}s`, retryAfterSec: rl.retryAfterSec },
        { status: 429 },
      )
    }
    const body = await readJson<BacktestBody>(req)
    const mode = body.mode === 'optimize' || body.mode === 'sweep' || body.mode === 'walkforward' ? body.mode : 'run'

    // Task 15 — heavy modes return 202 + jobId and run detached (see
    // backtest-jobs.ts). The response is back in milliseconds; the client
    // polls GET ?job=… for progress and the final payload.
    if (JOB_MODES.has(mode)) {
      // fast pre-gate: refusing to even queue on a hot heap is a 503 the UI
      // can show immediately (the job re-gates when it actually starts)
      const memGate = memoryGuard(0.7)
      if (!memGate.ok) {
        return NextResponse.json(memoryGuardResponse(memGate), { status: 503, headers: { 'retry-after': '60' } })
      }
      const job = createBacktestJob(user.id)
      if (!job) {
        return NextResponse.json({ error: 'A backtest is already running' }, { status: 429 })
      }
      void (async () => {
        try {
          const r = await computeBacktest(user.id, body, jobProgress(job))
          if (r.status === 200) completeJob(job, r.body)
          else failJob(job, typeof r.body.error === 'string' ? r.body.error : `HTTP ${r.status}`)
        } catch (e) {
          failJob(job, e instanceof Error ? e.message : 'Backtest failed')
        }
      })()
      return NextResponse.json({ jobId: job.id, pollMs: 1500, mode }, { status: 202 })
    }

    // Task 3-d — one inline backtest at a time per user; the guard ALWAYS
    // releases. (Heavy jobs hold the same slot for their whole lifetime.)
    if (!tryAcquireBacktestSlot(user.id)) {
      return NextResponse.json({ error: 'A backtest is already running' }, { status: 429 })
    }
    try {
      const r = await computeBacktest(user.id, body)
      return NextResponse.json(r.body, { status: r.status })
    } finally {
      releaseBacktestSlot(user.id)
    }
  } catch (e) {
    return handleError(e)
  }
}

/**
 * GET /api/algo/backtest?job=<id> — poll a background optimizer job (Task 15).
 * running → { status:'running', frac, stage, startedAt, elapsedSec }
 * done    → { status:'done', …the exact payload the inline POST returned }
 * error   → { status:'error', error }   (validation 400s, mem-gate 503, …)
 * 404     → unknown/expired job (or the server restarted — jobs are in-memory)
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const jobId = req.nextUrl.searchParams.get('job')
    if (!jobId) {
      return NextResponse.json({ error: 'Missing job id' }, { status: 400 })
    }
    const job = getBacktestJob(user.id, jobId)
    if (!job) {
      return NextResponse.json(
        { error: 'Job not found — the server may have restarted; run the optimizer again' },
        { status: 404 },
      )
    }
    if (job.status === 'running') {
      return NextResponse.json({
        status: 'running',
        frac: job.frac,
        stage: job.stage,
        startedAt: job.createdAt,
        elapsedSec: Math.round((Date.now() - job.createdAt) / 1000),
      })
    }
    if (job.status === 'error') {
      return NextResponse.json({ status: 'error', error: job.error ?? 'Backtest failed' })
    }
    return NextResponse.json({ status: 'done', ...(job.result ?? {}) })
  } catch (e) {
    return handleError(e)
  }
}

/**
 * Task 15 — the former handleBacktest, converted to return { status, body }
 * so both the inline path and the background-job runner share one
 * implementation. Throws only on unexpected errors (auth/db) — validation
 * and gate failures are returned as status+body.
 */
async function computeBacktest(
  userId: string,
  body: BacktestBody,
  onProgress?: BacktestProgress,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Task 9-p — gate EVERY mode (plain runs included): a deep 1m window is
  // the heaviest single allocation in the app and 'run' used to be the one
  // ungated entry (optimize/sweep gated after the fetch). Refusing to start
  // on a hot heap is a 503; starting is a dead server.
  const memGate = memoryGuard(0.7)
  if (!memGate.ok) {
    return { status: 503, body: memoryGuardResponse(memGate) as Record<string, unknown> }
  }
  const mode = body.mode === 'optimize' || body.mode === 'sweep' || body.mode === 'walkforward' ? body.mode : 'run'

  // sweep mode (Task 87) runs the WHOLE catalog — the caller's strategy (if
  // any) is only a placeholder for the shared config validation below; every
  // sweep candidate gets its own catalog params inside sweepStrategies().
  let strategy = body.strategy
  if (mode === 'sweep') strategy = isAlgoStrategyId(strategy) ? strategy : 'bb-reversion'
  if (!isAlgoStrategyId(strategy)) {
    return { status: 400, body: { error: 'Unknown strategy' } }
  }
  const tf = ALGO_TIMEFRAMES.includes(body.timeframe as AlgoTimeframe) ? (body.timeframe as AlgoTimeframe) : null
  if (!tf) {
    return { status: 400, body: { error: 'Timeframe must be one of 1m / 5m / 15m' } }
  }
  const symbol = String(body.symbol ?? '').trim().toUpperCase()
  if (!symbol || !/^[A-Z0-9./:-]{1,15}$/.test(symbol)) {
    return { status: 400, body: { error: 'Invalid symbol' } }
  }
  const days = Math.min(ALGO_MAX_DAYS[tf], Math.max(1, Math.round(Number(body.days) || 30)))
  const qty = Number(body.qty)
  if (!(qty > 0)) {
    return { status: 400, body: { error: 'Quantity must be > 0' } }
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
    return { status: 400, body: { error: 'Risk % must be a positive number (percent of equity) when sizing mode is risk' } }
  }
  if (sizingMode === 'risk' && riskBasis !== 'pct' && riskMoney == null) {
    return { status: 400, body: { error: 'Risk money must be a positive number when sizing mode is risk' } }
  }

  // ---- fetch the history (same source the live engine polls; TTL-cached —
  // Task 10-a: shared fetchBacktestBars helper, identical gates/messages) ----
  // Task 15 — the deep fetch is the SLOW phase (6–35s cold, paginated from
  // the feeds); surface it in the job progress so the UI never shows a bare
  // "queued 0%" while bars are streaming in.
  onProgress?.(0.01, `fetching ${symbol} ${tf} bars (${days}d)…`)
  const hist = await fetchBacktestBars(symbol, tf as Timeframe, userId, days, MAX_BARS)
  if (!hist.ok) {
    return { status: 400, body: { error: hist.error } }
  }
  onProgress?.(0.04, 'preparing series…')
  const bars = hist.bars

  // ACTUAL coverage — the feed may return less history than requested (per-
  // feed bar caps, brand-new listings). Report the real window so the UI can
  // say "data Jul 9 → Oct 21" instead of pretending the requested period.
  const fromT = bars[0].time
  const toT = bars[bars.length - 1].time
  const nowSec = Math.floor(Date.now() / 1000)
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
    // Task 12 — vol-scaled slippage (ATR% × impact, clamped 0.5..3)
    dynSlip: body.dynSlip === true,
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
    source: hist.source ?? 'alpaca',
    dataCapped: coveredDays < days - 3,
  }

  if (body.mode === 'optimize') {
    // Task 9-l — heap guard: a grid search cannot downsize mid-flight, and
    // over the heap ceiling it kills the PROCESS (fatal OOM), so refuse
    // politely while the heap is hot instead of dying.
    const mem = memoryGuard(0.7)
    if (!mem.ok) {
      return { status: 503, body: memoryGuardResponse(mem) as Record<string, unknown> }
    }
    const ranges = Array.isArray(body.ranges) ? (body.ranges as OptimizeRange[]) : []
    const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
    const optimize = optimizeBacktest(series, cfg, ranges, { minTrades, onProgress })
    if (optimize.totalCombos === 0) {
      return { status: 400, body: { error: 'No valid optimize ranges — tick at least one parameter and set min < max' } }
    }
    return { status: 200, body: { optimize, meta } }
  }

  if (mode === 'sweep') {
    // Task 9-l — heap guard (see optimize branch): the all-strategies sweep
    // is the heaviest request in the app — hundreds of sims × IS/OOS series
    // copies. When the heap is already near its cap this is a fatal-OOM
    // sentence; a 503 the UI can surface is strictly better.
    const mem = memoryGuard(0.7)
    if (!mem.ok) {
      return { status: 503, body: memoryGuardResponse(mem) as Record<string, unknown> }
    }
    const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
    const topX = Math.min(20, Math.max(1, Math.round(Number(body.topX) || 8)))
    // Task 3-d — walk-forward fraction (0..0.5, default 0 = off)
    const oosFraction = Number.isFinite(Number(body.oosFraction))
      ? Math.min(0.5, Math.max(0, Number(body.oosFraction)))
      : 0
    const sweep = sweepStrategies(series, cfg, { minTrades, topX, oosFraction, onProgress })
    return {
      status: 200,
      body: { sweep, meta: { ...meta, mtmDD: true, skippedShorts: sweep.skippedShorts ?? 0 } },
    }
  }

  if (mode === 'walkforward') {
    // Task 12 — the heaviest mode: folds × (optimizer + verify) + hold-out.
    // Same heap gate as the sweep, same concurrency guard as every mode.
    const mem = memoryGuard(0.7)
    if (!mem.ok) {
      return { status: 503, body: memoryGuardResponse(mem) as Record<string, unknown> }
    }
    const ranges = Array.isArray(body.ranges) ? (body.ranges as OptimizeRange[]) : []
    const minTrades = Math.min(200, Math.max(1, Math.round(Number(body.minTrades) || 8)))
    const wf = walkForward(series, cfg, {
      ranges,
      folds: Math.min(6, Math.max(2, Math.round(Number(body.folds) || 3))),
      isFraction: Number.isFinite(Number(body.isFraction)) ? Number(body.isFraction) : 0.7,
      anchored: body.anchored === true,
      holdoutFraction: Number.isFinite(Number(body.holdoutFraction)) ? Number(body.holdoutFraction) : 0.2,
      minTrades,
      onProgress,
    })
    return { status: 200, body: { walkforward: wf, meta } }
  }

  const result = runBacktest(series, cfg)
  // Task 3-d — equity curve for the wire: downsampled to ≤500 points
  // (stride + first/last kept; the point-per-trade array is never shipped)
  const wire = { ...result, equity: downsampleEquity(result.equity) }
  // Task 12 — Monte Carlo bootstrap of the realized trade sequence:
  // resample-with-replacement confidence bands for the edge (null when
  // there are too few trades to mean anything)
  const mc = monteCarloBootstrap(
    result.trades.map((t) => t.pnl),
    capital,
  )
  return {
    status: 200,
    body: {
      result: wire,
      mc,
      meta: { ...meta, mtmDD: true, skippedShorts: result.metrics.skippedShorts ?? 0, dynSlip: cfg.dynSlip === true && (cfg.slippageBps ?? 0) > 0 },
    },
  }
}
