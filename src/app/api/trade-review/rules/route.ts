import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { handleError } from '@/lib/api-helpers'
import {
  CONSOLIDATE_SYSTEM_PROMPT, CONSOLIDATE_USER_TEMPLATE,
  rankCandidates, parseAuditOutput,
  type ParsedRule,
} from '@/lib/trade-review'

// v2.12.49 — Trade-review RULE lifecycle (closing the loop). The auditor
// stores CANDIDATE guardrails; this route promotes/discards them one by one
// and runs the WEEKLY-STYLE CONSOLIDATION: the model merges the candidate
// pool + current actives into a fresh ACTIVE list capped at 5-7 rules, old
// actives retire. A deterministic ranking fallback (confidence × frequency ×
// recency) applies when the LLM pass fails — the loop never deadlocks.
// GET ?active=1 → only ACTIVE rules (the steward's injection source),
// otherwise every rule (the panel's view).

const ACTIVE_CAP = 7

// same LLM plumbing as the audit route (queue + temperature fallback)
let llmQueue: Promise<void> = Promise.resolve()
function enqueueLlm<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(fn, fn)
  const gap = () => new Promise<void>((r) => setTimeout(r, 600))
  llmQueue = run.then(gap, gap)
  return run
}
let zaiPromise: Promise<unknown> | null = null
async function getZai() {
  if (!zaiPromise) {
    zaiPromise = (async () => {
      const mod = await import('z-ai-web-dev-sdk')
      const ZAI = (mod as unknown as { default: unknown }).default ?? (mod as unknown)
      return await (ZAI as { create(): Promise<unknown> }).create()
    })()
  }
  return zaiPromise
}
type ChatSdk = { chat: { completions: { create: (o: Record<string, unknown>) => Promise<unknown> } } }
function extractContent(completion: unknown): string {
  const content = (completion as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) throw new Error('empty LLM response')
  return content
}

