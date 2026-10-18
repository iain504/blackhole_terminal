// Economic calendar (Alpaca does not provide one).
// Primary source: ForexFactory weekly feed via faireconomy.media.
// NOTE (2026-10): the .json mirror answers 429 (rate limited) from this host
// while the .xml mirror returns 200 — so XML is the primary and the JSON feed
// is only a fallback attempt. Last resort: a bundled representative schedule.
import { CalendarEvent } from './market-types'

const XML_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml'
const JSON_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const CACHE_TTL_MS = 15 * 60 * 1000
const UA = 'Mozilla/5.0 (compatible; TradeTerminal/1.0; +https://localhost)'

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
 * ("2:15pm"), both in America/New_York wall time. Convert to a real UTC ISO
 * instant, honoring EST/EDT via Intl (two-iteration fixed point).
 */
function etToIso(dateStr: string, timeStr: string): string {
  const dm = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(dateStr || '')
  if (!dm) return new Date().toISOString()
  const mm = dm[1].padStart(2, '0')
  const dd = dm[2].padStart(2, '0')
  const yyyy = dm[3]
  const tm = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec((timeStr || '').trim())
  let hour = 0
  let minute = 0
  if (tm) {
    hour = parseInt(tm[1], 10) % 12 + (/pm/i.test(tm[3]) ? 12 : 0)
    minute = parseInt(tm[2], 10)
  }
  const wall = `${yyyy}-${mm}-${dd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  // Fixed point: find the UTC instant u whose New York wall clock equals `wall`.
  // wallUtc = the wall time read as-if-UTC (constant anchor).
  const wallUtc = Date.parse(`${wall}Z`)
  let utc = wallUtc
  for (let i = 0; i < 4; i++) {
    const parts = dtf.formatToParts(new Date(utc))
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
    const asUtc = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}Z`)
    const diff = wallUtc - asUtc
    if (diff === 0) break
    utc += diff
  }
  return new Date(utc).toISOString()
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
      time: etToIso(tag(body, 'date'), tag(body, 'time')),
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

export async function getEconomicCalendar(): Promise<{ events: CalendarEvent[]; live: boolean; source?: string }> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { events: cache.events, live: cache.live }
  }
  // 1) XML mirror (currently the one that works) 2) JSON mirror 3) sample
  for (const [fn, source] of [[fetchXml, 'forexfactory-xml'], [fetchJson, 'forexfactory-json']] as const) {
    try {
      const events = await fn()
      cache = { events, fetchedAt: Date.now(), live: true }
      return { events, live: true, source }
    } catch (e) {
      console.error(`Calendar feed ${source} failed:`, e instanceof Error ? e.message : e)
    }
  }
  const events = sampleCalendar()
  cache = { events, fetchedAt: Date.now(), live: false }
  return { events, live: false, source: 'sample' }
}
