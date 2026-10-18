// Yahoo Finance earnings dates (same data the python `yfinance` lib exposes:
// quoteSummary modules `calendarEvents` + `earningsHistory`).
// Yahoo requires a cookie + crumb for quoteSummary — this mirrors the
// yfinance flow: GET fc.yahoo.com (sets A1/A3 cookies) → GET /v1/test/getcrumb
// → call quoteSummary with ?crumb=...
// Results are cached in local memory (earnings change rarely).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export interface YahooEarningsEvent {
  ts: number // unix seconds (report date, UTC midnight-ish)
  epsActual?: number | null
  epsEstimate?: number | null
  upcoming?: boolean
}

export interface YahooEarnings {
  events: YahooEarningsEvent[]
  source: 'yfinance'
}

interface YahooSession {
  cookie: string
  crumb: string
  at: number
}

let session: YahooSession | null = null
let sessionPromise: Promise<YahooSession> | null = null

async function fetchSession(): Promise<YahooSession> {
  // 1) collect cookies (fc.yahoo.com 404s but sets the A1/A3 cookies — that is expected)
  const res = await fetch('https://fc.yahoo.com/', {
    headers: { 'user-agent': UA },
    redirect: 'follow',
  }).catch(() => null)
  const setCookies =
    res?.headers.getSetCookie?.() ??
    (res ? [res.headers.get('set-cookie')].filter(Boolean) : [])
  const cookie =
    setCookies
      .map((c) => String(c).split(';')[0])
      .filter(Boolean)
      .join('; ') || ''

  // 2) crumb
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'user-agent': UA, cookie },
  })
  if (!crumbRes.ok) throw new Error(`yahoo getcrumb failed (${crumbRes.status})`)
  const crumb = (await crumbRes.text()).trim()
  if (!crumb || crumb.startsWith('{')) throw new Error('yahoo crumb invalid')
  return { cookie, crumb, at: Date.now() }
}

async function getSession(force = false): Promise<YahooSession> {
  if (!force && session && Date.now() - session.at < 30 * 60 * 1000) return session
  if (!sessionPromise || force) {
    sessionPromise = fetchSession()
      .then((s) => {
        session = s
        return s
      })
      .finally(() => {
        sessionPromise = null
      })
  }
  return sessionPromise
}

// ---- earnings cache (memory) ----
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6h
const STALE_TTL = 7 * 24 * 60 * 60 * 1000 // serve stale for 7d if live fetch fails
const cache = new Map<string, { data: YahooEarnings; at: number }>()

interface QuoteSummaryResp {
  quoteSummary?: {
    result?: {
      calendarEvents?: {
        earnings?: {
          earningsDate?: { raw?: number; fmt?: string }[]
          isEarningsDateEstimate?: boolean
        }
      }
      earningsHistory?: {
        history?: {
          quarter?: { raw?: number; fmt?: string }
          epsActual?: { raw?: number }
          epsEstimate?: { raw?: number }
        }[]
      }
    }[]
    error?: { description?: string } | null
  }
}

async function fetchEarningsLive(symbol: string): Promise<YahooEarnings> {
  const s = await getSession()
  const modules = encodeURIComponent('calendarEvents,earningsHistory')
  const call = async (sess: YahooSession) => {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol,
    )}?modules=${modules}&crumb=${encodeURIComponent(sess.crumb)}`
    return fetch(url, {
      headers: { 'user-agent': UA, cookie: sess.cookie, accept: 'application/json' },
    })
  }
  let res = await call(s)
  // expired/invalid crumb → refresh once and retry
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const fresh = await getSession(true)
    res = await call(fresh)
  }
  if (!res.ok) throw new Error(`yahoo quoteSummary ${res.status}`)
  const json = (await res.json()) as QuoteSummaryResp
  const r = json.quoteSummary?.result?.[0]
  if (!r) throw new Error('yahoo quoteSummary empty')

  const events: YahooEarningsEvent[] = []
  const seenDays = new Set<string>()
  const push = (e: YahooEarningsEvent) => {
    if (!Number.isFinite(e.ts)) return
    const key = new Date(e.ts * 1000).toISOString().slice(0, 10)
    if (seenDays.has(key)) return
    seenDays.add(key)
    events.push(e)
  }
  // past quarters (most recent first) — quarter.raw = report date
  for (const h of r.earningsHistory?.history ?? []) {
    const ts = h.quarter?.raw
    if (!ts) continue
    push({
      ts: Math.floor(ts),
      epsActual: h.epsActual?.raw ?? null,
      epsEstimate: h.epsEstimate?.raw ?? null,
    })
  }
  // next upcoming earnings (earningsDate[0] = consensus estimate)
  const up = r.calendarEvents?.earnings?.earningsDate?.[0]?.raw
  if (up && up * 1000 > Date.now() - 86400 * 1000) {
    push({ ts: Math.floor(up), upcoming: true })
  }
  return { events: events.sort((a, b) => a.ts - b.ts), source: 'yfinance' }
}

/** Earnings dates for a symbol (past quarters + next upcoming), yfinance-style. Returns null when Yahoo is unavailable. */
export async function getYahooEarnings(symbol: string): Promise<YahooEarnings | null> {
  const key = symbol.toUpperCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data
  try {
    const data = await fetchEarningsLive(key)
    cache.set(key, { data, at: Date.now() })
    return data
  } catch {
    // stale-while-error
    if (hit && Date.now() - hit.at < STALE_TTL) return hit.data
    return null
  }
}
