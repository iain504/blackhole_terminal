import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser, UnauthorizedError } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'
import { trimAiStewardLessons } from '@/lib/ai-steward-lessons'

export const dynamic = 'force-dynamic'

// /api/ai-steward/events — audit trail for the AI 護倉 (portfolio steward)
// engine (v2.12.22). The client engine executes validated actions against the
// broker routes, then POSTs every action/lesson/summary here; GET feeds the
// panel (and the engine's cross-reload 記憶). Pruning happens inside POST:
// rows older than the retention window are deleted and a hard per-user cap
// bounds the table — "stored in db and purged periodically to save space".
// v2.12.26 — lesson rows are MIRRORED into the permanent AiStewardLesson
// table before the prune runs, so distilled lessons survive the retention
// window and the cap (the audit row still ages out; the memory never does).
const KINDS = new Set(['position', 'order', 'lesson', 'cycle', 'error'])
const STATUSES = new Set(['executed', 'skipped', 'failed', 'dry_run', 'stored'])
const MAX_PER_POST = 40
const PER_USER_CAP = 400
const DEFAULT_PURGE_DAYS = 14
const MIN_PURGE_DAYS = 3
const MAX_PURGE_DAYS = 60
const GET_LIMIT = 120

const clampInt = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d
}

// GET — the user's latest events (newest first) for the panel + engine memory.
export async function GET() {
  try {
    const user = await requireUser()
    const events = await db.aiStewardEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: GET_LIMIT,
    })
    return NextResponse.json({ events })
  } catch (e) {
    return handleError(e)
  }
}

interface PostBody {
  events?: unknown[]
  purgeDays?: unknown
}

// POST — record a batch of steward events, then prune (retention window +
// per-user cap) and return the fresh event list so the panel stays in sync.
export async function POST(req: Request) {
  let user
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    throw e
  }
  try {
    const rl = await rateLimit(`ai-steward:${user.id}`, 12, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many requests — retry in ${rl.retryAfterSec}s.` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    const body = (await readJsonSafe(req)) as PostBody | null
    const purgeDays = clampInt(body?.purgeDays, DEFAULT_PURGE_DAYS, MIN_PURGE_DAYS, MAX_PURGE_DAYS)

    const rows = (Array.isArray(body?.events) ? body!.events : [])
      .slice(0, MAX_PER_POST)
      .map((raw): Record<string, unknown> | null => {
        if (!raw || typeof raw !== 'object') return null
        const e = raw as Record<string, unknown>
        const kind = String(e.kind ?? '')
        const status = String(e.status ?? '')
        const detail = String(e.detail ?? '').trim().slice(0, 300)
        if (!KINDS.has(kind) || !STATUSES.has(status) || !detail) return null
        const symbol = e.symbol ? String(e.symbol).slice(0, 20) : null
        const action = String(e.action ?? '').slice(0, 30) || 'note'
        const payload =
          e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)
            ? (e.payload as Record<string, unknown>)
            : undefined
        return { userId: user.id, kind, action, symbol, status, detail, payload }
      })
      .filter((r): r is Record<string, unknown> => r !== null)

    if (rows.length > 0) {
      await db.aiStewardEvent.createMany({ data: rows as Prisma.AiStewardEventCreateManyInput[] })
      // v2.12.26 — mirror lesson rows into the PERMANENT memory table before
      // the prune below: same text re-observed bumps lastSeenAt (reinforced),
      // new texts are added. The audit rows above still age out; these don't.
      const lessonRows = rows.filter((r) => r.kind === 'lesson') as { detail?: string }[]
      for (const lr of lessonRows) {
        const text = String(lr.detail ?? '').trim()
        if (!text) continue
        await db.aiStewardLesson.upsert({
          where: { userId_text: { userId: user.id, text } },
          create: { userId: user.id, text },
          update: { lastSeenAt: new Date() },
        })
      }
      await trimAiStewardLessons(user.id)
    }

    // ---- prune to save space ------------------------------------------------
    // 1) retention window: everything older than purgeDays goes
    const cutoff = new Date(Date.now() - purgeDays * 86_400_000)
    const prunedOld = await db.aiStewardEvent.deleteMany({
      where: { userId: user.id, createdAt: { lt: cutoff } },
    })
    // 2) hard cap: keep only the newest PER_USER_CAP rows
    let prunedCap = 0
    const keep = await db.aiStewardEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: PER_USER_CAP,
      select: { id: true },
    })
    if (keep.length >= PER_USER_CAP) {
      const r = await db.aiStewardEvent.deleteMany({
        where: { userId: user.id, id: { notIn: keep.map((k) => k.id) } },
      })
      prunedCap = r.count
    }

    const events = await db.aiStewardEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: GET_LIMIT,
    })
    return NextResponse.json({
      ok: true,
      stored: rows.length,
      pruned: prunedOld.count + prunedCap,
      purgeDays,
      events,
    })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE — manual wipe (panel 「清除記錄」 button): everything for this user.
export async function DELETE() {
  try {
    const user = await requireUser()
    const r = await db.aiStewardEvent.deleteMany({ where: { userId: user.id } })
    return NextResponse.json({ ok: true, deleted: r.count, events: [] })
  } catch (e) {
    return handleError(e)
  }
}
