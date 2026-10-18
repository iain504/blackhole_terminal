// Server-side symbol universe: the full Alpaca US-equity asset list (cached in
// memory) + crypto majors. Powers watchlist/chart symbol prediction (prefix
// search) and "does this symbol actually exist" validation so junk can no
// longer be added. Two layers of robustness:
//   1. The bulk list (GET /v2/assets — a ~6.5 MB payload with ~14k assets) is
//      fetched with a generous timeout and retried across hosts; a recent
//      failure short-circuits retries for 2 minutes so typing in the UI never
//      hangs on a doomed 6 MB download.
//   2. ANY symbol that misses the cached universe is verified with a direct
//      GET /v2/assets/{symbol} lookup (fast, authoritative, ~0.5s) before it
//      is declared invalid — the bulk list can be stale, but a fresh listing
//      like SPCX still resolves. Positive hits are merged back into the
//      cached universe so prefix search finds them too.
// Falls back to the curated static list when Alpaca is unavailable entirely.
import { getAlpacaKeys } from './alpaca'
import { ALL_US_SYMBOLS, CRYPTO_UNIVERSE, isValidSymbolFormat } from './market-types'

export { isValidSymbolFormat } from './market-types'

export interface SymbolEntry {
  symbol: string
  name: string
  exchange: string
  crypto: boolean
}

interface AlpacaAsset {
  symbol: string
  name: string | null
  exchange: string
  status: string
  tradable: boolean
  class: string
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h refresh for the bulk list
const FAIL_BACKOFF_MS = 2 * 60 * 1000 // after a failed bulk fetch, skip retries for 2 min
const LOOKUP_POS_TTL_MS = 12 * 60 * 60 * 1000 // direct-lookup hit cache
const LOOKUP_NEG_TTL_MS = 10 * 60 * 1000 // direct-lookup miss cache (404s)

let cache: { at: number; entries: SymbolEntry[] } | null = null
let inflight: Promise<SymbolEntry[] | null> | null = null
let lastBulkFailAt = 0

// per-symbol direct-lookup caches (positive entries / negative timestamps)
const posCache = new Map<string, { at: number; entry: SymbolEntry }>()
const negCache = new Map<string, number>()

interface AlpacaRes {
  status: number
  json: unknown
}

async function alpacaReq(
  base: string,
  path: string,
  keyId: string,
  secret: string,
  timeoutMs: number,
): Promise<AlpacaRes | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      return null
    }
    return { status: res.status, json }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function toEntry(r: AlpacaAsset): SymbolEntry | null {
  if (typeof r.symbol !== 'string') return null
  const sym = r.symbol.toUpperCase()
  if (!isValidSymbolFormat(sym)) return null
  return {
    symbol: sym,
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : '',
    exchange: typeof r.exchange === 'string' ? r.exchange : '',
    crypto: false,
  }
}

async function fetchAlpacaAssets(keyId: string, secret: string): Promise<SymbolEntry[] | null> {
  // Assets live on the trading API; try paper host first (paper keys), then
  // live. One retry per host — the payload is large (~6.5 MB / ~14k assets).
  for (const base of ['https://paper-api.alpaca.markets', 'https://api.alpaca.markets']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await alpacaReq(base, '/v2/assets?status=active&asset_class=us_equity', keyId, secret, 30000)
      if (!res || res.status !== 200 || !Array.isArray(res.json)) continue
      const seen = new Set<string>()
      const entries: SymbolEntry[] = []
      for (const raw of res.json) {
        const e = toEntry(raw as AlpacaAsset)
        if (!e || seen.has(e.symbol)) continue
        seen.add(e.symbol)
        entries.push(e)
      }
      if (entries.length > 100) return entries
    }
  }
  return null
}

/** Direct authoritative check for one symbol: GET /v2/assets/{symbol}. */
async function fetchAlpacaAssetExact(
  sym: string,
  keyId: string,
  secret: string,
): Promise<SymbolEntry | null | 'error'> {
  for (const base of ['https://paper-api.alpaca.markets', 'https://api.alpaca.markets']) {
    const res = await alpacaReq(base, `/v2/assets/${encodeURIComponent(sym)}`, keyId, secret, 8000)
    if (res && res.status === 200) {
      const e = toEntry(res.json as AlpacaAsset)
      if (e && e.symbol === sym) return e
      return null
    }
    if (res && res.status === 404) return null // authoritative miss
    // 401/429/5xx/network — try the next host
  }
  return 'error'
}

