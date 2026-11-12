import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { getQuotes } from '@/lib/alpaca'
import { normalizeLessonText, trimAiStewardLessons } from '@/lib/ai-steward-lessons'
import { planLessonText, planReviewOutcome } from '@/lib/ai-trade-gates'

export const dynamic = 'force-dynamic'

// v2.12.37 — AI TRADE PLAN LEDGER (React > Respond > Review).
//
//   POST /api/ai-trade/plans  { plans: [...] }
//     the scanner (react entry mode) persists the CONDITIONAL trade plans it
//     wants watched: symbol/side/trigger/tp/sl + the context they were
//     planned under. Any previous WAITING plan for the SAME (user, symbol,
//     side) is superseded (the fresh analysis replaces stale levels); plans
//     for other symbols keep waiting. Pruned to the newest 150 per user.
//
//   GET /api/ai-trade/plans?active=1
//     hydration: the WAITING plans this account should keep reacting to
//     (survives reloads and runner hand-over between devices) + how many
//     plans executed in the last 24h (the reactor's maxOpen denominator).
//
//   GET /api/ai-trade/plans?resolve=1[&history=1]
//     resolve=1 — the 24h REVIEW pass for closed (never executed) plans:
//     mark-to-market was-the-wait-right (good-wait / missed-run / neutral)
//     and each verdict distilled into ONE 「計劃覆盤」 line UPSERTED into the
//     PERMANENT AiStewardLesson memory. history=1 — lifecycle counts + the
//     recent closed rows for the panel's review stats.

const PLAN_KEEP = 150
const RESOLVE_AFTER_MS = 24 * 3600_000
const RESOLVE_BATCH = 20

const PLAN_STATUSES = ['WAITING', 'EXECUTED', 'INVALIDATED', 'EXPIRED', 'GATED', 'CANCELLED', 'SUPERSEDED'] as const

interface PlanIn {
  symbol?: unknown
  side?: unknown
  bias?: unknown
  confidence?: unknown
  trigger?: unknown
  tp?: unknown
  sl?: unknown
  rr?: unknown
  refPrice?: unknown
  reason?: unknown
  regime?: unknown
  earnings?: unknown
  mode?: unknown
}

