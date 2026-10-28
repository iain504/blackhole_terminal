// Task 11-b — per-user rate limiting, now DB-PERSISTED.
//
// History: Task 3-d shipped a purely in-process fixed-window counter. The
// 2026 deep review (Task 11) flagged it: every restart wiped all brute-force
// counters, so `login` / `register` windows could be reset by bouncing the
// server. Buckets now live in the RateLimitBucket table (Prisma/SQLite,
// see schema.prisma) with the SAME call shape — only now async:
//
//   await rateLimit(key, max, windowMs) → { ok, retryAfterSec }
//   await resetRateLimit(key)
//
// Every call site is an async route handler, so the await is free. Semantics
// are unchanged fixed-window: the FIRST call in a window starts it; calls up
// to `max` pass; anything beyond returns ok:false with the whole seconds
// until the window resets.
//
// Resilience: if the DB errors (wedged SQLite, missing table), counting
// falls back to an in-process Map (same per-instance trust model as before)
// and emits ONE throttled structured warning so ops notices without spam.
// The fallback is intentional: rate limiting is a guard, not a correctness
// dependency — a storage outage must not brick auth flows.
//
// Pruning: at most once per 5 minutes, a fire-and-forget deleteMany() removes
// every row already past its window (indexed on resetAt). Keeps the table
// tiny forever without a cron job.

import { db } from '@/lib/db'
import { log } from '@/lib/logger'

export interface RateLimitResult {
  ok: boolean
  retryAfterSec: number
}

// ---- in-process fallback (also the pre-11-b behavior) ----------------------
interface Bucket {
  count: number
  resetAt: number
}

const g = globalThis as unknown as { __rateLimitBuckets?: Map<string, Bucket> }
const memoryBuckets: Map<string, Bucket> = (g.__rateLimitBuckets ??= new Map())

let lastFallbackAt = 0
function noteFallback(err: unknown): void {
  const now = Date.now()
  lastFallbackAt = now
  if (now - (g.__rateLimitFallbackWarnedAt ?? 0) < 60_000) return
  g.__rateLimitFallbackWarnedAt = now
  log.warn('rate_limit_db_fallback', { err: err instanceof Error ? err.message : String(err) })
}

/** Which store served the most recent call — surfaced by /api/health. */
export function rateLimitStore(): 'db' | 'memory' {
  return Date.now() - lastFallbackAt < 60_000 ? 'memory' : 'db'
}

function memoryLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const b = memoryBuckets.get(key)
  if (!b || b.resetAt <= now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSec: 0 }
  }
  b.count++
  if (b.count <= max) return { ok: true, retryAfterSec: 0 }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
}

export async function rateLimit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now()
  try {
    // Bump the LIVE window's bucket (single-writer SQLite; a cross-instance
    // race can only shift a window by one step — acceptable for this guard).
    const bumped = await db.rateLimitBucket.updateMany({
      where: { key, resetAt: { gt: new Date(now) } },
      data: { count: { increment: 1 } },
    })
    if (bumped.count === 0) {
      // No live row: first call ever, or the window expired → start a fresh
      // one. Must be a single ATOMIC upsert, not create-then-catch-update:
      // N concurrent requests on a cold key all lose the create race, and
      // every P2002 loser gets printed by Prisma's error logger even inside
      // try/catch (the log flood seen as "prisma:error … rateLimitBucket").
      // Upsert compiles to native INSERT … ON CONFLICT (key) DO UPDATE on
      // SQLite, so no query ever fails. Semantics unchanged: when a
      // concurrent creator won, we reset to count=1 with a fresh window.
      await db.rateLimitBucket.upsert({
        where: { key },
        create: { key, count: 1, resetAt: new Date(now + windowMs) },
        update: { count: 1, resetAt: new Date(now + windowMs) },
      })
      return { ok: true, retryAfterSec: 0 }
    }
    const row = await db.rateLimitBucket.findUnique({
      where: { key },
      select: { count: true, resetAt: true },
    })
    if (!row) return { ok: true, retryAfterSec: 0 } // pruned between calls — allow
    if (row.count <= max) return { ok: true, retryAfterSec: 0 }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((row.resetAt.getTime() - now) / 1000)) }
  } catch (err) {
    noteFallback(err)
    return memoryLimit(key, max, windowMs)
  } finally {
    maybePrune()
  }
}

export async function resetRateLimit(key: string): Promise<void> {
  memoryBuckets.delete(key)
  try {
    await db.rateLimitBucket.deleteMany({ where: { key } })
  } catch (err) {
    noteFallback(err)
  }
}

// ---- lazy pruning -----------------------------------------------------------
let lastPruneAt = 0
function maybePrune(): void {
  const now = Date.now()
  if (now - lastPruneAt < 5 * 60_000) return
  lastPruneAt = now
  db.rateLimitBucket
    .deleteMany({ where: { resetAt: { lt: new Date(now) } } })
    .catch(() => {
      /* the pruner must never surface — the rate limit already answered */
    })
}
