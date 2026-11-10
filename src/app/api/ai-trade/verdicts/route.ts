import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { getQuotes } from '@/lib/alpaca'
import { normalizeLessonText, trimAiStewardLessons } from '@/lib/ai-steward-lessons'
import { verdictLessonText } from '@/lib/ai-trade-gates'

export const dynamic = 'force-dynamic'

// v2.12.33 — AI auto-trade POST-HOC ATTRIBUTION.
//
//   POST /api/ai-trade/verdicts  { verdicts: [...] }
//     the scanner records EVERY non-flat verdict with the context it was
//     decided under (regime / earnings / fired-or-dry-run-or-gated + gate
//     note), pruned to the newest 200 per user.
//
//   GET /api/ai-trade/verdicts?resolve=1[&history=1]
//     resolve=1 — the 24h reconciliation pass: verdicts older than 24h get
//     a mark-to-market outcome (24h P&L% from the live quote; win > +0.5%,
//     loss < −0.5%, else flat) and each distilled into ONE 「自動交易覆盤」
//     line UPSERTED into the PERMANENT AiStewardLesson memory (same text
//     re-observed bumps lastSeenAt) — the steward reads those every cycle
//     and "which evidence combinations actually win" stops evaporating with
//     the scan logs. history=1 — the last 100 resolved rows for the scan's
//     [覆盤統計] pack line.
//
// Fail-open everywhere: a failed quote marks the verdict flat-with-no-pnl
// (resolved, unambiguous) rather than blocking future reconciliations.

const VERDICT_KEEP = 200
const RESOLVE_AFTER_MS = 24 * 3600_000
const RESOLVE_BATCH = 20

interface VerdictIn {
  symbol?: unknown
  direction?: unknown
  confidence?: unknown
  entry?: unknown
  stop?: unknown
  target?: unknown
  rr?: unknown
  regime?: unknown
  earnings?: unknown
  status?: unknown
  gateNote?: unknown
}

