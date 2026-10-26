import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { symbolSchema } from '@/lib/validation'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { resolveTradeMode } from '@/lib/trading'
import { ALGO_MAX_DAYS } from '@/lib/algo-strategies'
import { fetchBacktestBars } from '@/lib/backtest-history'
import { validateGridConfig, startGridTrade } from '@/lib/grid-engine'
import {
  analyzeGridForSymbol, isGridAutoPreset, AUTO_PRESETS,
  type GridAutoDecision, type GridAutoPreset,
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
// ---------------------------------------------------------------------------

interface GridAutoBody {
  watchlistId?: string
  symbols?: string[]
  qtyPerGrid?: number
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
    const qtyPerGrid = Number(body?.qtyPerGrid)
    if (!Number.isFinite(qtyPerGrid) || qtyPerGrid <= 0) return bad('Quantity per grid must be a positive number')
    const hasStocks = symbols.some((s) => !s.includes('/'))
    if (hasStocks && !Number.isInteger(qtyPerGrid)) {
      return bad('Stocks require a whole-number quantity per grid (min 1) — crypto supports fractional sizes')
    }
    const preset: GridAutoPreset = isGridAutoPreset(body?.preset) ? body.preset : 'balanced'
    const maxEndDays = Math.min(365, Math.max(1, Math.round(Number(body?.maxEndDays) || 30)))
    const daysReq = Math.min(365, Math.max(5, Math.round(Number(body?.days) || 60)))
    const timeframe = daysReq <= 14 ? '15m' : daysReq <= 60 ? '1h' : '1D'
    const days = Math.min(daysReq, GRID_TF_MAX_DAYS[timeframe])

    // ---- START mode: broker preconditions FIRST (one check, not per symbol) ----
    if (mode === 'start') {
      if (!(await hasAlpacaKeys(user.id))) {
        return bad('No Alpaca keys — add them in Settings first (grids place real paper/live orders)')
      }
      const tradeMode = await resolveTradeMode(user.id)
      if (tradeMode === 'live') return bad('Refusing to auto-start grid trades in LIVE mode — switch the trade mode to paper')
    }

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
          qtyPerGrid,
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
    if (mode === 'start') {
      const selected = Array.isArray(body?.selected) ? new Set(body.selected.map((s) => String(s).toUpperCase())) : null
      for (const r of results) {
        if (r.decision !== 'start' || !r.plan) continue
        if (selected && !selected.has(r.symbol)) continue
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
