import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { resolveTradeMode } from '@/lib/trading'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { ensureAlgoEngines, startAlgoRun } from '@/lib/algo-engine'
import {
  isAlgoStrategyId, ALGO_TIMEFRAMES, SYMBOL_RE, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { ALGO_MAX_RUNNING_RUNS } from '@/lib/algo-engine'
import { clampAtrMult } from '@/lib/atr'
import { TIMEFRAMES } from '@/lib/market-types'

export const dynamic = 'force-dynamic'

export interface AlgoRunDto {
  id: string
  symbol: string
  timeframe: string
  strategy: string
  params: Record<string, number>
  qty: number
  sizingMode: string
  riskBasis: string
  riskMoney: number | null
  riskMoneyPct: number | null
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  tpTf?: string | null
  slTf?: string | null
  trailMode: string
  trailArmPct: number | null
  trailGivePct: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
  kronosGate: boolean
  status: string
  tradesToday: number
  startedAt: string
  stoppedAt: string | null
  logs: { id: string; level: string; message: string; createdAt: string }[]
}

export function toDto(r: {
  id: string; symbol: string; timeframe: string; strategy: string; params: unknown
  qty: number; sizingMode?: string; riskBasis?: string
  riskMoney?: number | null; riskMoneyPct?: number | null
  tpMode: string; tpValue: number | null; slMode: string; slValue: number | null
  tpTf?: string | null; slTf?: string | null
  trailMode?: string; trailArmPct?: number | null; trailGivePct?: number | null
  maxTradesDay: number; rthOnly: boolean; flattenEod: boolean
  cooldownMin?: number; requireNewSignal?: boolean
  kronosGate?: boolean
  status: string
  state: unknown; startedAt: Date; stoppedAt: Date | null
}, logs: AlgoRunDto['logs']): AlgoRunDto {
  const st = (r.state && typeof r.state === 'object' ? r.state : {}) as { tradesToday?: number }
  return {
    id: r.id, symbol: r.symbol, timeframe: r.timeframe, strategy: r.strategy,
    params: (r.params as Record<string, number>) ?? {},
    qty: r.qty,
    sizingMode: r.sizingMode === 'risk' ? 'risk' : 'fixed',
    riskBasis: r.sizingMode === 'risk' && r.riskBasis === 'pct' ? 'pct' : 'usd',
    riskMoney: r.sizingMode === 'risk' && r.riskBasis !== 'pct' ? (r.riskMoney ?? null) : null,
    riskMoneyPct: r.sizingMode === 'risk' && r.riskBasis === 'pct' ? (r.riskMoneyPct ?? null) : null,
    tpMode: r.tpMode, tpValue: r.tpValue, slMode: r.slMode, slValue: r.slValue,
    tpTf: r.tpTf ?? null, slTf: r.slTf ?? null,
    trailMode: r.trailMode === 'pct' ? 'pct' : 'off',
    trailArmPct: r.trailMode === 'pct' ? (r.trailArmPct ?? null) : null,
    trailGivePct: r.trailMode === 'pct' ? (r.trailGivePct ?? null) : null,
    maxTradesDay: r.maxTradesDay, rthOnly: r.rthOnly, flattenEod: r.flattenEod,
    cooldownMin: r.cooldownMin ?? 0, requireNewSignal: r.requireNewSignal === true,
    kronosGate: r.kronosGate === true,
    status: r.status, tradesToday: st.tradesToday ?? 0,
    startedAt: r.startedAt.toISOString(), stoppedAt: r.stoppedAt?.toISOString() ?? null,
    logs,
  }
}

// GET /api/algo — all runs + their recent logs (also resumes crashed engines)
export async function GET() {
  try {
    const user = await requireUser()
    await ensureAlgoEngines(user.id)
    const rows = await db.algoRun.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 })
    // strategy-drawer rules ride along (Task 70-c) so the "export ALL" file can
    // include every StrategyRule of the user without a second endpoint
    const rules = await db.strategyRule.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        symbol: true, kind: true, condition: true, level: true, timeframe: true,
        params: true, action: true, qty: true, tpMode: true, tpValue: true,
        slMode: true, slValue: true, repeat: true, status: true,
      },
    })
    const logs = await db.algoLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 600,
    })
    const byRun = new Map<string, AlgoRunDto['logs']>()
    for (const l of logs) {
      const list = byRun.get(l.runId) ?? []
      if (list.length < 100) {
        list.push({ id: l.id, level: l.level, message: l.message, createdAt: l.createdAt.toISOString() })
        byRun.set(l.runId, list)
      }
    }
    const mode = await resolveTradeMode(user.id)
    const configured = await hasAlpacaKeys(user.id)
    return NextResponse.json({
      runs: rows.map((r) => toDto(r, (byRun.get(r.id) ?? []).slice().reverse())),
      rules,
      mode,
      configured,
    })
  } catch (e) {
    return handleError(e)
  }
}

