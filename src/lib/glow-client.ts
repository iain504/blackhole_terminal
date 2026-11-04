'use client'

// v2.11.3 — ONE shared grid + algo glow poller for every chart pane.
//
// Before: each ChartPanel instance ran its own 5s GET /api/grid + GET /api/algo
// poll — an 8-pane grid fired ~3.2 req/s of identical requests (both endpoints
// answer with per-user data, so every pane fetched the same payload). Now
// every pane subscribes to a single refcounted poller: one pair of requests
// per 5s no matter how many panes, tabs, or workspaces are open. The server
// additionally TTL-caches these GETs for 3s (src/lib/api-cache.ts), so even
// multi-tab users collapse into ≤1 DB query per window.
//
// Contract preserved from the per-pane pollers:
//   - fetch immediately on first subscribe, then every 5s
//   - any non-OK response clears that half of the snapshot → nothing renders,
//     never a toast or a crash; offline keeps the last snapshot
//   - paused while the browser tab is hidden (document.hidden), with an
//     immediate refresh the moment it becomes visible again
//   - last subscriber unsubscribes → timer torn down (zero background cost)

export interface GlowGridRow {
  id: string
  symbol: string
  status: string
  lowerPrice: number
  upperPrice: number
  levels?: number[]
  maxSL: number | null
  maxTP: number | null
  slBasis?: string | null
  tpBasis?: string | null
  /** Task 10-g — 'both' | 'buy' | 'sell' (absent reads as 'both') */
  direction?: string | null
}

export interface GlowAlgoRow {
  id: string
  symbol: string
  status: string
}

export interface GlowSnapshot {
  grids: GlowGridRow[] | null
  algos: GlowAlgoRow[] | null
}

type Sub = (s: GlowSnapshot) => void

interface GlowState {
  subs: Set<Sub>
  timer: ReturnType<typeof setInterval> | null
  onVis: (() => void) | null
  snapshot: GlowSnapshot
  fetching: boolean
}

function state(): GlowState {
  const g = globalThis as { __ttGlowClient?: GlowState }
  if (!g.__ttGlowClient) {
    g.__ttGlowClient = {
      subs: new Set<Sub>(),
      timer: null,
      onVis: null,
      snapshot: { grids: null, algos: null },
      fetching: false,
    }
  }
  return g.__ttGlowClient
}

async function fetchOnce(): Promise<void> {
  const st = state()
  if (st.fetching) return // previous cycle still in flight — skip, don't pile up
  st.fetching = true
  try {
    const [gRes, aRes] = await Promise.allSettled([fetch('/api/grid'), fetch('/api/algo')])
    let grids: GlowGridRow[] | null = st.snapshot.grids
    let algos: GlowAlgoRow[] | null = st.snapshot.algos
    if (gRes.status === 'fulfilled') {
      if (gRes.value.ok) {
        const json = (await gRes.value.json().catch(() => null)) as { grids?: GlowGridRow[] } | null
        grids = Array.isArray(json?.grids) ? json!.grids! : null
      } else {
        grids = null // 401 logged out / 4xx / 5xx — same silent contract as before
      }
    }
    // rejected → offline: keep the last grid snapshot
    if (aRes.status === 'fulfilled') {
      if (aRes.value.ok) {
        const json = (await aRes.value.json().catch(() => null)) as {
          runs?: { id?: unknown; symbol?: unknown; status?: unknown }[]
        } | null
        algos = Array.isArray(json?.runs)
          ? json!.runs!.map((r) => ({ id: String(r?.id ?? ''), symbol: String(r?.symbol ?? ''), status: String(r?.status ?? '') }))
          : null
      } else {
        algos = null
      }
    }
    // rejected → offline: keep the last algo snapshot
    st.snapshot = { grids, algos }
    for (const sub of st.subs) {
      try {
        sub(st.snapshot)
      } catch {
        /* a broken subscriber never kills the poller */
      }
    }
  } finally {
    st.fetching = false
  }
}

function tick(): void {
  if (!document.hidden) void fetchOnce()
}

function start(): void {
  const st = state()
  if (st.timer != null) return
  st.timer = setInterval(tick, 5000)
  st.onVis = () => {
    if (!document.hidden) void fetchOnce() // instant refresh on tab return
  }
  document.addEventListener('visibilitychange', st.onVis)
}

function stop(): void {
  const st = state()
  if (st.timer != null) clearInterval(st.timer)
  st.timer = null
  if (st.onVis) document.removeEventListener('visibilitychange', st.onVis)
  st.onVis = null
  st.snapshot = { grids: null, algos: null } // cold start for the next subscriber
}

/**
 * Subscribe a pane to the shared glow snapshot. Returns an unsubscribe
 * function. The first subscriber starts the shared poller (with an immediate
 * fetch); the last unsubscribe stops it entirely.
 */
export function subscribeGlow(cb: Sub): () => void {
  const st = state()
  st.subs.add(cb)
  if (st.timer == null) {
    start()
    void fetchOnce()
  }
  // hand the new subscriber the last-known snapshot immediately
  try {
    cb(st.snapshot)
  } catch {
    /* ignore */
  }
  return () => {
    st.subs.delete(cb)
    if (st.subs.size === 0) stop()
  }
}
