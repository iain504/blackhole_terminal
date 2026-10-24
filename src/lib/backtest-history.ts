// Task 10-a — shared deep-history fetcher for backtests.
//
// Extracted VERBATIM from the algo backtest route (Task 3-d machinery) so the
// grid backtest reuses the EXACT same bars pipeline:
//   • Short-TTL deep-history cache — a deep window (730d crypto ≈ 86k bars)
//     takes 6–35s to paginate from the feeds, and the tune→re-run→optimize
//     loop would otherwise re-pay that on EVERY request. Historical bars are
//     immutable except the newest (the forming bar is dropped per request
//     anyway), so 2min staleness is invisible to the replay. Bounded to 6
//     entries (~60-80MB worst) — this cache duplicates the global bars-cache,
//     and on the 1.8GB-heap dev box every retained MB is sweep headroom.
//   • 1m windows are NEVER cached (30d ≈ 43k bars — the double retention is
//     exactly what killed the box on repeated 1m backtests, Task 9-p).
//   • Binance / Alpaca / demo fallbacks stay inside getBars (lib/alpaca) —
//     demo feeds are surfaced as an honest failure by fetchBacktestBars,
//     NEVER replayed as fake results.
// The algo route now imports this helper with byte-identical behavior.
import { getBars } from '@/lib/alpaca'
import { TIMEFRAMES, type Bar, type Timeframe } from '@/lib/market-types'

const BARS_TTL_MS = 120_000
const BARS_CACHE_MAX = 6
const barsCache = new Map<string, { at: number; res: Awaited<ReturnType<typeof getBars>> }>()

export async function getBarsCached(symbol: string, tf: Timeframe, userId: string, days: number) {
  // Task 9-p — NEVER retain a 1m window (30d ≈ 43k bars): the tune→re-run
  // loop's refetch for 1m costs a couple of seconds, the retained window
  // costs tens of MB of heap for minutes. This cache duplicated the global
  // bars-cache — the double retention is exactly what killed the box on
  // repeated 1m backtests.
  if (tf === '1m') return getBars(symbol, tf, userId, { lookbackDays: days })
  const key = `${userId}|${symbol}|${tf}|${days}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.res
  const res = await getBars(symbol, tf, userId, { lookbackDays: days })
  barsCache.set(key, { at: Date.now(), res })
  if (barsCache.size > BARS_CACHE_MAX) {
    const oldest = [...barsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) barsCache.delete(oldest[0])
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
