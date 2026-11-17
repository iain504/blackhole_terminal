import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { getBars, getQuotes } from '@/lib/alpaca'
import { getAccount, getPositions, resolveTradeMode } from '@/lib/trading'
import { getMarketHours } from '@/lib/market-hours'
import { isCryptoSymbol } from '@/lib/market-types'
import { detectSrLevels } from '@/lib/sr'
import { classifySession, matchActiveRules, rankCandidates } from '@/lib/trade-review'
import {
  GATE_SYSTEM_PROMPT, GATE_USER_TEMPLATE, buildGateSnapshot, parseGateOutput,
  dailyAtr14, rvolFromBars, htfAlignment,
  type GateCandidateInput, type GateMarketContext, type GateVerdict,
} from '@/lib/trade-gate'
import { llmChat, llmSetupHint, llmStatus } from '@/lib/llm'

export const dynamic = 'force-dynamic'
// the gatekeeper runs at temp 0.1 and must answer before the order lane waits
export const maxDuration = 120

// v2.12.52 — STANDALONE LLM transport: z-ai-web-dev-sdk is gone; the gate
// speaks OpenAI-compatible HTTP to any provider (LLM_API_URL/KEY/MODEL).
// Fail-closed semantics unchanged — an unresolvable provider 503s BEFORE the
// deterministic snapshot is built, and no ERROR gate-log row is burned.
//
// v2.12.51 — Z.AI credentials fix for HOSTED deployments: the SDK resolves
// .z-ai-config (cwd/home//etc) which never exists on Render — the credentials
// now ride the ZAI_CONFIG_JSON env var (materialized by docker-entrypoint.sh
// at boot, runtime fallback in src/lib/zai.ts) and a pre-flight in POST fails
// fast with an actionable 503 instead of persisting an ERROR verdict row per
// signal. Fail-closed semantics unchanged.
//
// v2.12.50 — PRE-TRADE VETO GATE (Risk & Regime Filter).
//
//   POST /api/ai-trade/gate { candidate: {...}, planId? }
//     Called by the engine (react follow / instant fire) AFTER the mechanical
//     gates pass and BEFORE /api/trading/orders. The route builds the
//     deterministic snapshot (session / NBBO spread vs ATR / RVOL / HTF
//     alignment / portfolio exposure / ACTIVE audit guardrails — every number
//     computed by code, the model never sees raw ticks), calls the gatekeeper
//     LLM @ temp 0.1, strictly validates the JSON verdict, persists a
//     PreTradeGateLog row and returns the verdict.
//
//   GET — recent gate log rows + decision stats + the gatekeeper audit
//     (shadow outcomes of vetoed plans: good-wait = capital preserved,
//     missed-run = a guardrail may be too strict).
//
//   PATCH { id, orderId } — link the Alpaca order id after an approved entry
//     fills, closing the loop between gate verdict and execution.

const GATE_RULE_CAP = 7 // the guardrail block must not bloat the prompt
const LOG_KEEP = 400 // per-user cap on stored gate evaluations

// --- candidate sanitization --------------------------------------------------

interface CandidateIn {
  symbol?: unknown
  side?: unknown
  entry?: unknown
  stop?: unknown
  target?: unknown
  confidence?: unknown
  timeframe?: unknown
  reason?: unknown
  regime?: unknown
  planId?: unknown
}

function sanitizeCandidate(b: CandidateIn): { candidate: GateCandidateInput; planId: string | null } | null {
  const symbol = String(b.symbol ?? '').trim().toUpperCase()
  if (!symbol || !/^[A-Z0-9./:=_-]{1,15}$/.test(symbol)) return null
  const side = b.side === 'buy' ? 'buy' : b.side === 'sell' ? 'sell' : null
  if (!side) return null
  const num = (x: unknown) => {
    const n = Number(x)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const entry = num(b.entry)
  const stop = num(b.stop)
  const target = num(b.target)
  if (entry == null || stop == null || target == null) return null
  const conf = Math.round(Number(b.confidence))
  const candidate: GateCandidateInput = {
    symbol,
    side,
    entry,
    stop,
    target,
    confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, conf)) : 50,
    timeframe: typeof b.timeframe === 'string' && b.timeframe.trim() ? b.timeframe.trim().slice(0, 8) : '1h',
    reason: typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '',
    regime: typeof b.regime === 'string' && ['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'UNKNOWN'].includes(b.regime) ? b.regime : null,
  }
  const planId = typeof b.planId === 'string' && b.planId.length < 40 ? b.planId : null
  return { candidate, planId }
}

