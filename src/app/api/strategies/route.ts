import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { TIMEFRAMES, Timeframe } from '@/lib/market-types'
import { ensureStrategySupervisor } from '@/lib/strategy'
import { resolveTradeMode } from '@/lib/trading'

export interface StrategyDto {
  id: string
  symbol: string
  kind: string // 'rsi' | 'macd'
  condition: string // rsi: cross_above|cross_below · macd: bull_cross|bear_cross|cross_above|cross_below
  level: number
  timeframe: string
  params: { period?: number; fast?: number; slow?: number; signal?: number } | null
  action: string // 'buy' | 'sell'
  qty: number
  tpMode: string // 'none' | 'price' | 'pct'
  tpValue: number | null
  slMode: string
  slValue: number | null
  repeat: boolean
  status: string // armed | paused | placing | triggered | failed
  lastSide: string | null
  triggeredAt: string | null
  orderId: string | null
  fireNote: string | null
  createdAt: string
}

export function toDto(r: {
  id: string; symbol: string; kind: string; condition: string; level: number
  timeframe: string; params: unknown; action: string; qty: number
  tpMode: string; tpValue: number | null; slMode: string; slValue: number | null
  repeat: boolean; status: string; lastSide: string | null
  triggeredAt: Date | null; orderId: string | null; fireNote: string | null; createdAt: Date
}): StrategyDto {
  return {
    id: r.id, symbol: r.symbol, kind: r.kind, condition: r.condition, level: r.level,
    timeframe: r.timeframe, params: (r.params as StrategyDto['params']) ?? null,
    action: r.action, qty: r.qty,
    tpMode: r.tpMode, tpValue: r.tpValue, slMode: r.slMode, slValue: r.slValue,
    repeat: r.repeat, status: r.status, lastSide: r.lastSide,
    triggeredAt: r.triggeredAt?.toISOString() ?? null,
    orderId: r.orderId, fireNote: r.fireNote,
    createdAt: r.createdAt.toISOString(),
  }
}

// GET /api/strategies — all strategy rules for user (also warms the supervisor)
export async function GET() {
  try {
    const user = await requireUser()
    const rows = await db.strategyRule.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
    const mode = await resolveTradeMode(user.id)
    ensureStrategySupervisor(user.id, mode)
    return NextResponse.json({ strategies: rows.map(toDto) })
  } catch (e) {
    return handleError(e)
  }
}

interface CreateBody {
  symbol: string
  kind?: string // 'rsi' | 'macd'
  condition?: string
  level?: number
  timeframe?: string
  params?: { period?: number; fast?: number; slow?: number; signal?: number }
  action?: string // 'buy' | 'sell'
  qty?: number
  tpMode?: string // 'none' | 'price' | 'pct'
  tpValue?: number | null
  slMode?: string
  slValue?: number | null
  repeat?: boolean
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}
const validTf = (tf: string | undefined): Timeframe =>
  tf && TIMEFRAMES[tf as Timeframe] ? (tf as Timeframe) : '1D'
// pct values are PERCENT magnitudes (2 = 2%)
const clampPct = (v: number) => Math.min(100, Math.max(0.01, v))
const clampPctOrKeep = (mode: string, v: number) => (mode === 'pct' ? clampPct(v) : v)

/** Validate one TP/SL config; returns an error string or null. */
function validateExit(mode: string, value: number | null | undefined, label: string): string | null {
  if (mode === 'none') return null
  if (mode === 'price') {
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label} price must be a positive number`
    return null
  }
  if (mode === 'pct') {
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label} % must be a positive number`
    if (value > 100) return `${label} % must be ≤ 100`
    return null
  }
  return `${label} mode must be none, price or pct`
}

// POST /api/strategies — create a conditional order rule
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<CreateBody>(req)
    const symbol = (body.symbol || '').toUpperCase()
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })

    const kind = body.kind === 'macd' ? 'macd' : 'rsi'
    const count = await db.strategyRule.count({ where: { userId: user.id } })
    if (count >= 50) return NextResponse.json({ error: 'Strategy limit reached (50)' }, { status: 400 })

    const action = body.action === 'sell' ? 'sell' : 'buy'
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: 'qty must be a positive number' }, { status: 400 })
    }

    const tpMode = ['none', 'price', 'pct'].includes(body.tpMode || '') ? body.tpMode! : 'none'
    const slMode = ['none', 'price', 'pct'].includes(body.slMode || '') ? body.slMode! : 'none'
    const tpValue = tpMode === 'none' ? null : Number(body.tpValue)
    const slValue = slMode === 'none' ? null : Number(body.slValue)
    const tpErr = validateExit(tpMode, tpValue, 'TP')
    if (tpErr) return NextResponse.json({ error: tpErr }, { status: 400 })
    const slErr = validateExit(slMode, slValue, 'SL')
    if (slErr) return NextResponse.json({ error: slErr }, { status: 400 })

    let condition: string
    let level = Number(body.level) || 0
    let params: Record<string, number>
    if (kind === 'rsi') {
      condition = body.condition === 'cross_below' ? 'cross_below' : 'cross_above'
      if (!Number.isFinite(level) || level <= 0 || level >= 100) {
        return NextResponse.json({ error: 'RSI level must be between 0 and 100' }, { status: 400 })
      }
      params = { period: clampInt(body.params?.period, 2, 200, 14) }
    } else {
      condition = ['bull_cross', 'bear_cross', 'cross_above', 'cross_below'].includes(body.condition || '')
        ? body.condition!
        : 'bull_cross'
      const usesLevel = condition === 'cross_above' || condition === 'cross_below'
      if (usesLevel && !Number.isFinite(level)) {
        return NextResponse.json({ error: 'macd cross level required' }, { status: 400 })
      }
      let fast = clampInt(body.params?.fast, 1, 200, 12)
      let slow = clampInt(body.params?.slow, 2, 400, 26)
      if (slow <= fast) slow = fast + 1
      params = { fast, slow, signal: clampInt(body.params?.signal, 1, 200, 9) }
    }

    const r = await db.strategyRule.create({
      data: {
        userId: user.id, symbol, kind, condition, level,
        timeframe: validTf(body.timeframe), params,
        action, qty,
        tpMode, tpValue: tpValue != null && Number.isFinite(tpValue) ? clampPctOrKeep(tpMode, tpValue) : null,
        slMode, slValue: slValue != null && Number.isFinite(slValue) ? clampPctOrKeep(slMode, slValue) : null,
        repeat: Boolean(body.repeat),
        status: 'armed',
        lastSide: null, // first check records the side — fires on a genuine crossing
      },
    })
    // warm the supervisor so this rule fires even with no terminal tab open
    const mode = await resolveTradeMode(user.id)
    ensureStrategySupervisor(user.id, mode)
    return NextResponse.json({ strategy: toDto(r) })
  } catch (e) {
    return handleError(e)
  }
}
