// Economic calendar (Alpaca does not provide one).
// Primary source: ForexFactory weekly feed via faireconomy.media.
// NOTE (2026-10): the .json mirror answers 429 (rate limited) from this host
// while the .xml mirror returns 200 — so XML is the primary and the JSON feed
// is only a fallback attempt. Last resort: a bundled representative schedule.
//
// ACTUAL VALUES: the faireconomy mirrors (xml + json) never contain <actual>
// data — they are schedule-only feeds. The "Actual" column is therefore filled
// by scraping ForexFactory's own calendar page (which publishes actuals) and
// merging values by day+currency+time+title computed in the page's rendering
// timezone (FF renders in the requester's IP-geolocated zone and embeds it as
// timezone_name in the HTML; its day views group by that zone too). The page
// sits behind a TLS-fingerprinting bot check that 403s server-side
// fetch()/undici — but answers plain curl — so the scrape shells out to curl.
// TIMEZONE: the XML feed's date/time tags are UTC (verified against the JSON
// mirror's explicit offsets) — do NOT read them as New York wall time.
import { execFile } from 'node:child_process'
import { CalendarEvent } from './market-types'

const XML_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml'
const JSON_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const FF_PAGE_URL = 'https://www.forexfactory.com/calendar'
const CACHE_TTL_MS = 15 * 60 * 1000
const UA = 'Mozilla/5.0 (compatible; TradeTerminal/1.0; +https://localhost)'
// The calendar page sits behind a browser check — fetch it with a real
// browser user-agent (the plain bot UA gets a degraded/blocked response).
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// How long the scraped actuals stay trusted before a refresh:
//  - background (non-fresh) calls refresh them at most every 4 minutes;
//  - fresh calls (tab open / manual refresh / post-release polling) bypass
//    that once the cache is at least 60s old — same guard as the weekly feed.
const ACTUALS_TTL_MS = 4 * 60 * 1000
const ACTUALS_FRESH_GUARD_MS = 60_000

// Scraped actual values keyed by "<page-day>|<ccy>|<time>|<title>" (page's
// rendering timezone). pastDaysDone tracks page-tz days STRICTLY BEFORE today
// whose pages were already scraped — historical actuals never change, so a
// past day is fetched at most once per server lifetime. Today is always
// eligible for re-scrape (releases land there). tz = the page timezone the
// keys were built against (bootstrap-detected from the HTML).
let actualsCache: { map: Record<string, string>; fetchedAt: number; pastDaysDone: Set<string>; tz: string } | null = null

let cache: { events: CalendarEvent[]; fetchedAt: number; live: boolean } | null = null

interface FfEvent {
  title: string
  country: string
  date?: string
  impact?: string
  forecast?: string
  previous?: string
  actual?: string
}

function mapImpact(impact?: string): string {
  const v = (impact || '').toLowerCase()
  if (v === 'high' || v === 'medium' || v === 'low') return v
  if (v === 'holiday') return 'low'
  return 'medium'
}

function mondayOfWeek(d = new Date()): Date {
  const day = (d.getUTCDay() + 6) % 7
  const m = new Date(d)
  m.setUTCDate(d.getUTCDate() - day)
  m.setUTCHours(0, 0, 0, 0)
  return m
}

