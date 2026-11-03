// v2.4.0 — Nebula Autopilot engine (智慧體 / FSD-style fleet manager).
//
// One autonomous pipeline per session:
//   scan    → every universe symbol: deep bars + full-catalog sweeps on BOTH
//             lanes (day @ 15m, swing @ 1h — MTF ladder included), realistic
//             per-market costs, 25% OOS walk-forward on every sweep row.
//   tune    → the top candidates go through optimizeBacktest grids (strategy
//             params + the virtual tpValue/slValue dims).
//   ranking → Calmar-score board, OOS-verified rows first, ranked 1..N.
//   budget  → live account BUYING POWER: deployable = BP × deployCapPct,
//             per-slot budget, risk-% cap, per-position notional cap → the
//             exact qty for every fleet slot (riskSizedQty + notional caps).
//   ready   → the ranking table waits for the ENGAGE command.
//   engaged → for each fleet slot a REAL AlgoRun engine starts (the same
//             15s-cycle engine the Algo tab drives), mode per settings —
//             paper or live (v2.4.0 live unlock).
//
// The pipeline runs detached (like backtest-jobs / reco refresh), writes
// progress into the AgentSession row and every decision into AgentEvent so
// the tab can replay exactly what the autopilot was thinking.
import {
  db, dbDiskStatus, checkpointWal, isDiskFullError, diskFullError,
  DISK_MIN_FREE_BYTES, DISK_WARN_FREE_BYTES, humanBytes,
} from '@/lib/db'
import { memoryGuard } from '@/lib/mem-guard'
import { getAccount } from '@/lib/trading'
import { getQuotes, hasAlpacaKeys } from '@/lib/alpaca'
import { fetchBacktestBars } from '@/lib/backtest-history'
import {
  prepareSeries, sweepStrategies, optimizeBacktest, autoOptimizeRanges,
  type BacktestConfig, type BacktestSeries, type SweepRow, type OptimizeRange,
} from '@/lib/backtest'
import {
  ALGO_STRATEGIES, strategyLane, algoMaxDays, MTF_TREND_TF, MTF_MID_TF,
  riskSizedQty, type AlgoStrategyId, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { startAlgoRun, stopAlgoRun, ALGO_MAX_RUNNING_RUNS } from '@/lib/algo-engine'
import { getSentimentSummary, topUpSentiment, startFleetSentimentRefresher } from '@/lib/sentiment-engine'
import { getRegimeSnapshot } from '@/lib/regime-engine'
import type { RegimeSnapshot } from '@/lib/regime-types'
import {
  getEarningsBatch, earningsLabel, EARNINGS_BLOCK_DAYS, EARNINGS_WARN_DAYS, EARNINGS_SCORE_MULT,
} from '@/lib/earnings'
import { costsFor } from '@/lib/algo-reco'
import { agentUniverse, AGENT_US_100 } from '@/lib/agent-universe'
import {
  AGENT_SETTINGS_DEFAULTS, type AgentCandidate, type AgentSettings,
  type AgentSessionStatus, type AgentStats, type AgentBudget, type AgentRunRow,
} from '@/lib/agent-types'
import type { BacktestMetrics, SweepOos } from '@/lib/backtest'

const SCAN_DAY_TF: AlgoTimeframe = '15m'
const SCAN_SWING_TF: AlgoTimeframe = '1h'
const SCAN_DAY_DAYS = 120
// v2.4.1 — 400d (was 240d): crypto 1h at 400d ≈ 9.6k bars crosses the 9k
// deep-path threshold, so crypto swing history comes from the bar-store /
// Alpaca deep fetch instead of the bursty Binance klines path (which
// rate-limits whole IPs on a 12-symbol scan burst — HTTP 418). Stocks get a
// deeper swing window too (~2.8k RTH bars — still light), inside the 500d cap.
const SCAN_SWING_DAYS = 400
const SWEEP_TOP_X = 2
const SWEEP_MAX_COMBOS = 20
const SWEEP_OOS = 0.25
const SWEEP_MIN_TRADES = 8
const TUNE_MAX_COMBOS = 160
const HEAP_ABORT = 0.78
const MAX_EVENTS = 400
const MIN_POS_NOTIONAL = 10 // a planned position below $10 is dust — skipped

// v2.8.0 — persistent scan-result store (AgentScanCache table).
//
// The full scan is the longest, most expensive operation in the app (100+
// symbols × 2 lanes × deep bars + full-catalog sweeps + optimizer grids).
// Every (symbol, lane) result lands in the store the moment it is computed,
// which gives three properties the user asked for:
//   1. PERSISTENCE — results survive process restarts and DB sessions.
//   2. INCREMENTAL RERUN — a relaunch (after a crash, an abort or a fresh
//      day) recomputes ONLY symbols that are missing or stale; everything
//      fresh is reused verbatim, so a crash-resume costs seconds.
//   3. AGE REFRESH — rows older than SCAN_CACHE_FRESH_MS are stale and get
//      recomputed on the next run (the market moved; the backtest follows).
// Bump SCAN_CACHE_ENGINE whenever sweep behavior changes (strategy catalog,
// costs, lane windows) — it invalidates the whole store in one move.
const SCAN_CACHE_ENGINE = 'v1'
const SCAN_CACHE_FRESH_MS = 24 * 60 * 60 * 1000 // results refresh when older than 24h

type CacheRow = Awaited<ReturnType<typeof db.agentScanCache.findUnique>>

type ScanRow = { symbol: string; isCrypto: boolean; row: SweepRow; tf: AlgoTimeframe; lane: 'day' | 'swing'; bars: number; coveredDays: number; cached?: NonNullable<CacheRow> }

/** Fresh (symbol, lane) cache row, or null when missing/stale/other-engine. */
async function loadFreshCache(symbol: string, lane: 'day' | 'swing'): Promise<CacheRow> {
  try {
    const row = await db.agentScanCache.findUnique({ where: { symbol_lane: { symbol, lane } } })
    if (!row || row.engine !== SCAN_CACHE_ENGINE) return null
    if (Date.now() - row.computedAt.getTime() > SCAN_CACHE_FRESH_MS) return null
    return row
  } catch {
    return null // cache must never break the scan
  }
}

/** Rebuild the pipeline's ScanRow from a positive cache row (null for the 'none' sentinel). */
function cachedToScanRow(c: NonNullable<CacheRow>, symbol: string, isCrypto: boolean): ScanRow | null {
  if (c.strategy === 'none' || c.score == null || !c.metrics || !c.params) return null
  return {
    symbol,
    isCrypto,
    row: {
      strategy: c.strategy as ScanRow['row']['strategy'],
      params: c.params as Record<string, number>,
      score: c.score,
      metrics: c.metrics as BacktestMetrics,
      oos: (c.oos as SweepOos | null) ?? null,
      boundary: c.boundary,
    },
    tf: c.tf as ScanRow['tf'],
    lane: c.lane as ScanRow['lane'],
    bars: c.bars,
    coveredDays: c.coveredDays,
  }
}

/** Persist one (symbol, lane) outcome — positive best-row or the 'none' sentinel. */
async function writeCacheRow(symbol: string, isCrypto: boolean, lane: 'day' | 'swing', tf: AlgoTimeframe, best: SweepRow | null, bars: number, coveredDays: number): Promise<void> {
  const base = {
    engine: SCAN_CACHE_ENGINE, isCrypto, tf,
    strategy: best ? best.strategy : 'none',
    params: (best ? best.params : null) as object | null,
    metrics: (best ? best.metrics : null) as object | null,
    oos: (best?.oos ?? null) as object | null,
    score: best ? best.score : null,
    boundary: best?.boundary === true,
    bars, coveredDays,
    // a fresh sweep invalidates the previous tuning outcome
    tunedStrategy: null, tunedParams: null, tunedTpPct: null, tunedSlPct: null, tunedMetrics: null,
    computedAt: new Date(),
  }
  try {
    await db.agentScanCache.upsert({
      where: { symbol_lane: { symbol, lane } },
      create: { symbol, lane, ...base },
      update: base,
    })
  } catch { /* cache write failures never break the scan */ }
}

/** Persist the tuning outcome of one cached (symbol, lane) row. */
async function writeCacheTuned(symbol: string, lane: 'day' | 'swing', strategy: string, tp: number | null, sl: number | null, params: Record<string, number> | null, metrics: BacktestMetrics | null, score: number | null): Promise<void> {
  try {
    await db.agentScanCache.update({
      where: { symbol_lane: { symbol, lane } },
      data: {
        tunedStrategy: strategy,
        tunedParams: (params ?? null) as object | null,
        tunedTpPct: tp,
        tunedSlPct: sl,
        tunedScore: score,
        tunedMetrics: (metrics ?? null) as object | null,
      },
    })
  } catch { /* cache write failures never break the scan */ }
}

// ---------------------------------------------------------------------------
// session/job registry (single-flight per user, survives HMR via globalThis)
// ---------------------------------------------------------------------------
interface AgentJob {
  sessionId: string
  userId: string
  abort: boolean
}
type GlobalWithAgent = typeof globalThis & { __ttAgentJobs?: Map<string, AgentJob> }
const g = globalThis as GlobalWithAgent
const jobs: Map<string, AgentJob> = (g.__ttAgentJobs ??= new Map())

export function agentJobRunning(userId: string): boolean {
  return jobs.has(userId)
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
async function ev(sessionId: string, userId: string, level: string, message: string): Promise<void> {
  try {
    await db.agentEvent.create({ data: { sessionId, userId, level, message } })
    // bound the feed — drop the oldest once the session history grows past MAX_EVENTS
    const count = await db.agentEvent.count({ where: { sessionId } })
    if (count > MAX_EVENTS) {
      const old = await db.agentEvent.findMany({
        where: { sessionId }, orderBy: { createdAt: 'asc' }, take: count - MAX_EVENTS, select: { id: true },
      })
      if (old.length > 0) {
        await db.agentEvent.deleteMany({ where: { id: { in: old.map((e) => e.id) } } })
      }
    }
  } catch { /* the feed must never break the pipeline */ }
}

const pct = (v: number, d = 2) => Number(v.toFixed(d))

function agentCfg(symbol: string, isCrypto: boolean, lane: 'day' | 'swing'): BacktestConfig {
  const costs = costsFor(symbol)
  return {
    strategy: 'bb-reversion', // placeholder — sweeps override per strategy
    params: {},
    qty: 10,
    sizingMode: 'fixed',
    riskBasis: 'usd',
    riskMoney: null,
    isCrypto,
    // autopilot exit policy — tuned later via the virtual tpValue/slValue dims
    tpMode: 'pct',
    tpValue: lane === 'day' ? 2.5 : 6,
    slMode: 'pct',
    slValue: lane === 'day' ? 1.5 : 3,
    maxTradesDay: 3,
    rthOnly: !isCrypto && lane === 'day',
    flattenEod: lane === 'day',
    cooldownMin: 0,
    requireNewSignal: false,
    slippageBps: costs.slip,
    feeBps: costs.fee,
    spreadBps: costs.spread,
    capital: 10_000,
    maxNotionalX: 1, // no simulated leverage
    collectEquity: false,
    mtf: lane === 'swing' ? { trendTf: MTF_TREND_TF['1h'], midTf: MTF_MID_TF['1h'] } : null,
  }
}

function sweepRowToCandidate(r: ScanRow, base: AgentCandidate | null): AgentCandidate {
  const m = r.row.metrics
  return {
    symbol: r.symbol,
    isCrypto: r.isCrypto,
    tf: r.tf,
    strategy: r.row.strategy,
    params: r.row.params,
    lane: r.lane,
    score: Number.isFinite(r.row.score) ? pct(r.row.score, 3) : 0,
    netPct: pct(m.netPct),
    winRate: pct(m.winRate, 1),
    pf: pct(m.profitFactor),
    maxDDPct: pct(m.maxDrawdownPct),
    trades: m.trades,
    oosNetPct: r.row.oos ? pct(r.row.oos.netPct) : null,
    boundary: r.row.boundary === true,
    bars: r.bars,
    coveredDays: r.coveredDays,
    tuned: false,
    tpPct: base?.tpPct ?? (r.lane === 'day' ? 2.5 : 6),
    slPct: base?.slPct ?? (r.lane === 'day' ? 1.5 : 3),
  }
}

/** Tuning grid: the strategy's sanctioned auto grid + the exit legs. */
function tuneRanges(strategy: AlgoStrategyId, lane: 'day' | 'swing'): OptimizeRange[] {
  const tpValues = lane === 'day' ? [1.5, 2, 2.5, 3, 4] : [4, 5, 6, 8]
  const slValues = lane === 'day' ? [1, 1.25, 1.5, 2, 2.5] : [2, 2.5, 3, 4]
  return [
    ...autoOptimizeRanges(strategy),
    { key: 'tpValue', min: tpValues[0], max: tpValues[tpValues.length - 1], step: 0.5, values: tpValues },
    { key: 'slValue', min: slValues[0], max: slValues[slValues.length - 1], step: 0.25, values: slValues },
  ]
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------
async function runPipeline(sessionId: string, userId: string, settings: AgentSettings): Promise<void> {
  const job = jobs.get(userId)
  const dead = () => !job || job.abort
  const universe = agentUniverse(settings.includeCrypto)
  const scanTotal = universe.length
  const stats: AgentStats = {
    scanned: 0, scanTotal, tuned: 0, tuneTotal: 0,
    fleetStarted: 0, fleetFailed: 0,
    startedAt: new Date().toISOString(), finishedAt: null,
  }
  const touch = async (patch: {
    status?: AgentSessionStatus; phase?: string; progress?: number
    stats?: AgentStats; error?: string | null
    candidates?: AgentCandidate[]; budget?: AgentBudget; universe?: unknown
  }) => {
    const data: Record<string, unknown> = { ...patch }
    if (patch.stats != null) data.stats = patch.stats as unknown as object
    if (patch.candidates != null) data.candidates = patch.candidates as unknown as object
    if (patch.budget != null) data.budget = patch.budget as unknown as object
    if (patch.universe !== undefined) data.universe = patch.universe as object
    await db.agentSession.update({ where: { id: sessionId }, data: data as Parameters<typeof db.agentSession.update>[0]['data'] })
  }

  try {
    await ev(sessionId, userId, 'info',
      `Autopilot engaged — scanning ${scanTotal} symbols (${AGENT_US_100.length} US high-VOL${settings.includeCrypto ? ' + crypto majors' : ''}) · tune top ${settings.topTune} · fleet ${settings.topN} slots`)
    // v2.8.0 — surface how much of this run the results store will absorb
    try {
      const freshRows = await db.agentScanCache.count({
        where: { engine: SCAN_CACHE_ENGINE, computedAt: { gt: new Date(Date.now() - SCAN_CACHE_FRESH_MS) } },
      })
      if (freshRows > 0) {
        await ev(sessionId, userId, 'scan',
          `Results store — ${freshRows} fresh (symbol × lane) row(s) will be REUSED (freshness 24h). A rerun after a crash/restart resumes where the last scan stopped.`)
      }
    } catch { /* informational only */ }
    await touch({ universe: { us: AGENT_US_100, crypto: settings.includeCrypto }, stats })

    // ---------------- phase 1 — SCAN ----------------
    const scanRows: ScanRow[] = []
    for (let i = 0; i < universe.length; i++) {
      if (dead()) throw new Error('aborted')
      const { symbol, isCrypto } = universe[i]
      const mem = memoryGuard(HEAP_ABORT)
      if (!mem.ok) throw new Error(`Scan paused — heap ${mem.heapUsedMb}MB / ${mem.limitMb}MB cap. Retry when the server is quieter.`)
      let added = 0
      try {
        // BOTH lanes per symbol — day scalpers on 15m, MTF swing on 1h
        for (const lane of ['day', 'swing'] as const) {
          const tf = lane === 'day' ? SCAN_DAY_TF : SCAN_SWING_TF
          const days = Math.min(lane === 'day' ? SCAN_DAY_DAYS : SCAN_SWING_DAYS, algoMaxDays(tf, isCrypto))
          // v2.8.0 — results store first: a fresh (symbol, lane) row is reused
          // verbatim (crash resume / incremental rerun); the 'none' sentinel
          // (swept clean) is reused too, so reruns skip those symbols as well
          const cached = await loadFreshCache(symbol, lane)
          if (cached) {
            const reused = cachedToScanRow(cached, symbol, isCrypto)
            if (reused) {
              scanRows.push({ ...reused, cached })
              added++
              stats.reused = (stats.reused ?? 0) + 1
            }
            continue // positive row reused, or negative 'none' sentinel — either way done
          }
          const hist = await fetchBacktestBars(symbol, tf, userId, days)
          if (!hist.ok || !hist.bars || hist.bars.length < 80) continue
          const bars = hist.bars
          const series: BacktestSeries = prepareSeries(bars)
          const cfg = agentCfg(symbol, isCrypto, lane)
          const sweep = await sweepStrategies(series, cfg, {
            lane, minTrades: SWEEP_MIN_TRADES, topX: SWEEP_TOP_X,
            maxCombosPerStrategy: SWEEP_MAX_COMBOS, oosFraction: SWEEP_OOS,
          })
          const best = sweep.rows.find((r) => Number.isFinite(r.score) && r.score > 0) ?? null
          const covered = Math.max(1, Math.round((Date.now() / 1000 - bars[0].time) / 86400))
          // persist the outcome the moment it exists — a crash/rescan resumes from here
          await writeCacheRow(symbol, isCrypto, lane, tf, best, series.n, covered)
          if (best) {
            scanRows.push({ symbol, isCrypto, row: best, tf, lane, bars: series.n, coveredDays: covered })
            added++
          }
        }
      } catch (e) {
        // v2.5.1 — a DISK FULL failure is an environment problem, not a bad
        // symbol: stop the whole scan cleanly instead of hammering 100 more
        // symbols into the same full volume (each retry spams prisma errors
        // to stdout → docker logs → even less disk).
        if (isDiskFullError(e)) throw diskFullError(dbDiskStatus())
        /* otherwise unreachable feed for this symbol — the rest still scan */
      }
      stats.scanned = i + 1
      // v2.5.1 — MID-FLIGHT DISK GUARD: every 10 symbols measure the volume,
      // truncate the WAL and warn early / abort cleanly below the floor.
      if ((i + 1) % 10 === 0) {
        const disk = dbDiskStatus()
        if (disk.freeBytes != null) {
          if (disk.freeBytes < DISK_MIN_FREE_BYTES) throw diskFullError(disk)
          if (disk.freeBytes < DISK_WARN_FREE_BYTES) {
            await checkpointWal('truncate')
            await ev(sessionId, userId, 'warn',
              `Disk running low — ${humanBytes(disk.freeBytes)} free on the database volume. Consider pruning the host before the next scan.`)
          }
        }
      }
      await touch({
        phase: `SCAN ${i + 1}/${scanTotal} · ${symbol}${added ? ' ✓' : ''}`,
        progress: 0.05 + 0.5 * ((i + 1) / scanTotal),
        stats,
      })
      if (added > 0) {
        const last = scanRows[scanRows.length - 1]
        await ev(sessionId, userId, 'scan',
          `${symbol} → ${ALGO_STRATEGIES[last.row.strategy].name} @ ${last.tf} (${last.lane}) · score ${pct(last.row.score, 2)} · net ${pct(last.row.metrics.netPct, 1)}% · ${last.row.metrics.trades} trades${last.row.oos && last.row.oos.netPct > 0 ? ` · OOS +${pct(last.row.oos.netPct, 1)}%` : ''}${last.cached ? ' · from results store' : ''}`)
      }
    }

    if (dead()) throw new Error('aborted')
    if (scanRows.length === 0) {
      throw new Error('No profitable setup found across the whole universe — every symbol swept clean. Widen settings or retry later.')
    }

    // ---------------- phase 2 — TUNE ----------------
    scanRows.sort((a, b) => (Number.isFinite(b.row.score) ? b.row.score : -1e9) - (Number.isFinite(a.row.score) ? a.row.score : -1e9))
    const tunePool = scanRows.slice(0, Math.max(4, Math.min(40, settings.topTune)))
    stats.tuneTotal = tunePool.length
    await touch({ status: 'tuning', phase: `TUNE 0/${tunePool.length}`, stats })
    await ev(sessionId, userId, 'info', `Scan complete — ${scanRows.length}/${scanTotal} symbols produced positive-score setups (${stats.reused ?? 0} lane result(s) reused from the store). Tuning the top ${tunePool.length}.`)

    const candidates: AgentCandidate[] = []
    for (let i = 0; i < tunePool.length; i++) {
      if (dead()) throw new Error('aborted')
      const t = tunePool[i]
      const cand = sweepRowToCandidate(t, null)
      const mem = memoryGuard(HEAP_ABORT)
      // v2.8.0 — tuning reuse: the store remembers the tuned outcome per
      // (symbol, lane). When the sweep row is unchanged, the optimizer grid
      // (up to 160 combos × prepareSeries) is skipped entirely and the tuned
      // params/exit legs/metrics replay from the store.
      const ct = t.cached
      const tunedReusable =
        ct && ct.tunedStrategy === t.row.strategy &&
        ct.tunedParams != null && ct.tunedMetrics != null &&
        ct.tunedTpPct != null && ct.tunedSlPct != null && ct.tunedScore != null
      if (tunedReusable) {
        const tp = { ...(ct.tunedParams as Record<string, number>) }
        const tpV = Number(tp.tpValue)
        const slV = Number(tp.slValue)
        delete tp.tpValue
        delete tp.slValue
        cand.params = tp
        cand.tpPct = ct.tunedTpPct as number
        cand.slPct = ct.tunedSlPct as number
        cand.score = pct(ct.tunedScore as number, 3)
        const tm = ct.tunedMetrics as BacktestMetrics
        cand.netPct = pct(tm.netPct)
        cand.winRate = pct(tm.winRate, 1)
        cand.pf = pct(tm.profitFactor)
        cand.maxDDPct = pct(tm.maxDrawdownPct)
        cand.trades = tm.trades
        cand.tuned = true
      } else if (mem.ok) {
        try {
          const days = Math.min(t.lane === 'day' ? SCAN_DAY_DAYS : SCAN_SWING_DAYS, algoMaxDays(t.tf, t.isCrypto))
          const hist = await fetchBacktestBars(t.symbol, t.tf, userId, days)
          if (hist.ok && hist.bars && hist.bars.length >= 80) {
            const series = prepareSeries(hist.bars)
            const cfg = agentCfg(t.symbol, t.isCrypto, t.lane)
            const opt = await optimizeBacktest(series, cfg, tuneRanges(t.row.strategy, t.lane), {
              minTrades: SWEEP_MIN_TRADES, maxCombos: TUNE_MAX_COMBOS,
            })
            if (opt.best && Number.isFinite(opt.best.score) && opt.best.score > cand.score) {
              const bp = { ...opt.best.params }
              const tpV = Number(bp.tpValue)
              const slV = Number(bp.slValue)
              delete bp.tpValue
              delete bp.slValue
              cand.params = bp
              if (Number.isFinite(tpV) && tpV > 0) cand.tpPct = tpV
              if (Number.isFinite(slV) && slV > 0) cand.slPct = slV
              cand.score = pct(opt.best.score, 3)
              cand.netPct = pct(opt.best.metrics.netPct)
              cand.winRate = pct(opt.best.metrics.winRate, 1)
              cand.pf = pct(opt.best.metrics.profitFactor)
              cand.maxDDPct = pct(opt.best.metrics.maxDrawdownPct)
              cand.trades = opt.best.metrics.trades
              // v2.8.0 — store the winning tune so future runs skip this grid
              void writeCacheTuned(t.symbol, t.lane, t.row.strategy,
                Number.isFinite(tpV) && tpV > 0 ? tpV : null,
                Number.isFinite(slV) && slV > 0 ? slV : null,
                bp, opt.best.metrics, opt.best.score)
            }
            cand.tuned = true
          }
        } catch { /* keep the raw sweep row when tuning fails */ }
      } else {
        cand.tuned = false
      }
      candidates.push(cand)
      stats.tuned = i + 1
      await touch({ phase: `TUNE ${i + 1}/${tunePool.length} · ${t.symbol}${tunedReusable ? ' · store' : ''}`, progress: 0.55 + 0.25 * ((i + 1) / tunePool.length), stats })
      await ev(sessionId, userId, 'tune',
        `${t.symbol} tuned${tunedReusable ? ' (from results store)' : ''} — score ${cand.score} · TP ${cand.tpPct}% / SL ${cand.slPct}% · net ${cand.netPct}% · PF ${cand.pf} · DD ${cand.maxDDPct}%`)
    }

    // ---------------- phase 3 — RANKING ----------------
    if (dead()) throw new Error('aborted')

    // v2.5.0 — SENTIMENT BLEND: the score board now folds in the Market
    // Sentiment Engine. Each candidate's backtest Calmar score (scoreBase) is
    // adjusted by its freshest news-sentiment snapshot: score × (1 + W ×
    // sentiment). A +1.0 bullish tape boosts a setup W%, a -1.0 bearish one
    // cuts it W% — enough to re-order neighbours, never enough to rescue a
    // bad backtest. Symbols with no fresh snapshot keep their raw score.
    // The fleet's live runs also arm the sentiment GATE on engage.
    // v2.7.0 — the weight is user-tunable (mission parameters) and the
    // pipeline now pulls its own news: before blending, the top of the board
    // without a current snapshot gets an inline ingest+score top-up, so the
    // blend runs on real data instead of hoping the user scanned by hand.
    const SENTIMENT_WEIGHT = Math.min(1, Math.max(0, settings.sentimentWeight ?? 0.25))
    let sentimentHits = 0
    try {
      const snapsPre = await getSentimentSummary()
      const freshPre = new Set(snapsPre.filter((s) => !s.stale).map((s) => s.symbol))
      // top-up pool: highest-scored candidates first (candidates arrive in
      // sweep-score order), never symbols that already have a fresh snapshot
      const cap = Math.min(Math.max(settings.topTune, 12), 24)
      const pool: { symbol: string; force?: boolean }[] = []
      const seenPool = new Set<string>()
      for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
        if (pool.length >= cap) break
        if (seenPool.has(c.symbol)) continue
        if (freshPre.has(c.symbol)) continue
        seenPool.add(c.symbol)
        pool.push({ symbol: c.symbol, force: !snapsPre.some((s) => s.symbol === c.symbol) })
      }
      if (pool.length > 0) {
        await touch({ phase: 'SENTIMENT', progress: 0.8, stats })
        await ev(sessionId, userId, 'scan', `Sentiment top-up — pulling fresh news for ${pool.length} setup(s) without a current snapshot…`)
        const topped = await topUpSentiment(pool)
        await ev(sessionId, userId, 'scan', `Sentiment top-up done — ${topped}/${pool.length} symbol(s) refreshed.`)
      }

      const snaps = await getSentimentSummary()
      const bySymbol = new Map(snaps.filter((s) => !s.stale).map((s) => [s.symbol, s]))
      for (const c of candidates) {
        c.scoreBase = c.score
        const s = bySymbol.get(c.symbol)
        if (!s) continue
        c.sent = s.score
        const adj = c.score * (1 + SENTIMENT_WEIGHT * s.score)
        c.score = Math.round(Math.max(0, adj) * 1000) / 1000
        sentimentHits++
      }
      if (sentimentHits > 0) {
        candidates.sort((a, b) => {
          const ao = a.oosNetPct != null && a.oosNetPct > 0 ? 1 : 0
          const bo = b.oosNetPct != null && b.oosNetPct > 0 ? 1 : 0
          if (ao !== bo) return bo - ao // OOS-verified first
          return b.score - a.score
        })
        await ev(sessionId, userId, 'rank',
          `Sentiment blended — ${sentimentHits}/${candidates.length} setups carried a fresh news score (weight ±${Math.round(SENTIMENT_WEIGHT * 100)}%); the sentiment gate will also guard every fleet entry`)
      } else {
        await ev(sessionId, userId, 'info',
          'Sentiment: no fresh snapshots yet — ranking on pure backtest scores. Run a sentiment scan (Chart → Sentiment panel) to feed news into the board.')
      }
    } catch {
      await ev(sessionId, userId, 'warn', 'Sentiment blend skipped (engine unavailable) — ranking on pure backtest scores.')
    }

    // ---------------- phase 3.2 — EARNINGS AWARENESS (v2.11.0) ----------------
    // The one calendar event a backtest can never see: an earnings report
    // re-prices a stock in a single overnight gap no stop-loss can bridge.
    // When the gate is armed, every board symbol's next consensus report date
    // (Yahoo calendarEvents — cached 12h/3h + single-flight) is pulled and
    // annotated onto the row:
    //   • within 5d  → score × 0.85 (de-ranks, does not delete — the setup may
    //     still be the best thing on the board)
    //   • within 2d  → the fleet's per-entry earnings gate will refuse NEW
    //     longs through the report day (already-open positions ride through)
    // Crypto has no calendar and a missing/failed date fails open — no data,
    // no dampening. The annotation travels with the session, so the score
    // board shows an E·Nd badge and ENGAGE journals the calendar risk.
    if (settings.earningsGate) {
      try {
        await touch({ phase: 'EARNINGS', progress: 0.81, stats })
        const board = candidates.slice(0, 40)
        const evBy = await getEarningsBatch(board.map((c) => c.symbol))
        const flagged: string[] = []
        for (const c of board) {
          const evItem = evBy.get(c.symbol.toUpperCase())
          if (!evItem || !evItem.known) continue
          c.earningsAt = new Date(evItem.atMs as number).toISOString()
          c.earningsDays = evItem.daysAway
          if (!evItem.inWarn) {
            c.earningsFlag = null
            continue
          }
          c.earningsFlag = evItem.inBlock ? 'block' : 'warn'
          c.score = Math.round(c.score * EARNINGS_SCORE_MULT * 1000) / 1000
          flagged.push(`${c.symbol} ${earningsLabel(evItem.daysAway)}${evItem.inBlock ? ' · gated' : ''}`)
        }
        if (flagged.length > 0) {
          await ev(sessionId, userId, 'rank',
            `Earnings scan — ${flagged.length}/${board.length} setups report within ${EARNINGS_WARN_DAYS}d: ${flagged.slice(0, 5).join(' · ')}${flagged.length > 5 ? ` · +${flagged.length - 5} more` : ''} — scores ×${EARNINGS_SCORE_MULT}, new longs pause inside the ${EARNINGS_BLOCK_DAYS}-day report window`)
        } else {
          await ev(sessionId, userId, 'info',
            `Earnings scan — 0/${board.length} setups report within ${EARNINGS_WARN_DAYS}d; the entry earnings gate stays quiet (and fails open when a date is unknown).`)
        }
      } catch {
        await ev(sessionId, userId, 'warn', 'Earnings scan skipped (calendar unavailable) — no dampening applied, the entry gate will fail open.')
      }
    }

    candidates.sort((a, b) => {
      const ao = a.oosNetPct != null && a.oosNetPct > 0 ? 1 : 0
      const bo = b.oosNetPct != null && b.oosNetPct > 0 ? 1 : 0
      if (ao !== bo) return bo - ao // OOS-verified first
      return b.score - a.score
    })
    const ranked = candidates.slice(0, 40)
    ranked.forEach((c, i) => { c.rank = i + 1 })
    await touch({ status: 'ranking', phase: 'RANK', progress: 0.82, candidates: ranked, stats })
    const top3 = ranked.slice(0, 3).map((c) => `#${c.rank} ${c.symbol} (${c.score})`).join(' · ')
    await ev(sessionId, userId, 'rank', `Score board published — ${ranked.length} qualified setups. Podium: ${top3}`)

    // ---------------- phase 3.5 — MARKET REGIME (v2.10.0 top-down overlay) ----
    // The board above is bottom-up (per-symbol backtest × news). Before sizing,
    // the engine now also reads the US TAPE: SPY/QQQ trend + UVXY vol. In
    // RISK_OFF the deployable budget is halved (fewer/smaller slots) and every
    // fleet run arms the per-entry regime gate so live BUYs are blocked while
    // the tape stays risk-off. A failed/stale read degrades to ×1 + a warn —
    // a bad regime read never rescues or kills a scan by itself.
    let regimeSnap: RegimeSnapshot | null = null
    if (settings.regimeGate) {
      try {
        await touch({ phase: 'REGIME', progress: 0.85, stats })
        regimeSnap = await getRegimeSnapshot(userId)
        await ev(sessionId, userId, 'info',
          `US tape regime: ${regimeSnap.regime}${regimeSnap.stale ? ' (STALE — gates will fail open)' : ''} — ${regimeSnap.reasons.slice(0, 3).join(' · ')}`)
      } catch {
        regimeSnap = null
        await ev(sessionId, userId, 'warn', 'US tape regime read failed — budget unscaled, the entry regime gate will fail open.')
      }
    }
    // RISK_OFF halves the deployable budget (mixed tape trades full size)
    const REGIME_DEPLOY_MULT = settings.regimeGate && regimeSnap && !regimeSnap.stale && regimeSnap.regime === 'RISK_OFF' ? 0.5 : 1

    // ---------------- phase 4 — BUDGET (buying power sizing) ----------------
    const budget = await computeBudget(userId, settings, ranked, sessionId, REGIME_DEPLOY_MULT)
    if (budget) {
      await touch({ status: 'budget', phase: 'BUDGET', progress: 0.92, budget, candidates: ranked, stats })
      await ev(sessionId, userId, 'budget',
        `Account ${budget.mode.toUpperCase()} — equity $${budget.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })} · buying power $${budget.buyingPower.toLocaleString(undefined, { maximumFractionDigits: 2 })} · deployable $${budget.deployable.toLocaleString(undefined, { maximumFractionDigits: 0 })} · per-slot $${budget.perSlot.toLocaleString(undefined, { maximumFractionDigits: 0 })}${REGIME_DEPLOY_MULT !== 1 ? ` · regime ${regimeSnap?.regime} — deployable × ${REGIME_DEPLOY_MULT}` : ''}`)
      if (budget.fleetNotional > 0) {
        await ev(sessionId, userId, 'budget', `Fleet sized — ${ranked.filter((c) => c.selected && (c.allocQty ?? 0) > 0).length} slots × ≈$${(budget.fleetNotional / Math.max(1, ranked.filter((c) => c.selected && (c.allocQty ?? 0) > 0).length)).toLocaleString(undefined, { maximumFractionDigits: 0 })} notional each (risk ${settings.riskPerTradePct}%/trade, position cap ${settings.maxPosPct}% equity)`)
      }
    } else {
      await ev(sessionId, userId, 'warn', 'Account snapshot unavailable — fleet sizing deferred to engage time.')
    }

    await touch({ status: 'ready', phase: 'READY', progress: 1, candidates: ranked, budget: budget ?? undefined, stats })
    stats.finishedAt = new Date().toISOString()
    await touch({ stats })
    await ev(sessionId, userId, 'info',
      `Autopilot READY — top ${Math.min(settings.topN, ranked.length)} setups armed. Press ENGAGE to start the fleet${settings.autoEngage ? ' (auto-engage will fire in seconds)' : ''}.`)
    if (settings.autoEngage && budget) {
      await ev(sessionId, userId, 'info', 'Auto-engage enabled — launching the fleet.')
      await engageAgent(userId, sessionId)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // v2.5.1 — every touch() below can itself fail when the disk is full;
    // belt-and-braces .catch so the failure path can never throw past the
    // pipeline (getAgentState's crash-heal marks orphaned in-flight rows).
    const safeTouch = (patch: Parameters<typeof touch>[0]) => touch(patch).catch(() => {})
    const safeEv = (level: string, message: string) => ev(sessionId, userId, level, message)
    try {
      if (msg === 'aborted') {
        await safeTouch({ status: 'stopped', phase: 'ABORTED', error: null })
        await safeEv('warn', 'Pipeline aborted by user.')
      } else {
        await safeTouch({ status: 'error', phase: isDiskFullError(e) ? 'DISK FULL' : 'FAILED', error: msg })
        await safeEv('error', `Pipeline failed — ${msg}`)
      }
    } catch { /* even the failure path is unwritable — nothing more we can do */ }
    stats.finishedAt = new Date().toISOString()
    await db.agentSession.update({ where: { id: sessionId }, data: { stats: stats as unknown as object } }).catch(() => {})
  } finally {
    jobs.delete(userId)
  }
}

/** Live account snapshot → per-slot sizing over the ranked board. */
async function computeBudget(
  userId: string, settings: AgentSettings, ranked: AgentCandidate[], sessionId: string,
  regimeMult = 1, // v2.10.0 — the market-regime deployable multiplier (RISK_OFF → 0.5)
): Promise<AgentBudget | null> {
  const mode = settings.mode
  // getAccount wraps the broker payload: { data: TradingAccount | null, status }
  const acctRes = await getAccount(userId, mode).catch(() => null)
  const acct = acctRes?.data ?? null
  if (!acct) return null
  const equity = Number(acct.equity)
  const buyingPower = Number(acct.buying_power)
  if (!(equity > 0) || !(buyingPower > 0)) return null
  // v2.10.0 — the deployable cap now carries the regime multiplier: a risk-off
  // tape halves what the fleet may deploy BEFORE per-slot math happens, so the
  // sizing (not just the entry gate) respects the top-down overlay
  const deployable = buyingPower * (settings.deployCapPct / 100) * regimeMult
  const eligible = ranked.filter((c) => c.score >= settings.minScore && c.score > 0)
  const fleetCount = Math.min(settings.topN, eligible.length)
  const perSlot = fleetCount > 0 ? deployable / fleetCount : deployable
  const riskPerTrade = equity * (settings.riskPerTradePct / 100)
  const maxPosNotional = equity * (settings.maxPosPct / 100)

  const symbols = eligible.slice(0, fleetCount).map((c) => c.symbol)
  const priceBy = new Map<string, number>()
  if (symbols.length > 0) {
    const res = await getQuotes(symbols, userId, { trading: true }).catch(() => null)
    if (res) for (const q of res.quotes) priceBy.set(q.symbol, q.price)
  }

  let fleetNotional = 0
  for (const c of ranked) {
    c.selected = false
    c.allocQty = null
    c.allocNotional = null
    c.skipReason = null
  }
  for (const c of eligible.slice(0, fleetCount)) {
    c.selected = true
    const price = priceBy.get(c.symbol)
    if (price == null || !(price > 0)) {
      c.skipReason = 'no live quote'
      continue
    }
    const capNotional = Math.min(maxPosNotional, perSlot)
    const qtyNotional = c.isCrypto ? capNotional / price : Math.floor(capNotional / price)
    const qtyRisk = riskSizedQty(Math.min(riskPerTrade, capNotional * (c.slPct / 100)), price, c.slPct, c.isCrypto)
    const qty = Math.min(qtyNotional, qtyRisk ?? Infinity)
    const notional = qty * price
    if (!Number.isFinite(qty) || qty <= 0 || notional < MIN_POS_NOTIONAL) {
      c.skipReason = 'budget too small for a position at this price'
      continue
    }
    c.allocQty = qty
    c.allocNotional = Math.round(notional * 100) / 100
    fleetNotional += notional
  }

  return {
    mode, equity: Math.round(equity * 100) / 100, cash: Math.round(Number(acct.cash) * 100) / 100,
    buyingPower: Math.round(buyingPower * 100) / 100, currency: acct.currency || 'USD',
    deployable: Math.round(deployable * 100) / 100, perSlot: Math.round(perSlot * 100) / 100,
    riskPerTrade: Math.round(riskPerTrade * 100) / 100, maxPosNotional: Math.round(maxPosNotional * 100) / 100,
    fleetNotional: Math.round(fleetNotional * 100) / 100,
    at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// public commands
// ---------------------------------------------------------------------------
export async function startAgentScan(userId: string, rawSettings: Partial<AgentSettings>): Promise<{ sessionId: string } | 'busy' | { error: string }> {
  if (jobs.has(userId)) return 'busy'
  // v2.5.1 — PRE-FLIGHT DISK GUARD: the scan is the heaviest writer in the app
  // (progress touches + events + WAL growth per symbol × 100+ symbols). On a
  // nearly-full docker volume it dies mid-storm with SQLite error 13 and the
  // failure spam itself makes the disk situation worse. Refuse to start with
  // an actionable message instead, and checkpoint the WAL while we're here.
  const preDisk = dbDiskStatus()
  if (preDisk.freeBytes != null && preDisk.freeBytes < DISK_MIN_FREE_BYTES) {
    return { error: diskFullError(preDisk).message }
  }
  await checkpointWal('truncate')
  // housekeeping — sessions with their big candidates JSON pile up forever;
  // keep the newest 20 per user and drop the rest (+ their event feeds) before
  // creating another one.
  try {
    const old = await db.agentSession.findMany({
      where: { userId }, orderBy: { createdAt: 'desc' }, skip: 20, select: { id: true },
    })
    if (old.length > 0) {
      const ids = old.map((s) => s.id)
      await db.agentEvent.deleteMany({ where: { sessionId: { in: ids } } })
      await db.agentSession.deleteMany({ where: { id: { in: ids } } })
    }
  } catch { /* pruning is best-effort */ }
  const settings: AgentSettings = { ...AGENT_SETTINGS_DEFAULTS, mode: 'paper', ...(rawSettings ?? {}) } as AgentSettings
  settings.topTune = Math.min(40, Math.max(4, Math.round(settings.topTune)))
  settings.topN = Math.min(15, Math.max(3, Math.round(settings.topN)))
  settings.riskPerTradePct = Math.min(3, Math.max(0.1, settings.riskPerTradePct))
  settings.deployCapPct = Math.min(95, Math.max(10, settings.deployCapPct))
  settings.maxPosPct = Math.min(25, Math.max(2, settings.maxPosPct))
  settings.minScore = Math.max(0, settings.minScore)
  settings.maxTradesDay = Math.min(10, Math.max(1, Math.round(settings.maxTradesDay)))
  // v2.7.0 — sentiment blend weight is user-tunable now
  settings.sentimentWeight = Math.min(1, Math.max(0, Number.isFinite(settings.sentimentWeight) ? settings.sentimentWeight : 0.25))
  // v2.10.0 — the US-tape regime gate is armed by default (opt-OUT)
  settings.regimeGate = settings.regimeGate !== false
  // v2.11.0 — the earnings gate is armed by default (opt-OUT)
  settings.earningsGate = settings.earningsGate !== false
  settings.mode = settings.mode === 'live' ? 'live' : 'paper'

  const session = await db.agentSession.create({
    data: {
      userId, status: 'scanning', phase: 'WARM-UP', progress: 0.02,
      mode: settings.mode, settings: settings as unknown as object, stats: {} as unknown as object,
    },
  })
  const job: AgentJob = { sessionId: session.id, userId, abort: false }
  jobs.set(userId, job)
  void runPipeline(session.id, userId, settings)
  return { sessionId: session.id }
}

export async function abortAgentScan(userId: string): Promise<boolean> {
  const job = jobs.get(userId)
  if (!job) return false
  job.abort = true
  return true
}

/** ENGAGE — start the fleet: one real AlgoRun engine per selected slot. */
export async function engageAgent(userId: string, sessionId: string): Promise<{ ok: boolean; started: number; failed: number; error?: string }> {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return { ok: false, started: 0, failed: 0, error: 'Session not found' }
  if (session.status === 'engaged') return { ok: true, started: 0, failed: 0 }
  if (session.status !== 'ready') return { ok: false, started: 0, failed: 0, error: `Session is ${session.status} — wait for READY before engaging` }

  const settings = session.settings as unknown as AgentSettings
  const mode = settings.mode === 'live' ? 'live' : 'paper'
  // the agent calls startAlgoRun DIRECTLY (no /api/algo route in between), so
  // the route's keys check must be mirrored HERE — without keys the engines
  // would spin 15s cycles failing on every broker call
  if (!(await hasAlpacaKeys(userId))) {
    const msg = 'Engage refused — no Alpaca keys on this account. Add them in Settings first (the fleet places real paper/live orders).'
    await ev(sessionId, userId, 'error', msg)
    return { ok: false, started: 0, failed: 0, error: msg }
  }
  if (mode === 'live' && !(await hasAlpacaKeys(userId, 'live'))) {
    const msg = 'LIVE engage refused — no live Alpaca keys on this account. Add live keys in Settings or engage in paper.'
    await ev(sessionId, userId, 'error', msg)
    return { ok: false, started: 0, failed: 0, error: msg }
  }

  const candidates = (session.candidates as unknown as AgentCandidate[] | null) ?? []
  // v2.8.0 — a re-engage (parked → ready → engage) must not carry the OLD
  // run ids: startAlgoRun mints fresh engines and overwrites started slots,
  // but failed slots would keep pointing at their previous stopped run.
  for (const c of candidates) c.runId = null
  const selected = candidates.filter((c) => c.selected && (c.allocQty ?? 0) > 0 && !c.skipReason)
  if (selected.length === 0) {
    const msg = 'No sized fleet slots — every candidate skipped (budget/quote). Nothing to engage.'
    await ev(sessionId, userId, 'warn', msg)
    return { ok: false, started: 0, failed: 0, error: msg }
  }

  // v2.10.0 — journal the tape at engage so the event feed records WHAT THE
  // FLEET WAS TRADING INTO. The per-entry regime gate enforces this live:
  // while the tape reads RISK_OFF, fleet runs refuse NEW LONG entries (shorts
  // and crypto stay live; UNKNOWN/stale fails open).
  if (settings.regimeGate !== false) {
    try {
      const r = await getRegimeSnapshot(userId)
      await ev(sessionId, userId, 'info',
        `US tape at engage: ${r.regime}${r.stale ? ' (stale — gates fail open)' : ''} — ${r.reasons.slice(0, 2).join(' · ')}${r.regime === 'RISK_OFF' ? ' · fleet longs are gated until this lifts' : ''}`)
    } catch { /* regime is advisory here — the entry gate fails open */ }
  }

  // v2.11.0 — journal the calendar risk the board already priced in: a slot
  // inside the warn window gets one line (watch the gap if a fill lands the
  // day before); inside the block window the per-entry earnings gate will
  // hold its BUYs until the report passes.
  if (settings.earningsGate !== false) {
    const flagged = selected.filter((c) => c.earningsFlag === 'block' || c.earningsFlag === 'warn')
    for (const c of flagged.slice(0, 6)) {
      await ev(sessionId, userId, 'warn',
        `${c.symbol} — ${earningsLabel(c.earningsDays)} (est. ${c.earningsAt ? c.earningsAt.slice(0, 10) : 'date unknown'})${c.earningsFlag === 'block' ? ' · the earnings gate pauses new BUYs through the report' : ' · a fill here rides INTO the report — gap risk owned by the stop'}`)
    }
  }

  const running = await db.algoRun.count({ where: { userId, status: 'running' } })
  let slots = Math.max(0, ALGO_MAX_RUNNING_RUNS - running)
  let started = 0
  let failed = 0
  for (const c of selected) {
    if (slots <= 0) {
      c.skipReason = `engine cap reached (${ALGO_MAX_RUNNING_RUNS} running)`
      await ev(sessionId, userId, 'warn', `${c.symbol} skipped — ${c.skipReason}`)
      continue
    }
    try {
      const run = await startAlgoRun({
        userId,
        symbol: c.symbol,
        mode, // v2.4.0 — live allowed; the user's explicit settings choice
        timeframe: c.tf,
        strategy: c.strategy,
        params: c.params,
        qty: c.allocQty ?? 1,
        sizingMode: 'fixed',
        riskBasis: 'usd',
        riskMoney: null,
        riskMoneyPct: null,
        tpMode: 'pct',
        tpValue: c.tpPct,
        slMode: 'pct',
        slValue: c.slPct,
        tpTf: null,
        slTf: null,
        trailMode: 'off',
        trailArmPct: null,
        trailGivePct: null,
        maxTradesDay: settings.maxTradesDay,
        rthOnly: !c.isCrypto && c.lane === 'day',
        flattenEod: c.lane === 'day',
        cooldownMin: c.lane === 'day' ? 10 : 0,
        requireNewSignal: false,
        kronosGate: false,
        // v2.5.0 — the autopilot ALWAYS arms the sentiment gate: fleet entries
        // must not fight fresh news (the ranking already blended sentiment in)
        sentimentGate: true,
        // v2.10.0 — and the US-tape regime gate (opt-out in mission parameters):
        // new longs are refused while SPY/QQQ/UVXY read risk-off
        regimeGate: settings.regimeGate !== false,
        // v2.11.0 — and the earnings gate (opt-out in mission parameters):
        // new longs are refused inside the 2-day pre-report window
        earningsGate: settings.earningsGate !== false,
      }, { autostart: true })
      c.runId = run.id
      slots--
      started++
      await ev(sessionId, userId, 'trade',
        `FLEET ON — ${c.symbol} ${c.tf} ${ALGO_STRATEGIES[c.strategy].name} ×${c.allocQty} (${mode.toUpperCase()}) · TP ${c.tpPct}% / SL ${c.slPct}% · score ${c.score}`)
    } catch (e) {
      failed++
      c.skipReason = e instanceof Error ? e.message.slice(0, 140) : 'start failed'
      await ev(sessionId, userId, 'error', `${c.symbol} start FAILED — ${c.skipReason}`)
    }
  }

  const stats = (session.stats as unknown as AgentStats | null) ?? {
    scanned: 0, scanTotal: 0, tuned: 0, tuneTotal: 0, fleetStarted: 0, fleetFailed: 0,
    startedAt: new Date().toISOString(), finishedAt: null,
  }
  stats.fleetStarted = started
  stats.fleetFailed = failed
  await db.agentSession.update({
    where: { id: sessionId },
    data: {
      status: started > 0 ? 'engaged' : 'ready',
      phase: started > 0 ? 'ENGAGED' : 'READY',
      candidates: candidates as unknown as object,
      stats: stats as unknown as object,
    },
  })
  await ev(sessionId, userId, 'info',
    started > 0
      ? `Fleet ENGAGED — ${started} engine(s) live in ${mode.toUpperCase()}${failed ? `, ${failed} failed` : ''}. The rainbow is spinning.`
      : `Engage produced 0 engines — session stays READY.`)
  return { ok: started > 0, started, failed }
}

/** DISENGAGE — stop every fleet engine (optionally flatten positions). */
export async function disengageAgent(userId: string, sessionId: string, flatten: boolean): Promise<{ ok: boolean; stopped: number; error?: string }> {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return { ok: false, stopped: 0, error: 'Session not found' }
  if (session.status !== 'engaged') return { ok: true, stopped: 0 }
  const candidates = (session.candidates as unknown as AgentCandidate[] | null) ?? []
  let stopped = 0
  for (const c of candidates) {
    if (!c.runId) continue
    try {
      await stopAlgoRun(c.runId, flatten)
      stopped++
      await ev(sessionId, userId, 'trade', `FLEET OFF — ${c.symbol} engine stopped${flatten ? ' · positions flattened' : ''}`)
    } catch (e) {
      await ev(sessionId, userId, 'error', `${c.symbol} stop FAILED — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // v2.8.0 — disengage parks the session instead of killing it: status goes
  // back to READY with the score board intact, so RE-ENGAGE restarts the
  // fleet instantly (no full re-scan) and the board also survives server
  // restarts. 'stopped' stays reserved for user-aborted pipelines.
  await db.agentSession.update({ where: { id: sessionId }, data: { status: 'ready', phase: 'PARKED — READY TO RE-ENGAGE' } })
  await ev(sessionId, userId, 'info', `Autopilot DISENGAGED — ${stopped} engine(s) stopped. Score board parked — press RE-ENGAGE to restart the fleet, or launch a fresh scan.`)
  return { ok: true, stopped }
}

/** Settings update — only meaningful on a READY session (re-sizes the fleet). */
export async function updateAgentSettings(userId: string, sessionId: string, patch: Partial<AgentSettings>): Promise<{ ok: boolean; error?: string }> {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return { ok: false, error: 'Session not found' }
  if (session.status !== 'ready') return { ok: false, error: `Settings are editable while READY only (current: ${session.status})` }
  const settings = { ...(session.settings as unknown as AgentSettings), ...patch }
  settings.topN = Math.min(15, Math.max(3, Math.round(settings.topN)))
  settings.riskPerTradePct = Math.min(3, Math.max(0.1, settings.riskPerTradePct))
  settings.deployCapPct = Math.min(95, Math.max(10, settings.deployCapPct))
  settings.maxPosPct = Math.min(25, Math.max(2, settings.maxPosPct))
  settings.minScore = Math.max(0, settings.minScore)
  // v2.7.0 — sentiment blend weight is user-tunable now
  settings.sentimentWeight = Math.min(1, Math.max(0, Number.isFinite(settings.sentimentWeight) ? settings.sentimentWeight : 0.25))
  // v2.10.0 — regime gate armed by default (opt-out); a manual re-size also
  // re-reads the tape so the deployable multiplier tracks the CURRENT regime
  settings.regimeGate = settings.regimeGate !== false
  // v2.11.0 — earnings gate armed by default (opt-out)
  settings.earningsGate = settings.earningsGate !== false
  let regimeMult = 1
  if (settings.regimeGate) {
    try {
      const r = await getRegimeSnapshot(userId)
      if (!r.stale && r.regime === 'RISK_OFF') regimeMult = 0.5
    } catch { /* fail open — unscaled */ }
  }
  settings.mode = settings.mode === 'live' ? 'live' : 'paper'

  const candidates = (session.candidates as unknown as AgentCandidate[] | null) ?? []
  const budget = await computeBudget(userId, settings, candidates, sessionId, regimeMult)
  await db.agentSession.update({
    where: { id: sessionId },
    data: { settings: settings as unknown as object, candidates: candidates as unknown as object, budget: (budget ?? undefined) as object | undefined },
  })
  await ev(sessionId, userId, 'budget',
    `Settings updated — fleet ${settings.topN} slots · risk ${settings.riskPerTradePct}%/trade · deploy ${settings.deployCapPct}% BP · position cap ${settings.maxPosPct}% · mode ${settings.mode.toUpperCase()} — fleet re-sized.`)
  return { ok: true }
}

export async function deleteAgentSession(userId: string, sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return { ok: false, error: 'Session not found' }
  if (session.status === 'engaged') return { ok: false, error: 'Disengage the fleet before deleting this session' }
  const job = jobs.get(userId)
  if (job?.sessionId === sessionId) return { ok: false, error: 'The pipeline is still running — abort it first' }
  await db.agentEvent.deleteMany({ where: { sessionId } })
  await db.agentSession.delete({ where: { id: sessionId } })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// state read — the GET payload builder (also self-heals crashed pipelines)
// ---------------------------------------------------------------------------
export async function getAgentState(userId: string): Promise<{
  session: unknown
  candidates: AgentCandidate[]
  events: { id: string; level: string; message: string; createdAt: string }[]
  runs: AgentRunRow[]
} | null> {
  // v2.7.0 — first touch after boot starts the fleet sentiment refresher
  // (15-min heartbeat; globalThis-guarded so it only ever runs once)
  startFleetSentimentRefresher()
  const session = await db.agentSession.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })
  if (!session) return null

  // crash healing: an in-flight status with no live job means the process
  // restarted under it — mark the session failed instead of spinning forever
  const inflight = ['scanning', 'tuning', 'ranking', 'budget'] as const
  if ((inflight as readonly string[]).includes(session.status)) {
    const job = jobs.get(userId)
    if (!job || job.sessionId !== session.id) {
      await db.agentSession.update({
        where: { id: session.id },
        data: { status: 'error', phase: 'INTERRUPTED', error: 'Pipeline interrupted by a server restart — launch a new scan; finished symbol results were saved to the store and will be reused.' },
      }).catch(() => {})
      session.status = 'error'
      session.phase = 'INTERRUPTED'
    }
  }

  const events = await db.agentEvent.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: 120,
  })
  const candidates = (session.candidates as unknown as AgentCandidate[] | null) ?? []
  const runIds = candidates.map((c) => c.runId).filter((v): v is string => typeof v === 'string' && v.length > 0)
  const runs: AgentRunRow[] = []
  if (runIds.length > 0) {
    const rows = await db.algoRun.findMany({ where: { id: { in: runIds } } })
    const logs = await db.algoLog.findMany({
      where: { runId: { in: runIds } },
      orderBy: { createdAt: 'desc' },
      take: runIds.length * 30,
    })
    const lastLog = new Map<string, { message: string; level: string }>()
    for (const l of logs) {
      if (!lastLog.has(l.runId)) lastLog.set(l.runId, { message: l.message, level: l.level })
    }
    for (const r of rows) {
      const ll = lastLog.get(r.id)
      runs.push({
        runId: r.id, symbol: r.symbol, timeframe: r.timeframe, strategy: r.strategy,
        status: r.status, mode: r.mode, qty: r.qty, tradesToday: 0,
        startedAt: r.startedAt?.toISOString() ?? null,
        lastLog: ll?.message ?? null, lastLogLevel: ll?.level ?? null,
      })
    }
  }
  return {
    session: {
      id: session.id, status: session.status, phase: session.phase, progress: session.progress,
      mode: session.mode, settings: session.settings, stats: session.stats, budget: session.budget,
      error: session.error, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString(),
    },
    candidates,
    events: events.reverse().map((e) => ({ id: e.id, level: e.level, message: e.message, createdAt: e.createdAt.toISOString() })),
    runs,
  }
}