// --- LLM call (same discipline as the auditor: queue + param fallback) -------

let llmQueue: Promise<void> = Promise.resolve()
function enqueueLlm<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(fn, fn)
  const gap = () => new Promise<void>((r) => setTimeout(r, 400))
  llmQueue = run.then(gap, gap)
  return run
}

/** One gatekeeper call @ temperature 0.1 (deterministic JSON before the order
 *  lane, per the veto-gate spec) through the standalone llmChat transport. A
 *  provider that rejects the temperature/max_tokens PARAMs falls back to its
 *  defaults rather than failing the gate. */
async function callGatekeeper(system: string, user: string): Promise<string> {
  return enqueueLlm(async () => {
    const msgs = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
    try {
      const completion = await llmChat({
        messages: msgs, temperature: 0.1, max_tokens: 700, thinking: { type: 'disabled' },
      })
      return extractContent(completion)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/temperature|max_tokens/i.test(msg)) {
        const completion = await llmChat({ messages: msgs, thinking: { type: 'disabled' } })
        return extractContent(completion)
      }
      throw e
    }
  })
}

function extractContent(completion: unknown): string {
  const content = (completion as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) throw new Error('empty LLM response')
  return content
}

// --- context assembly (every failure degrades to null + honest note) ---------

interface CtxFetch {
  ctx: GateMarketContext
  quotesOk: boolean
}

async function buildContext(userId: string, mode: 'paper' | 'live', candidate: GateCandidateInput): Promise<CtxFetch> {
  const isCrypto = isCryptoSymbol(candidate.symbol)
  const nowSec = Math.floor(Date.now() / 1000)

  const [q, daily, intraday, hours, acc, pos] = await Promise.all([
    getQuotes([candidate.symbol], userId, { trading: true }).catch(() => null),
    getBars(candidate.symbol, '1D', userId, { lookbackDays: 70 }).catch(() => null),
    getBars(candidate.symbol, '15m', userId, { lookbackDays: 2 }).catch(() => null),
    getMarketHours([candidate.symbol], userId, mode).catch(() => null),
    getAccount(userId, mode).catch(() => null),
    getPositions(userId, mode).catch(() => null),
  ])

  const normSym = candidate.symbol.replace('/', '').toUpperCase()
  const quote = q?.quotes?.find((x) => x.symbol.toUpperCase() === candidate.symbol.toUpperCase() || x.symbol.toUpperCase() === normSym) ?? null
  const dailyBars = daily && !daily.demo && daily.bars.length > 0 ? daily.bars : []
  const intradayBars = intraday && !intraday.demo && intraday.bars.length > 0 ? intraday.bars : []

  // point-in-time ATR: only DAILY bars that CLOSED before now feed it
  const closedDaily = dailyBars.filter((b) => b.time + 86_400 <= nowSec)
  const atr = dailyAtr14(closedDaily)
  const atrRef = quote?.price ?? candidate.entry
  const htf = htfAlignment(candidate.side, closedDaily)

  // nearest tested daily S/R vs the price the order would chase
  const levels = closedDaily.length >= 15
    ? detectSrLevels(
        closedDaily.slice(-90).map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })),
        { minTouches: 2, maxLevels: 6, pivotWindow: 5, refPrice: atrRef },
      )
    : []
  const sup = levels.filter((l) => l.side === 'support').sort((a, b) => b.price - a.price)[0] ?? null
  const res = levels.filter((l) => l.side === 'resistance').sort((a, b) => a.price - b.price)[0] ?? null

  // session + minutes to the regular close (clock-derived when available)
  const session = classifySession(nowSec * 1000, isCrypto ? 'crypto' : 'us_equity')
  let minutesToClose: number | null = null
  if (hours?.us?.isOpen && hours.us.nextClose) {
    const ms = Date.parse(hours.us.nextClose) - Date.now()
    if (Number.isFinite(ms) && ms > 0) minutesToClose = Math.round(ms / 60_000)
  }

  // portfolio exposure state — each source fails independently and honestly
  let equity: number | null = null
  let buyingPower: number | null = null
  let dailyDrawdownPct: number | null = null
  let openPositions: number | null = null
  let sameDir: number | null = null
  const accJ = acc?.status === 200 ? (acc.data as { equity?: string; buying_power?: string; last_equity?: string } | null) : null
  if (accJ && typeof accJ.equity === 'string') {
    const eq = Number.parseFloat(accJ.equity)
    const le = Number.parseFloat(accJ.last_equity ?? '')
    const bp = Number.parseFloat(accJ.buying_power ?? '')
    if (Number.isFinite(eq) && eq > 0) {
      equity = eq
      buyingPower = Number.isFinite(bp) && bp > 0 ? bp : eq
      if (Number.isFinite(le) && le > 0) dailyDrawdownPct = ((eq - le) / le) * 100
    }
  }
  const posList = pos?.status === 200 && Array.isArray(pos.data) ? pos.data : null
  if (posList) {
    openPositions = posList.length
    sameDir = posList.filter((p) => {
      const s = String(p?.symbol ?? '').replace('/', '').toUpperCase()
      return s === normSym || p?.side === (candidate.side === 'buy' ? 'long' : 'short')
    }).length
  }
  const portfolioFailOpen = equity == null && posList == null

  return {
    ctx: {
      session,
      extendedLike: session === 'pre' || session === 'post' || session === 'overnight' || session === 'weekend',
      minutesToClose,
      lastPrice: quote?.price ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spread: null,
      spreadPct: null,
      spreadAtrPct: null,
      spreadToStop: null,
      rvol: intradayBars.length >= 21 ? rvolFromBars(intradayBars) : null,
      atr,
      atrPct: atr != null && atrRef > 0 ? (atr / atrRef) * 100 : null,
      sma20: htf.sma20,
      sma50: htf.sma50,
      slope20Pct: htf.slope20Pct,
      support: sup?.price ?? null,
      supportPct: sup && atrRef > 0 ? ((atrRef - sup.price) / atrRef) * 100 : null,
      resistance: res?.price ?? null,
      resistancePct: res && atrRef > 0 ? ((res.price - atrRef) / atrRef) * 100 : null,
      htfAlignment: htf.alignment,
      equity,
      buyingPower,
      dailyDrawdownPct,
      openPositions,
      sameDirectionPositions: sameDir,
      portfolioFailOpen,
    },
    quotesOk: quote != null,
  }
}

