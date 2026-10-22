"use client";

import { create } from "zustand";
import { toast } from "sonner";
import type { AlertDirection, AlertItem, AuthUser, Timeframe, WatchlistSummary } from "@/lib/types";
import {
  addToWatchlist,
  createWatchlist,
  deleteWatchlist,
  fetchWatchlists,
  removeFromWatchlist,
  updateWatchlist,
  authMe,
} from "@/lib/client-api";
import {
  createAlert as apiCreateAlert,
  deleteAlert as apiDeleteAlert,
  fetchAlerts,
  fetchUserState,
  pushUserState,
  updateAlert as apiUpdateAlert,
  authLogout,
} from "@/lib/client-api";
import { INDICATOR_DEFAULTS, type IndicatorKey, type IndicatorState } from "@/lib/indicators";
import { resetDrawingStore, type DrawTool } from "@/lib/drawings";

export type ChartType = "candles" | "line" | "area";
export type DataMode = "live" | "demo";

/** Multi-chart layouts: single, two columns, two rows, 2×2 grid. */
export type LayoutId = "1" | "2h" | "2v" | "4";

export interface ChartFrame {
  id: string;
  symbol: string;
  timeframe: Timeframe;
}

export const LAYOUT_IDS: LayoutId[] = ["1", "2h", "2v", "4"];
export const FRAME_IDS = ["f1", "f2", "f3", "f4"] as const;
export const LAYOUT_COUNT: Record<LayoutId, number> = { "1": 1, "2h": 2, "2v": 2, "4": 4 };

/** Panels stacked in the right sidebar (desktop): watchlist on top, then quote, news, calendar. */
export type SidebarPanelId = "watchlist" | "quote" | "news" | "calendar";
export const SIDEBAR_PANEL_IDS: SidebarPanelId[] = ["watchlist", "quote", "news", "calendar"];

/** Bottom tab pages: chart workspace, full-page tools or the heat map. */
export type TabKind = "charts" | "calendar" | "heatmap";
export interface TerminalTab {
  id: string;
  kind: TabKind;
  name: string;
}

function makeTab(id: string, kind: TabKind, name: string): TerminalTab {
  return { id, kind, name };
}

/** Validate persisted tabs; returns null when unusable. */
function sanitizeTabs(
  raw: { id?: string; kind?: string; name?: string }[] | undefined
): { tabs: TerminalTab[]; activeTabId: string } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const tabs: TerminalTab[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const id = typeof t.id === "string" && t.id ? t.id : null;
    if (!id || seen.has(id)) continue;
    const kind: TabKind = t.kind === "calendar" ? "calendar" : t.kind === "heatmap" ? "heatmap" : "charts";
    const fallback = kind === "calendar" ? "Economic Calendar" : kind === "heatmap" ? "Heat Map" : "Chart";
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 40) : fallback;
    seen.add(id);
    tabs.push(makeTab(id, kind, name));
  }
  if (tabs.length === 0) return null;
  return { tabs, activeTabId: tabs[0].id };
}

interface UiPrefs {
  symbol?: string;
  timeframe?: Timeframe;
  chartType?: ChartType;
  indicators?: IndicatorState;
  layout?: LayoutId;
  frames?: { id?: string; symbol?: string; timeframe?: Timeframe }[];
  activeFrameId?: string;
  sidebarOrder?: string[];
  sidebarCollapsed?: Record<string, boolean>;
  activeListId?: string | null;
  tabs?: { id?: string; kind?: string; name?: string }[];
  activeTabId?: string;
}

const PREFS_KEY = "fluxview.ui.v1";
const DRAWINGS_LS_KEY = "fluxview.drawings.v1";

// ---------------- per-user state sync (5s autosave) ----------------

// While signed in, every local change marks the blob dirty; a 5s interval
// (started by startUserStateSync) pushes it to /api/user/state. The blob is
// the localStorage prefs + the drawings store, so layout, tabs, drawings,
// watchlist selection etc. all follow the account across devices.
let stateDirty = false;
let suppressDirty = false; // true while applying a server-pulled blob
let syncTimer: number | null = null;

function markStateDirty(): void {
  if (suppressDirty) return;
  if (useTerminal.getState().authStatus !== "authed") return;
  stateDirty = true;
}

/** Call after any non-prefs local change (e.g. chart drawings) to schedule a save. */
export function noteUserStateDirty(): void {
  markStateDirty();
}

