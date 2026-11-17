import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode, isNoKeysError, isKeysUnreadableError, authBackoffMsLeft, type TradingOrder } from '@/lib/trading'
import { getBars, describeAlpacaKeys } from '@/lib/alpaca'
import { matchFifo } from '@/lib/trade-history'
import { db } from '@/lib/db'
import { handleError } from '@/lib/api-helpers'
import {
  AUDIT_BATCH_SIZE, AUDIT_SYSTEM_PROMPT, AUDIT_USER_TEMPLATE,
  classifySession, isExtendedLike, computeExcursions, atrAtEntry,
  volumeRatioAtEntry, slippageBps, excursionTimeframe, buildAuditBatches,
  parseAuditOutput, ruleDedupeKey,
  type EnrichedTrade,
} from '@/lib/trade-review'
import { llmChat } from '@/lib/llm'
import type { Bar } from '@/lib/market-types'

// v2.12.52 — STANDALONE LLM transport on the platform's BUILT-IN config (no
// vendor SDK, no new env keys): the user's own Settings → AI Agent endpoint
// when saved, otherwise the built-in EdgeZero lane (hard defaults — works in
// any fresh container out of the box). See src/lib/llm.ts for the lane order.
//
// v2.12.49 — AI TRADE REVIEW auditor. POST runs the full pipeline:
//   closed trades (FIFO) → enrichment (session / MAE-MFE vs ATR / slippage /
//   volume ratio, POINT-IN-TIME only) → LLM batches of 5-10 @ temp 0.15 →
//   strict JSON validation → TradeAuditBatch + TradeAudit + ReviewRule rows.
// GET returns the stored audit history (latest batches first).
//
// Guardrails: one run at a time per user+mode (in-memory lock); batches that
// fail (LLM/parse) mark the run partial but never erase earlier successes;
// the auditor's output is validated so hallucinated trade ids, invented
// quadrants, unclamped scores, and off-vocabulary tags never reach the DB;
// no-keys accounts get the standard honest configured:false shape.

/** in-memory single-run lock per user+mode (module scope survives route
 *  invocations in the same server process — same pattern as widenMemo). */
const running = new Map<string, number>()
const RUNNING_STALE_MS = 6 * 60_000 // a crashed run must not wedge the lock
function runLocked(key: string): boolean {
  const at = running.get(key)
  return at != null && Date.now() - at < RUNNING_STALE_MS
}

// --- LLM call (same discipline as sentiment-score: queue + 429 backoff) ----
let llmQueue: Promise<void> = Promise.resolve()
const BATCH_GAP_MS = 600
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
function enqueueLlm<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(fn, fn)
  const gap = () => new Promise<void>((r) => setTimeout(r, BATCH_GAP_MS))
  llmQueue = run.then(gap, gap)
  return run
}

/** One auditor call @ temperature 0.15 (analytical consistency, per the audit
 *  spec) through the standalone llmChat transport. A provider that rejects the
 *  temperature PARAM falls back to its default rather than failing the run. */
