export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W" | "1M";

export const TIMEFRAMES: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"];

/** Timeframes whose bars have unix-second timestamps (vs "YYYY-MM-DD" strings). */
export const INTRADAY_TFS: ReadonlySet<Timeframe> = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "4h"]);

/** A single OHLCV bar. `time` is unix-seconds for intraday, "YYYY-MM-DD" for daily+ */
export interface Bar {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Snapshot {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  tradeTime: number | null;
}

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: number; // unix seconds
}

export interface SearchItem {
  symbol: string;
  name: string;
  exchange: string;
}

export interface Mover {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  volume: number | null;
}

export interface MoversData {
  gainers: Mover[];
  losers: Mover[];
}

export type DataMode = "live" | "demo";

export type EventImpact = "high" | "medium" | "low" | "holiday";

/** Macro economic-calendar event (ForexFactory weekly feed in live mode). */
export interface EconEvent {
  id: string;
  time: number; // unix seconds
  currency: string; // USD, EUR, GBP, …
  impact: EventImpact;
  title: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  /** true when the event is synthetic demo data filling days the live feed doesn't cover */
  synthetic?: boolean;
}

export interface CalendarResponse {
  events: EconEvent[];
  mode: DataMode;
}

export interface StatusResponse {
  mode: DataMode;
  feed: string | null;
}

export interface WatchlistResponse {
  symbols: string[];
}

/** A named watchlist with tag color and its symbols. */
export interface WatchlistSummary {
  id: string;
  name: string;
  color: string;
  symbols: string[];
}

/** Price alert (server-persisted). */
export type AlertDirection = "above" | "below" | "cross";

export interface AlertItem {
  id: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  note: string | null;
  color: string | null; // chart line color (null → amber default)
  active: boolean;
  triggeredAt: number | null;
  createdAt: number;
}

export interface TriggeredAlert {
  alert: AlertItem;
  price: number;
  notified: boolean;
  notifyError: string | null;
}

export interface TelegramStatus {
  configured: boolean;
  tokenMasked: string | null;
  chatMasked: string | null;
}

/** Signed-in account (never carries secrets). */
export interface AuthUser {
  id: string;
  username: string;
  totpEnabled: boolean;
}

export interface AuthCheckResponse {
  user: AuthUser | null;
  hasUsers: boolean;
}

export const LIST_COLORS: readonly string[] = [
  "#26a69a", "#ef5350", "#ff9800", "#f0b90b", "#66bb6a", "#42a5f5", "#ab47bc", "#ec407a",
];

/** Palette offered when recoloring drawings and alert lines. */
export const LINE_COLORS: readonly string[] = [
  "#26a69a", "#ef5350", "#f0b90b", "#e056fd", "#42a5f5", "#66bb6a", "#ff9800", "#d1d4dc",
];
