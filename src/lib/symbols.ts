// Server-side symbol universe: the full Alpaca US-equity asset list (cached in
// memory) + crypto majors. Powers watchlist symbol prediction (prefix search)
// and "does this symbol actually exist" validation so junk can no longer be
// added to watchlists. Falls back to the curated static list when Alpaca is
// unavailable (no keys / network error).
import { getAlpacaKeys } from './alpaca'
import { ALL_US_SYMBOLS, CRYPTO_UNIVERSE } from './market-types'

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

// Alpaca symbols: letters/digits plus . - / : (e.g. BRK.B, BTC/USD). 1–15 chars.
const SYM_RE = /^[A-Z0-9./:-]{1,15}$/

export function isValidSymbolFormat(sym: string): boolean {
  return SYM_RE.test(sym)
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h refresh
let cache: { at: number; entries: SymbolEntry[] } | null = null
let inflight: Promise<SymbolEntry[] | null> | null = null

async function fetchAlpacaAssets(keyId: string, secret: string): Promise<SymbolEntry[] | null> {
  // Assets live on the trading API; try paper host first (paper keys), then live.
  for (const base of ['https://paper-api.alpaca.markets', 'https://api.alpaca.markets']) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(`${base}/v2/assets?status=active&asset_class=us_equity`, {
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secret,
          accept: 'application/json',
        },
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!res.ok) continue
      const rows = (await res.json()) as AlpacaAsset[]
      if (!Array.isArray(rows) || rows.length === 0) continue
      const entries: SymbolEntry[] = []
      for (const r of rows) {
        if (typeof r.symbol !== 'string' || !isValidSymbolFormat(r.symbol.toUpperCase())) continue
        entries.push({
          symbol: r.symbol.toUpperCase(),
          name: typeof r.name === 'string' ? r.name.slice(0, 80) : '',
          exchange: typeof r.exchange === 'string' ? r.exchange : '',
          crypto: false,
        })
      }
      if (entries.length > 100) return entries
    } catch {
      /* try next host */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/** Full universe (Alpaca-cached or static fallback). */
export async function getSymbolUniverse(userId?: string): Promise<{ entries: SymbolEntry[]; source: 'alpaca' | 'static' }> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return { entries: cache.entries, source: 'alpaca' }
  if (!inflight) {
    const p = (async () => {
      const keys = await getAlpacaKeys(userId)
      if (!keys) return null
      return fetchAlpacaAssets(keys.keyId, keys.secret)
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