async function callConsolidator(system: string, user: string): Promise<string> {
  return enqueueLlm(async () => {
    const zai = (await getZai()) as ChatSdk
    const msgs = [
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ]
    try {
      return extractContent(await zai.chat.completions.create({ messages: msgs, temperature: 0.2, thinking: { type: 'disabled' } }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/temperature/i.test(msg)) {
        return extractContent(await zai.chat.completions.create({ messages: msgs, thinking: { type: 'disabled' } }))
      }
      throw e
    }
  })
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const activeOnly = searchParams.get('active') === '1'

    const rules = await db.reviewRule.findMany({
      where: { userId: user.id, ...(activeOnly ? { status: 'active' } : {}) },
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
      take: 60,
    })
    // newest-batch-first ordering within the same status; candidates first
    // (the panel's action queue), then actives, then retired/discarded.
    const rank = (s: string) => (s === 'candidate' ? 0 : s === 'active' ? 1 : 2)
    const sorted = [...rules].sort((a, b) => {
      const d = rank(a.status) - rank(b.status)
      if (d !== 0) return d
      return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
    })
    return NextResponse.json({ rules: sorted })
  } catch (e) {
    return handleError(e)
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await req.json().catch(() => ({}))) as { action?: string; ruleId?: string }
    const action = body.action

    if (action === 'promote' || action === 'discard' || action === 'retire') {
      const ruleId = typeof body.ruleId === 'string' ? body.ruleId : ''
      if (!ruleId) return NextResponse.json({ error: 'ruleId required' }, { status: 400 })
      const rule = await db.reviewRule.findFirst({ where: { id: ruleId, userId: user.id } })
      if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
      if (action === 'promote') {
        // promoting one more onto a full board retires the lowest-ranked active
        const actives = await db.reviewRule.findMany({ where: { userId: user.id, status: 'active' } })
        if (actives.length >= ACTIVE_CAP && !actives.some((a) => a.id === rule.id)) {
          const worst = rankCandidates(actives.filter((a) => a.id !== rule.id)).slice(-1)[0]
          if (worst) {
            await db.reviewRule.update({ where: { id: worst.id }, data: { status: 'retired', retiredAt: new Date() } })
          }
        }
        await db.reviewRule.update({ where: { id: rule.id }, data: { status: 'active', promotedAt: new Date(), retiredAt: null } })
        return NextResponse.json({ ok: true, status: 'active' })
      }
      if (action === 'discard') {
        await db.reviewRule.update({ where: { id: rule.id }, data: { status: 'discarded' } })
        return NextResponse.json({ ok: true, status: 'discarded' })
      }
      await db.reviewRule.update({ where: { id: rule.id }, data: { status: 'retired', retiredAt: new Date() } })
      return NextResponse.json({ ok: true, status: 'retired' })
    }

    if (action === 'consolidate') {
      const candidates = await db.reviewRule.findMany({ where: { userId: user.id, status: 'candidate' } })
      const actives = await db.reviewRule.findMany({ where: { userId: user.id, status: 'active' } })
      if (candidates.length === 0 && actives.length === 0) {
        return NextResponse.json({ ok: true, error: 'No candidate or active rules to consolidate yet — run an audit first.', active: [] })
      }
      const topCandidates = rankCandidates(candidates).slice(0, 12)
      const candJson = JSON.stringify(topCandidates.map((r) => ({
        rule_id: r.id, condition: r.condition, action: r.action,
        confidence: r.confidence, tags: JSON.parse(r.tags || '[]'), frequency: r.frequency,
      })), null, 1)
      const actJson = JSON.stringify(actives.map((r) => ({
        rule_id: r.id, condition: r.condition, action: r.action,
        confidence: r.confidence, tags: JSON.parse(r.tags || '[]'),
      })), null, 1)

      let nextRules: ParsedRule[] | null = null
      let via = 'llm'
      try {
        const content = await callConsolidator(CONSOLIDATE_SYSTEM_PROMPT, CONSOLIDATE_USER_TEMPLATE(candJson, actJson))
        // reuse the auditor's strict parser: rule rows only (no audits/patterns)
        const parsed = parseAuditOutput(content, new Set())
        if (parsed && parsed.rules.length > 0) nextRules = parsed.rules.slice(0, ACTIVE_CAP)
      } catch { /* fall through to deterministic */ }

      if (!nextRules || nextRules.length === 0) {
        // deterministic fallback: merged actives + top-ranked candidates, capped
        const keepActives: ParsedRule[] = actives.map((r) => ({
          rule_id: r.id, condition: r.condition, action: r.action,
          confidence: (['HIGH', 'MEDIUM', 'LOW'].includes(r.confidence) ? r.confidence : 'MEDIUM') as ParsedRule['confidence'],
          tags: JSON.parse(r.tags || '[]'),
        }))
        nextRules = [...keepActives, ...rankCandidates(topCandidates).map((r) => ({
          rule_id: r.id, condition: r.condition, action: r.action,
          confidence: (['HIGH', 'MEDIUM', 'LOW'].includes(r.confidence) ? r.confidence : 'MEDIUM') as ParsedRule['confidence'],
          tags: JSON.parse(r.tags || '[]'),
        }))].slice(0, ACTIVE_CAP)
        via = 'deterministic'
      }

      const now = new Date()
      const nextIds = new Set(nextRules.map((r) => r.rule_id))
      // retire every active that did not survive consolidation
      for (const a of actives) {
        if (!nextIds.has(a.id)) {
          await db.reviewRule.update({ where: { id: a.id }, data: { status: 'retired', retiredAt: now } })
        }
      }
      // upsert the consolidated set as ACTIVE (rule_id echoes an existing id
      // or a fresh composite — the parser caps/gates everything already)
      for (const r of nextRules) {
        const existing = await db.reviewRule.findFirst({ where: { id: r.rule_id, userId: user.id } })
        if (existing) {
          await db.reviewRule.update({
            where: { id: existing.id },
            data: {
              condition: r.condition, action: r.action, confidence: r.confidence,
              tags: JSON.stringify(r.tags), status: 'active',
              promotedAt: existing.promotedAt ?? now, retiredAt: null, lastSeenAt: now,
            },
          })
        } else {
          await db.reviewRule.create({
            data: {
              userId: user.id,
              dedupeKey: r.condition.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120),
              condition: r.condition, action: r.action, confidence: r.confidence,
              tags: JSON.stringify(r.tags), status: 'active', promotedAt: now, lastSeenAt: now,
            },
          })
        }
      }
      const active = await db.reviewRule.findMany({ where: { userId: user.id, status: 'active' } })
      return NextResponse.json({ ok: true, via, active })
    }

    return NextResponse.json({ error: 'Unknown action — use promote | discard | retire | consolidate' }, { status: 400 })
  } catch (e) {
    return handleError(e)
  }
}