function collectStateBlob(): string {
  let prefs: unknown = {};
  let drawings: unknown = {};
  try {
    prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    // keep default
  }
  try {
    drawings = JSON.parse(window.localStorage.getItem(DRAWINGS_LS_KEY) ?? "{}");
  } catch {
    // keep default
  }
  return JSON.stringify({ v: 1, prefs, drawings });
}

/** Push the local blob when dirty (called on the 5s timer / unload). */
export async function flushUserState(): Promise<void> {
  if (!stateDirty) return;
  if (useTerminal.getState().authStatus !== "authed") return;
  stateDirty = false;
  try {
    await pushUserState(collectStateBlob());
  } catch {
    stateDirty = true; // retry on the next tick
  }
}

/** Apply a state blob pulled from the server (prefs + drawings). */
function applyStateBlob(raw: string): void {
  const parsed = JSON.parse(raw) as { prefs?: Record<string, unknown>; drawings?: Record<string, unknown> } | null;
  if (!parsed || typeof parsed !== "object") return;
  suppressDirty = true;
  try {
    // MERGE server prefs over the local ones (server wins per key) so sparse
    // or older server blobs can never erase richer local state.
    if (parsed.prefs && typeof parsed.prefs === "object") {
      let local: Record<string, unknown> = {};
      try {
        local = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
      } catch {
        // keep empty
      }
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...local, ...parsed.prefs }));
    }
    if (parsed.drawings && typeof parsed.drawings === "object") {
      let localDrawings: Record<string, unknown> = {};
      try {
        localDrawings = JSON.parse(window.localStorage.getItem(DRAWINGS_LS_KEY) ?? "{}") as Record<string, unknown>;
      } catch {
        // keep empty
      }
      window.localStorage.setItem(DRAWINGS_LS_KEY, JSON.stringify({ ...localDrawings, ...parsed.drawings }));
      // make every chart panel re-read the drawing store from localStorage
      resetDrawingStore();
      window.dispatchEvent(new CustomEvent("fluxview:drawings", { detail: { key: "*", sourceId: "server" } }));
    }
  } catch {
    // storage errors — ignore
  }
  suppressDirty = false;
  // re-apply prefs to the store (force re-hydration)
  useTerminal.setState({ hydrated: false });
  useTerminal.getState().hydratePrefs();
}

/** Fetch the account's saved state after login (or seed it with the current one). */
export async function pullUserState(): Promise<void> {
  try {
    const { state } = await fetchUserState();
    if (state) {
      applyStateBlob(state);
    } else {
      stateDirty = false;
      await pushUserState(collectStateBlob()).catch(() => null);
    }
  } catch {
    // unreachable server — stay local
  }
}

/** Start the 5s autosave timer + flush on unload (idempotent). */
export function startUserStateSync(): void {
  if (syncTimer !== null || typeof window === "undefined") return;
  syncTimer = window.setInterval(() => void flushUserState(), 5000);
  window.addEventListener("beforeunload", () => {
    void flushUserState();
  });
}

// NOTE: never read localStorage at module scope — the server render would use
// defaults while the client render used persisted values, causing a hydration
// mismatch. Prefs are applied post-mount via hydratePrefs().
function loadPrefs(): UiPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as UiPrefs | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePrefs(patch: UiPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // ignore storage errors
  }
  markStateDirty(); // signed-in users: the 5s autosave will push this
}

function makeFrame(id: string, symbol = "AAPL", timeframe: Timeframe = "1D"): ChartFrame {
  return { id, symbol, timeframe };
}

/** Validate persisted frames; returns null when unusable. */
function sanitizeFrames(raw: UiPrefs): { layout: LayoutId; frames: ChartFrame[]; activeFrameId: string } | null {
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;
  const layout: LayoutId = raw.layout && LAYOUT_COUNT[raw.layout] ? raw.layout : "1";
  const count = LAYOUT_COUNT[layout];
  const frames: ChartFrame[] = [];
  for (let i = 0; i < count; i++) {
    const f = raw.frames[i];
    const symbol = typeof f?.symbol === "string" && f.symbol.trim() ? f.symbol.trim().toUpperCase() : "AAPL";
    const timeframe: Timeframe = f?.timeframe ?? "1D";
    frames.push({ id: FRAME_IDS[i], symbol, timeframe });
  }
  const activeFrameId = frames.some((f) => f.id === raw.activeFrameId) ? (raw.activeFrameId as string) : "f1";
  return { layout, frames, activeFrameId };
}