async function callAuditor(userId: string, system: string, user: string): Promise<string> {
  return enqueueLlm(async () => {
    const msgs = [
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ]
    try {
      const completion = await llmChat({ userId, messages: msgs, temperature: 0.15 })
      return extractContent(completion)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/temperature/i.test(msg)) {
        const completion = await llmChat({ userId, messages: msgs })
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

// --- enrichment -------------------------------------------------------------

interface SymbolMeta { assetClass: string; rawSymbol: string }

/** Build the audit payload for one trade: session tags, excursions vs ATR,
 *  volume pulse, slippage — every field point-in-time. Bars failures degrade
 *  that field to null + an honest note; they never fail the run. */
function enrichTrade(
  t: {
    id: string; symbol: string; side: 'long' | 'short'; qty: number
    entryPrice: number; exitPrice: number; entryAt: string; exitAt: string
    pnl: number; pnlPct: number; durationMs: number
    source?: string; strategy?: string; reason?: unknown
  },
  meta: SymbolMeta,
  dailyBars: Bar[] | null,
  windowBars: Bar[] | null,
  entryOrder: TradingOrder | undefined,
  exitOrder: TradingOrder | undefined,
): EnrichedTrade {
  const entrySec = Math.floor(Date.parse(t.entryAt) / 1000)
  const exitSec = Math.floor(Date.parse(t.exitAt) / 1000)
  const entrySession = classifySession(t.entryAt, meta.assetClass)
  const exitSession = classifySession(t.exitAt, meta.assetClass)
  const heldExtended = isExtendedLike(entrySession) || isExtendedLike(exitSession) || exitSec - entrySec > 12 * 3600

  const atr = dailyBars ? atrAtEntry(dailyBars, entrySec) : null
  const exc = windowBars && Number.isFinite(entrySec) && Number.isFinite(exitSec)
    ? computeExcursions(windowBars, entrySec, exitSec, t.side, t.entryPrice, atr)
    : null
  const volRatio = windowBars && Number.isFinite(entrySec) ? volumeRatioAtEntry(windowBars, entrySec) : null

  const entrySlip = entryOrder
    ? slippageBps(t.entryPrice, entryOrder.limit_price, entryOrder.side === 'sell' ? 'sell' : 'buy')
    : null
  const exitSlip = exitOrder
    ? slippageBps(t.exitPrice, exitOrder.limit_price, exitOrder.side === 'sell' ? 'sell' : 'buy')
    : null

  return {
    trade_id: t.id,
    symbol: t.symbol,
    asset_class: meta.assetClass || 'us_equity',
    side: t.side,
    qty: t.qty,
    source: t.source ?? 'manual',
    ...(t.strategy ? { strategy: t.strategy } : {}),
    entry_time: t.entryAt,
    exit_time: t.exitAt,
    held_minutes: Math.max(0, Math.round(t.durationMs / 60_000)),
    entry_price: t.entryPrice,
    exit_price: t.exitPrice,
    pnl: Number(t.pnl.toFixed(2)),
    pnl_pct: Number(t.pnlPct.toFixed(2)),
    entry_session: entrySession,
    exit_session: exitSession,
    held_extended: heldExtended,
    excursions: exc
      ? {
          mae: Number(exc.mae.toFixed(4)), mae_pct: Number(exc.maePct.toFixed(3)),
          mfe: Number(exc.mfe.toFixed(4)), mfe_pct: Number(exc.mfePct.toFixed(3)),
          mae_atr: exc.maeAtr != null ? Number(exc.maeAtr.toFixed(2)) : null,
          mfe_atr: exc.mfeAtr != null ? Number(exc.mfeAtr.toFixed(2)) : null,
        }
      : null,
    excursion_note: exc ? null : 'excursions unavailable (no intraday bars for the window) — judge on execution metrics only',
    atr: atr != null && t.entryPrice > 0
      ? { value: Number(atr.toFixed(4)), pct: Number(((atr / t.entryPrice) * 100).toFixed(3)) }
      : null,
    volume_ratio: volRatio != null ? Number(volRatio.toFixed(2)) : null,
    slippage: entrySlip != null || exitSlip != null
      ? {
          entry_bps: entrySlip != null ? Number(entrySlip.toFixed(1)) : null,
          exit_bps: exitSlip != null ? Number(exitSlip.toFixed(1)) : null,
        }
      : null,
    reason: typeof t.reason === 'string' ? t.reason.slice(0, 120) : '',
  }
}

// --- GET: stored audit history ----------------------------------------------
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))

    const batches = await db.tradeAuditBatch.findMany({
      where: { userId: user.id, mode },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { audits: { orderBy: { createdAt: 'asc' }, take: 60 } },
    })
    return NextResponse.json({ mode, batches, running: runLocked(`${user.id}:${mode}`) })
  } catch (e) {
    return handleError(e)
  }
}

