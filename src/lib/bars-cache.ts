// Shared bar-series cache for poll engines (indicator alarms + strategy bot).
// Both engines are polled by every open tab every ~20-30s; a short TTL
// collapses concurrent polls for the same series into ONE upstream fetch.
// A hard entry cap bounds process memory: without it every symbol|tf ever
// polled stays resident for the life of the process (~50MB each at max
// history) and next-server RSS creeps toward the kernel OOM line.
import { getBars } from '@/lib/alpaca'
import { Bar, Timeframe } from '@/lib/market-types'

const barsCache = new Map<string, { bars: Bar[]; demo: boolean; at: number }>()
const BARS_TTL_MS = 20000
const MAX_ENTRIES = 8 // ~400MB worst case; LRU-evicted series simply refetch

export async function barsFor(symbol: string, tf: Timeframe, userId: string, lookbackDays?: number) {
  // Task 89 — the cache key includes the USER dimension: a keyless/demo
  // user's simulated bars used to be served to a keyed user (and vice versa)
  // for up to 20s, making the algo engine log "no live bar data" until TTL
  // expiry. fetchBacktestBars already keys the same way (demo status derives
  // from the user's keys, so userId is the right partition).
  // v2.3.0 — the key also includes the requested DEPTH: swing live runs fetch
  // a deeper window (their HTF ladder needs trend buckets the chart-width
  // default doesn't carry), and a 900-bar chart window must never be served
  // to a swing run (or the deep window to a chart) just because the tf
  // matches. 0 = default depth (callers that don't care).
  const key = `${userId}|${symbol}|${tf}|${lookbackDays ?? 0}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) {
    // refresh recency so the Map insertion order stays an LRU order
    barsCache.delete(key)
    barsCache.set(key, hit)
    return hit
  }
  const res = await getBars(symbol, tf, userId, lookbackDays != null ? { lookbackDays } : undefined)
  const entry = { bars: res.bars, demo: Boolean(res.demo), at: Date.now() }
  if (!barsCache.has(key) && barsCache.size >= MAX_ENTRIES) {
    // oldest-inserted key (recency is kept fresh on hits)
    const oldest = barsCache.keys().next().value
    if (oldest !== undefined) barsCache.delete(oldest)
  }
  barsCache.delete(key)
  barsCache.set(key, entry)
  return entry
}
