'use client'

// Central terminal store: session, tabs, panel layout, watchlists, drawings, alerts.
// Layout auto-saves to server every 5s when dirty (Task 16 #3).
import { create } from 'zustand'
import { Timeframe } from '@/lib/market-types'

export interface SessionUser {
  id: string
  username: string
}

export type TabType = 'chart' | 'calendar' | 'heatmap'

export interface Tab {
  id: string
  type: TabType
  symbol: string
  timeframe: Timeframe
}

export type PanelId = 'watchlist' | 'quote' | 'news'

export interface DrawingPoint {
  time: number | null
  price: number
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

export interface Alert {
  id: string
  symbol: string
  price: number
  direction: 'above' | 'below' | string
  color: string
  status: 'active' | 'paused' | 'triggered' | string
  note: string | null
  triggeredAt: string | null
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
  setTabSymbol: (tabId: string, symbol: string) => void
  setTabTimeframe: (tabId: string, tf: Timeframe) => void
  selectSymbol: (symbol: string) => void

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
  addSymbolToWatchlist: (watchlistId: string, symbol: string) => Promise<boolean>
  removeSymbolFromWatchlist: (watchlistId: string, symbol: string) => Promise<void>

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

  selectSymbol: (symbol) => {
    const { activeTabId, tabs } = get()
    const active = tabs.find((t) => t.id === activeTabId)
    if (active && active.type === 'chart') {
      get().setTabSymbol(active.id, symbol)
    } else {
      const chartTab = tabs.find((t) => t.type === 'chart')
      if (chartTab) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === chartTab.id ? { ...t, symbol } : t)),
          activeTabId: chartTab.id,
          layoutDirty: true,
        }))
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
    const tabs = blob.tabs
      .filter((t) => t && typeof t.id === 'string' && ['chart', 'calendar', 'heatmap'].includes(t.type))
      .map((t) => ({
        id: t.id,
        type: t.type as TabType,
        symbol: (t.symbol || 'AAPL').toUpperCase(),
        timeframe: (['1m', '5m', '15m', '1h', '1D', '1W', '1M'].includes(t.timeframe as string) ? t.timeframe : '1D') as Timeframe,
      }))
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
    await fetch(`/api/watchlists/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
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
    if (!list) return false
    const sym = symbol.trim().toUpperCase()
    if (!sym || list.items.includes(sym)) return false
    const items = [...list.items, sym].slice(0, 50)
    set((s) => ({ watchlists: s.watchlists.map((l) => (l.id === watchlistId ? { ...l, items } : l)) }))
    const res = await fetch(`/api/watchlists/${watchlistId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    })
    return res.ok
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

  drawingsBySymbol: {},
  drawingTool: 'cursor',
  setDrawingTool: (t) => set({ drawingTool: t }),

  loadDrawings: async (symbol) => {
    try {
      const res = await fetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}`)
      if (!res.ok) return
      const json = await res.json()
      set((s) => ({ drawingsBySymbol: { ...s.drawingsBySymbol, [symbol]: (json.drawings as Drawing[]) || [] } }))
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
}))

// helper (non-hook)
export function activeTabOf() {
  const { tabs, activeTabId } = useTerminal.getState()
  return tabs.find((t) => t.id === activeTabId) || tabs[0]
}
