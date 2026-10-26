import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { symbolSchema } from '@/lib/validation'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { getAccount, resolveTradeMode } from '@/lib/trading'
import { ALGO_MAX_DAYS } from '@/lib/algo-strategies'
import { fetchBacktestBars } from '@/lib/backtest-history'
import { validateGridConfig, startGridTrade } from '@/lib/grid-engine'
import {
  analyzeGridForSymbol, isGridAutoPreset, AUTO_PRESETS,
  type GridAutoDecision, type GridAutoPreset, type GridAutoSizing,
} from '@/lib/grid-auto'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// POST /api/grid/auto (Task 18) — the Auto Grid watchlist scanner.
//
// Two-phase (the dialog drives both):
//   start:false → SCAN — analyze every watchlist symbol, persist a 'scan'
//                 GridAutoRun, return the full report. Nothing is created.
//   start:true  → START — re-run the analysis, create one grid per accepted
//                 symbol (auto:true + autoPlan + autoEndAt) via the SAME
//                 validation + engine path as POST /api/grid, persist a
//                 'start' run, return per-item results.
//
// Decision logic lives in src/lib/grid-auto.ts (pure, engine-parity backtest
// evidence: the sweep winner of optimizeGridConfig over real bars). Every
// started grid carries: why it started (reason), the metrics behind it
// (details), the exact setup and its end conditions (SL/TP percent guards +
// planned autoEndAt force-stop).
//
// Task 18-b — RISK-MONEY SIZING: `sizing:'equityPct'` allocates the SAME % of
// account equity to every symbol's grid and derives qty per level from the
// winner's price × levels, so TSLA and ECHO grids carry the same money behind
// (a fixed qty differs 10–100× across price scales). A START batch enforces a
// risk budget: planned deployment never exceeds account equity — tail symbols
// are skipped with an honest reason instead of over-allocating.
// ---------------------------------------------------------------------------

interface GridAutoBody {
  watchlistId?: string
  symbols?: string[]
  /** legacy fixed sizing — qty per grid level (ignored when sizing=equityPct) */
  qtyPerGrid?: number
  /** 'fixed' (default, back-compat) | 'equityPct' — % of equity per grid */
  sizing?: string
  /** equityPct mode: allocation per grid as % of account equity (0.1–100) */
  equityPct?: number
  preset?: string
  /** planned end in days (engine force-stops at startedAt + maxEndDays) */
  maxEndDays?: number
  /** history window in days (≤60 → 1h bars, else 1D) */
  days?: number
  /** false/absent = scan only · true = start the accepted symbols */
  start?: boolean
  /** when starting: restrict to these symbols (subset of the accepted) */
  selected?: string[]
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })
const round2 = (n: number) => Math.round(n * 100) / 100

/** window → crossing granularity — SAME mapping the grid optimize/backtest routes use */
const GRID_TF_MAX_DAYS: Record<'15m' | '1h' | '1D', number> = {
  '15m': ALGO_MAX_DAYS['15m'],
  '1h': 365,
  '1D': 365,
}

