// US-equity session classification (client-safe, no imports).
//
// Alpaca's Market Data v2 bars endpoint has NO extended-hours flag — with
// `feed=iex` it simply returns every bar the exchange printed, including the
// pre-market (04:00–09:30 ET), after-hours (16:00–20:00 ET) and overnight
// (IEX 20:00–04:00) sessions. Showing "extended trading hours" as an OPTION
// (TradingView's ETH toggle) therefore has to happen client-side: classify
// each bar by its OPEN time in America/New_York and filter/shade accordingly.

export type SessionKind = 'regular' | 'extended'

/** US regular session in ET minutes-of-day: 09:30 (570) → 16:00 (960).
 * SINGLE SOURCE OF TRUTH (Task 11-f): the algo engine and the backtester
 * import these instead of redefining their own copies. */
export const RTH_START_MIN = 9 * 60 + 30
export const RTH_END_MIN = 16 * 60
const RTH_START = RTH_START_MIN
const RTH_END = RTH_END_MIN

// One shared formatter (Intl formatter construction is expensive); DST is
// handled by the timeZone database inside Intl, so half-day/offset drift
// around DST transitions stays correct.
let etPartsFmt: Intl.DateTimeFormat | null = null

// Bars are re-rendered on every crosshair move — memoize time → ET minutes
// so repeated overlay passes never re-run formatToParts for the same bar.
const etMinutesCache = new Map<number, number>()

function etMinutesOfDay(timeSec: number): number {
  const cached = etMinutesCache.get(timeSec)
  if (cached != null) return cached
  if (!etPartsFmt) {
    etPartsFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    })
  }
  let minutes = 0
  try {
    const parts = etPartsFmt.formatToParts(new Date(timeSec * 1000))
    let h = 0
    let m = 0
    for (const p of parts) {
      if (p.type === 'hour') h = Number(p.value) % 24 // some engines emit "24" for midnight
      else if (p.type === 'minute') m = Number(p.value)
    }
    if (Number.isFinite(h) && Number.isFinite(m)) minutes = h * 60 + m
  } catch {
    // Intl failure → treat as regular so nothing is ever hidden by accident
    return RTH_START
  }
  if (etMinutesCache.size > 200_000) etMinutesCache.clear()
  etMinutesCache.set(timeSec, minutes)
  return minutes
}

export { etMinutesOfDay }

// ET calendar date key ("YYYY-MM-DD", en-CA) — day accumulators / daily caps
// in the algo engine + backtester. Cached formatter, same discipline as above.
let etDateFmt: Intl.DateTimeFormat | null = null
export function etDateKey(timeSec: number): string {
  if (!etDateFmt) {
    etDateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }
  try {
    return etDateFmt.format(new Date(timeSec * 1000))
  } catch {
    return 'unknown'
  }
}

/**
 * Classify a bar (by its unix-second OPEN time) as inside the US regular
 * session or part of extended trading. Unknown/Intl-failure → 'regular'
 * (fail-open so a broken formatter can never blank a chart).
 */
export function sessionOf(timeSec: number): SessionKind {
  const v = etMinutesOfDay(timeSec)
  return v >= RTH_START && v < RTH_END ? 'regular' : 'extended'
}

let etWeekdayFmt: Intl.DateTimeFormat | null = null

/**
 * True when `timeSec` is inside the US regular session AND on an ET weekday
 * (Mon–Fri). sessionOf() alone is a time-of-day check — Sat/Sun 10:00 ET
 * would pass it while the market is closed. ORDER GATES (the grid engine
 * submits orders only here) need the weekday too: Alpaca rejects market
 * orders outside the regular session, and every rejection counts as an
 * engine failure (fail-streak → the grid parks itself as 'error').
 * Holidays are NOT detected (no trading-calendar dependency) — the broker
 * rejects honestly on the rare holiday tick. Intl failure → true (fail-open,
 * same discipline as sessionOf: a broken formatter must never silently gate).
 */
export function isRegularSession(timeSec: number): boolean {
  if (!etWeekdayFmt) {
    etWeekdayFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    })
  }
  try {
    const wd = etWeekdayFmt.format(new Date(timeSec * 1000))
    if (wd === 'Sat' || wd === 'Sun') return false
  } catch {
    return true
  }
  return sessionOf(timeSec) === 'regular'
}