interface TerminalStore {
  // active-frame mirror (kept in sync for components that follow the active chart)
  symbol: string;
  timeframe: Timeframe;
  // multi-frame layout
  layout: LayoutId;
  frames: ChartFrame[];
  activeFrameId: string;
  hydrated: boolean;

  // right sidebar (desktop): stack order of the watchlist/quote/news panels + collapsed flags
  sidebarOrder: SidebarPanelId[];
  sidebarCollapsed: Record<SidebarPanelId, boolean>;

  // bottom tab pages (chart workspace / economic calendar)
  tabs: TerminalTab[];
  activeTabId: string;

  chartType: ChartType;
  indicators: IndicatorState;
  drawTool: DrawTool;
  settingsOpen: boolean;
  mobileListOpen: boolean;
  newsCollapsed: boolean;
  mode: DataMode | null;
  watchlist: string[]; // symbols of the ACTIVE list
  watchlists: WatchlistSummary[]; // all named lists
  activeListId: string | null;
  watchlistLoaded: boolean;
  listsLocked: boolean; // 401 — sign in to use watchlists

  // price alerts (server-persisted)
  alerts: AlertItem[];
  alertsLoaded: boolean;
  alertsOpen: boolean;
  alertsLocked: boolean; // 401 — sign in to use alerts

  // auth (2FA-capable accounts)
  authUser: AuthUser | null;
  authStatus: "loading" | "guest" | "authed";
  hasUsers: boolean; // at least one account exists → private APIs are gated
  authOpen: boolean;

  initAuth: () => Promise<void>;
  setAuthOpen: (v: boolean) => void;
  finishLogin: (user: AuthUser) => Promise<void>;
  logout: () => Promise<void>;

  hydratePrefs: () => void;
  setSymbol: (s: string, frameId?: string) => void;
  setTimeframe: (t: Timeframe, frameId?: string) => void;
  setChartType: (c: ChartType) => void;
  toggleIndicator: (k: IndicatorKey) => void;
  setDrawTool: (t: DrawTool) => void;
  setLayout: (l: LayoutId) => void;
  setActiveFrame: (id: string) => void;
  setSettingsOpen: (v: boolean) => void;
  setMobileListOpen: (v: boolean) => void;
  setNewsCollapsed: (v: boolean) => void;
  moveSidebarPanel: (id: SidebarPanelId, dir: -1 | 1) => void;
  toggleSidebarPanel: (id: SidebarPanelId) => void;
  setActiveTab: (id: string) => void;
  addTab: (kind: TabKind) => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  setMode: (m: DataMode) => void;
  loadWatchlist: () => Promise<void>;
  setActiveList: (id: string) => void;
  createList: (name: string, color: string) => Promise<void>;
  updateList: (id: string, patch: { name?: string; color?: string }) => Promise<void>;
  removeList: (id: string) => Promise<void>;
  addSymbol: (s: string) => Promise<void>;
  removeSymbol: (s: string) => Promise<void>;
  loadAlerts: () => Promise<void>;
  addAlert: (input: { symbol: string; price: number; direction: string; note?: string; color?: string }) => Promise<void>;
  updateAlert: (id: string, patch: { active?: boolean; price?: number; direction?: string; note?: string | null; color?: string | null }) => Promise<void>;
  toggleAlert: (id: string, active: boolean) => Promise<void>;
  removeAlert: (id: string) => Promise<void>;
  setAlertsOpen: (v: boolean) => void;
}