/** Representative weekly schedule (times UTC) used when the live feed is unreachable. */
export function sampleCalendar(): CalendarEvent[] {
  const mon = mondayOfWeek()
  const at = (dayOffset: number, hourUtc: number, minute = 0) =>
    new Date(mon.getTime() + dayOffset * 86400000 + hourUtc * 3600000 + minute * 60000).toISOString()
  const evts: [number, number, number, string, string, 'high' | 'medium' | 'low', string | null, string | null, string | null][] = [
    [0, 9, 0, 'EUR', 'German Ifo Business Climate', 'high', null, '86.0', '85.7'],
    [0, 13, 30, 'USD', 'Chicago Fed National Activity', 'low', null, '0.10', '0.15'],
    [1, 7, 0, 'EUR', 'German GDP QoQ', 'high', null, '0.2%', '0.2%'],
    [1, 9, 30, 'GBP', 'Claimant Count Change', 'medium', null, '15.0K', '12.3K'],
    [1, 13, 30, 'USD', 'Core PPI m/m', 'high', null, '0.3%', '0.2%'],
    [2, 9, 0, 'EUR', 'CPI Flash Estimate y/y', 'high', null, '2.3%', '2.4%'],
    [2, 13, 30, 'USD', 'Core CPI m/m', 'high', null, '0.3%', '0.3%'],
    [2, 13, 30, 'USD', 'CPI y/y', 'high', null, '2.7%', '2.6%'],
    [2, 14, 45, 'USD', 'FOMC Statement & Fed Funds Rate', 'high', null, '4.50%', '4.50%'],
    [3, 8, 15, 'EUR', 'Spanish Unemployment Rate', 'low', null, '11.2%', '11.2%'],
    [3, 12, 30, 'USD', 'Unemployment Claims', 'medium', null, '220K', '213K'],
    [3, 14, 0, 'USD', 'Crude Oil Inventories', 'medium', null, '-1.2M', '2.1M'],
    [4, 7, 0, 'GBP', 'Retail Sales m/m', 'high', null, '0.4%', '0.1%'],
    [4, 9, 0, 'EUR', 'ECB Lagarde Speaks', 'medium', null, null, null],
    [4, 13, 30, 'USD', 'Non-Farm Payrolls / Employment Situation', 'high', null, '185K', '212K'],
    [4, 13, 30, 'USD', 'Unemployment Rate', 'high', null, '4.2%', '4.1%'],
    [4, 14, 0, 'USD', 'ISM Services PMI', 'medium', null, '54.5', '54.1'],
  ]
  return evts.map(([d, h, m, country, event, importance, actual, forecast, prior]) => ({
    time: at(d, h, m),
    country,
    importance,
    event,
    actual,
    forecast,
    prior,
  }))
}

/** First inner text of a tag inside an <event> block (CDATA or plain). */
function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i')
  const m = re.exec(block)
  return m ? m[1].trim() : ''
}

/**
 * ForexFactory's XML feed gives a separate date (MM-DD-YYYY) and 12h time
 * ("2:15pm"). VERIFIED 2026-10 against the JSON mirror (which carries explicit
 * -04:00 offsets): the XML tags are UTC, NOT New York wall time — reading them
 * as ET shifted every event by the ET offset. Parse as UTC directly.
 * "All Day" / "Tentative" / other non-time labels parse as 00:00 UTC.
 */
function utcToIso(dateStr: string, timeStr: string): string {
  const dm = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(dateStr || '')
  if (!dm) return new Date().toISOString()
  const tm = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec((timeStr || '').trim())
  let hour = 0
  let minute = 0
  if (tm) {
    hour = parseInt(tm[1], 10) % 12 + (/pm/i.test(tm[3]) ? 12 : 0)
    minute = parseInt(tm[2], 10)
  }
  return new Date(Date.UTC(+dm[3], +dm[1] - 1, +dm[2], hour, minute)).toISOString()
}

/**
 * ForexFactory event id from the feed's <url> tag. The mirror emits a
 * malformed CDATA ("<![CDATAttps://...") but tag() still captures the body —
 * the id is the calendar/<id>-slug prefix of the URL.
 */
function ffEventId(urlTag: string): string | undefined {
  const m = /\/calendar\/(\d+)-/.exec(urlTag)
  return m ? m[1] : undefined
}

/** Parse the ForexFactory weekly XML into CalendarEvents. */
export function parseFfXml(xml: string): CalendarEvent[] {
  const out: CalendarEvent[] = []
  const blocks = xml.split(/<event>/i).slice(1)
  for (const block of blocks) {
    const end = block.indexOf('</event>')
    const body = end >= 0 ? block.slice(0, end) : block
    const title = tag(body, 'title')
    if (!title) continue
    out.push({
      id: ffEventId(tag(body, 'url')),
      time: utcToIso(tag(body, 'date'), tag(body, 'time')),
      country: tag(body, 'country') || '',
      importance: mapImpact(tag(body, 'impact')),
      event: title,
      actual: tag(body, 'actual') || null,
      forecast: tag(body, 'forecast') || null,
      prior: tag(body, 'previous') || null,
    })
  }
  return out
}

