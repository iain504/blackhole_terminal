import type { EarningsEvent } from "@/lib/earnings";
import type {
  AlertItem,
  AuthCheckResponse,
  AuthUser,
  Bar,
  CalendarResponse,
  DataMode,
  MoversData,
  NewsItem,
  SearchItem,
  Snapshot,
  StatusResponse,
  TelegramStatus,
  Timeframe,
  TriggeredAlert,
  WatchlistSummary,
} from "@/lib/types";

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-json response
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return json as T;
}

async function apiSend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-json response
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return json as T;
}

export const fetchStatus = () => apiGet<StatusResponse>("/api/status");

export const fetchBars = (symbol: string, tf: Timeframe) =>
  apiGet<{ bars: Bar[]; mode: DataMode }>(`/api/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);

export const fetchSnapshots = (symbols: string[]) =>
  symbols.length
    ? apiGet<{ snapshots: Record<string, Snapshot> }>(
        `/api/snapshots?symbols=${symbols.map(encodeURIComponent).join(",")}`
      )
    : Promise.resolve({ snapshots: {} as Record<string, Snapshot> });

export const fetchMovers = () => apiGet<MoversData & { mode: DataMode }>("/api/movers");

export const fetchNews = (symbol: string) =>
  apiGet<{ news: NewsItem[] }>(`/api/news?symbol=${encodeURIComponent(symbol)}`);

export const fetchSearch = (q: string) =>
  apiGet<{ results: SearchItem[] }>(`/api/search?q=${encodeURIComponent(q)}`);

// Alpaca has no earnings endpoint — synthetic schedule in both modes
export const fetchEarnings = (symbol: string) =>
  apiGet<{ events: EarningsEvent[]; mode: DataMode; synthetic: boolean }>(
    `/api/earnings?symbol=${encodeURIComponent(symbol)}`
  );

export const fetchWatchlist = (listId?: string) =>
  apiGet<{ symbols: string[] }>(`/api/watchlist${listId ? `?listId=${encodeURIComponent(listId)}` : ""}`);

export const addToWatchlist = (symbol: string, listId?: string) =>
  apiSend<{ symbols: string[] }>("/api/watchlist", "POST", { symbol, listId });

export const removeFromWatchlist = (symbol: string, listId?: string) =>
  apiSend<{ symbols: string[] }>(
    `/api/watchlist?symbol=${encodeURIComponent(symbol)}${listId ? `&listId=${encodeURIComponent(listId)}` : ""}`,
    "DELETE"
  );

// ---------------- named watchlists ----------------

export const fetchWatchlists = () => apiGet<{ lists: WatchlistSummary[] }>("/api/watchlists");

export const createWatchlist = (name: string, color: string) =>
  apiSend<{ list: WatchlistSummary }>("/api/watchlists", "POST", { name, color });

export const updateWatchlist = (id: string, patch: { name?: string; color?: string }) =>
  apiSend<{ list: { id: string; name: string; color: string } }>(`/api/watchlists/${id}`, "PATCH", patch);

export const deleteWatchlist = (id: string) =>
  apiSend<{ lists: WatchlistSummary[] }>(`/api/watchlists/${id}`, "DELETE");

// ---------------- price alerts ----------------

export const fetchAlerts = () => apiGet<{ alerts: AlertItem[] }>("/api/alerts");

export const createAlert = (input: { symbol: string; price: number; direction: string; note?: string }) =>
  apiSend<{ alert: AlertItem }>("/api/alerts", "POST", input);

export const updateAlert = (
  id: string,
  patch: { active?: boolean; price?: number; direction?: string; note?: string | null; color?: string | null }
) => apiSend<{ alert: AlertItem }>(`/api/alerts/${id}`, "PATCH", patch);

export const deleteAlert = (id: string) => apiSend<{ ok: boolean }>(`/api/alerts/${id}`, "DELETE");

export const evaluateAlerts = (prices: Record<string, number>) =>
  apiSend<{ triggered: TriggeredAlert[] }>("/api/alerts/evaluate", "POST", { prices });

// ---------------- telegram notifications ----------------

export const fetchTelegramStatus = () => apiGet<TelegramStatus>("/api/telegram");

export const saveTelegram = (botToken: string, chatId: string, test: boolean) =>
  apiSend<{ ok: boolean; tokenMasked: string; chatMasked: string }>("/api/telegram", "POST", {
    botToken,
    chatId,
    test,
  });

export const clearTelegram = () => apiSend<{ ok: boolean }>("/api/telegram", "DELETE");

// ---------------- economic calendar ----------------

export const fetchCalendar = () => apiGet<CalendarResponse>("/api/calendar");

export const fetchSettings = () =>
  apiGet<{ configured: boolean; keyIdMasked: string | null }>("/api/settings");

export const saveSettings = (keyId: string, secret: string) =>
  apiSend<{ ok: boolean; keyIdMasked: string }>("/api/settings", "POST", { keyId, secret });

export const clearSettings = () => apiSend<{ ok: boolean }>("/api/settings", "DELETE");

// ---------------- auth (2FA-capable accounts) ----------------

export const authMe = () => apiGet<AuthCheckResponse>("/api/auth/me");

export const authRegister = (username: string, password: string) =>
  apiSend<{ user: AuthUser }>("/api/auth/register", "POST", { username, password });

export const authLogin = (username: string, password: string) =>
  apiSend<{ user?: AuthUser; twofa?: boolean; ticket?: string }>("/api/auth/login", "POST", { username, password });

export const authVerify2fa = (ticket: string, code: string) =>
  apiSend<{ user: AuthUser }>("/api/auth/2fa/verify", "POST", { ticket, code });

export const authLogout = () => apiSend<{ ok: boolean }>("/api/auth/logout", "POST");

export const auth2faSetup = () =>
  apiSend<{ secret: string; otpauthUrl: string; qrDataUrl: string }>("/api/auth/2fa/setup", "POST");

export const auth2faEnable = (code: string) =>
  apiSend<{ user: AuthUser }>("/api/auth/2fa/enable", "POST", { code });

export const auth2faDisable = (code: string) =>
  apiSend<{ user: AuthUser }>("/api/auth/2fa/disable", "POST", { code });

// ---------------- per-user UI state (5s autosave) ----------------

export const fetchUserState = () => apiGet<{ state: string | null }>("/api/user/state");

export const pushUserState = (data: string) => apiSend<{ ok: boolean }>("/api/user/state", "POST", { data });
