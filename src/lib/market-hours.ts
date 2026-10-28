// Alpaca market-clock service (server-side only) — Task 35.
//
// Answers "is this symbol's market open right now?" for the per-chart
// session indicator:
//   GREEN LIGHT  — US regular trading hour (and crypto: 24/7 open)
//   YELLOW SUN   — US pre-market    04:00 → session open, ET
//   PURPLE MOON  — US after-hours   session close → 20:00, ET
//   DIM DOT      — closed (overnight / weekend / holiday / asset halted)
//
// Sources of truth — all Alpaca Trading API:
//   GET /v2/clock              → is_open + next_open / next_close (US equities)
//   GET /v1/calendar?start&end → today's real open/close (catches half-days
//                                and holidays that fixed 09:30–16:00 misses)
//   GET /v2/assets/{symbol}    → crypto asset status. Alpaca crypto trades
//                                24/7 with no clock endpoint, so "open" is
//                                confirmed by the asset being ACTIVE.
// Without keys (demo mode) everything degrades to a local ET-clock estimate
// flagged `estimated` — same fail-open philosophy as sessions.ts.
import { getAlpacaKeys } from './alpaca'
import { resolveTradeMode, TRADE_BASE, type TradeMode } from './trading'
import {
  isCryptoSymbol,
  type MarketHoursResponse,
  type MarketStatusEntry,
  type MarketStatusState,
} from './market-types'
import { etMinutesOfDay, etDateKey, RTH_START_MIN, RTH_END_MIN } from './sessions'

interface AlpacaClock {
  timestamp: string
  is_open: boolean
  next_open: string
  next_close: string
}

interface AlpacaCalendarDay {
  date: string
  open: string // "09:30" ET
  close: string // "16:00" ET
}

interface AlpacaAsset {
  class: string // 'us_equity' | 'crypto'
  exchange: string
  status: string // 'active' | 'inactive'
}

interface Cls {
  state: MarketStatusState
  label: string
  detail?: string
  estimated?: boolean
}

// ---- in-memory caches (single-process, per instructions) ----
const CLOCK_TTL = 30_000
const CAL_TTL = 5 * 60_000
const ASSET_TTL = 6 * 3600_000

let clockCache: { mode: TradeMode; at: number; clock: AlpacaClock | null } | null = null
let calCache: { mode: TradeMode; date: string; at: number; day: AlpacaCalendarDay | null } | null = null
const assetCache = new Map<string, { at: number; status: 'active' | 'inactive' }>()

// ---- ET helpers (server reuses the client-safe sessions.ts formatters) ----

let etWdFmt: Intl.DateTimeFormat | null = null
function etWeekday(timeSec: number): string {
  if (!etWdFmt) {
    etWdFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
  }
  try {
    return etWdFmt.format(new Date(timeSec * 1000))
  } catch {
    return 'Mon'
  }
}

let etHmFmt: Intl.DateTimeFormat | null = null
/** Current ET wall clock, "HH:MM". */
function etNowHm(timeSec: number): string {
  if (!etHmFmt) {
    etHmFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  }
  try {
    return etHmFmt.format(new Date(timeSec * 1000))
  } catch {
    return '--:--'
  }
}

let etIsoFmt: Intl.DateTimeFormat | null = null
/** ISO instant → "Wed 09:30 ET" (for next_open / next_close in tooltips). */
function fmtEt(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  if (!etIsoFmt) {
    etIsoFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  }
  try {
    return `${etIsoFmt.format(new Date(iso))} ET`.replace(',', '')
  } catch {
    return undefined
  }
}

function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}

function fmtMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

// ---- Alpaca fetchers (with module-level caching) ----

interface ClockResult { clock: AlpacaClock | null }
interface CalResult { day: AlpacaCalendarDay | null }