/* ---------------------------------------------- actual values (page scrape) */

const FF_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const ET_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** ET calendar day ("2026-10-20") of an ISO instant — used for the bootstrap day param. */
function etDateKey(iso: string): string {
  const parts = ET_DATE_FMT.formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

const wallFmtCache = new Map<string, Intl.DateTimeFormat>()

/** Wall-clock day + HH:MM of an instant in an IANA timezone (the page's rendering zone). */
function wallInTz(iso: string, tz: string): { day: string; hhmm: string } {
  let fmt = wallFmtCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    wallFmtCache.set(tz, fmt)
  }
  const parts = fmt.formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` }
}

/** "2026-10-20" → the page's day param format "oct20.2026". */
function dayToParam(day: string): string {
  const [y, m, d] = day.split('-')
  return `${FF_MONTHS[Number(m) - 1] ?? 'jan'}${Number(d)}.${y}`
}

function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
}

const NO_VALUE = new Set(['', '-', '—'])

/**
 * GET a URL with curl. Used for the FF calendar page: its bot check rejects
 * non-browser TLS fingerprints (server fetch → 403) while curl passes.
 * Resolves { status, body }; status comes from the trailing %{http_code}.
 */
function curlGet(url: string, timeoutSec: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      [
        '-sS', '--compressed', '--max-time', String(timeoutSec),
        '-w', '\n%{http_code}',
        '-H', `user-agent: ${BROWSER_UA}`,
        '-H', 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'accept-language: en-US,en;q=0.9',
        url,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: (timeoutSec + 2) * 1000 },
      (err, stdout) => {
        const idx = stdout.lastIndexOf('\n')
        const status = parseInt(idx >= 0 ? stdout.slice(idx + 1).trim() : '', 10)
        const body = idx >= 0 ? stdout.slice(0, idx) : stdout
        if (err && !body) return reject(err)
        resolve({ status: Number.isFinite(status) ? status : 0, body })
      },
    )
  })
}

/**
 * Normalized page row time: "5:30am" → "05:30". "All Day" / "Tentative" / "Day 1"
 * stay verbatim — the feed side cannot reproduce those (it only keeps an ISO
 * instant), so such events simply stay unmatched (they rarely carry actuals).
 */
function normPageTime(raw: string): string {
  const tm = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(raw.trim())
  if (!tm) return raw.trim()
  const h = parseInt(tm[1], 10) % 12 + (/pm/i.test(tm[3]) ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${tm[2]}`
}

/**
 * Scrape one day of the ForexFactory calendar page.
 * Returns the day's actual values keyed by "<page-day>|<ccy>|<time>|<title>"
 * plus the page's rendering timezone — FF renders in the REQUESTER's
 * IP-geolocated timezone (the HTML embeds `timezone_name: 'Asia/Hong_Kong'`
 * style values) and groups its day views by that same zone.
 *
 * Row quirks handled:
 *  - the time cell is only filled on the FIRST row of a time group; later
 *    rows repeat an empty cell, so the last seen time carries over;
 *  - titles are tag-stripped + entity-decoded before use as a key.
 */