// --- POST: run the gate -------------------------------------------------------

export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await req.json().catch(() => null)) as { candidate?: CandidateIn; mode?: string } | null
    const mode = await resolveTradeMode(user.id, body?.mode)
    const parsed = body?.candidate ? sanitizeCandidate(body.candidate) : null
    if (!parsed) {
      return NextResponse.json({ error: 'candidate (symbol, side, entry, stop, target) required' }, { status: 400 })
    }
    const { candidate, planId } = parsed

    // v2.12.52 pre-flight — the gate verdict must never silently degrade on a
    // deployment without an LLM provider: answer with ONE actionable 503
    // (fail-closed, and no ERROR gate-log row is burned per signal).
    const llmProbe = await llmStatus()
    if (!llmProbe.configured) {
      return NextResponse.json(
        { error: `Pre-trade gate unavailable — ${llmSetupHint(llmProbe)}` },
        { status: 503 },
      )
    }

    // 1) deterministic context + ACTIVE guardrails (parallel)
    const [{ ctx, quotesOk }, activeRules] = await Promise.all([
      buildContext(user.id, mode, candidate),
      db.reviewRule.findMany({
        where: { userId: user.id, status: 'active' },
        orderBy: [{ confidence: 'desc' }, { frequency: 'desc' }, { lastSeenAt: 'desc' }],
        take: GATE_RULE_CAP * 3,
      }).catch(() => []),
    ])

    // session-matched injection (same matching the steward uses), ranked, capped
    const sessionForMatch = ctx.session === 'regular' ? 'regular' : 'post'
    const ranked = rankCandidates(activeRules.map((r) => ({
      confidence: r.confidence, frequency: r.frequency, lastSeenAt: r.lastSeenAt, source: r,
    })))
    const matched = matchActiveRules(ranked.map((r) => ({
      condition: r.source.condition, action: r.source.action, confidence: r.source.confidence,
      tags: safeTags(r.source.tags), source: r.source,
    })), sessionForMatch, GATE_RULE_CAP)

    // stable injection ids: G1..Gn — the model cites these; the mapping back
    // to the DB rows rides the stored guardrails JSON
    const guardrails = matched.map((r, i) => ({
      rule_id: `G${i + 1}`,
      source_id: (r.source as { id: string }).id,
      condition: r.condition,
      action: r.action,
      confidence: r.confidence,
    }))
    const validRuleIds = new Set(guardrails.map((g) => g.rule_id))

    const snapshot = buildGateSnapshot(candidate, ctx)

    // 2) gatekeeper verdict (LLM) — a failure becomes an honest ERROR row,
    //    never a silent approve
    let verdict: GateVerdict | null = null
    let errorNote: string | null = null
    try {
      const content = await callGatekeeper(
        GATE_SYSTEM_PROMPT,
        GATE_USER_TEMPLATE(
          JSON.stringify(snapshot, null, 1),
          JSON.stringify(guardrails.map(({ rule_id, condition, action }) => ({ rule_id, condition, action })), null, 1),
        ),
      )
      verdict = parseGateOutput(content, validRuleIds)
      if (!verdict) errorNote = 'gatekeeper returned unparseable output'
    } catch (e) {
      errorNote = e instanceof Error ? e.message.slice(0, 300) : 'gatekeeper call failed'
    }

    // 3) persist + answer
    const cited = verdict?.guardrailsTriggered ?? []
    const citedDetail = guardrails
      .filter((g) => cited.includes(g.rule_id))
      .map(({ rule_id, condition, action }) => ({ rule_id, condition, action }))

    const row = await db.preTradeGateLog.create({
      data: {
        userId: user.id, mode,
        symbol: candidate.symbol, side: candidate.side,
        entry: candidate.entry, stop: candidate.stop, target: candidate.target,
        rr: snapshot.signal.reward_to_risk,
        decision: verdict?.decision ?? 'ERROR',
        confidenceScore: verdict?.confidenceScore ?? null,
        sizeMultiplier: verdict?.sizeMultiplier ?? null,
        sessionTag: ctx.session,
        minutesToClose: ctx.minutesToClose,
        spreadPct: snapshot.microstructure.spread_pct_of_price,
        spreadAtrPct: snapshot.microstructure.spread_pct_of_atr,
        spreadToStop: snapshot.microstructure.spread_to_stop_ratio,
        rvol: snapshot.microstructure.rvol,
        htfAlignment: ctx.htfAlignment,
        dailyDrawdown: ctx.dailyDrawdownPct != null ? Number(ctx.dailyDrawdownPct.toFixed(2)) : null,
        openPositions: ctx.openPositions,
        guardrails: guardrails.length > 0
          ? JSON.stringify({ injected: guardrails.map(({ rule_id, source_id, condition }) => ({ rule_id, source_id, condition })), cited })
          : null,
        rationale: verdict?.rationale ?? null,
        planId,
        error: errorNote,
        candidateJson: JSON.stringify(snapshot),
        responseJson: verdict ? JSON.stringify({ verdict, citedDetail }) : null,
      },
    })

    // prune (best-effort): keep the newest LOG_KEEP rows per user
    try {
      const keep = await db.preTradeGateLog.findMany({
        where: { userId: user.id }, orderBy: { createdAt: 'desc' }, skip: LOG_KEEP, select: { id: true },
      })
      if (keep.length > 0) await db.preTradeGateLog.deleteMany({ where: { id: { in: keep.map((k) => k.id) } } })
    } catch { /* pruning is best-effort */ }

    return NextResponse.json({
      ok: true, logId: row.id, mode,
      verdict: verdict ?? null,
      error: errorNote,
      guardrailsDetail: citedDetail,
      quotesOk,
    })
  } catch (e) {
    return handleError(e)
  }
}

