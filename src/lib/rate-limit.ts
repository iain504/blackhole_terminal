// Task 3-d — per-user rate limiting (in-process).
//
// ⚠ COORDINATION NOTE: a dedicated rate-limit implementation with this EXACT
// API (`rateLimit(key, max, windowMs) → { ok, retryAfterSec }` + `resetRateLimit`)
// is being built by another agent. This file is the minimal, API-identical
// placeholder so imports resolve NOW — when the real module lands it can
// replace this file 1:1 (callers only use the two exported functions and the
// `{ ok, retryAfterSec }` shape). Buckets live on globalThis so Next.js dev
// HMR doesn't reset them on every module reload.
//
// Semantics: fixed-window counter per key. The FIRST call in a window starts
// it; calls up to `max` pass; anything beyond returns ok:false with the whole
// seconds until the window resets. Purely in-process (per instance) — same
// trust model as the rest of this single-process deployment.

export interface RateLimitResult {
  ok: boolean
  retryAfterSec: number
}

interface Bucket {
  count: number
  resetAt: number
}

const g = globalThis as unknown as { __rateLimitBuckets?: Map<string, Bucket> }
const buckets: Map<string, Bucket> = (g.__rateLimitBuckets ??= new Map())

function prune(now: number): void {
  if (buckets.size < 5_000) return
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k)
  }
}

export function rateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  prune(now)
  const b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSec: 0 }
  }
  b.count++
  if (b.count <= max) return { ok: true, retryAfterSec: 0 }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
}

export function resetRateLimit(key: string): void {
  buckets.delete(key)
}