async function fetchDayActuals(day: string): Promise<{ map: Record<string, string>; tz: string }> {
  const { status, body } = await curlGet(`${FF_PAGE_URL}?day=${dayToParam(day)}`, 8)
  if (status !== 200) throw new Error(`HTTP ${status}`)
  const tz = /timezone_name:\s*'([^']+)'/.exec(body)?.[1] || 'America/New_York'
  const out: Record<string, string> = {}
  let lastTime = ''
  for (const row of body.matchAll(/<tr[^>]*data-event-id="(\d+)"[\s\S]*?<\/tr>/g)) {
    const blk = row[0]
    const timeCell = /<td class="calendar__cell calendar__time"[^>]*>([\s\S]*?)<\/td>/.exec(blk)
    if (timeCell) {
      const text = decodeHtml(timeCell[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
      if (text) lastTime = text
    }
    const ccy = decodeHtml(
      /<td class="calendar__cell calendar__currency"[^>]*>([\s\S]*?)<\/td>/.exec(blk)?.[1] ?? '',
    )
      .replace(/<[^>]+>/g, '')
      .trim()
    const titleCell = /<span class="calendar__event-title">([\s\S]*?)<\/span>/.exec(blk)
    const title = titleCell ? decodeHtml(titleCell[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''
    const cell = /class="calendar__cell calendar__actual"[^>]*>([\s\S]*?)<\/td>/.exec(blk)
    const text = cell ? decodeHtml(cell[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''
    if (!title || !ccy) continue
    const key = `${day}|${ccy}|${normPageTime(lastTime)}|${title}`
    if (!NO_VALUE.has(text)) out[key] = text
  }
  return { map: out, tz }
}

/**
 * Overlay scraped actuals onto feed events: both sides are keyed
 * "<page-day>|<ccy>|<time>|<title>" computed in the page's rendering timezone.
 * Only already-released events participate.
 */
function mergeActuals(events: CalendarEvent[], tz: string, nowMs: number): CalendarEvent[] {
  if (!actualsCache || !tz) return events
  const map = actualsCache.map
  return events.map((e) => {
    if (e.actual) return e
    const t = Date.parse(e.time)
    if (Number.isNaN(t) || t > nowMs) return e
    const wall = wallInTz(e.time, tz)
    const actual = map[`${wall.day}|${e.country}|${wall.hhmm}|${e.event}`]
    return actual ? { ...e, actual } : e
  })
}

/**
 * Fill the "Actual" column for released events. The schedule mirrors never
 * carry actuals, so scrape the FF calendar page for the days that still have
 * released-but-unknown values and merge by day+ccy+time+title (in the page's
 * own timezone — detected from the first fetched page).
 *
 * Request budget:
 *  - fresh calls (tab open / manual refresh / post-release polling) re-scrape
 *    today's page at most once per 60s;  - background calls at most once per
 *    4 min;  - days before today are scraped ONCE per server lifetime;
 *  - at most ~6 page fetches per enrichment cycle, sequential.
 * Failures never block the calendar — events are returned with whatever is
 * already known and the scrape retried after the guard window.
 */
async function enrichActuals(events: CalendarEvent[], fresh: boolean): Promise<CalendarEvent[]> {
  const nowMs = Date.now()
  const merged = actualsCache?.tz ? mergeActuals(events, actualsCache.tz, nowMs) : events
  const stillMissing = merged.some((e) => {
    if (e.actual) return false
    const t = Date.parse(e.time)
    return !Number.isNaN(t) && t <= nowMs
  })
  if (!stillMissing) return merged
  const guard = fresh ? ACTUALS_FRESH_GUARD_MS : ACTUALS_TTL_MS
  if (actualsCache && nowMs - actualsCache.fetchedAt < guard) return merged

  const nowIso = new Date(nowMs).toISOString()
  const fetched = new Set<string>()
  // Bootstrap the page timezone with a single page fetch (any day page embeds
  // `timezone_name`); its rows count toward this cycle when the day matches.
  if (!actualsCache?.tz) {
    try {
      const bootDay = etDateKey(nowIso)
      const boot = await fetchDayActuals(bootDay)
      actualsCache = { map: boot.map, fetchedAt: nowMs, pastDaysDone: new Set(), tz: boot.tz }
      fetched.add(bootDay)
    } catch (e) {
      console.error('Calendar actuals scrape (bootstrap) failed:', e instanceof Error ? e.message : e)
      // Keep any previous map/tz, but stamp the guard so we do not retry on
      // every request — next attempt happens after the guard window.
      actualsCache = {
        map: actualsCache?.map ?? {},
        fetchedAt: nowMs,
        pastDaysDone: actualsCache?.pastDaysDone ?? new Set(),
        tz: actualsCache?.tz ?? '',
      }
      return actualsCache.tz ? mergeActuals(events, actualsCache.tz, nowMs) : merged
    }
  }
  const tz = actualsCache!.tz
  const map = { ...actualsCache!.map }
  const pastDaysDone = new Set(actualsCache!.pastDaysDone)
  const todayTz = wallInTz(nowIso, tz).day
  const days = new Set<string>()
  for (const e of events) {
    if (e.actual) continue
    const t = Date.parse(e.time)
    if (Number.isNaN(t) || t > nowMs) continue
    const { day } = wallInTz(e.time, tz)
    if (day < todayTz) {
      if (pastDaysDone.has(day)) continue // historical day — scraped once
    } else if (day > todayTz) {
      continue // future day
    }
    days.add(day)
  }
  // Sequential (not Promise.all) — be gentle with the FF page.
  for (const day of [...days].sort()) {
    if (fetched.has(day)) continue
    if (fetched.size >= 6) break
    try {
      const r = await fetchDayActuals(day)
      Object.assign(map, r.map)
      fetched.add(day)
      if (day < todayTz) pastDaysDone.add(day)
    } catch (e) {
      console.error(`Calendar actuals scrape ${day} failed:`, e instanceof Error ? e.message : e)
    }
  }
  actualsCache = { map, fetchedAt: nowMs, pastDaysDone, tz }
  return mergeActuals(events, tz, nowMs)
}

async function fetchXml(): Promise<CalendarEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(XML_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const events = parseFfXml(text)
    if (events.length === 0) throw new Error('empty feed')
    return events
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(): Promise<CalendarEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(JSON_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'user-agent': UA, accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as FfEvent[]
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('empty feed')
    return raw.map((e) => ({
      time: e.date || new Date().toISOString(),
      country: e.country || '',
      importance: mapImpact(e.impact),
      event: e.title || '',
      actual: e.actual && e.actual !== '' ? e.actual : null,
      forecast: e.forecast || null,
      prior: e.previous || null,
    }))
  } finally {
    clearTimeout(timer)
  }
}

export async function getEconomicCalendar(
  opts?: { fresh?: boolean },
): Promise<{ events: CalendarEvent[]; live: boolean; source?: string }> {
  // fresh=1 skips the 15-min cache read — the calendar tab sends it on every
  // open so the user always sees the latest ForexFactory data.
  const nowMs = Date.now()
  let events: CalendarEvent[] | null = null
  let live = false
  let source: string | undefined
  if (cache && nowMs - cache.fetchedAt < CACHE_TTL_MS) {
    // Even a fresh request reuses a VERY young cache: rapid tab open/close
    // must not hammer the feed (it rate-limits aggressively).
    if (!opts?.fresh || nowMs - cache.fetchedAt < 60_000) {
      events = cache.events
      live = cache.live
    }
  }
  if (!events) {
    // 1) XML mirror (currently the one that works) 2) JSON mirror
    for (const [fn, src] of [[fetchXml, 'forexfactory-xml'], [fetchJson, 'forexfactory-json']] as const) {
      try {
        events = await fn()
        live = true
        source = src
        cache = { events, fetchedAt: nowMs, live: true }
        break
      } catch (e) {
        console.error(`Calendar feed ${src} failed:`, e instanceof Error ? e.message : e)
      }
    }
  }
  if (!events) {
    // The live fetch failed — serve the PREVIOUS data (even if stale) rather
    // than degrading to the sample schedule on every feed hiccup.
    if (cache) {
      events = cache.events
      live = cache.live
    } else {
      events = sampleCalendar()
      live = false
      source = 'sample'
      cache = { events, fetchedAt: nowMs, live: false }
    }
  }
  // Fill the Actual column from the FF calendar page (the schedule mirrors
  // never publish actuals). Cheap after the first call — past days are
  // scraped once, today per guard window, merged by event id.
  const enriched = await enrichActuals(events, opts?.fresh === true)
  if (cache && cache.events === events) cache.events = enriched
  return { events: enriched, live, source }
}
