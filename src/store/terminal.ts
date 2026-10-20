'use client'

// Central terminal store: session, tabs, panel layout, watchlists, drawings, alerts.
// Layout auto-saves to server every 5s when dirty (Task 16 #3).
import { create } from 'zustand'
import { Timeframe } from '@/lib/market-types'

export interface SessionUser {
  id: string
  username: string
}

export type TabType = 'chart' | 'calendar' | 'heatmap' | 'positions'

// Multi-chart grid layouts (per chart tab). '1' single, '2h' side-by-side,
// '2v' stacked, '3s' one wide top + two bottom, '4' 2×2 grid, '6' 3×2 grid,
// '8' 4×2 grid.
export type GridLayoutId = '1' | '2h' | '2v' | '3s' | '4' | '6' | '8'
export const GRID_LAYOUTS: { id: GridLayoutId; label: string; short: string; panes: number }[] = [
  { id: '1', label: 'Single chart', short: '1', panes: 1 },
  { id: '2h', label: '2 charts — side by side', short: '2×1', panes: 2 },
  { id: '2v', label: '2 charts — stacked', short: '1×2', panes: 2 },
  { id: '3s', label: '3 charts — one wide + two', short: '3', panes: 3 },
  { id: '4', label: '4 charts — grid', short: '2×2', panes: 4 },
  { id: '6', label: '6 charts — grid', short: '3×2', panes: 6 },
  { id: '8', label: '8 charts — grid', short: '4×2', panes: 8 },
]

export interface Pane {
  symbol: string
  timeframe: Timeframe
}

export interface Tab {
  id: string
  type: TabType
  symbol: string
  timeframe: Timeframe
  /** multi-chart grid config; undefined = single chart (legacy layout) */
  grid?: { layout: GridLayoutId; panes: Pane[] }
  /** which pane drives the Quote/News sidebar (grid mode) */
  focusedPane?: number
  /** sync crosshair across panes of this tab */
  syncCrosshair?: boolean
}

/** Resolves the pane list for a tab (grid config or the single legacy pane). */
export function tabPanes(tab: Tab): Pane[] {
  if (tab.grid?.panes?.length) return tab.grid.panes
  return [{ symbol: tab.symbol, timeframe: tab.timeframe }]
}

/** Resolves the active grid layout for a tab ('1' when unset). */
export function tabLayout(tab: Tab): GridLayoutId {
  return tab.grid?.layout ?? '1'
}

/** Pane count for a layout id. */
export function layoutPaneCount(id: GridLayoutId): number {
  return GRID_LAYOUTS.find((l) => l.id === id)?.panes ?? 1
}

export type PanelId = 'watchlist' | 'quote' | 'news'

/** Which y-scale a drawing point lives in: the main price scale or one of
 *  the indicator strips (volume / RSI / MACD). 'price' = main scale.
 *  A point drawn inside the VOL strip stores a VOLUME value, inside RSI an
 *  RSI level (0-100), inside MACD a MACD-line value — so lines stay glued to
 *  the pane they were drawn on (TradingView-style per-pane coordinates). */
export type DrawingPane = 'price' | 'vol' | 'rsi' | 'macd'

export interface DrawingPoint {
  time: number | null
  price: number
  /** scale the value belongs to (default 'price') — pointsJson in db */
  pane?: DrawingPane
}

export type DrawingKind = 'hline' | 'vline' | 'trend' | 'fib'

export interface Drawing {
  id: string
  symbol: string
  kind: DrawingKind
  points: DrawingPoint[]
  color: string
  width: number
  meta?: Record<string, unknown> | null
}

export interface Watchlist {
  id: string
  name: string
  color: string
  sortOrder: number
  items: string[]
}

/** Result of adding a symbol to a watchlist (validation-aware). */
export type AddSymbolResult = { ok: true } | { ok: false; reason: 'invalid' | 'duplicate' | 'unknown' | 'error' }

