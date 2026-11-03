// v2.11.0 — Earnings awareness for the Nebula Autopilot (FSD).
//
// The one calendar event a backtest can never see: an earnings report
// re-prices a stock in a single overnight gap, so a BUY entered the day
// before owns the gap with no stop that can protect it. This module answers
// one question per symbol — WHEN does it next report, and is the fleet
// inside the danger window?
//
// Data: the same keyless Yahoo quoteSummary `calendarEvents` flow yahoo.ts
// already runs for the chart's [E] markers (cookie+crumb, consensus date for
// the next report). Yahoo's `earningsDate` is an ESTIMATE — dates move — so
// everything here degrades honestly:
//   • no date / fetch failure / crypto symbol → known: false
//   • every consumer FAILS OPEN (no dampening, no entry block) — a missing
//     date must never brick trading, same discipline as the sentiment and
//     regime gates.
//
// Verdict windows (all evaluated against raw instants, not rounded days):
//   inBlock — now ∈ [report − 2d, report + 20h]  → hard BUY pause (entry gate)
//   inWarn  — now ∈ [report − 5d, report + 20h]  → score × EARNINGS_SCORE_MULT
// The +20h grace covers the report DAY itself: Yahoo's ts sits at/near
// midnight UTC of the date, but the release lands before the open (BMO) or
// after the close (AMC) — the gate must hold through both.
//
// Caching: per-symbol TTL of 12h when the report is >7d out (estimates
// barely move), 3h once it is close (they do), plus a single-flight map so a
// batch call never duplicates an in-progress fetch. Batch lookups run on a
// small concurrency pool — the ranking phase asks for the whole board at
// once and Yahoo rate-limits bursts.
import { getYahooEarnings } from '@/lib/yahoo'
import { isCryptoSymbol } from '@/lib/market-types'

export const EARNINGS_BLOCK_DAYS = 2 // hard BUY-pause window before the report
export const EARNINGS_WARN_DAYS = 5 // score-dampening window before the report
export const EARNINGS_SCORE_MULT = 0.85 // score dampening inside the warn window
const REPORT_DAY_GRACE_MS = 20 * 3600 * 1000 // hold through the report day (BMO/AMC)
const DAY_MS = 86_400_000

export interface EarningsEvent {
  symbol: string
  /** next consensus report instant (ms) — null when none known */
  atMs: number | null
  /** calendar days until the report (0 = today); null when unknown */
  daysAway: number | null
  /** inside the hard BUY-pause window (entry gate) */
  inBlock: boolean
  /** inside the score-dampening window (ranking) */
  inWarn: boolean
  /** false = no trustworthy data (crypto / no date / fetch failed) — fail open */
  known: boolean
}

export const EARNINGS_UNKNOWN: EarningsEvent = {
  symbol: '', atMs: null, daysAway: null, inBlock: false, inWarn: false, known: false,
}

function unknown(symbol: string): EarningsEvent {
  return { ...EARNINGS_UNKNOWN, symbol }
}

function verdict(symbol: string, atMs: number | null): EarningsEvent {
  if (atMs == null || !Number.isFinite(atMs)) return unknown(symbol)
  const now = Date.now()
  const daysAway = Math.max(0, Math.floor((atMs - now) / DAY_MS))
  const inBlock = now >= atMs - EARNINGS_BLOCK_DAYS * DAY_MS && now <= atMs + REPORT_DAY_GRACE_MS
  const inWarn = now >= atMs - EARNINGS_WARN_DAYS * DAY_MS && now <= atMs + REPORT_DAY_GRACE_MS
  return { symbol, atMs, daysAway, inBlock, inWarn, known: true }
}

const CACHE_FAR_MS = 12 * 3600 * 1000 // report >7d out — the estimate rarely moves
const CACHE_NEAR_MS = 3 * 3600 * 1000 // report within 7d — estimates do move
const cache = new Map<string, { at: number; ev: EarningsEvent }>()
const inflight = new Map<string, Promise<EarningsEvent>>()

/** Next-earnings verdict for one symbol. NEVER throws — failures read as unknown. */
export async function getEarningsEvent(symbol: string): Promise<EarningsEvent> {
  const key = symbol.toUpperCase()
  if (isCryptoSymbol(key)) return unknown(key)
  const hit = cache.get(key)
  if (hit) {
    const ttl = hit.ev.atMs != null && hit.ev.atMs - Date.now() > 7 * DAY_MS ? CACHE_FAR_MS : CACHE_NEAR_MS
    if (Date.now() - hit.at < ttl) return hit.ev
  }
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      const y = await getYahooEarnings(key).catch(() => null)
      const ev = verdict(key, y?.upcoming ? y.upcoming.ts * 1000 : null)
      cache.set(key, { at: Date.now(), ev })
      return ev
    })()
    inflight.set(key, p)
    void p.finally(() => { inflight.delete(key) }).catch(() => { /* never throws */ })
  }
  return p
}

/** Pooled batch lookup — the ranking phase asks for the whole board at once. */
export async function getEarningsBatch(symbols: string[], concurrency = 6): Promise<Map<string, EarningsEvent>> {
  const out = new Map<string, EarningsEvent>()
  const queue = [...new Set(symbols.map((s) => s.toUpperCase()))]
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const sym = queue.shift()
        if (!sym) break
        out.set(sym, await getEarningsEvent(sym))
      }
    }),
  )
  return out
}

/** Human label used by journals and badges: "earnings today" / "in 2d". */
export function earningsLabel(daysAway: number | null): string {
  if (daysAway == null) return 'earnings (date unknown)'
  if (daysAway === 0) return 'earnings TODAY'
  if (daysAway === 1) return 'earnings tomorrow'
  return `earnings in ${daysAway}d`
}
