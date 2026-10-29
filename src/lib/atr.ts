// ATR (Average True Range) exit service — v1.96.0.
//
// SL/TP in every location (manual ticket, algo runs, strategy rules, grid
// guards) can now be expressed as a MULTIPLIER of the Wilder ATR(14) on a
// chosen timeframe instead of a percent or absolute price — the stop distance
// then breathes with the instrument's volatility instead of being a fixed %.
//
// This module is the ONE server-side resolution point the engines share:
//   • strategy.ts  — fire time, anchored on the live quote (fail loud)
//   • algo-engine.ts — entry time, anchored on the spread-aware fill-side
//     quote (fail closed — entry skipped when ATR data is unavailable)
//   • grid-engine.ts — guard re-resolution every tick (60s-cached value with
//     a 24h last-good fallback so a data hiccup never disarms a stop)
//   • GET /api/market/atr — the UI preview endpoint (same math, cached)
import { barsFor } from '@/lib/bars-cache'
import { computeAtr } from '@/lib/indicators'
import { Timeframe, TIMEFRAMES } from '@/lib/market-types'

export const ATR_PERIOD = 14
/** ATR multiplier bounds (tpValue/slValue/maxSL/maxTP when the mode is 'atr'). */
export const ATR_MULT_MIN = 0.1
export const ATR_MULT_MAX = 20

/** Any chart timeframe is a valid ATR timeframe. */
export function isAtrTimeframe(tf: unknown): tf is Timeframe {
  return typeof tf === 'string' && tf in TIMEFRAMES
}

/** Default ATR timeframe when a config omits one (hourly ATR(14) is the
 *  classic day-trading stop basis; coarse enough to be stable, fine enough
 *  to track intraday regime shifts). */
export const ATR_DEFAULT_TF: Timeframe = '1h'

/** Clamp/validate an ATR multiplier from user input — null when unusable. */
export function clampAtrMult(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(ATR_MULT_MAX, Math.max(ATR_MULT_MIN, n))
}

/** Resolve the effective ATR timeframe of a stored config value (null/legacy → default). */
export function atrTfOf(tf: string | null | undefined): Timeframe {
  return isAtrTimeframe(tf) ? tf : ATR_DEFAULT_TF
}

/**
 * Convert an ATR distance into the PERCENT-equivalent offset from `ref` so
 * every existing percent consumer (resolveExit, pctPx, riskSizedQty) can be
 * reused unchanged. Clamped to the same 0.01–100 band the pct paths enforce.
 * Returns null when any input is unusable (caller fails closed).
 */
export function atrToPct(atr: number, mult: number, ref: number | null | undefined): number | null {
  if (!(atr > 0) || !(mult > 0) || ref == null || !(ref > 0)) return null
  const pct = ((mult * atr) / ref) * 100
  if (!Number.isFinite(pct) || pct <= 0) return null
  return Math.min(100, Math.max(0.01, pct))
}

export interface AtrSnapshot {
  atr: number
  /** epoch ms when this value was computed from bars */
  at: number
  /** true = served from the 24h last-good fallback (fresh fetch failed) */
  stale: boolean
}

// ---- cache -----------------------------------------------------------------
// ATR changes slowly (one new bar per timeframe interval) and engines poll
// fast (grid 5s, algo 15s, strategy 20s) — a 60s TTL collapses the polling
// into at most one bars fetch per minute per (user, symbol, tf). On a failed
// fetch the LAST GOOD value stays usable for 24h: a guard/stop that already
// exists must not lose its distance just because one upstream request hiccuped
// (a stop distance "breathing to zero" during an outage is worse than a stale
// one). Entries are tiny (one number) so the cap is generous.
interface AtrCacheEntry extends AtrSnapshot { bars: number }
const atrCache = new Map<string, AtrCacheEntry>()
const ATR_TTL_MS = 60_000
const ATR_LASTGOOD_MS = 24 * 60 * 60_000
const ATR_CACHE_MAX = 500

/**
 * Cached ATR(14) snapshot for a symbol+timeframe. Returns null only when
 * there is NO usable value (no bars ever, or the last good one is > 24h old).
 */
export async function getAtrSnapshot(
  symbol: string,
  tf: Timeframe,
  userId: string,
  period: number = ATR_PERIOD,
): Promise<AtrSnapshot | null> {
  const key = `${userId}|${symbol}|${tf}|${period}`
  const hit = atrCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ATR_TTL_MS) {
    // refresh recency (Map insertion order = LRU order)
    atrCache.delete(key)
    atrCache.set(key, hit)
    return { atr: hit.atr, at: hit.at, stale: false }
  }
  let fresh: AtrCacheEntry | null = null
  try {
    const entry = await barsFor(symbol, tf, userId)
    if (!entry.demo && entry.bars.length > period) {
      const atr = computeAtr(entry.bars, period)
      if (atr != null && atr > 0) {
        fresh = { atr, at: now, stale: false, bars: entry.bars.length }
      }
    }
  } catch { /* bars fetch failed — fall through to last-good */ }
  if (fresh) {
    if (!atrCache.has(key) && atrCache.size >= ATR_CACHE_MAX) {
      const oldest = atrCache.keys().next().value
      if (oldest !== undefined) atrCache.delete(oldest)
    }
    atrCache.delete(key)
    atrCache.set(key, fresh)
    return { atr: fresh.atr, at: fresh.at, stale: false }
  }
  // last-good fallback window (24h) — engines keep their protective distance
  if (hit && now - hit.at < ATR_LASTGOOD_MS) {
    atrCache.delete(key)
    atrCache.set(key, hit)
    return { atr: hit.atr, at: hit.at, stale: true }
  }
  return null
}