function sanitizePlan(p: PlanIn) {
  const symbol = String(p.symbol ?? '').trim().toUpperCase()
  if (!symbol || !/^[A-Z0-9./:=_-]{1,15}$/.test(symbol)) return null
  const side = p.side === 'sell' ? 'sell' : p.side === 'buy' ? 'buy' : null
  if (!side) return null
  const bias = p.bias === 'short' ? 'short' : p.bias === 'long' ? 'long' : 'flat'
  const num = (x: unknown) => {
    const n = Number(x)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const trigger = num(p.trigger)
  const tp = num(p.tp)
  const sl = num(p.sl)
  const rr = num(p.rr)
  const refPrice = num(p.refPrice)
  if (trigger == null || tp == null || sl == null || rr == null || refPrice == null) return null
  const confidence = Math.round(Number(p.confidence))
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null
  const regimeRaw = typeof p.regime === 'string' ? p.regime.toUpperCase() : ''
  const regime = ['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'UNKNOWN'].includes(regimeRaw) ? regimeRaw : null
  const earningsRaw = typeof p.earnings === 'string' ? p.earnings : ''
  const earnings = earningsRaw === 'block' || earningsRaw === 'unknown' || /^\d{1,3}$/.test(earningsRaw) ? earningsRaw : null
  return {
    symbol,
    side,
    bias,
    confidence,
    trigger,
    tp,
    sl,
    rr,
    refPrice,
    reason: typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim().slice(0, 120) : null,
    regime,
    earnings,
    mode: p.mode === 'live' ? 'live' : 'paper',
    status: 'WAITING' as const,
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => null) as { plans?: PlanIn[] } | null
    const list = Array.isArray(body?.plans) ? body.plans.slice(0, 60) : []
    if (list.length === 0) return NextResponse.json({ ok: true, stored: 0 })
    const rows = list
      .map((p) => sanitizePlan(p ?? {}))
      .filter((p): p is NonNullable<ReturnType<typeof sanitizePlan>> => p != null)
    if (rows.length === 0) return NextResponse.json({ ok: true, stored: 0 })

    // supersede stale WAITING plans for the SAME (symbol, side) pairs — the
    // fresh analysis owns those levels; everything else keeps waiting.
    const touchedSymbols = [...new Set(rows.map((r) => r.symbol))]
    await db.aiTradePlan.updateMany({
      where: {
        userId: user.id,
        status: 'WAITING',
        symbol: { in: touchedSymbols },
        side: { in: ['buy', 'sell'] },
      },
      data: { status: 'SUPERSEDED', statusNote: '新一輪評估取代', closedAt: new Date() },
    })
    await db.aiTradePlan.createMany({ data: rows.map((r) => ({ ...r, userId: user.id })) })
    // prune to the newest PLAN_KEEP rows per user
    try {
      const keep = await db.aiTradePlan.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: PLAN_KEEP,
        select: { id: true },
      })
      if (keep.length >= PLAN_KEEP) {
        await db.aiTradePlan.deleteMany({ where: { userId: user.id, id: { notIn: keep.map((r) => r.id) } } })
      }
    } catch { /* pruning is best-effort */ }
    return NextResponse.json({ ok: true, stored: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => null) as { id?: unknown; status?: unknown; note?: unknown } | null
    const id = typeof body?.id === 'string' ? body.id : null
    const status = typeof body?.status === 'string' ? (body.status as string) : null
    if (!id || !status || !PLAN_STATUSES.includes(status as (typeof PLAN_STATUSES)[number])) {
      return NextResponse.json({ error: 'invalid plan transition' }, { status: 400 })
    }
    const closed = status !== 'WAITING'
    const row = await db.aiTradePlan.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } })
    if (!row) return NextResponse.json({ error: 'plan not found' }, { status: 404 })
    if (row.status !== 'WAITING') return NextResponse.json({ ok: true, noop: true })
    await db.aiTradePlan.update({
      where: { id },
      data: {
        status,
        statusNote: typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null,
        ...(closed ? { closedAt: new Date() } : {}),
      },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser()
    const { searchParams } = new URL(req.url)
    const wantActive = searchParams.get('active') === '1'
    const wantResolve = searchParams.get('resolve') === '1'
    const wantHistory = searchParams.get('history') === '1'

    if (wantActive) {
      const rows = await db.aiTradePlan.findMany({
        where: { userId: user.id, status: 'WAITING' },
        orderBy: { createdAt: 'desc' },
        take: 60,
      })
      const since = new Date(Date.now() - 24 * 3600_000)
      const executedRecent = await db.aiTradePlan.count({ where: { userId: user.id, status: 'EXECUTED', closedAt: { gte: since } } })
      return NextResponse.json({
        plans: rows.map((r) => ({
          id: r.id, symbol: r.symbol, side: r.side, bias: r.bias, confidence: r.confidence,
          trigger: r.trigger, tp: r.tp, sl: r.sl, rr: r.rr, refPrice: r.refPrice,
          reason: r.reason, regime: r.regime, mode: r.mode, status: r.status,
          createdAt: r.createdAt.getTime(),
        })),
        executedRecent,
      })
    }

    let resolved = 0
    let lessonsWritten = 0
    if (wantResolve) {
      try {
        const due = await db.aiTradePlan.findMany({
          where: {
            userId: user.id,
            resolvedAt: null,
            closedAt: { not: null, lte: new Date(Date.now() - RESOLVE_AFTER_MS) },
            status: { not: 'WAITING' },
          },
          orderBy: { closedAt: 'asc' },
          take: RESOLVE_BATCH,
        })
        if (due.length > 0) {
          const symbols = [...new Set(due.map((d) => d.symbol))].slice(0, 20)
          const { quotes } = await getQuotes(symbols, user.id).catch(() => ({ quotes: [] as { symbol?: string; price?: number }[] }))
          const priceBySym = new Map<string, number>()
          for (const q of quotes) {
            const p = Number(q?.price)
            if (q?.symbol && Number.isFinite(p) && p > 0) priceBySym.set(q.symbol.toUpperCase(), p)
          }
          for (const d of due) {
            const px = priceBySym.get(d.symbol)
            const { outcome, pnlPct } = planReviewOutcome(
              d.side === 'sell' ? 'sell' : 'buy',
              d.trigger, d.sl, px ?? Number.NaN,
            )
            await db.aiTradePlan.update({ where: { id: d.id }, data: { resolvedAt: new Date(), outcome, pnlPct } })
            resolved++
            if (outcome !== 'neutral') {
              const text = normalizeLessonText(planLessonText({
                symbol: d.symbol,
                side: d.side === 'sell' ? 'sell' : 'buy',
                trigger: d.trigger,
                confidence: d.confidence,
                status: d.status,
                regime: d.regime,
              }, outcome, pnlPct))
              if (text) {
                const existing = await db.aiStewardLesson.findUnique({
                  where: { userId_text: { userId: user.id, text } },
                  select: { id: true },
                }).catch(() => null)
                if (existing) {
                  await db.aiStewardLesson.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
                } else {
                  await db.aiStewardLesson.create({ data: { userId: user.id, text } }).catch(() => {})
                  lessonsWritten++
                }
              }
            }
          }
          await trimAiStewardLessons(user.id).catch(() => {})
        }
      } catch { /* review must never fail the scan */ }
    }

    interface HistRow {
      symbol: string; side: string; status: string; trigger: number
      outcome: string | null; pnlPct: number | null; closedAt: string | null; statusNote: string | null
    }
    let stats = { waiting: 0, executed: 0, invalidated: 0, expired: 0, gated: 0, superseded: 0, goodWait: 0, missedRun: 0, neutral: 0 }
    let recent: HistRow[] = []
    if (wantHistory) {
      try {
        const rows = await db.aiTradePlan.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 300,
          select: { symbol: true, side: true, status: true, trigger: true, outcome: true, pnlPct: true, closedAt: true, statusNote: true },
        })
        stats = {
          waiting: rows.filter((r) => r.status === 'WAITING').length,
          executed: rows.filter((r) => r.status === 'EXECUTED').length,
          invalidated: rows.filter((r) => r.status === 'INVALIDATED').length,
          expired: rows.filter((r) => r.status === 'EXPIRED').length,
          gated: rows.filter((r) => r.status === 'GATED').length,
          superseded: rows.filter((r) => r.status === 'SUPERSEDED').length,
          goodWait: rows.filter((r) => r.outcome === 'good-wait').length,
          missedRun: rows.filter((r) => r.outcome === 'missed-run').length,
          neutral: rows.filter((r) => r.outcome === 'neutral').length,
        }
        recent = rows
          .filter((r) => r.status !== 'WAITING')
          .slice(0, 12)
          .map((r) => ({
            symbol: r.symbol, side: r.side, status: r.status, trigger: r.trigger,
            outcome: r.outcome, pnlPct: r.pnlPct,
            closedAt: r.closedAt ? r.closedAt.toISOString() : null,
            statusNote: r.statusNote,
          }))
      } catch { /* history is best-effort */ }
    }

    return NextResponse.json({ resolved, lessonsWritten, stats, recent })
  } catch (e) {
    return handleError(e)
  }
}
