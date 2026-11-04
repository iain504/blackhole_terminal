// v2.11.3 — tiny in-process TTL cache for hot read endpoints.
//
// Why: before this, /api/market/quote hit Binance/Alpaca on EVERY request —
// and six independent client pollers (watchlist, quote panel, mobile, per-pane
// charts, landing ticker, demo-meta check) all polled it on overlapping 10-20s
// cadences. One shared TTL window collapses all of them into at most one
// upstream fetch per window. Same story for /api/grid + /api/algo, which every
// chart pane polled every 5s (an 8-pane grid ⇒ ~3.2 req/s of identical DB
// queries: 2000 fill rows + 600 log rows serialized per pane per cycle).
//
// Design:
//   - TTL entries in a globalThis Map (survives dev HMR, bounded at
//     MAX_ENTRIES with simple FIFO eviction — keys are few by construction).
//   - Single-flight: concurrent requests for the same key share one loader
//     promise (the post-cache-load thundering herd is also deduped).
//   - Stale-while-error: if a loader throws and an expired-but-present entry
//     exists (up to STALE_MULT × TTL old), serve it instead of failing —
//     market data a few seconds old beats a 500 during an upstream hiccup.
//     This materially improves stability for quote/heatmap consumers.
//   - Invalidation: bustApiCache(prefix). For the user-scoped grid/algo caches
//     the Prisma middleware in src/lib/db.ts busts automatically on ANY write
//     to the tables those endpoints read (routes + engines + scripts covered
//     in one place), so a mutation never serves from a stale snapshot.

interface Entry {
  value: unknown
  /** fresh until this epoch ms */
  expires: number
  /** still servable (stale-while-error) until this epoch ms */
  staleUntil: number
}

const MAX_ENTRIES = 256
const STALE_MULT = 6

function store(): Map<string, Entry> {
  const g = globalThis as { __ttApiCache?: Map<string, Entry> }
  if (!g.__ttApiCache) g.__ttApiCache = new Map<string, Entry>()
  return g.__ttApiCache
}

function inflight(): Map<string, Promise<unknown>> {
  const g = globalThis as { __ttApiCacheInflight?: Map<string, Promise<unknown>> }
  if (!g.__ttApiCacheInflight) g.__ttApiCacheInflight = new Map<string, Promise<unknown>>()
  return g.__ttApiCacheInflight
}

/** Drop cached responses — everything, or only keys starting with `prefix`. */
export function bustApiCache(prefix?: string): void {
  const s = store()
  if (!prefix) {
    s.clear()
    return
  }
  for (const k of Array.from(s.keys())) {
    if (k.startsWith(prefix)) s.delete(k)
  }
}

/**
 * Resolve `loader()` through the TTL cache. Fresh hit → cached value.
 * Concurrent misses share one loader (single-flight). Loader failure with an
 * expired-but-present entry → stale value (up to STALE_MULT × TTL).
 */
export async function cachedJson<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const s = store()
  const now = Date.now()
  const hit = s.get(key)
  if (hit && now < hit.expires) return hit.value as T

  const f = inflight()
  const pending = f.get(key)
  if (pending) return pending as Promise<T>

  const p = (async () => {
    try {
      const value = await loader()
      s.set(key, { value, expires: Date.now() + ttlMs, staleUntil: Date.now() + ttlMs * STALE_MULT })
      // FIFO trim — the map is small by construction; keep it provably bounded
      if (s.size > MAX_ENTRIES) {
        const oldest = s.keys().next().value
        if (oldest !== undefined) s.delete(oldest)
      }
      return value
    } catch (e) {
      // stale-while-error — the previous entry was never replaced on failure
      const stale = s.get(key)
      if (stale && Date.now() < stale.staleUntil) return stale.value as T
      throw e
    } finally {
      f.delete(key)
    }
  })()
  f.set(key, p)
  return p
}
