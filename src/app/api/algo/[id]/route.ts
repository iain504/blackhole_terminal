import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError, readJson } from '@/lib/api-helpers'
import { deleteAlgoRun, stopAlgoRun, updateAlgoRunConfig } from '@/lib/algo-engine'
import { resolveTradeMode } from '@/lib/trading'
import {
  isAlgoStrategyId, ALGO_TIMEFRAMES, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { toDto } from '../route'

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
  tpMode?: string
  tpValue?: number
  slMode?: string
  slValue?: number
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
    if (!symbol || symbol.length > 24) {
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
    const updated = await updateAlgoRunConfig(id, {
      symbol,
      timeframe: tf as AlgoTimeframe,
      strategy,
      params: body?.params,
      qty,
      tpMode: body?.tpMode === 'pct' ? 'pct' : 'none',
      tpValue: body?.tpMode === 'pct' ? clampPct(body?.tpValue) : null,
      slMode: body?.slMode === 'pct' ? 'pct' : 'none',
      slValue: body?.slMode === 'pct' ? clampPct(body?.slValue) : null,
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
