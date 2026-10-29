import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { TIMEFRAMES, Timeframe } from '@/lib/market-types'
import { ensureStrategySupervisor } from '@/lib/strategy'
import { resolveTradeMode, TradeMode } from '@/lib/trading'
import { hasAlpacaKeys } from '@/lib/alpaca'

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
  tpMode: string // 'none' | 'price' | 'pct' | 'atr'
  tpValue: number | null
  slMode: string
  slValue: number | null
  /** v1.96.0 — ATR(14) timeframes when the mode is 'atr' */
  tpTf: string | null
  slTf: string | null
  repeat: boolean
  status: string // armed | paused | placing | triggered | failed
  /** the Alpaca account this rule fires on — PINNED at arm time */
  mode: 'paper' | 'live'
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
  tpTf?: string | null; slTf?: string | null
  repeat: boolean; status: string; lastSide: string | null; mode?: string | null
  triggeredAt: Date | null; orderId: string | null; fireNote: string | null; createdAt: Date
}): StrategyDto {
  return {
    id: r.id, symbol: r.symbol, kind: r.kind, condition: r.condition, level: r.level,
    timeframe: r.timeframe, params: (r.params as StrategyDto['params']) ?? null,
    action: r.action, qty: r.qty,
    tpMode: r.tpMode, tpValue: r.tpValue, slMode: r.slMode, slValue: r.slValue,
    tpTf: r.tpTf ?? null, slTf: r.slTf ?? null,
    repeat: r.repeat, status: r.status, lastSide: r.lastSide,
    // Task 94 — rules may now be armed on LIVE via explicit opt-in; legacy
    // rows (and any null) read as the safe default 'paper'
    mode: r.mode === 'live' ? 'live' : 'paper',
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
  tpMode?: string // 'none' | 'price' | 'pct' | 'atr'
  tpValue?: number | null
  slMode?: string
  slValue?: number | null
  tpTf?: string | null
  slTf?: string | null
  repeat?: boolean
  /** Task 94 — which Alpaca account this rule fires on. Default 'paper'.
   *  'live' is an explicit OPT-IN: the request must carry liveConfirm:true
   *  (the drawer's "I understand" checkbox) and the user must have LIVE
   *  keys saved. The mode is then PINNED on the rule — tradeMode flips in
   *  Settings can never migrate it. */
  mode?: string
  liveConfirm?: boolean
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
  if (mode === 'atr') {
    // v1.96.0 — ATR multiplier of ATR(14) on the leg's timeframe
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label} ATR multiplier must be a positive number`
    if (value < 0.1 || value > 20) return `${label} ATR multiplier must be between 0.1 and 20`
    return null
  }
  if (mode === 'pct') {
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label} % must be a positive number`
    if (value > 100) return `${label} % must be ≤ 100`
    return null
  }
  return `${label} mode must be none, price, pct or atr`
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
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) {
      return NextResponse.json({ error: 'qty must be a positive number (max 1,000,000)' }, { status: 400 })
    }
    // Task 89 — stocks trade whole shares (the broker pipeline floors), so a
    // fractional stock qty would silently trade a different size than shown
    if (!symbol.includes('/') && !Number.isInteger(qty)) {
      return NextResponse.json({ error: 'Stocks require a whole-number quantity — crypto supports fractional sizes' }, { status: 400 })
    }

    // Task 94 — LIVE arming is an EXPLICIT opt-in (user request): default is
    // paper; 'live' requires BOTH the ack flag (liveConfirm — the drawer's
    // checkbox, so a stray fetch can never arm real-money orders) AND live
    // keys actually saved. The chosen mode is then pinned on the rule.
    const mode: TradeMode = body.mode === 'live' ? 'live' : 'paper'
    if (mode === 'live') {
      if (body.liveConfirm !== true) {
        return NextResponse.json({ error: 'Arming on LIVE requires explicit confirmation (liveConfirm)' }, { status: 400 })
      }
      if (!(await hasAlpacaKeys(user.id, 'live'))) {
        return NextResponse.json({ error: 'No LIVE Alpaca keys saved — add them in Settings → API keys (Live account) before arming a live rule' }, { status: 400 })
      }
    }

    const tpMode = ['none', 'price', 'pct', 'atr'].includes(body.tpMode || '') ? body.tpMode! : 'none'
    const slMode = ['none', 'price', 'pct', 'atr'].includes(body.slMode || '') ? body.slMode! : 'none'
    const tpValue = tpMode === 'none' ? null : Number(body.tpValue)
    const slValue = slMode === 'none' ? null : Number(body.slValue)
    const tpErr = validateExit(tpMode, tpValue, 'TP')
    if (tpErr) return NextResponse.json({ error: tpErr }, { status: 400 })
    const slErr = validateExit(slMode, slValue, 'SL')
    if (slErr) return NextResponse.json({ error: slErr }, { status: 400 })
    // v1.96.0 — ATR(14) timeframes (validated chart timeframes, default '1h')
    const atrTfValid = (tf: unknown): string => (typeof tf === 'string' && tf in TIMEFRAMES ? tf : '1h')
    const tpTf = tpMode === 'atr' ? atrTfValid(body.tpTf) : null
    const slTf = slMode === 'atr' ? atrTfValid(body.slTf) : null

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
        // Task 89/94 — PINNED account: fires on this mode forever, immune to
        // tradeMode flips ('live' only reachable through the opt-in above)
        mode,
        timeframe: validTf(body.timeframe), params,
        action, qty,
        tpMode, tpValue: tpValue != null && Number.isFinite(tpValue) ? clampPctOrKeep(tpMode, tpValue) : null,
        slMode, slValue: slValue != null && Number.isFinite(slValue) ? clampPctOrKeep(slMode, slValue) : null,
        tpTf, slTf,
        repeat: Boolean(body.repeat),
        status: 'armed',
        lastSide: null, // first check records the side — fires on a genuine crossing
      },
    })
    // warm the supervisor so this rule fires even with no terminal tab open
    // (evaluation is mode-agnostic — each rule fires on its own pinned mode)
    ensureStrategySupervisor(user.id, mode)
    return NextResponse.json({ strategy: toDto(r) })
  } catch (e) {
    return handleError(e)
  }
}