/** Full universe (Alpaca-cached or static fallback). */
export async function getSymbolUniverse(userId?: string): Promise<{ entries: SymbolEntry[]; source: 'alpaca' | 'static' }> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return { entries: cache.entries, source: 'alpaca' }
  // back off after a fresh failure so UI requests don't queue on doomed retries
  if (now - lastBulkFailAt < FAIL_BACKOFF_MS) {
    return { entries: cache ? cache.entries : staticUniverse(), source: cache ? 'alpaca' : 'static' }
  }
  if (!inflight) {
    const p = (async () => {
      const keys = await getAlpacaKeys(userId)
      if (!keys) return null
      const rows = await fetchAlpacaAssets(keys.keyId, keys.secret)
      if (!rows) lastBulkFailAt = Date.now()
      return rows
    })()
    inflight = p.finally(() => {
      if (inflight === p) inflight = null
    })
  }
  const rows = await inflight
  if (rows && rows.length > 0) {
    cache = { at: now, entries: rows }
    return { entries: rows, source: 'alpaca' }
  }
  // stale-while-error: serve the previous list if we ever had one
  if (cache) return { entries: cache.entries, source: 'alpaca' }
  return { entries: staticUniverse(), source: 'static' }
}

function mergeIntoUniverse(entry: SymbolEntry): void {
  if (!cache) return
  if (cache.entries.some((e) => e.symbol === entry.symbol)) return
  cache.entries = [...cache.entries, entry]
}

/**
 * Authoritative single-symbol resolution used for validation and exact
 * matches: universe cache → crypto majors → direct Alpaca lookup (with
 * positive/negative caches). Returns null only when the symbol genuinely
 * does not exist (or no keys/network — never negatively cached on errors).
 */
export async function resolveSymbolExact(sym: string, userId?: string): Promise<SymbolEntry | null> {
  const s = sym.trim().toUpperCase()
  if (!isValidSymbolFormat(s)) return null
  // fast per-symbol caches first — a cold bulk-list fetch (multi-second) must
  // never delay an exact validation that we already know the answer for
  const now = Date.now()
  const pos = posCache.get(s)
  if (pos && now - pos.at < LOOKUP_POS_TTL_MS) return pos.entry
  const neg = negCache.get(s)
  if (neg && now - neg < LOOKUP_NEG_TTL_MS) return null
  const { entries } = await getSymbolUniverse(userId)
  const hit = entries.find((e) => e.symbol === s)
  if (hit) return hit
  if (CRYPTO_UNIVERSE.includes(s)) {
    return { symbol: s, name: 'Crypto pair', exchange: 'CRYPTO', crypto: true }
  }
  const keys = await getAlpacaKeys(userId)
  if (!keys) return null
  const res = await fetchAlpacaAssetExact(s, keys.keyId, keys.secret)
  if (res === 'error') return null // network/auth trouble — do not remember as miss
  if (res) {
    posCache.set(s, { at: now, entry: res })
    mergeIntoUniverse(res)
    return res
  }
  negCache.set(s, now)
  return null
}

function staticUniverse(): SymbolEntry[] {
  return [
    ...ALL_US_SYMBOLS.map((s) => ({ symbol: s, name: '', exchange: '', crypto: false })),
    ...CRYPTO_UNIVERSE.map((s) => ({ symbol: s, name: 'Crypto pair', exchange: 'CRYPTO', crypto: true })),
  ]
}

export function findExactSymbol(entries: SymbolEntry[], sym: string): SymbolEntry | null {
  const s = sym.trim().toUpperCase()
  return entries.find((e) => e.symbol === s) ?? null
}

/** Prefix → contains → name match ranking. Empty query returns []. */
export function searchSymbols(entries: SymbolEntry[], q: string, limit = 12): SymbolEntry[] {
  const query = q.trim().toUpperCase()
  if (!query) return []
  const starts: SymbolEntry[] = []
  const contains: SymbolEntry[] = []
  const names: SymbolEntry[] = []
  for (const e of entries) {
    if (e.symbol === query) continue // exact handled separately by the caller
    if (e.symbol.startsWith(query)) starts.push(e)
    else if (e.symbol.includes(query)) contains.push(e)
    else if (e.name && e.name.toUpperCase().includes(query)) names.push(e)
  }
  return [...starts, ...contains, ...names].slice(0, limit)
}