export interface Alert {
  id: string
  symbol: string
  kind: 'price' | 'rsi' | 'macd' | string
  /** trigger level: price / RSI level / MACD cross level */
  price: number
  direction: 'above' | 'below' | string
  /** macd conditions: bull_cross | bear_cross | cross_above | cross_below */
  condition: string | null
  /** bar timeframe the indicator is computed on (rsi/macd) */
  timeframe: string
  /** rsi {period} · macd {fast,slow,signal} */
  params: { period?: number; fast?: number; slow?: number; signal?: number } | null
  color: string
  status: 'active' | 'paused' | 'triggered' | string
  note: string | null
  triggeredAt: string | null
  createdAt: string
}

/** Conditional ("complex") order rule — IF indicator condition THEN buy/sell + TP/SL. */
export interface Strategy {
  id: string
  symbol: string
  kind: 'rsi' | 'macd' | string
  /** rsi: cross_above | cross_below · macd: bull_cross | bear_cross | cross_above | cross_below */
  condition: string
  level: number
  timeframe: string
  params: { period?: number; fast?: number; slow?: number; signal?: number } | null
  action: 'buy' | 'sell' | string
  qty: number
  tpMode: 'none' | 'price' | 'pct' | string
  tpValue: number | null
  slMode: 'none' | 'price' | 'pct' | string
  slValue: number | null
  repeat: boolean
  status: 'armed' | 'paused' | 'placing' | 'triggered' | 'failed' | string
  lastSide: string | null
  triggeredAt: string | null
  orderId: string | null
  fireNote: string | null
  createdAt: string
}

export interface LayoutBlob {
  v: 1
  tabs: Tab[]
  activeTabId: string | null
  sidebar: {
    panelOrder: PanelId[]
    panelCollapsed: Record<string, boolean>
    mainSizes: [number, number]
  }
}

export const DRAW_COLORS = [
  '#22c55e', '#ef4444', '#f59e0b', '#a855f7', '#06b6d4', '#e879f9', '#f4f4f5',
]

interface TerminalState {
  // session
  user: SessionUser | null
  hydrated: boolean
  setUser: (u: SessionUser | null) => void
  setHydrated: (v: boolean) => void

  // tabs
  tabs: Tab[]
  activeTabId: string
  addTab: (type: TabType) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  /** drag-and-drop reorder: move a tab to a target index (clamped) */
  moveTab: (dragId: string, toIndex: number) => void
  setTabSymbol: (tabId: string, symbol: string) => void
  setTabTimeframe: (tabId: string, tf: Timeframe) => void
  selectSymbol: (symbol: string) => void

  // multi-chart grid (per chart tab)
  setGridLayout: (tabId: string, layout: GridLayoutId) => void
  setPaneSymbol: (tabId: string, paneIdx: number, symbol: string) => void
  setPaneTimeframe: (tabId: string, paneIdx: number, tf: Timeframe) => void
  setFocusedPane: (tabId: string, paneIdx: number) => void
  setSyncCrosshair: (tabId: string, v: boolean) => void

  // right sidebar panel layout (Task 12)
  panelOrder: PanelId[]
  panelCollapsed: Record<string, boolean>
  mainSizes: [number, number]
  setPanelOrder: (order: PanelId[]) => void
  togglePanelCollapsed: (id: PanelId) => void
  setMainSizes: (sizes: [number, number]) => void

  // autosave
  layoutDirty: boolean
  markLayoutDirty: () => void
  markLayoutClean: () => void
  layoutSnapshot: () => LayoutBlob
  hydrateFromServer: (data: unknown) => void