interface AlgoStartBody {
  symbol?: string
  timeframe?: string
  strategy?: string
  params?: Record<string, number>
  qty?: number
  sizingMode?: string
  riskBasis?: string
  riskMoney?: number
  riskMoneyPct?: number
  tpMode?: string
  tpValue?: number
  slMode?: string
  slValue?: number
  tpTf?: string | null
  slTf?: string | null
  trailMode?: string
  trailArmPct?: number
  trailGivePct?: number
  maxTradesDay?: number
  rthOnly?: boolean
  flattenEod?: boolean
  cooldownMin?: number
  requireNewSignal?: boolean
  // v2.0.0 — Kronos AI gate (model must agree with entries)
  kronosGate?: boolean
  // Task 79 — false = create the run STOPPED (imports of stopped configs);
  // no engine, no orders. Only STARTING runs stays paper-only.
  autoStart?: boolean
}

// POST /api/algo — create + start a run
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await readJson<AlgoStartBody>(req)
    const symbol = String(body?.symbol ?? '').trim().toUpperCase()
    // Task 89 — charset validation (was length-only): junk like "A B!" passed
    // and only failed downstream at the broker. Same rule as config import.
    if (!symbol || !SYMBOL_RE.test(symbol)) {
      return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
    }
    const tf = String(body?.timeframe ?? '5m')
    if (!(ALGO_TIMEFRAMES as readonly string[]).includes(tf)) {
      return NextResponse.json({ error: `timeframe must be one of ${ALGO_TIMEFRAMES.join('/')}` }, { status: 400 })
    }
    if (!isAlgoStrategyId(body?.strategy)) {
      return NextResponse.json({ error: 'Unknown strategy' }, { status: 400 })
    }
    const strategy = body.strategy
    const qty = Number(body?.qty)
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) {
      return NextResponse.json({ error: 'qty must be a positive number' }, { status: 400 })
    }
    if (!(await hasAlpacaKeys(user.id))) {
      return NextResponse.json({ error: 'No Alpaca keys — add them in Settings first (algo runs place real paper/live orders)' }, { status: 400 })
    }
    const mode = await resolveTradeMode(user.id)
    // Task 79 — a STOPPED run places no orders, so importing configs as
    // stopped runs is safe even in live mode; only STARTING runs is paper-only.
    const autoStart = body?.autoStart !== false
    if (autoStart && mode === 'live') {
      return NextResponse.json({ error: 'Refusing to start algo runs in LIVE mode — switch the trade mode to paper' }, { status: 400 })
    }
    // Task 89 — cap the number of RUNNING runs per user: each one is a 15s
    // engine cycle (bars + positions + quotes + state writes); unbounded runs
    // would churn the Alpaca rate budget and SQLite for no benefit.
    if (autoStart) {
      const runningCount = await db.algoRun.count({ where: { userId: user.id, status: 'running' } })
      if (runningCount >= ALGO_MAX_RUNNING_RUNS) {
        return NextResponse.json({ error: `Too many running algo runs (${runningCount}) — the limit is ${ALGO_MAX_RUNNING_RUNS}. Stop one before starting another.` }, { status: 400 })
      }
    }
    const clampPct = (v: unknown): number | null => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(0.01, n)) : null
    }
    // Task 78 — Risk Money sizing; Task 78e — budget basis ($ or % of equity).
    // risk+usd requires riskMoney > 0 · risk+pct requires riskMoneyPct > 0.
    const sizingMode = body?.sizingMode === 'risk' ? 'risk' : 'fixed'
    const riskBasis = body?.riskBasis === 'pct' ? 'pct' : 'usd'
    const riskMoneyRaw = Number(body?.riskMoney)
    const riskMoney = Number.isFinite(riskMoneyRaw) && riskMoneyRaw > 0
      ? Math.min(10_000_000, riskMoneyRaw)
      : null
    const riskPctRaw = Number(body?.riskMoneyPct)
    const riskMoneyPct = Number.isFinite(riskPctRaw) && riskPctRaw > 0
      ? Math.min(100, riskPctRaw)
      : null
    if (sizingMode === 'risk' && riskBasis === 'pct' && riskMoneyPct == null) {
      return NextResponse.json({ error: 'Risk % must be a positive number (percent of equity) when sizing mode is risk' }, { status: 400 })
    }
    // Task 89 — a % leg with an absent/≤0 value is REJECTED: the engine used
    // to store tpValue/slValue = null with mode 'pct' and then silently drop
    // the leg at entry (naked market order). The UI blocks this client-side;
    // this is the API backstop (imports predate it but the engine's
    // stored-leg fail-closed gate catches those at runtime).
    // v1.96.0 — exit legs accept 'pct' (0.01–100) or 'atr' (multiplier 0.1–20
    // of ATR(14) on a chart timeframe, default '1h') — anything else is 'none'.
    const parseExitLeg = (mode: unknown, value: unknown, tf: unknown, label: 'TP' | 'SL'):
      { mode: 'none' | 'pct' | 'atr'; value: number | null; tf: string | null } | string => {
      if (mode === 'pct') {
        const p = clampPct(value)
        if (p == null) return `${label} % must be a positive number when ${label} mode is pct`
        return { mode: 'pct', value: p, tf: null }
      }
      if (mode === 'atr') {
        const mult = clampAtrMult(value)
        if (mult == null) return `${label} ATR multiplier must be between 0.1 and 20`
        if (tf != null && (typeof tf !== 'string' || !(tf in TIMEFRAMES))) {
          return `${label} ATR timeframe must be one of ${Object.keys(TIMEFRAMES).join('/')}`
        }
        return { mode: 'atr', value: mult, tf: typeof tf === 'string' && tf ? tf : '1h' }
      }
      return { mode: 'none', value: null, tf: null }
    }
    const tpLeg = parseExitLeg(body?.tpMode, body?.tpValue, body?.tpTf, 'TP')
    if (typeof tpLeg === 'string') return NextResponse.json({ error: tpLeg }, { status: 400 })
    const slLeg = parseExitLeg(body?.slMode, body?.slValue, body?.slTf, 'SL')
    if (typeof slLeg === 'string') return NextResponse.json({ error: slLeg }, { status: 400 })
    // v1.97.0 — trailing exit: mode 'pct' requires BOTH a positive arm %
    // (profit needed to arm) and a positive give-back % (trail distance); any
    // other mode reads as 'off'. Clamps mirror the % legs (0.01–100).
    const trailMode = body?.trailMode === 'pct' ? 'pct' : 'off'
    let trailArmPct: number | null = null
    let trailGivePct: number | null = null
    if (trailMode === 'pct') {
      trailArmPct = clampPct(body?.trailArmPct)
      trailGivePct = clampPct(body?.trailGivePct)
      if (trailArmPct == null || trailGivePct == null) {
        return NextResponse.json({ error: 'Trailing exit needs a positive arm % and a positive give-back % when trail mode is pct' }, { status: 400 })
      }
    }
    if (sizingMode === 'risk' && riskBasis !== 'pct' && riskMoney == null) {
      return NextResponse.json({ error: 'Risk money must be a positive number when sizing mode is risk' }, { status: 400 })
    }
    const run = await startAlgoRun({
      userId: user.id,
      symbol,
      mode: autoStart ? mode : 'paper',
      timeframe: tf as AlgoTimeframe,
      strategy,
      params: body?.params,
      qty,
      sizingMode,
      riskBasis,
      riskMoney,
      riskMoneyPct,
      tpMode: tpLeg.mode,
      tpValue: tpLeg.value,
      tpTf: tpLeg.tf,
      slMode: slLeg.mode,
      slValue: slLeg.value,
      slTf: slLeg.tf,
      trailMode,
      trailArmPct,
      trailGivePct,
      maxTradesDay: Math.min(50, Math.max(1, Math.round(Number(body?.maxTradesDay) || 3))),
      rthOnly: body?.rthOnly !== false,
      flattenEod: body?.flattenEod !== false,
      // re-entry control (Task 70-c) — clamped like the other numeric fields
      cooldownMin: Math.min(240, Math.max(0, Math.round(Number(body?.cooldownMin) || 0))),
      requireNewSignal: body?.requireNewSignal === true,
      kronosGate: body?.kronosGate === true,
    }, { autostart: autoStart })
    return NextResponse.json({ run: toDto(run, []) }, { status: 201 })
  } catch (e) {
    return handleError(e)
  }
}

// collection DELETE stays explicit — target /api/algo/[id]
export async function DELETE() {
  return NextResponse.json({ error: 'Delete a single run via /api/algo/[id]' }, { status: 405 })
}
