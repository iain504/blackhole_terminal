// Alpaca market data client (server-side only).
// Stocks use v2/stocks/*; Crypto uses the DIFFERENT v1beta3/crypto/us/* API.
// When no API keys exist (env or per-user), all functions fall back to the
// deterministic demo simulator so the app always works — but the failure
// REASON is surfaced so the UI can tell "no keys" apart from "keys rejected".
import { db } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/crypt'
import {
  Bar, Quote, NewsItem, MarkerData, Timeframe, TIMEFRAMES,
  isCryptoSymbol,
} from './market-types'
import { simBars, simQuote, simNews, simMarkers } from './simulator'
import { getBinanceBars, getBinanceQuotes } from './binance'
import { saveBars, loadBars, hasCoverage } from './bar-store'

const DATA_BASE = 'https://data.alpaca.markets'
const ALPACA_TIMEOUT_MS = 9000
// v1.99.2 — bar PAGES are the one endpoint with multi-MB JSON payloads: a deep
// backtest window (e.g. 200d of 5m ≈ 30–50 paginated pages @ ~2k bars/page)
// legitimately takes >9s per page on a slow link, and the hard 9s abort killed
// the WHOLE fetch (dev.log: "Alpaca /v2/stocks/bars… failed: The operation was
// aborted"). Bar pages get a 20s budget + automatic retries below.
const ALPACA_BARS_TIMEOUT_MS = 20_000
const ALPACA_FETCH_ATTEMPTS = 3
const ALPACA_RETRY_BASE_MS = 600

export interface AlpacaKeys {
  keyId: string
  secret: string
}

/** Which account a Trading-API call targets (a key only works on ONE). */
export type AlpacaKeyMode = 'paper' | 'live'

/** Where a resolved key pair came from — 'legacy' = the pre-dual-key single
 * pair (assumed PAPER), 'env' = shared process keys (operator opt-in). */
export type KeyOrigin = 'paper' | 'live' | 'legacy' | 'env'

export interface AlpacaKeysWithOrigin extends AlpacaKeys {
  origin: KeyOrigin
}

/** Result of proving a key pair against BOTH trading hosts (Task 37). */
export interface AlpacaKeyCheck {
  valid: boolean
  /** which account actually accepted the keys (null = neither / unreachable) */
  detected: 'paper' | 'live' | null
  /** detected === the section the keys were tested for (null = not checked) */
  matchesMode: boolean | null
  message: string
}

/** Why a response fell back to demo data (undefined = live data, not demo). */
export type DemoReason = 'no-keys' | 'empty' | `alpaca-http-${number}` | 'alpaca-error'

export interface DemoMeta {
  demo: boolean
  reason?: DemoReason
  /** live data provider, e.g. 'binance' | 'alpaca' (undefined for demo data) */
  source?: string
}

function demoResult<T>(make: (reason: DemoReason) => T & DemoMeta, reason: DemoReason): T & DemoMeta {
  return make(reason)
}

/**
 * Validate Alpaca data-API credentials with a cheap real request.
 * Used by the settings test endpoint and after saving new keys.
 */