async function alpacaGet<T>(base: string, path: string, keys: { keyId: string; secret: string }): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`${base}${path}`, {
      headers: {
        'APCA-API-KEY-ID': keys.keyId,
        'APCA-API-SECRET-KEY': keys.secret,
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchClock(mode: TradeMode, keys: { keyId: string; secret: string }): Promise<AlpacaClock | null> {
  if (clockCache && clockCache.mode === mode && Date.now() - clockCache.at < CLOCK_TTL) {
    return clockCache.clock
  }
  const clock = await alpacaGet<AlpacaClock>(TRADE_BASE[mode], '/v2/clock', keys)
  clockCache = { mode, at: Date.now(), clock }
  return clock
}

/** Today's ET session, or null when today is a weekend/holiday.
 *  `ok:false` returned via null day + caller tracking is avoided: we cache
 *  the RESULT either way and let the caller treat "no calendar" as heuristic. */
async function fetchCalendar(mode: TradeMode, keys: { keyId: string; secret: string }, etDate: string): Promise<{ day: AlpacaCalendarDay | null; ok: boolean }> {
  if (calCache && calCache.mode === mode && calCache.date === etDate && Date.now() - calCache.at < CAL_TTL) {
    return { day: calCache.day, ok: true }
  }
  const list = await alpacaGet<AlpacaCalendarDay[]>(TRADE_BASE[mode], `/v1/calendar?start=${etDate}&end=${etDate}`, keys)
  if (Array.isArray(list)) {
    const day = list.find((d) => d.date === etDate) ?? null
    calCache = { mode, date: etDate, at: Date.now(), day }
    return { day, ok: true }
  }
  // fetch failed — keep any stale cache rather than dropping to heuristic
  if (calCache && calCache.mode === mode && calCache.date === etDate) {
    return { day: calCache.day, ok: true }
  }
  return { day: null, ok: false }
}

// ---- classification ----

// Exported for QA fixture scripts (scripts-tmp/) — pure function, no I/O.
export function classifyUs(nowSec: number, clock: AlpacaClock | null, clockOk: boolean, cal: AlpacaCalendarDay | null, calOk: boolean): Cls {
  const etMin = etMinutesOfDay(nowSec)
  const wd = etWeekday(nowSec)
  const weekday = wd !== 'Sat' && wd !== 'Sun'
  const openMin = cal ? parseHm(cal.open) : RTH_START_MIN
  const closeMin = cal ? parseHm(cal.close) : RTH_END_MIN
  const estimated = !clockOk

  // 1) Live clock says open → regular session. This is the truth.
  if (clockOk && clock?.is_open) {
    return {
      state: 'regular',
      label: 'Regular Trading Hour',
      detail: `US market open · closes ${fmtEt(clock.next_close) ?? fmtMinutes(closeMin) + ' ET'}`,
    }
  }

  // 2) Weekend (calendar/clock both agree it cannot be open)
  if (!weekday) {
    return { state: 'closed', label: 'Market Closed', detail: `Weekend · opens ${fmtEt(clock?.next_open) ?? 'next session'}`, estimated }
  }

  // 3) Trading day but the calendar reports no session → holiday
  if (calOk && !cal && clockOk) {
    return { state: 'closed', label: 'Market Closed', detail: `Market holiday · opens ${fmtEt(clock?.next_open) ?? 'next session'}` }
  }

  // 4) Pre-market window: 04:00 ET → session open
  if (etMin >= 240 && etMin < openMin) {
    return {
      state: 'pre',
      label: 'Pre-Market',
      detail: `Pre-market · regular session opens ${fmtEt(clock?.next_open) ?? fmtMinutes(openMin) + ' ET'}`,
      estimated,
    }
  }

  // 5) After-hours window: session close → 20:00 ET
  if (etMin >= closeMin && etMin < 1200) {
    return {
      state: 'post',
      label: 'Post Trading Hour',
      detail: `After-hours · reopens ${fmtEt(clock?.next_open) ?? 'next session'}`,
      estimated,
    }
  }

  // 6) Clock unavailable (demo / network fail) but we are inside the session
  //    window (real calendar open/close when known, else 09:30–16:00 default)
  if (!clockOk && etMin >= openMin && etMin < closeMin) {
    return { state: 'regular', label: 'Regular Trading Hour', detail: `US market open${cal ? '' : ' (estimate)'} · closes ${fmtMinutes(closeMin)} ET`, estimated: true }
  }

  // 7) Overnight / anything else
  return {
    state: 'closed',
    label: 'Market Closed',
    detail: `Closed · opens ${fmtEt(clock?.next_open) ?? 'next session'}`,
    estimated,
  }
}

function cryptoEntryFrom(status: 'active' | 'inactive', confirmed: boolean): Cls {
  if (status === 'active') {
    return {
      state: 'open24',
      label: 'Open 24/7',
      detail: confirmed ? 'Crypto · 24/7 market open — verified via Alpaca' : 'Crypto · 24/7 market open (local estimate)',
    }
  }
  return { state: 'closed', label: 'Market Closed', detail: 'Alpaca reports this crypto asset inactive' }
}

/** Crypto has no clock endpoint — confirm the asset is ACTIVE on Alpaca.
 *  Fail-open to "open 24/7, estimated" (crypto genuinely never closes). */
async function classifyCrypto(symbol: string, mode: TradeMode, keys: { keyId: string; secret: string } | null): Promise<Cls> {
  if (!keys) {
    return { ...cryptoEntryFrom('active', false), estimated: true }
  }
  const hit = assetCache.get(symbol)
  if (hit && Date.now() - hit.at < ASSET_TTL) {
    return cryptoEntryFrom(hit.status, true)
  }
  const alpacaSym = symbol.replace('/', '') // BTC/USD → BTCUSD
  const asset = await alpacaGet<AlpacaAsset>(TRADE_BASE[mode], `/v2/assets/${encodeURIComponent(alpacaSym)}`, keys)
  if (asset && typeof asset.status === 'string') {
    const status: 'active' | 'inactive' = asset.status === 'active' && asset.class === 'crypto' ? 'active' : 'inactive'
    assetCache.set(symbol, { at: Date.now(), status })
    return cryptoEntryFrom(status, true)
  }
  return { ...cryptoEntryFrom('active', false), estimated: true }
}

// ---- public API ----

export async function getMarketHours(symbols: string[], userId?: string, modeIn?: TradeMode): Promise<MarketHoursResponse> {
  const mode = modeIn ?? await resolveTradeMode(userId)
  const keys = await getAlpacaKeys(userId)
  const nowSec = Date.now() / 1000
  const hours: MarketHoursResponse['hours'] = {}

  const stockSyms = symbols.filter((s) => !isCryptoSymbol(s))
  const cryptoSyms = symbols.filter((s) => isCryptoSymbol(s))

  // With keys: classify from the live Alpaca clock + calendar. Without keys
  // (demo): the same classifier falls back to local ET-clock windows and
  // flags every entry `estimated` — never a blank/unknown indicator.
  let usCls: Cls = classifyUs(nowSec, null, false, null, false)
  let clock: AlpacaClock | null = null
  let clockOk = false
  if (keys) {
    clock = await fetchClock(mode, keys)
    clockOk = clock !== null
    const cal = await fetchCalendar(mode, keys, etDateKey(nowSec))
    usCls = classifyUs(nowSec, clock, clockOk, cal.day, cal.ok)
  }

  for (const s of stockSyms) {
    hours[s] = { symbol: s, asset: 'us_equity', ...usCls }
  }

  for (const s of cryptoSyms) {
    hours[s] = { symbol: s, asset: 'crypto', ...(await classifyCrypto(s, mode, keys)) }
  }

  return {
    us: clockOk && clock
      ? { isOpen: clock.is_open, nextOpen: clock.next_open, nextClose: clock.next_close, et: etNowHm(nowSec) }
      : undefined,
    hours,
    meta: { demo: !keys },
  }
}
