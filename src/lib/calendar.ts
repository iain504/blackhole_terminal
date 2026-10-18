// Economic calendar (Alpaca does not provide one).
// Primary source: ForexFactory weekly JSON mirror (faireconomy.media).
// Falls back to a bundled representative schedule when the feed is unreachable.
import { CalendarEvent } from './market-types'

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const CACHE_TTL_MS = 30 * 60 * 1000

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
    // day, hour, minute, country, event, importance, actual, forecast, prior
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

export async function getEconomicCalendar(): Promise<{ events: CalendarEvent[]; live: boolean }> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { events: cache.events, live: cache.live }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(FEED_URL, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as FfEvent[]
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('empty feed')
    const events: CalendarEvent[] = raw.map((e) => ({
      time: e.date || new Date().toISOString(),
      country: e.country || '',
      importance: mapImpact(e.impact),
      event: e.title || '',
      actual: e.actual && e.actual !== '' ? e.actual : null,
      forecast: e.forecast || null,
      prior: e.previous || null,
    }))
    cache = { events, fetchedAt: Date.now(), live: true }
    return { events, live: true }
  } catch (e) {
    console.error('Calendar feed failed, using sample:', e instanceof Error ? e.message : e)
    const events = sampleCalendar()
    cache = { events, fetchedAt: Date.now(), live: false }
    return { events, live: false }
  } finally {
    clearTimeout(timer)
  }
}