export async function validateAlpacaKeys(
  keyId: string,
  secret: string,
): Promise<{ valid: boolean; status: number; message: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALPACA_TIMEOUT_MS)
  try {
    const res = await fetch(`${DATA_BASE}/v2/stocks/snapshots?symbols=AAPL&feed=iex`, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (res.ok) {
      return { valid: true, status: res.status, message: 'Keys verified — live Alpaca data enabled' }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        status: res.status,
        message: 'Alpaca rejected these keys — check the Key ID and Secret (401/403).',
      }
    }
    if (res.status === 429) {
      return {
        valid: false,
        status: res.status,
        message: 'Alpaca rate limit reached (429) — wait a minute and test again.',
      }
    }
    return { valid: false, status: res.status, message: `Alpaca returned HTTP ${res.status}` }
  } catch (e) {
    return {
      valid: false,
      status: 0,
      message: `Could not reach Alpaca: ${e instanceof Error ? e.message : 'network error'}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

// Alpaca Trading API hosts (duplicated from trading.ts — trading.ts imports
// THIS module, so the base URLs live here to avoid a circular import).
const PAPER_TRADE_BASE = 'https://paper-api.alpaca.markets'
const LIVE_TRADE_BASE = 'https://api.alpaca.markets'

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  // Task 37 — DUAL key pairs: one Alpaca key only ever works on a PAPER or a
  // LIVE account (never both), so each account gets its own encrypted slot.
  alpacaPaperKeyIdEnc?: string
  alpacaPaperSecretEnc?: string
  alpacaLiveKeyIdEnc?: string
  alpacaLiveSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
  tradeMode?: string
}

/**
 * Task 3-d (security) — env-key fallback gate. The process-wide
 * APCA_API_KEY_ID/SECRET pair is only used when ALLOW_SHARED_BROKER === 'true'
 * (default OFF). Without this gate ANY registered user could silently trade
 * the shared broker account: this resolver also backs tradeFetch() in
 * trading.ts (order placement), so the fallback must be an explicit operator
 * opt-in, not an accident of deployment. Users otherwise trade with the keys
 * they save in Settings.
 */
function sharedBrokerAllowed(): boolean {
  return process.env.ALLOW_SHARED_BROKER === 'true'
}

function envAlpacaKeys(): AlpacaKeysWithOrigin | null {
  if (!sharedBrokerAllowed()) return null
  const envId = process.env.APCA_API_KEY_ID
  const envSecret = process.env.APCA_API_SECRET_KEY
  if (envId && envSecret) return { keyId: envId, secret: envSecret, origin: 'env' }
  return null
}

/** Decrypt one stored pair ('paper' | 'live' | 'legacy'). null = not set. */
function pairFrom(
  s: UserSettings | null,
  which: 'paper' | 'live' | 'legacy',
): AlpacaKeys | null {
  const kidEnc =
    which === 'live' ? s?.alpacaLiveKeyIdEnc : which === 'paper' ? s?.alpacaPaperKeyIdEnc : s?.alpacaKeyIdEnc
  const secEnc =
    which === 'live' ? s?.alpacaLiveSecretEnc : which === 'paper' ? s?.alpacaPaperSecretEnc : s?.alpacaSecretEnc
  if (!kidEnc || !secEnc) return null
  const keyId = decrypt(kidEnc)
  const secret = decrypt(secEnc)
  return keyId && secret ? { keyId, secret } : null
}

/**
 * Task 37 — MODE-STRICT key resolution for the Trading API. A saved key only
 * ever works on one host: paper keys → paper-api.alpaca.markets, live keys →
 * api.alpaca.markets. Feeding a paper key to the live host is exactly what
 * produced the periodic "Trading live /v2/positions -> 401" log flood (Task
 * 36), so:
 *  - paper mode: Paper pair → legacy single pair (pre-dual-key, assumed paper)
 *    → env (operator opt-in).
 *  - live mode: Live pair → env. The legacy pair NEVER serves live — its
 *    account type is unknown-by-construction and a wrong guess is a 401.
 */
export async function getAlpacaKeysForMode(
  userId: string | undefined,
  mode: AlpacaKeyMode,
): Promise<AlpacaKeysWithOrigin | null> {
  if (userId) {
    const user = await db.user.findUnique({ where: { id: userId } })
    const s = (user?.settings as UserSettings | null) || null
    const own = pairFrom(s, mode)
    if (own) return { ...own, origin: mode }
    if (mode === 'paper') {
      const legacy = pairFrom(s, 'legacy')
      if (legacy) return { ...legacy, origin: 'legacy' }
    }
  }
  return envAlpacaKeys()
}

/**
 * Any usable key for the MODE-AGNOSTIC data API (data.alpaca.markets accepts
 * paper and live keys alike). Preference follows the user's tradeMode, then
 * the other pair, then the legacy single pair, then env.
 */
export async function resolveAnyAlpacaKeys(userId: string | undefined): Promise<AlpacaKeysWithOrigin | null> {
  if (userId) {
    const user = await db.user.findUnique({ where: { id: userId } })
    const s = (user?.settings as UserSettings | null) || null
    const preferred: AlpacaKeyMode = s?.tradeMode === 'live' ? 'live' : 'paper'
    for (const which of [preferred, preferred === 'paper' ? ('live' as const) : ('paper' as const)]) {
      const own = pairFrom(s, which)
      if (own) return { ...own, origin: which }
    }
    const legacy = pairFrom(s, 'legacy')
    if (legacy) return { ...legacy, origin: 'legacy' }
  }
  return envAlpacaKeys()
}

export async function getAlpacaKeys(userId?: string): Promise<AlpacaKeys | null> {
  const r = await resolveAnyAlpacaKeys(userId)
  return r ? { keyId: r.keyId, secret: r.secret } : null
}

export async function hasAlpacaKeys(userId: string | undefined, mode?: AlpacaKeyMode): Promise<boolean> {
  if (mode) return (await getAlpacaKeysForMode(userId, mode)) !== null
  return (await resolveAnyAlpacaKeys(userId)) !== null
}

// ---- legacy single-pair migration (Task 37) ----

const legacyMigrated = new Set<string>()

/**
 * One-time copy of the pre-dual-key `alpacaKeyIdEnc/alpacaSecretEnc` pair into
 * the correct NEW slot. The account type is DETECTED with a real /v2/account
 * call against both hosts (definitive — a key works on exactly one); when the
 * network check can't decide, the pair defaults to Paper (paper keys start
 * with "PK", and every legacy key in this deployment is one). Legacy fields
 * are kept (never deleted) so older config exports keep round-tripping.
 * Runs at most once per process per user, triggered from settings GET.
 */
export async function migrateLegacyAlpacaKeys(userId: string): Promise<void> {
  if (legacyMigrated.has(userId)) return
  legacyMigrated.add(userId)
  try {
    const user = await db.user.findUnique({ where: { id: userId } })
    const s = (((user?.settings as UserSettings | null) || {}) as Record<string, unknown>)
    const legacyIdEnc = s.alpacaKeyIdEnc
    const legacySecEnc = s.alpacaSecretEnc
    if (typeof legacyIdEnc !== 'string' || typeof legacySecEnc !== 'string') return
    if (s.alpacaPaperKeyIdEnc && s.alpacaLiveKeyIdEnc) return // both slots already filled
    const keyId = decrypt(legacyIdEnc)
    const secret = decrypt(legacySecEnc)
    if (!keyId || !secret) return
    const check = await detectAlpacaKeyAccount(keyId, secret)
    const target = check.detected === 'live' ? 'live' : 'paper' // undecided → paper
    if (target === 'paper') {
      if (s.alpacaPaperKeyIdEnc) return
      s.alpacaPaperKeyIdEnc = encrypt(keyId)
      s.alpacaPaperSecretEnc = encrypt(secret)
    } else {
      if (s.alpacaLiveKeyIdEnc) return
      s.alpacaLiveKeyIdEnc = encrypt(keyId)
      s.alpacaLiveSecretEnc = encrypt(secret)
    }
    const { Prisma } = await import('@prisma/client')
    await db.user.update({
      where: { id: userId },
      data: { settings: s as unknown as Prisma.InputJsonValue },
    })
  } catch {
    /* best-effort — the legacy fallback in getAlpacaKeysForMode keeps working */
  }
}

/**
 * Task 37 — PROVE which account a key pair belongs to by calling
 * /v2/account on BOTH trading hosts: a key returns 200 on exactly one.
 * This is the definitive paper-vs-live answer (key-ID prefixes PK… / AK… are
 * only a hint) and backs the Settings test endpoint + save-time validation.
 */
export async function detectAlpacaKeyAccount(
  keyId: string,
  secret: string,
  expectedMode?: AlpacaKeyMode,
): Promise<AlpacaKeyCheck> {
  const id = keyId.trim()
  const prefixHint = id.startsWith('PK')
    ? 'Keys starting with "PK" belong to a PAPER account.'
    : id.startsWith('AK')
      ? 'Keys starting with "AK" belong to a LIVE account.'
      : ''
  const paperStatus = await tradingAccountStatus(PAPER_TRADE_BASE, id, secret)
  if (paperStatus >= 200 && paperStatus < 300) {
    return {
      valid: true,
      detected: 'paper',
      matchesMode: expectedMode ? expectedMode === 'paper' : null,
      message: 'Keys verified on the PAPER account (paper-api.alpaca.markets).',
    }
  }
  const liveStatus = await tradingAccountStatus(LIVE_TRADE_BASE, id, secret)
  if (liveStatus >= 200 && liveStatus < 300) {
    return {
      valid: true,
      detected: 'live',
      matchesMode: expectedMode ? expectedMode === 'live' : null,
      message: 'Keys verified on the LIVE account (api.alpaca.markets).',
    }
  }
  if ([paperStatus, liveStatus].some((c) => c === 401 || c === 403)) {
    return {
      valid: false,
      detected: null,
      matchesMode: expectedMode ? false : null,
      message: `Alpaca rejected these keys on BOTH the paper and live accounts (401/403). Check the Key ID and Secret.${prefixHint ? ` ${prefixHint}` : ''}`,
    }
  }
  return {
    valid: false,
    detected: null,
    matchesMode: null,
    message: `Could not reach Alpaca (paper HTTP ${paperStatus}, live HTTP ${liveStatus}) — try again.`,
  }
}

/** GET /v2/account against one trading host → HTTP status (0 = network fail). */
async function tradingAccountStatus(base: string, keyId: string, secret: string): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`${base}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    return res.status
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/** Returns the parsed body plus HTTP status (0 = network/timeout failure).
 * v1.99.2 — TRANSIENT-FAILURE RETRY: network stalls and slow pages used to be
 * fatal after ONE attempt ("The operation was aborted" in dev.log). Now any
 * network/abort error retries up to ALPACA_FETCH_ATTEMPTS with a linear
 * backoff. HTTP status errors (401/403/429…) are NOT retried — a rejected key
 * or a rate limit will not heal in 600ms, and retrying those just delays the
 * honest error. Cheap endpoints keep the 9s budget; bar pages pass 20s. */
async function alpacaFetch<T>(
  path: string,
  keys: AlpacaKeys,
  opts?: { timeoutMs?: number },
): Promise<{ data: T | null; status: number }> {
  const timeoutMs = opts?.timeoutMs ?? ALPACA_TIMEOUT_MS
  for (let attempt = 1; attempt <= ALPACA_FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${DATA_BASE}${path}`, {
        headers: {
          'APCA-API-KEY-ID': keys.keyId,
          'APCA-API-SECRET-KEY': keys.secret,
          accept: 'application/json',
        },
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!res.ok) {
        console.error(`Alpaca ${path} -> HTTP ${res.status}`)
        return { data: null, status: res.status }
      }
      return { data: (await res.json()) as T, status: res.status }
    } catch (e) {
      if (attempt < ALPACA_FETCH_ATTEMPTS) {
        console.warn(
          `Alpaca ${path} attempt ${attempt}/${ALPACA_FETCH_ATTEMPTS} failed` +
            ` (${e instanceof Error ? e.message : e}) — retrying`,
        )
        await new Promise((r) => setTimeout(r, ALPACA_RETRY_BASE_MS * attempt))
        continue
      }
      console.error(`Alpaca ${path} failed after ${attempt} attempts:`, e instanceof Error ? e.message : e)
      return { data: null, status: 0 }
    } finally {
      clearTimeout(timer)
    }
  }
  return { data: null, status: 0 } // unreachable — loop always returns
}

// ---------- Bars ----------

interface AlpacaBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

function mapBars(raw: AlpacaBar[] | undefined): Bar[] {
  if (!raw) return []
  return raw.map((b) => ({
    time: Math.floor(new Date(b.t).getTime() / 1000),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }))
}

/** Aggregate daily bars into weekly (Mon-anchored) or monthly buckets (crypto API lacks 1W/1M). */
function aggregateDaily(bars: Bar[], timeframe: '1W' | '1M'): Bar[] {
  const groups = new Map<string, Bar[]>()
  for (const b of bars) {
    const d = new Date(b.time * 1000)
    let key: string
    if (timeframe === '1W') {
      const day = (d.getUTCDay() + 6) % 7 // Mon=0
      const monday = new Date(d)
      monday.setUTCDate(d.getUTCDate() - day)
      key = monday.toISOString().slice(0, 10)
    } else {
      key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    }
    const arr = groups.get(key)
    if (arr) arr.push(b)
    else groups.set(key, [b])
  }
  const out: Bar[] = []
  for (const [, arr] of groups) {
    const first = arr[0]
    const last = arr[arr.length - 1]
    out.push({
      time: first.time,
      open: first.open,
      high: Math.max(...arr.map((b) => b.high)),
      low: Math.min(...arr.map((b) => b.low)),
      close: last.close,
      volume: arr.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

interface PagedBars {
  bars: Record<string, AlpacaBar[]>
  next_page_token?: string
}

/**
 * Alpaca PAGINATES bar responses via `next_page_token` even below the limit
 * param (observed caps vary per feed/timeframe — IEX stocks ~2k bars/page,
 * crypto ~1k bars/page). Ignoring the token silently truncates to the OLDEST
 * page — the chart then "ends" days/weeks before now. This helper follows the
 * token until the last page. Default cap 60 pages (~60–120k bars) is sized to
 * cover the deepest legit window (730 days of 5m) without ballooning latency;
 * truncation is logged so a silently short window can never go unnoticed.
 */
async function fetchBarsPaged(
  path: string,
  keys: AlpacaKeys,
  symbol: string,
  maxPages = 60,
): Promise<{ bars: AlpacaBar[]; status: number; truncated: boolean }> {
  let all: AlpacaBar[] = []
  let token: string | undefined = undefined
  let status = 200
  for (let page = 0; page < maxPages; page++) {
    const url = token ? `${path}&page_token=${encodeURIComponent(token)}` : path
    const { data, status: st } = await alpacaFetch<PagedBars>(url, keys, { timeoutMs: ALPACA_BARS_TIMEOUT_MS })
    if (!data) {
      // network/HTTP failure — keep what we have (first page failure -> empty).
      // v1.99.2 — say it OUT LOUD: a mid-pagination abort silently returns the
      // OLDEST pages only (pages walk forward from `start`), i.e. a window that
      // ends days/weeks before now. Callers (backtests!) must be able to trust
      // `truncated`, and the log must show WHY the window came back short.
      if (page > 0) {
        console.warn(
          `[bars] ${symbol}: page ${page + 1} failed (status ${st}) after retries — ` +
            `returning ${all.length} PARTIAL bars (truncated, oldest pages only)`,
        )
      }
      return { bars: all, status: st, truncated: page > 0 }
    }
    status = st
    const chunk = data.bars?.[symbol] || []
    all = all.concat(chunk)
    token = data.next_page_token
    if (!token) return { bars: all, status, truncated: false }
  }
  console.warn(`[bars] ${symbol}: pagination hit the ${maxPages}-page cap — window is TRUNCATED (oldest pages kept, newest dropped)`)
  return { bars: all, status, truncated: true }
}

export interface GetBarsOptions {
  /** unix seconds — fetch bars ENDING just before this instant (scroll-back pagination) */
  before?: number
  /** fetch this many CALENDAR days of history (bounded by API limits) — used by
   * the S/R analyzer; default = the timeframe's chart barCount */
  lookbackDays?: number
  /** override the pagination page cap (default 60) */
  maxPages?: number
}

/**
 * Task 3-d — serve a crypto DEEP window from the local bar store (SQLite)
 * when it covers the requested span, ALWAYS refreshing the tail from Alpaca
 * (one slice ≈ last 2 days, the deep fetcher's 7-day slice floor) so the
 * newest closed bars are present and the store stays fresh. The forming bar
 * is never persisted (it is still forwarded in the RESPONSE, matching the
 * pre-store behavior where the route drops it). Returns null when the store
 * can't serve (no coverage / DB trouble) — the caller then fetches the full
 * window from Alpaca and saves it. Crypto bars are immutable once closed, so
 * only the tail can ever change; stock bars stay out of the store entirely
 * (split-adjustment risk).
 */
async function serveCryptoFromBarStore(
  symbol: string,
  timeframe: Timeframe,
  keys: AlpacaKeys | null,
  lookbackDays: number,
): Promise<Bar[] | null> {
  const tfSec = TIMEFRAMES[timeframe].seconds
  const nowSec = Math.floor(Date.now() / 1000)
  const fromSec = nowSec - lookbackDays * 86400
  try {
    const cov = await hasCoverage(symbol, timeframe, fromSec, nowSec, tfSec)
    if (!cov.covered) return null
    const dbBars = await loadBars(symbol, timeframe, fromSec, nowSec)
    if (dbBars.length === 0) return null
    // ALWAYS refresh the tail — the store alone can never serve stale bars.
    let tail: Bar[] = []
    if (keys) {
      try {
        tail = await getAlpacaCryptoBarsDeep(symbol, timeframe, keys, 2, new Date())
      } catch {
        tail = []
      }
    }
    // merge: DB bars as the base, fresher tail bars overlay by time, then the
    // tail's extra (newer) bars append — same ordering contract as the deep fetch
    const tailMap = new Map<number, Bar>()
    for (const b of tail) tailMap.set(b.time, b)
    const merged = [...dbBars]
    for (let i = 0; i < merged.length; i++) {
      const t = tailMap.get(merged[i]!.time)
      if (t) {
        merged[i] = t
        tailMap.delete(t.time)
      }
    }
    for (const b of tailMap.values()) merged.push(b)
    merged.sort((a, b) => a.time - b.time)
    // persist the CLOSED tail bars (forming bar dropped — never cached)
    const tailClosed = tail.filter((b) => b.time + tfSec <= nowSec && b.close > 0)
    if (tailClosed.length > 0) {
      const t0 = Date.now()
      const n = await saveBars(symbol, timeframe, tailClosed)
      console.log(`[bar-store] tail ${symbol} ${timeframe} n=${n} in ${Date.now() - t0}ms`)
    }
    console.log(`[bar-store] hit ${symbol} ${timeframe} n=${merged.length}`)
    return merged
  } catch (e) {
    console.warn(`[bar-store] ${symbol} ${timeframe} unavailable:`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Deep crypto history via Alpaca v1beta3, fetched BACKWARD in time slices
 * anchored at `end` so the NEWEST bars are always complete. v1beta3 pages walk
 * forward from `start` (~1k bars/page, size varies), so one forward walk over a
 * huge window truncates the most recent bars when the page cap is hit — fatal
 * for backtests (they'd silently replay data ending months ago). Slices are
 * sized to fit the page cap; the loop stops when the requested window is
 * covered, history is exhausted, a slice truncates, or the wall-clock budget
 * runs out — the result always spans [.. → end] contiguously.
 */
async function getAlpacaCryptoBarsDeep(
  symbol: string,
  timeframe: Timeframe,
  keys: AlpacaKeys,
  lookbackDays: number,
  endC: Date,
): Promise<Bar[]> {
  const tf = TIMEFRAMES[timeframe]
  const cryptoTf = timeframe === '1W' || timeframe === '1M' ? '1Day' : tf.alpaca
  // slice ≈ 28k bars max (≈ 27–33 pages @ ~0.9–1.5k/page — inside the 40 cap)
  const sliceDays = Math.max(7, Math.min(lookbackDays, 180, Math.floor((28_000 * tf.seconds) / 86400)))
  const deadline = Date.now() + 45_000
  const slices: Bar[][] = []
  let endCursorMs = endC.getTime()
  let coveredMs = 0
  const lookbackMs = lookbackDays * 86400 * 1000
  for (let seg = 0; seg < 40; seg++) {
    const segStartMs = endCursorMs - sliceDays * 86400 * 1000
    const path =
      `/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${cryptoTf}` +
      `&start=${new Date(segStartMs).toISOString().slice(0, 19) + 'Z'}` +
      `&end=${new Date(endCursorMs).toISOString().slice(0, 19) + 'Z'}&limit=10000`
    const { bars: raw, truncated } = await fetchBarsPaged(path, keys, symbol, 40)
    const mapped = mapBars(raw).filter((b) => b.close > 0)
    if (mapped.length === 0) break // history exhausted (or slice feed down)
    slices.push(mapped)
    coveredMs += endCursorMs - segStartMs
    if (truncated) break // slice itself hit the page cap — stop honestly
    if (coveredMs >= lookbackMs) break // requested window covered
    endCursorMs = mapped[0].time * 1000 - 1 // continue strictly before this slice
    if (Date.now() > deadline) break // wall-clock budget — newest data stays complete
  }
  const seen = new Set<number>()
  return slices.reverse().flat().filter((b) => {
    if (seen.has(b.time)) return false
    seen.add(b.time)
    return true
  })
}

export async function getBars(
  symbol: string,
  timeframe: Timeframe,
  userId?: string,
  opts?: GetBarsOptions,
): Promise<{ bars: Bar[]; truncated?: boolean } & DemoMeta> {
  // v1.99.2 — `truncated: true` = the feed dropped part of the requested window
  // mid-pagination (page failures surviving the retries). Backtests REUSE this
  // flag to refuse a silently-short history instead of replaying one that ends
  // weeks before now — a truncated replay looks like a normal result and is
  // exactly the kind of quiet lie that destroys trust in the numbers.
  // `before` shifts the whole window one chunk INTO THE PAST (end = before),
  // so each call appends the PRECEDING ~barCount bars to the chart.
  const before = opts?.before
  // Crypto: Binance FIRST — free public klines, no API key, so charts stream
  // real crypto data even before the user logs in / saves their Alpaca keys.
  // EXCEPTION: deep lookbacks (>9k bars — Binance pages cap at 10k bars ≈ 104d
  // on 15m) go to Alpaca's crypto API first, which paginates years of history;
  // Binance stays the fallback for chart-width windows and when Alpaca fails.
  const tf = TIMEFRAMES[timeframe]
  // Days of history needed. tf.barCount is a BAR count — a 900-bar 5m chart
  // is ~3 days, NOT 900. Using barCount as days inflated needCryptoBars to
  // 259,200 and sent every ordinary crypto chart down the 45s deep-fetch path
  // the moment Binance rate-limited us (the "ETH chart did not show up" bug).
  const cryptoLookbackDays = opts?.lookbackDays
    ?? (timeframe === '1W' || timeframe === '1M'
      ? Math.ceil((tf.barCount * tf.seconds) / 86400) + 20
      : Math.ceil((tf.barCount * tf.seconds) / 86400) + 1)
  const needCryptoBars = Math.ceil((cryptoLookbackDays * 86400) / tf.seconds)
  if (isCryptoSymbol(symbol) && needCryptoBars > 9000 && !before) {
    const keys = await getAlpacaKeys(userId)
    // Task 3-d — crypto bars are immutable: try the local store first (works
    // even without keys when the cache is fresh). 1W/1M are aggregated from
    // daily bars, so they never touch the store (raw bars only).
    if (timeframe !== '1W' && timeframe !== '1M') {
      const stored = await serveCryptoFromBarStore(symbol, timeframe, keys, cryptoLookbackDays)
      if (stored && stored.length > 0) return { bars: stored, demo: false, source: 'alpaca' }
    }
    if (keys) {
      const barsC = await getAlpacaCryptoBarsDeep(symbol, timeframe, keys, cryptoLookbackDays, new Date())
      if (barsC.length > 0) {
        // persist the complete window (closed bars only — the forming bar is
        // never cached). Failures are non-fatal: the fetch result still ships.
        if (timeframe !== '1W' && timeframe !== '1M') {
          const tfSecS = TIMEFRAMES[timeframe].seconds
          const nowSecS = Math.floor(Date.now() / 1000)
          const closed = barsC.filter((b) => b.time + tfSecS <= nowSecS)
          const t0 = Date.now()
          try {
            const nSaved = await saveBars(symbol, timeframe, closed)
            console.log(`[bar-store] save ${symbol} ${timeframe} n=${nSaved} in ${Date.now() - t0}ms`)
          } catch (e) {
            console.warn(`[bar-store] save failed ${symbol} ${timeframe}:`, e instanceof Error ? e.message : e)
          }
        }
        return { bars: barsC, demo: false, source: 'alpaca' }
      }
      // Alpaca empty (feed down / rate-limited) -> Binance fallback below.
    }
  }
  if (isCryptoSymbol(symbol)) {
    const bin = await getBinanceBars(symbol, timeframe, before != null ? before * 1000 : undefined, opts?.lookbackDays)
    if (bin.length > 0) return { bars: bin, demo: false, source: 'binance' }
    // Binance unreachable -> fall through to Alpaca (if keys) or demo below.
  }
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return demoResult(
      (reason) => ({
        bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount, before),
        demo: true,
        reason,
      }),
      'no-keys',
    )
  }
  const end = new Date()
  const endIso = before != null
    ? new Date(before * 1000).toISOString().slice(0, 19) + 'Z'
    : end.toISOString().slice(0, 19) + 'Z'

  if (isCryptoSymbol(symbol)) {
    // Crypto API: v1beta3 — supports up to 1Day; aggregate 1W/1M from daily.
    const cryptoTf = timeframe === '1W' || timeframe === '1M' ? '1Day' : tf.alpaca
    // same days derivation as the deep-path guard above (barCount ≠ days)
    const lookback = cryptoLookbackDays
    const s = new Date((before ?? Date.now() / 1000) * 1000 - lookback * 86400 * 1000).toISOString().slice(0, 19) + 'Z'
    const path =
      `/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${cryptoTf}&start=${s}&end=${endIso}&limit=10000`
    const { bars: rawBars, status, truncated } = await fetchBarsPaged(path, keys, symbol)
    if (!rawBars.length && status !== 200) {
      return demoResult(
        (reason) => ({
          bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount, before),
          demo: true,
          reason,
        }),
        status === 0 ? 'alpaca-error' : (`alpaca-http-${status}` as DemoReason),
      )
    }
    let bars = mapBars(rawBars)
    if (bars.length === 0) {
      return demoResult(
        (reason) => ({
          bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount, before),
          demo: true,
          reason,
        }),
        'empty',
      )
    }
    if (timeframe === '1W' || timeframe === '1M') bars = aggregateDaily(bars, timeframe)
    return { bars, demo: false, truncated }
  }

  // Stocks API: v2/stocks/bars — adjustment enum is `split` (NOT `splits`;
  // `splits` returns HTTP 400) and responses are PAGINATED (next_page_token).
  // If the window has no bars (weekend / illiquid IEX names), widen the lookback
  // so the chart shows the last available session instead of blank/demo data.
  const makePath = (startIsoS: string) =>
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${tf.alpaca}&start=${startIsoS}&end=${endIso}` +
    `&limit=10000&adjustment=split&feed=iex`
  let rawBars: AlpacaBar[] = []
  let status = 200
  let truncated = false
  // window width: explicit day-lookback (S/R analyzer) or the chart's barCount
  const windowMs = opts?.lookbackDays != null
    ? opts.lookbackDays * 86400 * 1000
    : tf.barCount * tf.seconds * 1000
  // v1.80.3 — scale the pagination cap with the window: the 60-page default
  // (~60–120k bars at IEX's ~1–2k bars/page) silently truncated DEEP 1m
  // windows (180d ≈ 70k bars ≈ 35–70 pages) — oldest pages kept, NEWEST
  // dropped, i.e. a backtest ending weeks in the past. Chart windows (~900
  // bars) never leave page 1, so they keep the 60 floor.
  const estPages = Math.ceil((windowMs / (tf.seconds * 1000)) / 1500) + 6
  const maxPages = Math.min(160, Math.max(60, estPages))
  for (const mult of [1, 5, 40]) {
    const s = new Date((before ?? end.getTime() / 1000) * 1000 - windowMs * mult)
    const res = await fetchBarsPaged(makePath(s.toISOString().slice(0, 19) + 'Z'), keys, symbol, maxPages)
    rawBars = res.bars
    status = res.status
    truncated = res.truncated
    if (rawBars.length > 0) break
    if (status !== 200) break
  }
  console.log(`[bars] stock ${symbol} ${timeframe}: ${rawBars.length} bars (truncated=${truncated}, before=${before ?? 'now'})`)
  if (!rawBars.length && status !== 200) {
    return demoResult(
      (reason) => ({
        bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount, before),
        demo: true,
        reason,
      }),
      status === 0 ? 'alpaca-error' : (`alpaca-http-${status}` as DemoReason),
    )
  }
  const bars = mapBars(rawBars)
  if (bars.length === 0) {
    return demoResult(
      (reason) => ({
        bars: simBars(symbol, timeframe, TIMEFRAMES[timeframe].barCount, before),
        demo: true,
        reason,
      }),
      'empty',
    )
  }
  // v1.99.2 — propagate truncation (page-cap or surviving page failure) so the
  // backtest gate can refuse a window that silently ends before now.
  return { bars, demo: false, truncated }
}

// ---------- Quotes / Snapshots ----------

interface StockSnapshot {
  latestTrade?: { p: number; t: string }
  // Task 85 — best bid/ask (bp/ap) when the feed returns a quote; IEX-feed
  // stock quotes are IEX-only NBBO, crypto latestQuote is the Alpaca crypto book
  latestQuote?: { bp?: number; ap?: number; t?: string }
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
  prevDailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
}
interface CryptoSnapshot {
  latestTrade?: { p: number; t: string }
  latestQuote?: { bp?: number; ap?: number; t?: string }
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
  prevDailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string }
}

function snapshotToQuote(symbol: string, snap: StockSnapshot | CryptoSnapshot | undefined): Quote | null {
  if (!snap) return null
  const price = snap.latestTrade?.p ?? snap.dailyBar?.c
  const prevClose = snap.prevDailyBar?.c
  if (price == null || prevClose == null || prevClose === 0) return null
  const daily = snap.dailyBar
  // Task 85 — surface the top of book when it's sane (positive, uncrossed)
  const qBid = snap.latestQuote?.bp
  const qAsk = snap.latestQuote?.ap
  return {
    symbol,
    price,
    change: price - prevClose,
    changePct: ((price - prevClose) / prevClose) * 100,
    open: daily?.o ?? prevClose,
    high: Math.max(daily?.h ?? price, price),
    low: Math.min(daily?.l ?? price, price),
    prevClose,
    volume: daily?.v ?? 0,
    ts: snap.latestTrade?.t ? Math.floor(new Date(snap.latestTrade.t).getTime() / 1000) : Math.floor(Date.now() / 1000),
    ...(qBid != null && qAsk != null && qBid > 0 && qAsk >= qBid ? { bid: qBid, ask: qAsk } : {}),
  }
}

/**
 * Fetch quotes. `opts.trading: true` marks the caller as making a TRADING
 * decision (engine guard, order sizing, bracket anchor): the simulator
 * fallback is then DISABLED — a transient Alpaca data failure must hand back
 * a missing symbol (reported in `degraded`), never a synthetic price. The
 * v1.80.7 incident: the grid engine's quote call 429'd, silently received a
 * simulated AAPL price ~34% under the market, fired Max SL on it and closed
 * lots at a price that never existed. Display-grade callers (watchlists,
 * heatmap, alerts) keep the sim fill so rows stay visible.
 */
export async function getQuotes(
  symbols: string[],
  userId?: string,
  opts?: { trading?: boolean },
): Promise<{ quotes: Quote[] } & DemoMeta & { degraded?: string[] }> {
  if (symbols.length === 0) return { quotes: [], demo: false }
  const stocks = symbols.filter((s) => !isCryptoSymbol(s))
  const cryptos = symbols.filter((s) => isCryptoSymbol(s))
  const quotes: Quote[] = []
  let lastStatus = 0
  let usedBinance = false

  // Crypto first: Binance free 24h tickers, no API key — real crypto prices
  // for logged-out visitors (missing symbols fall through to Alpaca/demo).
  if (cryptos.length > 0) {
    const bq = await getBinanceQuotes(cryptos)
    if (bq.length > 0) {
      quotes.push(...bq)
      usedBinance = true
    }
  }

  // Anything Binance missed (or all stock symbols) via Alpaca — only when the
  // user has keys; without keys non-crypto symbols stay on the simulator.
  const have = new Set(quotes.map((q) => q.symbol))
  const needStocks = stocks.filter((s) => !have.has(s))
  const needCrypto = cryptos.filter((s) => !have.has(s))
  const jobs: Promise<void>[] = []

  if (needStocks.length > 0 || needCrypto.length > 0) {
    const keys = await getAlpacaKeys(userId)
    if (keys) {
      for (let i = 0; i < needStocks.length; i += 30) {
        const chunk = needStocks.slice(i, i + 30)
        jobs.push((async () => {
          const { data: raw, status } = await alpacaFetch<Record<string, StockSnapshot>>(
            `/v2/stocks/snapshots?symbols=${encodeURIComponent(chunk.join(','))}&feed=iex`,
            keys,
          )
          if (!raw) {
            lastStatus = status
            return
          }
          for (const s of chunk) {
            const q = snapshotToQuote(s, raw[s])
            if (q) quotes.push(q)
          }
        })())
      }
      for (let i = 0; i < needCrypto.length; i += 15) {
        const chunk = needCrypto.slice(i, i + 15)
        jobs.push((async () => {
          // NOTE: crypto snapshots nest under `snapshots` (stocks are flat)
          const { data: raw, status } = await alpacaFetch<{ snapshots?: Record<string, CryptoSnapshot> }>(
            `/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(chunk.join(','))}`,
            keys,
          )
          if (!raw) {
            lastStatus = status
            return
          }
          const map = raw.snapshots ?? (raw as unknown as Record<string, CryptoSnapshot>)
          for (const s of chunk) {
            const q = snapshotToQuote(s, map[s])
            if (q) quotes.push(q)
          }
        })())
      }
      await Promise.all(jobs)
    }
  }

  // TRADING callers: never synthesize. Whatever real quotes landed (Binance /
  // Alpaca) are returned as-is; anything missing is reported in `degraded` so
  // the engine can defer the decision to the next tick instead of trading on
  // a simulator price.
  if (opts?.trading === true) {
    const haveT = new Set(quotes.map((q) => q.symbol))
    const missing = symbols.filter((s) => !haveT.has(s))
    return {
      quotes,
      demo: false,
      source: usedBinance ? (missing.length < symbols.length ? 'binance+alpaca' : 'binance') : 'alpaca',
      ...(missing.length > 0 ? { degraded: missing } : {}),
    }
  }

  if (quotes.length === 0) {
    return demoResult(
      (reason) => ({ quotes: symbols.map((s) => simQuote(s)), demo: true, reason }),
      lastStatus === 0 ? 'no-keys' : lastStatus ? (`alpaca-http-${lastStatus}` as DemoReason) : 'empty',
    )
  }
  // fill any missing with simulator to keep rows visible
  const have2 = new Set(quotes.map((q) => q.symbol))
  let simFilled = false
  for (const s of symbols) {
    if (!have2.has(s)) {
      quotes.push({ ...simQuote(s), symbol: s })
      simFilled = true
    }
  }
  const source2 = usedBinance ? (simFilled ? 'binance+sim-fill' : 'binance') : simFilled ? 'alpaca+sim-fill' : 'alpaca'
  return { quotes, demo: false, source: source2 }
}

// ---------- News ----------

interface AlpacaNewsItem {
  id: number
  headline: string
  summary: string
  author: string
  created_at: string
  updated_at: string
  url: string
  images: { size: string; url: string }[]
  symbols: string[]
  source: string
}

export async function getNews(symbol: string | null, limit: number, userId?: string): Promise<{ news: NewsItem[] } & DemoMeta> {
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return demoResult(
      (reason) => ({ news: simNews(symbol || 'MARKET', limit), demo: true, reason }),
      'no-keys',
    )
  }
  const params = new URLSearchParams({ limit: String(Math.min(limit, 50)), sort: 'desc' })
  if (symbol && !isCryptoSymbol(symbol)) params.set('symbols', symbol)
  const { data: raw, status } = await alpacaFetch<{ news: AlpacaNewsItem[] }>(`/v1beta1/news?${params.toString()}`, keys)
  if (!raw || !raw.news || raw.news.length === 0) {
    return demoResult(
      (reason) => ({ news: simNews(symbol || 'MARKET', limit), demo: true, reason }),
      !raw ? (status === 0 ? 'alpaca-error' : (`alpaca-http-${status}` as DemoReason)) : 'empty',
    )
  }
  const news = raw.news.map((n) => ({
    id: String(n.id),
    headline: n.headline,
    summary: n.summary,
    source: n.source || n.author || 'Alpaca',
    url: n.url,
    ts: Math.floor(new Date(n.created_at).getTime() / 1000),
    image: n.images?.find((i) => i.size === 'large')?.url || n.images?.[0]?.url,
    symbols: n.symbols || [],
  }))
  return { news, demo: false }
}