/** A single watchlist scan covers at most this many symbols (fetch cost). */
const MAX_SYMBOLS = 25

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`grid-auto:${user.id}`, 6, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many auto-grid runs — retry in ${rl.retryAfterSec}s`, retryAfterSec: rl.retryAfterSec },
        { status: 429 },
      )
    }
    const body = await readJson<GridAutoBody>(req)
    const mode = body?.start === true ? 'start' : 'scan'

    // ---- resolve the symbol universe: owned watchlist or explicit list ----
    let watchlistName = 'Custom list'
    let symbols: string[] = []
    if (body?.watchlistId) {
      const wl = await db.watchlist.findFirst({ where: { id: String(body.watchlistId), userId: user.id } })
      if (!wl) return bad('Watchlist not found')
      watchlistName = wl.name
      symbols = Array.isArray(wl.items) ? (wl.items as string[]) : []
    } else if (Array.isArray(body?.symbols)) {
      symbols = body.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    }
    symbols = [...new Set(symbols)]
      .filter((s) => symbolSchema.safeParse(s).success)
      .slice(0, MAX_SYMBOLS)
    if (symbols.length === 0) return bad('No valid symbols to scan — pick a watchlist with symbols or pass symbols[]')

    // ---- shared sizing/settings validation ----
    const sizingMode = body?.sizing === 'equityPct' ? 'equityPct' : 'fixed'
    const qtyPerGrid = Number(body?.qtyPerGrid)
    if (sizingMode === 'fixed') {
      if (!Number.isFinite(qtyPerGrid) || qtyPerGrid <= 0) return bad('Quantity per grid must be a positive number')
      const hasStocks = symbols.some((s) => !s.includes('/'))
      if (hasStocks && !Number.isInteger(qtyPerGrid)) {
        return bad('Stocks require a whole-number quantity per grid (min 1) — crypto supports fractional sizes')
      }
    }
    const equityPct = Number(body?.equityPct)
    if (sizingMode === 'equityPct' && (!Number.isFinite(equityPct) || equityPct < 0.1 || equityPct > 100)) {
      return bad('Equity % per grid must be between 0.1 and 100')
    }
    const preset: GridAutoPreset = isGridAutoPreset(body?.preset) ? body.preset : 'balanced'
    const maxEndDays = Math.min(365, Math.max(1, Math.round(Number(body?.maxEndDays) || 30)))
    const daysReq = Math.min(365, Math.max(5, Math.round(Number(body?.days) || 60)))
    const timeframe = daysReq <= 14 ? '15m' : daysReq <= 60 ? '1h' : '1D'
    const days = Math.min(daysReq, GRID_TF_MAX_DAYS[timeframe])

    // ---- broker preconditions ----
    // START mode always needs keys; equityPct sizing needs them in BOTH modes
    // (the allocation is a % of the LIVE account equity, read once per request)
    let equity: number | null = null
    let tradeMode: 'paper' | 'live' | null = null
    if (mode === 'start' || sizingMode === 'equityPct') {
      if (!(await hasAlpacaKeys(user.id))) {
        return bad('No Alpaca keys — add them in Settings first (grids place real paper/live orders)')
      }
      tradeMode = await resolveTradeMode(user.id)
      if (mode === 'start' && tradeMode === 'live') return bad('Refusing to auto-start grid trades in LIVE mode — switch the trade mode to paper')
      if (sizingMode === 'equityPct') {
        try {
          const acct = await getAccount(user.id, tradeMode)
          const eq = Number(acct.data?.equity)
          equity = acct.data != null && Number.isFinite(eq) && eq > 0 ? eq : null
        } catch {
          equity = null
        }
        if (equity == null) {
          return bad('Could not read the account equity — % of equity sizing needs a working broker connection (or switch to fixed qty)')
        }
      }
    }
    const sizing: GridAutoSizing = sizingMode === 'equityPct'
      ? { mode: 'equityPct', pct: equityPct, equity: equity! }
      : { mode: 'fixed', qty: qtyPerGrid }

    // ---- scan every symbol (sequential — fetches are cached/shared) ----
    const results: (GridAutoDecision & { gridId?: string; error?: string })[] = []
    for (const symbol of symbols) {
      try {
        const hist = await fetchBacktestBars(symbol, timeframe, user.id, days)
        if (!hist.ok) {
          results.push({ symbol, decision: 'skip', reason: hist.error ?? 'History unavailable', details: [], plan: null })
          continue
        }
        const d = analyzeGridForSymbol({
          symbol,
          bars: hist.bars,
          windowDays: days,
          sizing,
          preset,
          maxEndDays,
        })
        results.push(d)
      } catch (e) {
        results.push({
          symbol,
          decision: 'skip',
          reason: `Analysis failed: ${e instanceof Error ? e.message : String(e)}`,
          details: [],
          plan: null,
        })
      }
    }

    // ---- START mode: create the accepted grids (selected ⊆ accepted) ----
    let started = 0
    let failed = 0
    // Task 18-b risk budget (equityPct mode): the SUM of planned deployment
    // across the started batch never exceeds the account equity — a 25-symbol
    // watchlist at 5% each would otherwise silently try to deploy 125%. Tail
    // symbols are skipped with an honest reason (the plan stays for review).
    let deployed = 0
    if (mode === 'start') {
      const selected = Array.isArray(body?.selected) ? new Set(body.selected.map((s) => String(s).toUpperCase())) : null
      for (const r of results) {
        if (r.decision !== 'start' || !r.plan) continue
        if (selected && !selected.has(r.symbol)) continue
        const behind = r.plan.moneyBehind ?? 0
        if (sizing.mode === 'equityPct' && behind > 0 && deployed + behind > sizing.equity) {
          r.decision = 'skip'
          r.reason =
            `Risk budget exhausted — $${Math.round(deployed)} of $${Math.round(sizing.equity)} equity already planned this batch; ` +
            `this grid needs $${Math.round(behind)} more. Raise the per-grid %, start fewer symbols, or accept the risk manually.`
          continue
        }
        try {
          const p = r.plan
          const invalid = validateGridConfig({
            lowerPrice: p.lowerPrice,
            upperPrice: p.upperPrice,
            gridCount: p.gridCount,
            spacing: p.spacing,
            qtyPerGrid: p.qtyPerGrid,
            maxSL: p.maxSLPct,
            maxTP: p.maxTPPct,
            slBasis: 'percent',
            tpBasis: 'percent',
            isCrypto: r.symbol.includes('/'),
            direction: 'both',
          })
          if (invalid) {
            r.decision = 'skip'
            r.error = invalid
            r.reason = `Setup rejected by the server validator: ${invalid}`
            failed++
            continue
          }
          const grid = await startGridTrade({
            userId: user.id,
            symbol: r.symbol,
            lowerPrice: p.lowerPrice,
            upperPrice: p.upperPrice,
            gridCount: p.gridCount,
            spacing: p.spacing,
            qtyPerGrid: p.qtyPerGrid,
            maxSL: p.maxSLPct,
            maxTP: p.maxTPPct,
            slBasis: 'percent',
            tpBasis: 'percent',
            direction: 'both',
            closeOnStop: true,
            auto: true,
            autoPlan: { reason: r.reason, details: r.details, ...p },
            autoEndAt: new Date(Date.now() + p.maxEndDays * 86_400_000),
          })
          r.gridId = grid.id
          started++
          deployed += behind
        } catch (e) {
          r.decision = 'skip'
          r.error = e instanceof Error ? e.message : String(e)
          r.reason = `Could not start the grid: ${r.error}`
          failed++
        }
      }
    }

    const startedCount = mode === 'start'
      ? started
      : results.filter((r) => r.decision === 'start').length
    const skippedCount = results.filter((r) => r.decision === 'skip').length
    // planned deployment across everything this run accepted (info in scan
    // mode; in start mode the survivors after the risk-budget cap)
    const plannedDeployment = round2(
      results
        .filter((r) => r.decision === 'start' || r.gridId != null)
        .reduce((acc, r) => acc + (r.plan?.moneyBehind ?? 0), 0),
    )

    // ---- persist the run so the "why" survives reloads ----
    const run = await db.gridAutoRun.create({
      data: {
        userId: user.id,
        mode,
        watchlist: watchlistName,
        scanned: results.length,
        started: startedCount,
        skipped: skippedCount,
        failed,
        report: results as unknown as object,
      },
    })

    return NextResponse.json({
      runId: run.id,
      mode,
      watchlist: watchlistName,
      preset,
      presetLabel: AUTO_PRESETS[preset].label,
      sizing: sizing.mode === 'equityPct'
        ? { mode: 'equityPct', pct: sizing.pct, equity: Math.round(sizing.equity * 100) / 100 }
        : { mode: 'fixed', qty: sizing.qty },
      plannedDeployment,
      plannedDeploymentPct: sizing.mode === 'equityPct' && sizing.equity > 0
        ? Math.round((plannedDeployment / sizing.equity) * 1000) / 10
        : null,
      maxEndDays,
      days,
      timeframe,
      results,
      started: startedCount,
      skipped: skippedCount,
      failed,
    })
  } catch (e) {
    return handleError(e)
  }
}

// GET /api/grid/auto — the last 10 runs (scans + starts), newest first
export async function GET() {
  try {
    const user = await requireUser()
    const rows = await db.gridAutoRun.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    return NextResponse.json({
      runs: rows.map((r) => ({
        id: r.id,
        mode: r.mode,
        watchlist: r.watchlist,
        scanned: r.scanned,
        started: r.started,
        skipped: r.skipped,
        failed: r.failed,
        report: r.report,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    return handleError(e)
  }
}