// --- GET: recent evaluations + stats + gatekeeper audit -----------------------

export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))

    const logs = await db.preTradeGateLog.findMany({
      where: { userId: user.id, mode },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })

    const since = new Date(Date.now() - 30 * 86_400_000)
    const recent = await db.preTradeGateLog.findMany({
      where: { userId: user.id, mode, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { decision: true, guardrails: true },
    })

    const stats = {
      total: recent.length,
      approve: recent.filter((r) => r.decision === 'APPROVE').length,
      reduced: recent.filter((r) => r.decision === 'APPROVE_REDUCED_SIZE').length,
      reject: recent.filter((r) => r.decision === 'REJECT').length,
      error: recent.filter((r) => r.decision === 'ERROR').length,
    }

    // citation frequency — which guardrails actually fire on live candidates
    const citationCount = new Map<string, { id: string; condition: string; count: number }>()
    for (const r of recent) {
      const inj = injectedRules(r.guardrails)
      for (const id of citedIds(r.guardrails)) {
        const hit = inj.find((x) => x.rule_id === id)
        const key = hit?.condition ?? id
        const cur = citationCount.get(key) ?? { id, condition: hit?.condition ?? id, count: 0 }
        cur.count++
        citationCount.set(key, cur)
      }
    }
    const topCited = [...citationCount.values()].sort((a, b) => b.count - a.count).slice(0, 5)

    // the gatekeeper audit — shadow outcomes of vetoed plans (24h review)
    const vetoed = await db.aiTradePlan.findMany({
      where: { userId: user.id, gateVeto: true },
      orderBy: { closedAt: 'desc' },
      take: 60,
      select: { id: true, symbol: true, side: true, outcome: true, resolvedAt: true, statusNote: true, closedAt: true },
    })
    const graded = vetoed.filter((v) => v.outcome != null)
    const gateAudit = {
      vetoed: vetoed.length,
      graded: graded.length,
      goodWait: graded.filter((v) => v.outcome === 'good-wait').length,
      missedRun: graded.filter((v) => v.outcome === 'missed-run').length,
      neutral: graded.filter((v) => v.outcome === 'neutral').length,
      // ≥5 graded samples and a majority of missed-runs → the guardrail is
      // possibly too strict (the loop that prevents the gate from choking off
      // all trade volume)
      tooStrict: graded.length >= 5 && graded.filter((v) => v.outcome === 'missed-run').length / graded.length > 0.5,
      recent: vetoed.slice(0, 8).map((v) => ({
        symbol: v.symbol, side: v.side, outcome: v.outcome, resolved: v.resolvedAt != null, note: v.statusNote,
      })),
    }

    return NextResponse.json({
      mode,
      stats,
      topCited,
      gateAudit,
      logs: logs.map((r) => ({
        id: r.id, symbol: r.symbol, side: r.side, decision: r.decision,
        confidenceScore: r.confidenceScore, sizeMultiplier: r.sizeMultiplier,
        sessionTag: r.sessionTag, spreadPct: r.spreadPct, rvol: r.rvol,
        htfAlignment: r.htfAlignment, rationale: r.rationale, error: r.error,
        planId: r.planId, orderId: r.orderId, createdAt: r.createdAt.getTime(),
        cited: citedIds(r.guardrails),
      })),
    })
  } catch (e) {
    return handleError(e)
  }
}

