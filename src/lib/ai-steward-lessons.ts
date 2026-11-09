import { db } from '@/lib/db'

// v2.12.26 — shared server helpers for the AI 護倉 PERMANENT lesson memory.
//
// The ask: "need to remember 記取的教訓（餵回每輪檢視） permanently". Lessons
// used to live only as AiStewardEvent rows, which are pruned by the retention
// window (3–60 days) and a hard 400-row cap — so the steward's distilled
// memory evaporated after a few days. They now ALSO live in AiStewardLesson,
// a dedicated table that is NEVER retention-purged: re-observed lessons bump
// lastSeenAt, and only a generous cap (300) trims the oldest never-reinforced
// rows so the table stays bounded while effectively permanent.

/** Hard per-user cap on stored lessons (oldest-by-lastSeenAt fall off first). */
export const LESSONS_CAP = 300

/** Server-side text bound for a lesson (the engine already slices to 160). */
export const LESSON_MAX_LEN = 200

export function normalizeLessonText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/\s+/g, ' ').slice(0, LESSON_MAX_LEN)
  return text.length > 0 ? text : null
}

/** Keep the per-user lesson table within LESSONS_CAP (oldest-never-reinforced
 *  first to go). Cheap: a count + one deleteMany when over the cap. */
export async function trimAiStewardLessons(userId: string): Promise<number> {
  const keep = await db.aiStewardLesson.findMany({
    where: { userId },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    take: LESSONS_CAP,
    select: { id: true },
  })
  if (keep.length < LESSONS_CAP) return 0
  const r = await db.aiStewardLesson.deleteMany({
    where: { userId, id: { notIn: keep.map((k) => k.id) } },
  })
  return r.count
}

/** One-time-ish backfill: lesson-kind AUDIT rows that predate the permanent
 *  table are copied into it (idempotent — the (userId,text) unique constraint
 *  skips duplicates, so re-running never doubles lessons). Called from the
 *  lessons GET; legacy rows eventually age out of the audit trail, the memory
 *  copy does not. */
export async function backfillLegacyLessons(userId: string): Promise<number> {
  const legacy = await db.aiStewardEvent.findMany({
    where: { userId, kind: 'lesson' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { detail: true, createdAt: true },
  })
  // per-row upsert (idempotent via the (userId,text) unique constraint —
  // createMany+skipDuplicates is not emitted for SQLite by this Prisma build);
  // create keeps the legacy first-learned time, update is a no-op
  let created = 0
  const seen = new Set<string>()
  for (const e of legacy) {
    const text = normalizeLessonText(e.detail)
    if (!text || seen.has(text)) continue
    seen.add(text)
    const row = await db.aiStewardLesson.findUnique({
      where: { userId_text: { userId, text } },
      select: { id: true },
    })
    if (!row) {
      await db.aiStewardLesson.create({ data: { userId, text, createdAt: e.createdAt, lastSeenAt: e.createdAt } })
      created++
    }
  }
  return created
}