// ---------- Markers (earnings via news scan + news timestamps) ----------

// STRICT report-day phrasing only: matches headlines actually PUBLISHED on an
// earnings announcement day ("Tesla Posts Huge Q2 EPS Miss", "ACME Reports
// First Quarter 2026 Results", "XYZ Announces Q3 Earnings"). Loose "earnings"
// matching used to fire on previews/analysis ("What to expect from earnings",
// "Alphabet's Q2 Earnings—Why Wall Street's Frosty Reaction…") — planting fake
// [E] markers on random news days ("many wrong dates" bug).
const EARNINGS_REPORT_RE =
  /\b(?:reports?|posts?|announces?|releases?)\b[^.|]{0,60}?\b(?:first|second|third|fourth|q[1-4])\b[^.|]{0,40}?\b(?:quarter(?:ly)?|results|earnings|eps|financial results)\b|\b(?:first|second|third|fourth)[\s-]?quarter(?:ly)?\s+(?:20\d{2}\s+)?(?:financial\s+)?results\b/i
// Preview/analysis/scheduling chatter that must NEVER count as a report-day
// headline even when it contains a report verb ("Announces webcast for Q2
// earnings call", "What to expect from Q3 earnings", "set to report…").
const EARNINGS_NEG_RE =
  /\bpreview|webcast|conference call|earnings call|scheduled?|to report|will report|set to|what to expect|what to watch|ahead of|outlook|forecast|estimates\b/i

