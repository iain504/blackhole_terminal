import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser, UnauthorizedError } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'
import {
  backfillLegacyLessons,
  LESSONS_CAP,
  normalizeLessonText,
  trimAiStewardLessons,
} from '@/lib/ai-steward-lessons'

export const dynamic = 'force-dynamic'

// /api/ai-steward/lessons (v2.12.26) — the AI 護倉's PERMANENT memory
// ("記取的教訓（餵回每輪檢視）"). The ask: lessons distilled from today's
// closed trades must be remembered permanently, not purged with the audit
// trail. This table (AiStewardLesson) is never retention-pruned:
//   GET    — the memory list (plus a one-time-ish backfill of legacy lesson
//            audit rows that predate this table), newest-reinforced first.
//            The engine feeds the top slice back into every review cycle.
//   POST   — add/reinforce lessons (upsert by text; re-observation bumps
//            lastSeenAt) — used by tests/tools; the engine's lessons arrive
//            via the events POST which mirrors them here.
//   DELETE — ?id=<row> curates one lesson away, or ?all=1 wipes the memory.
// Bounded: LESSONS_CAP (300) per user — never-reinforced oldest rows go first.

const GET_LIMIT = 300

export async function GET() {
  try {
    const user = await requireUser()
    // legacy lesson audit rows predate this table — copy them in (idempotent)
    try { await backfillLegacyLessons(user.id) } catch { /* non-fatal */ }
    const lessons = await db.aiStewardLesson.findMany({
      where: { userId: user.id },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: GET_LIMIT,
    })
    return NextResponse.json({ lessons, cap: LESSONS_CAP })
  } catch (e) {
    return handleError(e)
  }
}

interface PostBody {
  lessons?: unknown[]
}

export async function POST(req: Request) {
  let user
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    throw e
  }
  try {
    const rl = await rateLimit(`ai-steward-lessons:${user.id}`, 30, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many requests — retry in ${rl.retryAfterSec}s.` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }
    const body = (await readJsonSafe(req)) as PostBody | null
    const texts = (Array.isArray(body?.lessons) ? body!.lessons : [])
      .map(normalizeLessonText)
      .filter((t): t is string => t !== null)
      .slice(0, 10)
    for (const text of texts) {
      await db.aiStewardLesson.upsert({
        where: { userId_text: { userId: user.id, text } },
        create: { userId: user.id, text },
        update: { lastSeenAt: new Date() },
      })
    }
    const trimmed = await trimAiStewardLessons(user.id)
    const lessons = await db.aiStewardLesson.findMany({
      where: { userId: user.id },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: GET_LIMIT,
    })
    return NextResponse.json({ ok: true, stored: texts.length, trimmed, lessons })
  } catch (e) {
    return handleError(e)
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const all = url.searchParams.get('all')
    if (all) {
      const r = await db.aiStewardLesson.deleteMany({ where: { userId: user.id } })
      return NextResponse.json({ ok: true, deleted: r.count, lessons: [] })
    }
    if (id) {
      // scoped to the owner — a foreign id simply deletes nothing
      const r = await db.aiStewardLesson.deleteMany({ where: { userId: user.id, id } })
      return NextResponse.json({ ok: true, deleted: r.count })
    }
    return NextResponse.json({ error: '缺少 id 或 all 參數' }, { status: 400 })
  } catch (e) {
    return handleError(e)
  }
}