export const useTerminal = create<TerminalStore>((set, get) => ({
  symbol: "AAPL",
  timeframe: "1D",
  layout: "1",
  frames: [makeFrame("f1")],
  activeFrameId: "f1",
  hydrated: false,
  sidebarOrder: ["watchlist", "quote", "news", "calendar"],
  sidebarCollapsed: { watchlist: false, quote: false, news: false, calendar: false },
  tabs: [makeTab("t1", "charts", "Chart 1")],
  activeTabId: "t1",

  chartType: "candles",
  indicators: { ...INDICATOR_DEFAULTS },
  drawTool: "cursor",
  settingsOpen: false,
  mobileListOpen: false,
  newsCollapsed: false,
  mode: null,
  watchlist: [],
  watchlists: [],
  activeListId: null,
  watchlistLoaded: false,
  listsLocked: false,
  alerts: [],
  alertsLoaded: false,
  alertsOpen: false,
  alertsLocked: false,

  authUser: null,
  authStatus: "loading",
  hasUsers: false,
  authOpen: false,

  // applied once after mount so the first client render matches SSR
  hydratePrefs: () => {
    if (get().hydrated) return;
    const p = loadPrefs();
    const patch: Partial<TerminalStore> = { hydrated: true };

    if (p.chartType) patch.chartType = p.chartType;
    if (p.indicators) patch.indicators = { ...INDICATOR_DEFAULTS, ...p.indicators };

    const frames = sanitizeFrames(p);
    if (frames) {
      patch.layout = frames.layout;
      patch.frames = frames.frames;
      patch.activeFrameId = frames.activeFrameId;
    }
    const f0 = patch.frames?.find((f) => f.id === patch.activeFrameId) ?? patch.frames?.[0];
    if (f0) {
      patch.symbol = f0.symbol;
      patch.timeframe = f0.timeframe;
    } else {
      // legacy blob without frames: mirror onto the primary frame so the
      // topbar/quote and the chart never disagree
      if (p.symbol || p.timeframe) {
        const symbol = p.symbol ? p.symbol.trim().toUpperCase() : undefined;
        const timeframe = p.timeframe;
        patch.frames = get().frames.map((f, i) =>
          i === 0
            ? { ...f, symbol: symbol ?? f.symbol, timeframe: timeframe ?? f.timeframe }
            : f
        );
        if (symbol) patch.symbol = symbol;
        if (timeframe) patch.timeframe = timeframe;
      }
    }

    if (Array.isArray(p.sidebarOrder)) {
      const valid = p.sidebarOrder.filter(
        (x): x is SidebarPanelId => typeof x === "string" && (SIDEBAR_PANEL_IDS as string[]).includes(x)
      );
      const missing = SIDEBAR_PANEL_IDS.filter((x) => !valid.includes(x));
      const order = [...valid, ...missing];
      if (order.length === SIDEBAR_PANEL_IDS.length) patch.sidebarOrder = order;
    }
    if (p.sidebarCollapsed && typeof p.sidebarCollapsed === "object") {
      const c = p.sidebarCollapsed;
      patch.sidebarCollapsed = {
        watchlist: c.watchlist === true,
        quote: c.quote === true,
        news: c.news === true,
        calendar: c.calendar === true,
      };
    }
    if (typeof p.activeListId === "string" && p.activeListId) {
      patch.activeListId = p.activeListId;
    }

    const tabs = sanitizeTabs(p.tabs);
    if (tabs) {
      patch.tabs = tabs.tabs;
      patch.activeTabId = tabs.tabs.some((t) => t.id === p.activeTabId) ? (p.activeTabId as string) : tabs.activeTabId;
    }

    set(patch);
  },

  setSymbol: (s, frameId) => {
    const symbol = s.trim().toUpperCase();
    const st = get();
    const target = frameId ?? st.activeFrameId;
    set({
      symbol,
      frames: st.frames.map((f) => (f.id === target ? { ...f, symbol } : f)),
    });
    savePrefs({ symbol, frames: get().frames });
  },
  setTimeframe: (t, frameId) => {
    const st = get();
    const target = frameId ?? st.activeFrameId;
    set({
      timeframe: t,
      frames: st.frames.map((f) => (f.id === target ? { ...f, timeframe: t } : f)),
    });
    savePrefs({ timeframe: t, frames: get().frames });
  },
  setChartType: (c) => {
    set({ chartType: c });
    savePrefs({ chartType: c });
  },
  toggleIndicator: (k) => {
    const indicators = { ...get().indicators, [k]: !get().indicators[k] };
    set({ indicators });
    savePrefs({ indicators });
  },
  setDrawTool: (t) => set({ drawTool: t }),
  setLayout: (l) => {
    const st = get();
    const count = LAYOUT_COUNT[l];
    const frames = FRAME_IDS.slice(0, count).map(
      (id, i) => st.frames.find((f) => f.id === id) ?? makeFrame(id, st.frames[0]?.symbol ?? "AAPL", st.frames[0]?.timeframe ?? "1D")
    );
    // keep the primary frame active so the mirrored symbol/timeframe stay coherent
    set({ layout: l, frames, activeFrameId: "f1", symbol: frames[0].symbol, timeframe: frames[0].timeframe });
    savePrefs({ layout: l, frames, activeFrameId: "f1", symbol: frames[0].symbol, timeframe: frames[0].timeframe });
  },
  setActiveFrame: (id) => {
    const st = get();
    if (st.activeFrameId === id) return;
    const f = st.frames.find((x) => x.id === id);
    if (!f) return;
    set({ activeFrameId: id, symbol: f.symbol, timeframe: f.timeframe });
    savePrefs({ activeFrameId: id, symbol: f.symbol, timeframe: f.timeframe });
  },
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setMobileListOpen: (v) => set({ mobileListOpen: v }),
  setNewsCollapsed: (v) => set({ newsCollapsed: v }),
  moveSidebarPanel: (id, dir) => {
    const order = [...get().sidebarOrder];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    set({ sidebarOrder: order });
    savePrefs({ sidebarOrder: order });
  },
  toggleSidebarPanel: (id) => {
    const sidebarCollapsed = { ...get().sidebarCollapsed, [id]: !get().sidebarCollapsed[id] };
    set({ sidebarCollapsed });
    savePrefs({ sidebarCollapsed });
  },

  setActiveTab: (id) => {
    if (get().activeTabId === id) return;
    if (!get().tabs.some((t) => t.id === id)) return;
    set({ activeTabId: id });
    savePrefs({ activeTabId: id });
  },

  addTab: (kind) => {
    const st = get();
    const id = `t${Date.now().toString(36)}${st.tabs.length.toString(36)}`;
    const sameKind = st.tabs.filter((t) => t.kind === kind).length + 1;
    const name =
      kind === "calendar"
        ? sameKind === 1
          ? "Economic Calendar"
          : `Economic Calendar ${sameKind}`
        : kind === "heatmap"
          ? sameKind === 1
            ? "Heat Map"
            : `Heat Map ${sameKind}`
          : `Chart ${sameKind}`;
    const tabs = [...st.tabs, makeTab(id, kind, name)];
    set({ tabs, activeTabId: id });
    savePrefs({ tabs, activeTabId: id });
  },

  closeTab: (id) => {
    const st = get();
    if (st.tabs.length <= 1) return;
    const idx = st.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tabs = st.tabs.filter((t) => t.id !== id);
    const activeTabId = st.activeTabId === id ? (tabs[idx - 1] ?? tabs[idx]).id : st.activeTabId;
    set({ tabs, activeTabId });
    savePrefs({ tabs, activeTabId });
  },

  renameTab: (id, name) => {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    const tabs = get().tabs.map((t) => (t.id === id ? { ...t, name: clean } : t));
    set({ tabs });
    savePrefs({ tabs });
  },
  setMode: (m) => set({ mode: m }),

  initAuth: async () => {
    try {
      const { user, hasUsers } = await authMe();
      if (user) {
        set({ authUser: user, authStatus: "authed", hasUsers: hasUsers });
        await pullUserState();
        await Promise.all([get().loadWatchlist(), get().loadAlerts()]);
      } else {
        set({ authUser: null, authStatus: "guest", hasUsers: hasUsers });
        if (hasUsers) {
          set({ listsLocked: true, alertsLocked: true });
        }
      }
    } catch {
      set({ authStatus: "guest" });
    }
  },

  setAuthOpen: (v) => set({ authOpen: v }),

  finishLogin: async (user) => {
    set({ authUser: user, authStatus: "authed", hasUsers: true, authOpen: false, listsLocked: false, alertsLocked: false });
    await pullUserState();
    await Promise.all([get().loadWatchlist(), get().loadAlerts()]);
    toast.success(`Welcome, ${user.username}`);
  },

  logout: async () => {
    try {
      await authLogout();
    } catch {
      // clear locally regardless
    }
    set({ authUser: null, authStatus: "guest", listsLocked: true, alertsLocked: true });
    // reload to reset all private in-memory state cleanly
    window.location.reload();
  },

  loadWatchlist: async () => {
    try {
      const { lists } = await fetchWatchlists();
      const st = get();
      const activeId =
        st.activeListId && lists.some((l) => l.id === st.activeListId) ? st.activeListId : lists[0]?.id ?? null;
      const active = lists.find((l) => l.id === activeId) ?? null;
      set({ watchlists: lists, activeListId: activeId, watchlist: active?.symbols ?? [], watchlistLoaded: true, listsLocked: false });
      if (activeId) savePrefs({ activeListId: activeId });
    } catch (e) {
      set({ watchlistLoaded: true, listsLocked: e instanceof Error && e.message.includes("Sign in") });
      if (!(e instanceof Error && e.message.includes("Sign in"))) {
        toast.error(e instanceof Error ? e.message : "Failed to load watchlist");
      }
    }
  },

  setActiveList: (id) => {
    const st = get();
    if (st.activeListId === id) return;
    const list = st.watchlists.find((l) => l.id === id);
    if (!list) return;
    set({ activeListId: id, watchlist: list.symbols });
    savePrefs({ activeListId: id });
  },

  createList: async (name, color) => {
    try {
      const { list } = await createWatchlist(name, color);
      set({ watchlists: [...get().watchlists, list], activeListId: list.id, watchlist: [] });
      savePrefs({ activeListId: list.id });
      toast.success(`Watchlist "${list.name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create watchlist");
    }
  },

  updateList: async (id, patch) => {
    try {
      await updateWatchlist(id, patch);
      set({ watchlists: get().watchlists.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
      toast.success(patch.name !== undefined ? "Watchlist renamed" : "Watchlist color updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update watchlist");
    }
  },

  removeList: async (id) => {
    try {
      const { lists } = await deleteWatchlist(id);
      const st = get();
      const activeId = st.activeListId === id ? lists[0]?.id ?? null : st.activeListId;
      const active = lists.find((l) => l.id === activeId) ?? lists[0] ?? null;
      set({ watchlists: lists, activeListId: active?.id ?? null, watchlist: active?.symbols ?? [] });
      savePrefs({ activeListId: active?.id ?? null });
      toast.success("Watchlist deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete watchlist");
    }
  },

  addSymbol: async (s) => {
    const symbol = s.trim().toUpperCase();
    try {
      const { symbols } = await addToWatchlist(symbol, get().activeListId ?? undefined);
      set({ watchlist: symbols, watchlists: get().watchlists.map((l) => (l.id === get().activeListId ? { ...l, symbols } : l)) });
      toast.success(`${symbol} added to watchlist`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add symbol");
    }
  },

  removeSymbol: async (s) => {
    try {
      const { symbols } = await removeFromWatchlist(s, get().activeListId ?? undefined);
      set({ watchlist: symbols, watchlists: get().watchlists.map((l) => (l.id === get().activeListId ? { ...l, symbols } : l)) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove symbol");
    }
  },

  loadAlerts: async () => {
    try {
      const { alerts } = await fetchAlerts();
      set({ alerts, alertsLoaded: true, alertsLocked: false });
    } catch (e) {
      const locked = e instanceof Error && e.message.includes("Sign in");
      set({ alertsLoaded: true, alertsLocked: locked });
      if (!locked) toast.error(e instanceof Error ? e.message : "Failed to load alerts");
    }
  },

  addAlert: async (input) => {
    try {
      const { alert } = await apiCreateAlert(input);
      set({ alerts: [alert, ...get().alerts] });
      toast.success(`${alert.symbol} alert @ ${alert.price} created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create alert");
    }
  },

  toggleAlert: async (id, active) => {
    const prev = get().alerts;
    set({ alerts: prev.map((a) => (a.id === id ? { ...a, active, triggeredAt: active ? null : a.triggeredAt } : a)) });
    try {
      const { alert } = await apiUpdateAlert(id, { active });
      set({ alerts: get().alerts.map((a) => (a.id === id ? alert : a)) });
    } catch (e) {
      set({ alerts: prev });
      toast.error(e instanceof Error ? e.message : "Failed to update alert");
    }
  },

  updateAlert: async (id, patch) => {
    const prev = get().alerts;
    const optimistic = prev.map((a) =>
      a.id === id
        ? {
            ...a,
            active: patch.active ?? a.active,
            price: patch.price ?? a.price,
            direction: (patch.direction as AlertDirection | undefined) ?? a.direction,
            note: patch.note !== undefined ? patch.note : a.note,
            color: patch.color !== undefined ? patch.color : a.color,
          }
        : a
    );
    set({ alerts: optimistic });
    try {
      const { alert } = await apiUpdateAlert(id, patch);
      set({ alerts: get().alerts.map((a) => (a.id === id ? alert : a)) });
    } catch (e) {
      set({ alerts: prev });
      toast.error(e instanceof Error ? e.message : "Failed to update alert");
    }
  },

  removeAlert: async (id) => {
    const prev = get().alerts;
    set({ alerts: prev.filter((a) => a.id !== id) });
    try {
      await apiDeleteAlert(id);
    } catch (e) {
      set({ alerts: prev });
      toast.error(e instanceof Error ? e.message : "Failed to delete alert");
    }
  },

  setAlertsOpen: (v) => set({ alertsOpen: v }),
}));

/** The frame the TopBar / search / watchlist currently target. */
export function useActiveFrame(): ChartFrame {
  return useTerminal((s) => s.frames.find((f) => f.id === s.activeFrameId) ?? s.frames[0]);
}