function sanitizeVerdict(v: VerdictIn) {
  const symbol = String(v.symbol ?? '').trim().toUpperCase()
  if (!symbol || !/^[A-Z0-9./:=_-]{1,15}$/.test(symbol)) return null
  const direction = v.direction === 'short' ? 'short' : v.direction === 'long' ? 'long' : null
  if (!direction) return null
  const status = v.status === 'fired' || v.status === 'dry-run' || v.status === 'gated' ? v.status : null
  if (!status) return null
  const num = (x: unknown) => {
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  const confidence = Math.round(num(v.confidence) ?? -1)
  if (confidence < 0 || confidence > 100) return null
  const regimeRaw = typeof v.regime === 'string' ? v.regime.toUpperCase() : ''
  const regime = ['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'UNKNOWN'].includes(regimeRaw) ? regimeRaw : null
  const earningsRaw = typeof v.earnings === 'string' ? v.earnings : ''
  const earnings = earningsRaw === 'block' || earningsRaw === 'unknown' || /^\d{1,3}$/.test(earningsRaw) ? earningsRaw : null
  return {
    symbol,
    direction,
    confidence,
    entry: num(v.entry),
    stop: num(v.stop),
    target: num(v.target),
    rr: num(v.rr),
    regime,
    earnings,
    status,
    gateNote: typeof v.gateNote === 'string' ? v.gateNote.slice(0, 120) : null,
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => null) as { verdicts?: VerdictIn[] } | null
    const list = Array.isArray(body?.verdicts) ? body.verdicts.slice(0, 50) : []
    if (list.length === 0) return NextResponse.json({ ok: true, stored: 0 })
    const rows = list
      .map((v) => sanitizeVerdict(v ?? {}))
      .filter((v): v is NonNullable<ReturnType<typeof sanitizeVerdict>> => v != null)
      .map((v) => ({ ...v, userId: user.id }))
    if (rows.length === 0) return NextResponse.json({ ok: true, stored: 0 })
    await db.aiTradeVerdict.createMany({ data: rows })
    // prune to the newest VERDICT_KEEP rows per user
    try {
      const keep = await db.aiTradeVerdict.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: VERDICT_KEEP,
        select: { id: true },
      })
      const keepIds = keep.map((r) => r.id)
      if (keepIds.length >= VERDICT_KEEP) {
        await db.aiTradeVerdict.deleteMany({ where: { userId: user.id, id: { notIn: keepIds } } })
      }
    } catch { /* pruning is best-effort */ }
    return NextResponse.json({ ok: true, stored: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser()
    const { searchParams } = new URL(req.url)
    const wantResolve = searchParams.get('resolve') === '1'
    const wantHistory = searchParams.get('history') === '1'

    let resolved = 0
    let lessonsWritten = 0
    if (wantResolve) {
      try {
        const due = await db.aiTradeVerdict.findMany({
          where: { userId: user.id, resolvedAt: null, createdAt: { lte: new Date(Date.now() - RESOLVE_AFTER_MS) } },
          orderBy: { createdAt: 'asc' },
          take: RESOLVE_BATCH,
        })
        if (due.length > 0) {
          // one quote round for every symbol in the batch
          const symbols = [...new Set(due.map((d) => d.symbol))].slice(0, 20)
          const { quotes } = await getQuotes(symbols, user.id).catch(() => ({ quotes: [] as { symbol?: string; price?: number }[] }))
          const priceBySym = new Map<string, number>()
          for (const q of quotes) {
            const p = Number(q?.price)
            if (q?.symbol && Number.isFinite(p) && p > 0) priceBySym.set(q.symbol.toUpperCase(), p)
          }
          for (const d of due) {
            const px = priceBySym.get(d.symbol)
            const entry = d.entry
            let pnlPct: number | null = null
            if (px != null && entry != null && entry > 0) {
              pnlPct = d.direction === 'long' ? ((px - entry) / entry) * 100 : ((entry - px) / entry) * 100
            }
            const outcome = pnlPct == null ? 'flat' : pnlPct > 0.5 ? 'win' : pnlPct < -0.5 ? 'loss' : 'flat'
            await db.aiTradeVerdict.update({
              where: { id: d.id },
              data: { resolvedAt: new Date(), outcome, pnlPct },
            })
            resolved++
            // distill into the PERMANENT lesson memory (same text re-observed
            // bumps lastSeenAt — repeats reinforce instead of duplicating)
            const text = normalizeLessonText(verdictLessonText({
              symbol: d.symbol,
              direction: d.direction === 'short' ? 'short' : 'long',
              confidence: d.confidence,
              regime: d.regime,
              earnings: d.earnings,
              status: d.status,
              pnlPct,
            }))
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
          await trimAiStewardLessons(user.id).catch(() => {})
        }
      } catch { /* reconciliation must never fail the scan */ }
    }

    let history: {
      symbol: string; direction: string; confidence: number; regime: string | null
      status: string; outcome: string | null; pnlPct: number | null; resolvedAt: string | null
    }[] = []
    if (wantHistory) {
      try {
        const rows = await db.aiTradeVerdict.findMany({
          where: { userId: user.id, resolvedAt: { not: null } },
          orderBy: { resolvedAt: 'desc' },
          take: 100,
          select: { symbol: true, direction: true, confidence: true, regime: true, status: true, outcome: true, pnlPct: true, resolvedAt: true },
        })
        history = rows.map((r) => ({
          symbol: r.symbol,
          direction: r.direction,
          confidence: r.confidence,
          regime: r.regime,
          status: r.status,
          outcome: r.outcome,
          pnlPct: r.pnlPct,
          resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        }))
      } catch { /* history is best-effort */ }
    }

    return NextResponse.json({ resolved, lessonsWritten, history })
  } catch (e) {
    return handleError(e)
  }
}
