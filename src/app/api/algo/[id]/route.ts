import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError, readJson } from '@/lib/api-helpers'
import { deleteAlgoRun, stopAlgoRun, updateAlgoRunConfig } from '@/lib/algo-engine'
import { resolveTradeMode } from '@/lib/trading'
import {
  isAlgoStrategyId, ALGO_TIMEFRAMES, SYMBOL_RE, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { toDto } from '../route'
import { clampAtrMult } from '@/lib/atr'
import { TIMEFRAMES } from '@/lib/market-types'

export const dynamic = 'force-dynamic'

async function ownedRun(userId: string, runId: string) {
  return db.algoRun.findFirst({ where: { id: runId, userId } })
}

// POST /api/algo/[id] — { action: 'stop', flatten?: boolean } | { action: 'delete' }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await req.json().catch(() => ({})) as { action?: string; flatten?: boolean }
    const run = await ownedRun(user.id, id)
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    if (body.action === 'stop') {
      await stopAlgoRun(id, body.flatten === true)
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'delete') {
      await deleteAlgoRun(id)
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    return handleError(e)
  }
}

interface AlgoPatchBody {
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
  maxTradesDay?: number
  rthOnly?: boolean
  flattenEod?: boolean
  cooldownMin?: number
  requireNewSignal?: boolean
}

// PATCH /api/algo/[id] — edit an existing run's settings (Task 71-1).
// The engine re-reads the run row every cycle, so a running run picks the
// change up on its next ≤15s tick — no restart needed. Validation mirrors
// POST /api/algo exactly (same clamps, same live-mode guard).
export async function PATCH(req: NextRequest, { params: routeParams }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await routeParams
    const run = await ownedRun(user.id, id)
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    const body = await readJson<AlgoPatchBody>(req)
    const symbol = String(body?.symbol ?? '').trim().toUpperCase()
    // Task 89 — charset validation (mirrors POST, same rule as config import)
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
    const mode = await resolveTradeMode(user.id)
    if (mode === 'live') {
      return NextResponse.json({ error: 'Refusing to edit algo runs in LIVE mode — switch the trade mode to paper' }, { status: 400 })
    }
    const clampPct = (v: unknown): number | null => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(0.01, n)) : null
    }
    // Task 78 — Risk Money sizing; Task 78e — budget basis ($ or % of equity).
    // Validation mirrors POST /api/algo exactly.
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
    // of ATR(14) on a chart timeframe, default '1h') — validation mirrors
    // POST /api/algo exactly.
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
    if (sizingMode === 'risk' && riskBasis !== 'pct' && riskMoney == null) {
      return NextResponse.json({ error: 'Risk money must be a positive number when sizing mode is risk' }, { status: 400 })
    }
    const updated = await updateAlgoRunConfig(id, {
      symbol,
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
      maxTradesDay: Math.min(50, Math.max(1, Math.round(Number(body?.maxTradesDay) || 3))),
      rthOnly: body?.rthOnly !== false,
      flattenEod: body?.flattenEod !== false,
      cooldownMin: Math.min(240, Math.max(0, Math.round(Number(body?.cooldownMin) || 0))),
      requireNewSignal: body?.requireNewSignal === true,
    })
    if (!updated) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    return NextResponse.json({ run: toDto(updated, []) })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/algo/[id] — delete run + logs (stops the engine first)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const run = await ownedRun(user.id, id)
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    await deleteAlgoRun(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