export async function getMarkers(symbol: string, from: number, to: number, userId?: string): Promise<MarkerData & DemoMeta> {
  const keys = await getAlpacaKeys(userId)
  if (!keys) {
    return demoResult(
      (reason) => ({ ...simMarkers(symbol, from, to), demo: true, reason }),
      'no-keys',
    )
  }
  const params = new URLSearchParams({
    symbols: isCryptoSymbol(symbol) ? '' : symbol,
    limit: '50',
    sort: 'desc',
    start: new Date(from * 1000).toISOString().slice(0, 19) + 'Z',
    end: new Date(to * 1000).toISOString().slice(0, 19) + 'Z',
  })
  if (!isCryptoSymbol(symbol)) params.set('symbols', symbol)
  else params.delete('symbols') // crypto news not symbol-filterable; use all
  // PAGINATE the news scan (bounded): report-day headlines for PAST quarters
  // sit deep in the feed for high-volume symbols — 50 items only reaches a
  // few weeks back. 8 pages × 50 = 400 headlines ≈ real past [E] days for
  // most symbols while keeping the marker fetch bounded.
  const MAX_PAGES = 8
  const allNews: AlpacaNewsItem[] = []
  let token: string | undefined = undefined
  let status = 200
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `/v1beta1/news?${params.toString()}${token ? `&page_token=${encodeURIComponent(token)}` : ''}`
    const { data, status: st } = await alpacaFetch<{ news: AlpacaNewsItem[]; next_page_token?: string }>(url, keys)
    if (!data) {
      status = st
      break
    }
    status = st
    allNews.push(...(data.news ?? []))
    token = data.next_page_token
    if (!token) break
  }
  if (allNews.length === 0) {
    return demoResult(
      (reason) => ({ ...simMarkers(symbol, from, to), demo: true, reason }),
      status === 0 ? 'alpaca-error' : status !== 200 ? (`alpaca-http-${status}` as DemoReason) : 'empty',
    )
  }
  const earnings: number[] = []
  const news: number[] = []
  const seen = new Set<string>()
  for (const n of allNews) {
    const ts = Math.floor(new Date(n.created_at).getTime() / 1000)
    if (ts < from || ts > to) continue
    news.push(ts)
    if (EARNINGS_REPORT_RE.test(n.headline) && !EARNINGS_NEG_RE.test(n.headline)) {
      const key = new Date(ts * 1000).toISOString().slice(0, 10)
      if (!seen.has(key)) {
        seen.add(key)
        earnings.push(ts)
      }
    }
  }
  // crypto has no earnings — drop for crypto symbols
  const finalEarnings = isCryptoSymbol(symbol) ? [] : earnings
  const newsSorted = [...news].sort((a, b) => b - a)
  return {
    earnings: finalEarnings,
    news: newsSorted.slice(0, 40),
    newsItems: allNews
      .map((n) => ({ ts: Math.floor(new Date(n.created_at).getTime() / 1000), title: n.headline }))
      .filter((n) => news.includes(n.ts))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40),
    demo: false,
  }
}