// --- POST: run the audit -----------------------------------------------------
export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await req.json().catch(() => ({}))) as { mode?: string; limit?: number }
    const mode = await resolveTradeMode(user.id, body.mode)

    const lockKey = `${user.id}:${mode}`
    if (runLocked(lockKey)) {
      return NextResponse.json(
        { error: 'An audit run is already in progress for this account — wait for it to finish.' },
        { status: 409 },
      )
    }
    running.set(lockKey, Date.now())

    try {
      const limitRaw = Number(body.limit)
      const limit = [12, 24, 36].includes(limitRaw) ? limitRaw : 24

      // 1) pull the recent closed-orders tape (page 1 — audits work on the
      //    most recent round-trips; ghost-widening is a history-display concern)
      const r = await getClosedOrders(user.id, mode, 500)
      if (!r.data) {
        if (isNoKeysError(r.error)) {
          return NextResponse.json({ mode, configured: false, error: 'No Alpaca keys configured — trade review needs closed trades to audit.' })
        }
        if (isKeysUnreadableError(r.error)) {
          const keysDesc = await describeAlpacaKeys(user.id, mode)
          return NextResponse.json({ mode, configured: true, error: `Saved keys couldn't be decrypted — trade review unavailable until re-entered. [using ${keysDesc}]` })
        }
        if (r.status === 401) {
          const retryInSec = Math.ceil(authBackoffMsLeft(user.id, mode) / 1000)
          const keysDesc = await describeAlpacaKeys(user.id, mode)
          return NextResponse.json({ mode, configured: true, error: `Keys rejected by Alpaca — trade review unavailable. [using ${keysDesc}] Next attempt in ~${retryInSec}s.`, retryInSec })
        }
        return NextResponse.json({ mode, error: r.error || 'Closed orders fetch failed' }, { status: r.status || 502 })
      }
      const orderList = Array.isArray(r.data) ? r.data : []
      if (orderList.length === 0) {
        return NextResponse.json({ mode, configured: true, error: 'No closed orders yet — place and close a trade first, then run the audit.' })
      }

      const fm = matchFifo(orderList, 1000)
      const byId = new Map<string, TradingOrder>()
      for (const o of orderList) byId.set(o.id, o)
      for (const o of orderList) for (const leg of o.legs ?? []) if (!byId.has(leg.id)) byId.set(leg.id, leg)

      // newest-first, deduped by id, capped to the requested window
      const trades = [...fm.trades]
        .sort((a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt))
        .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
        .slice(0, limit)
      if (trades.length === 0) {
        return NextResponse.json({ mode, configured: true, error: 'No completed round-trip trades in the recent window — nothing to audit yet.' })
      }

      // 2) enrichment — bars per symbol (daily for ATR, intraday per trade window)
      const metaByDisplay = new Map<string, SymbolMeta>()
      for (const o of orderList) {
        if (!metaByDisplay.has(o.symbol)) {
          metaByDisplay.set(o.symbol, { assetClass: o.asset_class === 'crypto' ? 'crypto' : 'us_equity', rawSymbol: o.symbol })
        }
      }
      const dailyBySymbol = new Map<string, Bar[] | null>()
      const windowByTrade = new Map<string, Bar[] | null>()
      const symbols = [...new Set(trades.map((t) => t.symbol))]

      await Promise.all(symbols.map(async (sym) => {
        try {
          const meta = metaByDisplay.get(sym)
          const raw = meta?.rawSymbol ?? sym
          const entries = trades.filter((t) => t.symbol === sym).map((t) => Date.parse(t.entryAt)).filter(Number.isFinite)
          const earliestEntry = entries.length > 0 ? Math.min(...entries) : Date.now()
          const lookbackDays = Math.min(180, Math.ceil((Date.now() - earliestEntry) / 86_400_000) + 40)
          const daily = await getBars(raw, '1D', user.id, { lookbackDays }).catch(() => null)
          dailyBySymbol.set(sym, daily && !daily.demo && daily.bars.length > 0 ? daily.bars : null)
        } catch {
          dailyBySymbol.set(sym, null)
        }
      }))

      await Promise.all(trades.map(async (t) => {
        try {
          const meta = metaByDisplay.get(t.symbol)
          const raw = meta?.rawSymbol ?? t.symbol
          const tf = excursionTimeframe(t.durationMs)
          const startSec = Math.floor(Date.parse(t.entryAt) / 1000)
          const endSec = Math.floor(Date.parse(t.exitAt) / 1000)
          const windowDays = Math.max(1, Math.ceil((endSec - startSec) / 86_400) + 1)
          const before = endSec > Math.floor(Date.now() / 1000) - 60 ? undefined : endSec
          const res = await getBars(raw, tf, user.id, { lookbackDays: windowDays, before }).catch(() => null)
          let bars: Bar[] | null = res && !res.demo && res.bars.length > 0 ? res.bars : null
          if (bars) {
            bars = bars.filter((b) => b.time >= startSec - 3 * 3600 && b.time <= endSec + 3600)
            if (bars.length === 0) bars = null
          }
          windowByTrade.set(t.id, bars)
        } catch {
          windowByTrade.set(t.id, null)
        }
      }))

      const enriched: EnrichedTrade[] = trades.map((t) => {
        const meta = metaByDisplay.get(t.symbol) ?? { assetClass: 'us_equity', rawSymbol: t.symbol }
        return enrichTrade(
          t, meta,
          dailyBySymbol.get(t.symbol) ?? null,
          windowByTrade.get(t.id) ?? null,
          byId.get(t.entryOrderId),
          byId.get(t.exitOrderIds[t.exitOrderIds.length - 1] ?? ''),
        )
      })

      // 3) LLM batches — sequential (queue), one DB batch row per run
      const batches = buildAuditBatches(enriched, AUDIT_BATCH_SIZE)
      const batchRow = await db.tradeAuditBatch.create({
        data: { userId: user.id, mode, status: 'ok', tradeCount: enriched.length },
      })

      let okBatches = 0
      let auditRows = 0
      let patternRows = 0
      let ruleRows = 0
      const failures: string[] = []
      const patternsCollected: { pattern_description: string; frequency_in_batch: number; estimated_pnl_impact: string }[] = []

      for (let i = 0; i < batches.length; i++) {
        const b = batches[i]
        const validIds = new Set(b.map((e) => e.trade_id))
        try {
          const content = await callAuditor(user.id, AUDIT_SYSTEM_PROMPT, AUDIT_USER_TEMPLATE(JSON.stringify(b, null, 1)))
          const parsed = parseAuditOutput(content, validIds)
          if (!parsed) throw new Error('auditor returned unparseable output')
          const dropped = b.length - parsed.audits.length
          if (dropped > 0) failures.push(`batch ${i + 1}: ${dropped} audit row(s) dropped (invalid or unknown trade_id)`)
          if (parsed.audits.length > 0) {
            await db.tradeAudit.createMany({
              data: parsed.audits.map((a) => {
                const src = b.find((e) => e.trade_id === a.trade_id)
                return {
                  batchId: batchRow.id, userId: user.id, mode,
                  tradeKey: `${mode}:${a.trade_id}`,
                  symbol: src?.symbol ?? a.symbol,
                  side: src?.side ?? 'long',
                  quadrant: a.quadrant, score: a.execution_score,
                  pnl: src?.pnl ?? 0, pnlPct: src?.pnl_pct ?? 0,
                  maePct: src?.excursions?.mae_pct ?? null,
                  mfePct: src?.excursions?.mfe_pct ?? null,
                  maeAtr: src?.excursions?.mae_atr ?? null,
                  mfeAtr: src?.excursions?.mfe_atr ?? null,
                  entrySession: src?.entry_session ?? null,
                  exitSession: src?.exit_session ?? null,
                  heldMinutes: src?.held_minutes ?? null,
                  diagnosis: a.mae_mfe_diagnosis,
                  sessionImpact: a.session_impact,
                  rootCause: a.root_cause,
                  rawJson: JSON.stringify({ trade: src ?? null, audit: a }),
                }
              }),
            })
            auditRows += parsed.audits.length
          }
          if (parsed.patterns.length > 0) {
            patternsCollected.push(...parsed.patterns)
            patternRows += parsed.patterns.length
          }
          for (const rule of parsed.rules) {
            const key = ruleDedupeKey(rule.condition, rule.action)
            const existing = await db.reviewRule.findFirst({
              where: { userId: user.id, dedupeKey: key, status: { in: ['candidate', 'active'] } },
            })
            if (existing) {
              await db.reviewRule.update({
                where: { id: existing.id },
                data: {
                  frequency: { increment: 1 },
                  lastSeenAt: new Date(),
                  lastBatchId: batchRow.id,
                  confidence: rule.confidence,
                  tags: JSON.stringify(rule.tags),
                  ...(rule.action !== existing.action ? { action: rule.action } : {}),
                },
              })
            } else {
              await db.reviewRule.create({
                data: {
                  userId: user.id, dedupeKey: key,
                  condition: rule.condition, action: rule.action,
                  confidence: rule.confidence,
                  tags: JSON.stringify(rule.tags),
                  status: 'candidate',
                  lastBatchId: batchRow.id,
                },
              })
              ruleRows++
            }
          }
          okBatches++
        } catch (e) {
          failures.push(`batch ${i + 1}: ${e instanceof Error ? e.message : 'LLM call failed'}`)
        }
        await sleep(150) // pace the backend
      }

      await db.tradeAuditBatch.update({
        where: { id: batchRow.id },
        data: {
          status: okBatches === batches.length ? 'ok' : okBatches > 0 ? 'partial' : 'failed',
          patternCount: patternRows,
          ruleCount: ruleRows,
          note: failures.length > 0 ? failures.join(' · ').slice(0, 900) : null,
          patternsJson: patternsCollected.length > 0 ? JSON.stringify(patternsCollected.slice(0, 24)) : null,
        },
      })

      // prune: keep the newest 10 batches per user+mode (cascade deletes audits)
      try {
        const old = await db.tradeAuditBatch.findMany({
          where: { userId: user.id, mode },
          orderBy: { createdAt: 'desc' },
          skip: 10,
          select: { id: true },
        })
        if (old.length > 0) {
          await db.tradeAuditBatch.deleteMany({ where: { id: { in: old.map((x) => x.id) } } })
        }
      } catch { /* pruning is best-effort */ }

      return NextResponse.json({
        mode, configured: true,
        batchId: batchRow.id,
        status: okBatches === batches.length ? 'ok' : okBatches > 0 ? 'partial' : 'failed',
        trades: enriched.length, batches: batches.length, okBatches,
        audits: auditRows, patterns: patternRows, rules: ruleRows,
        failures: failures.length > 0 ? failures : undefined,
      })
    } finally {
      running.delete(lockKey)
    }
  } catch (e) {
    return handleError(e)
  }
}