// --- PATCH: attach the execution order id to an approved evaluation ----------

export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await req.json().catch(() => null)) as { id?: unknown; orderId?: unknown } | null
    const id = typeof body?.id === 'string' ? body.id : null
    const orderId = typeof body?.orderId === 'string' ? body.orderId.slice(0, 60) : null
    if (!id || !orderId) return NextResponse.json({ error: 'id and orderId required' }, { status: 400 })
    const row = await db.preTradeGateLog.findFirst({ where: { id, userId: user.id }, select: { id: true } })
    if (!row) return NextResponse.json({ error: 'log not found' }, { status: 404 })
    await db.preTradeGateLog.update({ where: { id }, data: { orderId } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}

// --- guardrails JSON helpers ---------------------------------------------------

function parsedGuardrails(json: string | null): { injected?: { rule_id: string; condition: string }[]; cited?: string[] } | null {
  if (!json) return null
  try {
    const j = JSON.parse(json)
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}
function citedIds(json: string | null): string[] {
  const p = parsedGuardrails(json)
  return Array.isArray(p?.cited) ? (p?.cited as string[]) : []
}
function injectedRules(json: string | null): { rule_id: string; condition: string }[] {
  const p = parsedGuardrails(json)
  return Array.isArray(p?.injected) ? (p?.injected as { rule_id: string; condition: string }[]) : []
}

function safeTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}
