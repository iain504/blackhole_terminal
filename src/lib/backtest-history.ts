// Task 10-a — shared deep-history fetcher for backtests.
//
// Extracted VERBATIM from the algo backtest route (Task 3-d machinery) so the
// grid backtest reuses the EXACT same bars pipeline:
//   • Short-TTL deep-history cache — a deep window (730d crypto ≈ 86k bars)
//     takes 6–35s to paginate from the feeds, and the tune→re-run→optimize
//     loop would otherwise re-pay that on EVERY request. Historical bars are
//     immutable except the newest (the forming bar is dropped per request
//     anyway), so staleness is invisible to the replay. Bounded to 6 entries
//     — this cache duplicates the global bars-cache, and every retained MB is
//     sweep headroom on a small box.
//   • Task 15 — 1m windows ARE cached now (60s TTL, max 2 entries). The old
//     "never cache 1m" rule traded a REFETCH STORM for a retention saving:
//     every 1m optimize click re-paid the full 6–35s paginated fetch and its
//     transient double-allocation, which on a memory-capped host (Render
//     512MB) is exactly the repeated RSS spike that gets the pod killed
//     mid-request. Two bounded 1m entries (~10-20MB) are strictly cheaper
//     than a refetch spike on every click.
//   • Binance / Alpaca / demo fallbacks stay inside getBars (lib/alpaca) —
//     demo feeds are surfaced as an honest failure by fetchBacktestBars,
//     NEVER replayed as fake results.
// The algo route now imports this helper with byte-identical behavior.
import { getBars } from '@/lib/alpaca'
import { TIMEFRAMES, type Bar, type Timeframe } from '@/lib/market-types'

const BARS_TTL_MS = 120_000
const ONE_M_TTL_MS = 60_000
const BARS_CACHE_MAX = 6
const ONE_M_CACHE_MAX = 2
const barsCache = new Map<string, { at: number; tf: Timeframe; res: Awaited<ReturnType<typeof getBars>> }>()

function evictOldest(isOneM: boolean): void {
  let oldestKey: string | null = null
  let oldestAt = Infinity
  for (const [k, v] of barsCache) {
    // when inserting a 1m entry prefer evicting another 1m entry (they are
    // the biggest); fall through to the global oldest only if none cached
    if (isOneM && v.tf !== '1m' && barsCache.size > 1) continue
    if (v.at < oldestAt) {
      oldestAt = v.at
      oldestKey = k
    }
  }
  if (oldestKey) barsCache.delete(oldestKey)
}

export async function getBarsCached(symbol: string, tf: Timeframe, userId: string, days: number) {
  // Task 15 — 1m windows are cached with a SHORTER TTL and a tighter cap
  // (ONE_M_CACHE_MAX): the retention risk the old no-1m rule guarded against
  // is now bounded by design, and the tune→re-run loop stops re-paying the
  // deep paginated fetch on every click.
  const isOneM = tf === '1m'
  const ttl = isOneM ? ONE_M_TTL_MS : BARS_TTL_MS
  const key = `${userId}|${symbol}|${tf}|${days}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < ttl && !hit.res.truncated) return hit.res
  const res = await getBars(symbol, tf, userId, { lookbackDays: days })
  // v1.99.2 — a TRUNCATED fetch is never cached: the very next Run must do a
  // real refetch (the feed stall is usually gone in seconds), not re-serve the
  // same short window from the 120s TTL cache.
  if (!res.truncated) {
    barsCache.set(key, { at: Date.now(), tf, res })
    // per-class cap first (a 1m insert never evicts a cheap 5m/15m window),
    // then the global cap
    if (isOneM) {
      let oneMCount = 0
      for (const v of barsCache.values()) if (v.tf === '1m') oneMCount++
      if (oneMCount > ONE_M_CACHE_MAX) evictOldest(true)
    }
    if (barsCache.size > BARS_CACHE_MAX) evictOldest(false)
  }
  return res
}

export const DEFAULT_MAX_BARS = 120_000

export type BacktestHistory =
  | { ok: true; bars: Bar[]; source?: string }
  | { ok: false; error: string }

/**
 * Fetch + gate the history window for a backtest: TTL-cached deep fetch, the
 * honest demo/short-history 400s, dropping the FORMING bar (never a decision
 * bar in the live engines either) and the hard compute cap (keep the most
 * recent bars). Returns { ok:false, error } with the exact user-facing 400
 * messages the algo backtest route has always produced.
 */
export async function fetchBacktestBars(
  symbol: string,
  tf: Timeframe,
  userId: string,
  days: number,
  maxBars: number = DEFAULT_MAX_BARS,
): Promise<BacktestHistory> {
  const res = await getBarsCached(symbol, tf, userId, days)
  let bars = Array.isArray(res.bars) ? res.bars : []
  // v1.99.2 — TRUNCATED HISTORY IS A HARD REFUSAL: the retries in alpacaFetch
  // already absorbed transient stalls; if the window still came back short the
  // feed is having a real problem, and replaying a history that ends days/weeks
  // before now would produce a confident-looking backtest of the WRONG data.
  // Fail honestly with a retry hint instead (matches the demo-data refusal).
  if (res.truncated) {
    return {
      ok: false,
      error:
        'History came back incomplete — the data feed dropped part of the window mid-download. Press Run again to retry.',
    }
  }
  if (res.demo || bars.length < 80) {
    return {
      ok: false,
      error: res.demo
        ? 'No live historical data for this symbol (demo feed) — cannot backtest'
        : `Not enough history (${bars.length} bars) — widen the period or pick a smaller timeframe`,
    }
  }
  // drop the FORMING bar (never a decision bar in the live engine either)
  const tfSec = TIMEFRAMES[tf].seconds
  const nowSec = Math.floor(Date.now() / 1000)
  while (bars.length > 0 && bars[bars.length - 1].time + tfSec > nowSec) bars = bars.slice(0, -1)
  if (bars.length < 80) return { ok: false, error: 'Not enough closed bars in range' }
  // hard compute cap — keep the most recent bars
  if (bars.length > maxBars) bars = bars.slice(bars.length - maxBars)
  return { ok: true, bars, source: res.source }
}