  // watchlists
  watchlists: Watchlist[]
  activeWatchlistId: string | null
  watchlistsLoaded: boolean
  loadWatchlists: () => Promise<void>
  setActiveWatchlist: (id: string) => void
  createWatchlist: (name: string, color: string) => Promise<void>
  deleteWatchlist: (id: string) => Promise<void>
  updateWatchlist: (id: string, patch: { name?: string; color?: string; sortOrder?: number }) => Promise<void>
  moveWatchlist: (id: string, dir: -1 | 1) => Promise<void>
  addSymbolToWatchlist: (watchlistId: string, symbol: string) => Promise<AddSymbolResult>
  removeSymbolFromWatchlist: (watchlistId: string, symbol: string) => Promise<void>
  /** drag & drop reorder: move items[from] to index to (clamped), persisted */
  reorderWatchlistSymbol: (watchlistId: string, from: number, to: number) => Promise<void>

  // drawings
  drawingsBySymbol: Record<string, Drawing[]>
  drawingTool: DrawingKind | 'cursor'
  setDrawingTool: (t: DrawingKind | 'cursor') => void
  loadDrawings: (symbol: string) => Promise<void>
  addDrawingLocal: (d: Drawing) => void
  patchDrawingLocal: (id: string, symbol: string, patch: Partial<Drawing>) => void
  removeDrawingLocal: (id: string, symbol: string) => void

  // alerts
  alerts: Alert[]
  alertsLoaded: boolean
  loadAlerts: () => Promise<void>
  addAlertLocal: (a: Alert) => void
  patchAlertLocal: (id: string, patch: Partial<Alert>) => void
  removeAlertLocal: (id: string) => void

  // strategy bot (conditional orders)
  strategies: Strategy[]
  strategiesLoaded: boolean
  loadStrategies: () => Promise<void>
  addStrategyLocal: (s: Strategy) => void
  patchStrategyLocal: (id: string, patch: Partial<Strategy>) => void
  removeStrategyLocal: (id: string) => void
}

const DEFAULT_TAB: Omit<Tab, 'id'> = { type: 'chart', symbol: 'AAPL', timeframe: '1D' }

