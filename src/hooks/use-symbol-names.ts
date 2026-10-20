'use client'

// Resolves display names for watchlist symbols ("TSLA" → "Tesla, Inc.") for
// the mobile watchlist rows. Names are resolved once per symbol through the
// exact-match symbol API and cached in localStorage forever, so the cost is
// one small request per NEW symbol (batched 4 at a time) — never per render.
// SSR-safe: reads localStorage only in the browser (and the mobile shell
// never renders on the server anyway).

import { useEffect, useState } from 'react'

const CACHE_KEY = 'tt:symbolNames'

type NameMap = Record<string, string>

let cache: NameMap | null = null

function loadCache(): NameMap {
  if (cache) return cache
  cache = {}
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (raw) cache = JSON.parse(raw) as NameMap
    } catch {
      /* private mode / corrupt — start empty */
    }
  }
  return cache
}

function persist(): void {
  if (typeof window === 'undefined' || !cache) return
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* quota / private mode — cache stays in-memory */
  }
}

/**
 * Returns { symbol → display name } for the given symbols. Cached names are
 * merged during render (no state); the async fetch results land in state and
 * are written back to the cache. Unknown symbols resolve to '' (cached as
 * such so they are never re-fetched).
 */
export function useSymbolNames(symbols: string[]): Record<string, string> {
  const key = [...new Set(symbols.filter(Boolean))].sort().join(',')
  const [fetched, setFetched] = useState<NameMap>({})

  useEffect(() => {
    if (!key) return
    const c = loadCache()
    const missing = key.split(',').filter((s) => !(s in c))
    if (missing.length === 0) return
    let alive = true
    ;(async () => {
      for (let i = 0; i < missing.length && alive; i += 4) {
        const chunk = missing.slice(i, i + 4)
        const results = await Promise.all(
          chunk.map(async (s): Promise<[string, string]> => {
            try {
              const res = await fetch(`/api/market/symbols?q=${encodeURIComponent(s)}&exact=1`)
              if (!res.ok) return [s, '']
              const json = (await res.json()) as { name?: string | null }
              return [s, json.name ? String(json.name) : '']
            } catch {
              return [s, '']
            }
          }),
        )
        if (!alive) return
        let added = false
        const next: NameMap = {}
        for (const [s, name] of results) {
          c[s] = name // cache misses as '' — no refetch loop
          if (name) {
            next[s] = name
            added = true
          }
        }
        persist()
        // `alive` guards staleness: the effect re-runs (and re-cancels) on key change
        if (added) setFetched((prev) => ({ ...prev, ...next }))
      }
    })()
    return () => {
      alive = false
    }
  }, [key])

  // cached names merge during render — no setState-in-effect needed
  const names: NameMap = {}
  if (key) {
    const c = loadCache()
    for (const s of key.split(',')) {
      if (c[s]) names[s] = c[s]
      else if (fetched[s]) names[s] = fetched[s]
    }
  }
  return names
}