let idCounter = 0
function uid(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

const DEFAULT_LAYOUT: LayoutBlob = {
  v: 1,
  tabs: [],
  activeTabId: null,
  sidebar: { panelOrder: ['watchlist', 'quote', 'news'], panelCollapsed: {}, mainSizes: [72, 28] },
}

export const useTerminal = create<TerminalState>((set, get) => ({
  user: null,
  hydrated: false,
  setUser: (u) => set({ user: u }),
  setHydrated: (v) => set({ hydrated: v }),

  tabs: [{ id: uid('tab'), ...DEFAULT_TAB }],
  activeTabId: '',

  addTab: (type) => {
    const t: Tab =
      type === 'chart'
        ? { id: uid('tab'), type, symbol: get().tabs.find((x) => x.id === get().activeTabId)?.symbol || 'AAPL', timeframe: get().tabs.find((x) => x.id === get().activeTabId)?.timeframe || '1D' }
        : { id: uid('tab'), type, symbol: 'AAPL', timeframe: '1D' }
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id, layoutDirty: true }))
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get()
    if (tabs.length <= 1) return
    const idx = tabs.findIndex((t) => t.id === id)
    const remaining = tabs.filter((t) => t.id !== id)
    const nextActive = activeTabId === id ? remaining[Math.max(0, idx - 1)].id : activeTabId
    set({ tabs: remaining, activeTabId: nextActive, layoutDirty: true })
  },

  setActiveTab: (id) => set({ activeTabId: id, layoutDirty: true }),

  moveTab: (dragId, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === dragId)
      if (from < 0) return {}
      // remove first, then clamp the insertion point into the shortened array
      const next = s.tabs.filter((t) => t.id !== dragId)
      const idx = Math.max(0, Math.min(toIndex, next.length))
      next.splice(idx, 0, s.tabs[from])
      if (next.every((t, i) => t.id === s.tabs[i].id)) return {} // no-op order
      return { tabs: next, layoutDirty: true }
    }),

  setTabSymbol: (tabId, symbol) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, symbol } : t)),
      layoutDirty: true,
    })),

  setTabTimeframe: (tabId, tf) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, timeframe: tf } : t)),
      layoutDirty: true,
    })),

  // ---------- multi-chart grid ----------
  setGridLayout: (tabId, layout) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId || t.type !== 'chart') return t
        const panes = tabPanes(t)
        const count = layoutPaneCount(layout)
        const next = [...panes]
        while (next.length < count) next.push({ ...panes[0] })
        next.length = count
        if (layout === '1') {
          // single pane mirrors the legacy tab fields so other panels keep working
          return { ...t, symbol: next[0].symbol, timeframe: next[0].timeframe, grid: { layout, panes: next } }
        }
        return { ...t, grid: { layout, panes: next } }
      }),
      layoutDirty: true,
    })),

  setPaneSymbol: (tabId, paneIdx, symbol) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const panes = tabPanes(t)
        const i = Math.max(0, Math.min(paneIdx, panes.length - 1))
        if (panes[i].symbol === symbol) return t
        const next = panes.map((p, j) => (j === i ? { ...p, symbol } : p))
        // legacy single-chart mode keeps tab fields in sync
        if (!t.grid || t.grid.layout === '1') return { ...t, symbol, grid: { layout: t.grid?.layout ?? '1', panes: next } }
        return { ...t, grid: { layout: t.grid.layout, panes: next } }
      }),
      layoutDirty: true,
    })),

  setPaneTimeframe: (tabId, paneIdx, tf) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const panes = tabPanes(t)
        const i = Math.max(0, Math.min(paneIdx, panes.length - 1))
        if (panes[i].timeframe === tf) return t
        const next = panes.map((p, j) => (j === i ? { ...p, timeframe: tf } : p))
        if (!t.grid || t.grid.layout === '1') return { ...t, timeframe: tf, grid: { layout: t.grid?.layout ?? '1', panes: next } }
        return { ...t, grid: { layout: t.grid.layout, panes: next } }
      }),
      layoutDirty: true,
    })),

  setFocusedPane: (tabId, paneIdx) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId && t.focusedPane !== paneIdx ? { ...t, focusedPane: paneIdx } : t)),
      layoutDirty: true,
    })),

  setSyncCrosshair: (tabId, v) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, syncCrosshair: v } : t)),
      layoutDirty: true,
    })),

  selectSymbol: (symbol) => {
    const { activeTabId, tabs } = get()
    const active = tabs.find((t) => t.id === activeTabId)
    if (active && active.type === 'chart') {
      // target the focused pane so multi-chart grids follow watchlist clicks
      const panes = tabPanes(active)
      const idx = Math.min(active.focusedPane ?? 0, panes.length - 1)
      get().setPaneSymbol(active.id, idx, symbol)
    } else {
      const chartTab = tabs.find((t) => t.type === 'chart')
      if (chartTab) {
        // Activate the first chart tab and route through setPaneSymbol so the
        // tab's PANES are updated too — setting only `symbol` left
        // grid.panes[0] on the old symbol (tab label said XOM, chart showed
        // AAPL after clicking a heatmap tile from the heatmap tab).
        get().setPaneSymbol(chartTab.id, chartTab.focusedPane ?? 0, symbol)
        set((s) => ({ activeTabId: chartTab.id, layoutDirty: true }))
      }
    }
  },

  panelOrder: DEFAULT_LAYOUT.sidebar.panelOrder,
  panelCollapsed: {},
  mainSizes: DEFAULT_LAYOUT.sidebar.mainSizes,

  setPanelOrder: (order) => set({ panelOrder: order, layoutDirty: true }),

  togglePanelCollapsed: (id) =>
    set((s) => ({
      panelCollapsed: { ...s.panelCollapsed, [id]: !s.panelCollapsed[id] },
      layoutDirty: true,
    })),

  setMainSizes: (sizes) => {
    const prev = get().mainSizes
    if (Math.abs(prev[0] - sizes[0]) < 0.1 && Math.abs(prev[1] - sizes[1]) < 0.1) return
    set({ mainSizes: sizes, layoutDirty: true })
  },

  layoutDirty: false,
  markLayoutDirty: () => set({ layoutDirty: true }),
  markLayoutClean: () => set({ layoutDirty: false }),

  layoutSnapshot: () => {
    const s = get()
    return {
      v: 1 as const,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      sidebar: {
        panelOrder: s.panelOrder,
        panelCollapsed: s.panelCollapsed,
        mainSizes: s.mainSizes,
      },
    }
  },

  hydrateFromServer: (data) => {
    if (!data || typeof data !== 'object') return
    const blob = data as Partial<LayoutBlob>
    if (!blob.tabs || !Array.isArray(blob.tabs) || blob.tabs.length === 0) return
    const VALID_TFS = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M']
    const VALID_LAYOUTS: GridLayoutId[] = ['1', '2h', '2v', '3s', '4']
    const tabs = blob.tabs
      .filter((t) => t && typeof t.id === 'string' && ['chart', 'calendar', 'heatmap', 'positions'].includes(t.type))
      .map((t) => {
        const base = {
          id: t.id,
          type: t.type as TabType,
          symbol: (t.symbol || 'AAPL').toUpperCase(),
          timeframe: (VALID_TFS.includes(t.timeframe as string) ? t.timeframe : '1D') as Timeframe,
        }
        if (t.type !== 'chart') return { ...base }
        // restore multi-chart grid (sanitized; legacy blobs get a single pane)
        const layout: GridLayoutId =
          t.grid && VALID_LAYOUTS.includes(t.grid.layout) ? t.grid.layout : '1'
        let panes: Pane[] = Array.isArray(t.grid?.panes)
          ? t.grid.panes
              .filter((p) => p && typeof p.symbol === 'string')
              .map((p) => ({
                symbol: p.symbol.toUpperCase(),
                timeframe: (VALID_TFS.includes(p.timeframe as string) ? p.timeframe : '1D') as Timeframe,
              }))
          : []
        if (panes.length === 0) panes = [{ symbol: base.symbol, timeframe: base.timeframe }]
        const count = layoutPaneCount(layout)
        while (panes.length < count) panes.push({ ...panes[0] })
        panes.length = count
        return {
          ...base,
          grid: { layout, panes },
          focusedPane: Math.max(0, Math.min(typeof t.focusedPane === 'number' ? t.focusedPane : 0, count - 1)),
          syncCrosshair: Boolean(t.syncCrosshair),
        }
      })
    if (tabs.length === 0) return
    const activeTabId = tabs.some((t) => t.id === blob.activeTabId) ? (blob.activeTabId as string) : tabs[0].id
    const sb = blob.sidebar
    const mainSizes: [number, number] =
      Array.isArray(sb?.mainSizes) && sb.mainSizes.length === 2 ? [sb.mainSizes[0], 100 - sb.mainSizes[0]] : [72, 28]
    set({
      tabs,
      activeTabId,
      panelOrder: sb?.panelOrder?.length === 3 ? sb.panelOrder : DEFAULT_LAYOUT.sidebar.panelOrder,
      panelCollapsed: sb?.panelCollapsed || {},
      mainSizes,
      layoutDirty: false,
    })
  },

  watchlists: [],
  activeWatchlistId: null,
  watchlistsLoaded: false,

  loadWatchlists: async () => {
    try {
      const res = await fetch('/api/watchlists')
      if (!res.ok) return
      const json = await res.json()
      const lists = (json.lists as Watchlist[]) || []
      const { activeWatchlistId } = get()
      set({
        watchlists: lists,
        watchlistsLoaded: true,
        activeWatchlistId: activeWatchlistId && lists.some((l) => l.id === activeWatchlistId) ? activeWatchlistId : lists[0]?.id ?? null,
      })
    } catch {
      /* offline */
    }
  },

  setActiveWatchlist: (id) => set({ activeWatchlistId: id }),

  createWatchlist: async (name, color) => {
    const res = await fetch('/api/watchlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, color }),
    })
    if (!res.ok) return
    const json = await res.json()
    set((s) => ({ watchlists: [...s.watchlists, json.list], activeWatchlistId: json.list.id }))
  },

  deleteWatchlist: async (id) => {
    await fetch(`/api/watchlists/${id}`, { method: 'DELETE' })
    set((s) => {
      const lists = s.watchlists.filter((l) => l.id !== id)
      return {
        watchlists: lists,
        activeWatchlistId: s.activeWatchlistId === id ? lists[0]?.id ?? null : s.activeWatchlistId,
      }
    })
  },

  updateWatchlist: async (id, patch) => {
    set((s) => ({ watchlists: s.watchlists.map((l) => (l.id === id ? { ...l, ...patch } : l)) }))
    try {
      const res = await fetch(`/api/watchlists/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        // server rejected the patch (e.g. empty name) — resync to source of truth
        await get().loadWatchlists()
      }
    } catch {
      /* offline — optimistic state stays; next successful action resyncs */
    }
  },

  moveWatchlist: async (id, dir) => {
    const lists = [...get().watchlists]
    const idx = lists.findIndex((l) => l.id === id)
    const swap = idx + dir
    if (idx < 0 || swap < 0 || swap >= lists.length) return
    ;[lists[idx], lists[swap]] = [lists[swap], lists[idx]]
    const reordered = lists.map((l, i) => ({ ...l, sortOrder: i }))
    set({ watchlists: reordered })
    await Promise.all(
      reordered.map((l) =>
        fetch(`/api/watchlists/${l.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sortOrder: l.sortOrder }),
        }),
      ),
    )
  },

  addSymbolToWatchlist: async (watchlistId, symbol) => {
    const list = get().watchlists.find((l) => l.id === watchlistId)
    if (!list) return { ok: false, reason: 'error' }
    const sym = symbol.trim().toUpperCase()
    // format guard — Alpaca symbols are letters/digits plus . - / : (BRK.B, BTC/USD)
    if (!sym || !/^[A-Z0-9./:-]{1,15}$/.test(sym)) return { ok: false, reason: 'invalid' }
    if (list.items.includes(sym)) return { ok: false, reason: 'duplicate' }
    // existence check against the Alpaca asset universe (crypto majors always allowed)
    try {
      const res = await fetch(`/api/market/symbols?q=${encodeURIComponent(sym)}&exact=1`)
      if (res.ok) {
        const json = (await res.json()) as { valid?: boolean }
        if (json.valid !== true) return { ok: false, reason: 'unknown' }
      }
      // check endpoint unreachable → allow format-valid symbols (offline tolerance)
    } catch { /* offline */ }
    const items = [...list.items, sym].slice(0, 50)
    set((s) => ({ watchlists: s.watchlists.map((l) => (l.id === watchlistId ? { ...l, items } : l)) }))
    const res = await fetch(`/api/watchlists/${watchlistId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    })
    return res.ok ? { ok: true } : { ok: false, reason: 'error' }
  },

  removeSymbolFromWatchlist: async (watchlistId, symbol) => {
    const list = get().watchlists.find((l) => l.id === watchlistId)
    if (!list) return
    const items = list.items.filter((s) => s !== symbol)
    set((s) => ({ watchlists: s.watchlists.map((l) => (l.id === watchlistId ? { ...l, items } : l)) }))
    await fetch(`/api/watchlists/${watchlistId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    })
  },

  // drag & drop reorder — the items ARRAY order IS the persisted sort (the
  // PATCH endpoint stores it verbatim; export/import carries the same array)
  reorderWatchlistSymbol: async (watchlistId, from, to) => {
    const list = get().watchlists.find((l) => l.id === watchlistId)
    if (!list) return
    if (from < 0 || from >= list.items.length) return
    const to2 = Math.max(0, Math.min(list.items.length, to))
    if (to2 === from || to2 === from + 1) return // same place — no-op
    const items = [...list.items]
    const [sym] = items.splice(from, 1)
    // moving DOWN: removing the item first shifts the target left by one
    items.splice(from < to2 ? to2 - 1 : to2, 0, sym)
    set((s) => ({ watchlists: s.watchlists.map((l) => (l.id === watchlistId ? { ...l, items } : l)) }))
    try {
      const res = await fetch(`/api/watchlists/${watchlistId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) await get().loadWatchlists() // resync to source of truth
    } catch {
      /* offline — optimistic order stays; next action resyncs */
    }
  },

  drawingsBySymbol: {},
  drawingTool: 'cursor',
  setDrawingTool: (t) => set({ drawingTool: t }),

  loadDrawings: async (symbol) => {
    try {
      const res = await fetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}`)
      if (!res.ok) return
      const json = await res.json()
      set((s) => {
        const server = (json.drawings as Drawing[]) || []
        // The response was computed before the request finished, so it can be
        // stale: a drawing created WHILE the GET was in flight (optimistic
        // `tmp-` entry, or the confirmed one after the POST resolved) would be
        // silently wiped by a blind replace. Keep local-only entries — a
        // locally deleted drawing is absent from this list already, so
        // nothing deleted ever resurrects.
        const serverIds = new Set(server.map((d) => d.id))
        const localOnly = (s.drawingsBySymbol[symbol] || []).filter((d) => !serverIds.has(d.id))
        return { drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: [...server, ...localOnly] } }
      })
    } catch {
      /* offline */
    }
  },

  addDrawingLocal: (d) =>
    set((s) => ({
      drawingsBySymbol: { ...s.drawingsBySymbol, [d.symbol]: [...(s.drawingsBySymbol[d.symbol] || []), d] },
    })),

  patchDrawingLocal: (id, symbol, patch) =>
    set((s) => ({
      drawingsBySymbol: {
        ...s.drawingsBySymbol,
        [symbol]: (s.drawingsBySymbol[symbol] || []).map((d) => (d.id === id ? { ...d, ...patch } : d)),
      },
    })),

  removeDrawingLocal: (id, symbol) =>
    set((s) => ({
      drawingsBySymbol: {
        ...s.drawingsBySymbol,
        [symbol]: (s.drawingsBySymbol[symbol] || []).filter((d) => d.id !== id),
      },
    })),

  alerts: [],
  alertsLoaded: false,

  loadAlerts: async () => {
    try {
      const res = await fetch('/api/alerts')
      if (!res.ok) return
      const json = await res.json()
      set({ alerts: (json.alerts as Alert[]) || [], alertsLoaded: true })
    } catch {
      /* offline */
    }
  },

  addAlertLocal: (a) => set((s) => ({ alerts: [a, ...s.alerts] })),
  patchAlertLocal: (id, patch) =>
    set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  removeAlertLocal: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),

  // ---- strategy bot (conditional orders) ----
  strategies: [],
  strategiesLoaded: false,

  loadStrategies: async () => {
    try {
      const res = await fetch('/api/strategies')
      if (!res.ok) return
      const json = await res.json()
      set({ strategies: (json.strategies as Strategy[]) || [], strategiesLoaded: true })
    } catch {
      /* offline */
    }
  },

  addStrategyLocal: (r) => set((s) => ({ strategies: [r, ...s.strategies] })),
  patchStrategyLocal: (id, patch) =>
    set((s) => ({ strategies: s.strategies.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  removeStrategyLocal: (id) => set((s) => ({ strategies: s.strategies.filter((r) => r.id !== id) })),
}))

// helper (non-hook)
export function activeTabOf() {
  const { tabs, activeTabId } = useTerminal.getState()
  return tabs.find((t) => t.id === activeTabId) || tabs[0]
}
