// Shared market data types used by both API routes and client components.

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D' | '1W' | '1M'

export interface Bar {
  time: number // unix seconds (UTC), bar open time
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Quote {
  symbol: string
  price: number
  change: number // absolute daily change
  changePct: number
  open: number
  high: number
  low: number
  prevClose: number
  volume: number
  ts: number // quote time (unix seconds)
}

export interface NewsItem {
  id: string
  headline: string
  summary: string
  source: string
  url: string
  ts: number // unix seconds
  image?: string
  symbols: string[]
}

export interface MarkerData {
  earnings: number[] // unix seconds
  news: number[] // unix seconds
}

export interface HeatSymbol {
  symbol: string
  pct: number
  price: number
}

export interface HeatGroup {
  name: string
  symbols: HeatSymbol[]
}

export interface HeatmapResponse {
  us: HeatGroup[]
  crypto: HeatGroup[]
  demo: boolean
}

export interface CalendarEvent {
  time: string // ISO UTC
  country: string // currency / country code e.g. USD, EUR
  importance: 'high' | 'medium' | 'low' | string
  event: string
  actual: string | null
  forecast: string | null
  prior: string | null
}

export interface MarketMeta {
  demo: boolean
}

export interface BarsResponse {
  bars: Bar[]
  meta: MarketMeta
}

export interface QuoteResponse {
  quotes: Quote[]
  meta: MarketMeta
}

export interface NewsResponse {
  news: NewsItem[]
  meta: MarketMeta
}

export interface MarkersResponse {
  earnings: number[]
  news: number[]
  meta: MarketMeta
}

// ---- Timeframe configuration ----
// barCount: how many bars to request (longer history, Task 13 #5)
export const TIMEFRAMES: Record<Timeframe, { alpaca: string; seconds: number; barCount: number; label: string }> = {
  '1m': { alpaca: '1Min', seconds: 60, barCount: 1800, label: '1m' },
  '5m': { alpaca: '5Min', seconds: 300, barCount: 2000, label: '5m' },
  '15m': { alpaca: '15Min', seconds: 900, barCount: 1600, label: '15m' },
  '1h': { alpaca: '1Hour', seconds: 3600, barCount: 2000, label: '1H' },
  '4h': { alpaca: '4Hour', seconds: 14400, barCount: 1000, label: '4H' },
  '1D': { alpaca: '1Day', seconds: 86400, barCount: 1500, label: '1D' },
  '1W': { alpaca: '1Week', seconds: 604800, barCount: 520, label: '1W' },
  '1M': { alpaca: '1Month', seconds: 2592000, barCount: 240, label: '1M' },
}

export function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes('/')
}

// Alpaca crypto majors (v1beta3 crypto/us)
export const CRYPTO_UNIVERSE = [
  'BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'DOGE/USD', 'AVAX/USD',
  'LINK/USD', 'LTC/USD', 'BCH/USD', 'UNI/USD', 'AAVE/USD', 'XTZ/USD',
]

// Curated US stock universe (grouped for heat map)
export const US_HEAT_GROUPS: { name: string; symbols: string[] }[] = [
  { name: 'Mega-Cap Tech', symbols: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'] },
  { name: 'Semiconductors', symbols: ['AMD', 'AVGO', 'INTC', 'MU', 'QCOM', 'TXN', 'AMAT', 'TSM'] },
  { name: 'Software & Internet', symbols: ['ORCL', 'CRM', 'ADBE', 'NFLX', 'UBER', 'SHOP', 'SNOW'] },
  { name: 'Finance', symbols: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'V', 'MA', 'BRK.B'] },
  { name: 'Healthcare', symbols: ['UNH', 'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT'] },
  { name: 'Energy', symbols: ['XOM', 'CVX', 'COP', 'SLB', 'PSX', 'OXY'] },
  { name: 'Consumer', symbols: ['WMT', 'COST', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'SBUX', 'HD'] },
  { name: 'Industrials', symbols: ['BA', 'CAT', 'GE', 'HON', 'LMT', 'RTX', 'UPS', 'DE'] },
  { name: 'ETFs', symbols: ['SPY', 'QQQ', 'DIA', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI'] },
]

export const ALL_US_SYMBOLS = US_HEAT_GROUPS.flatMap((g) => g.symbols)

// Base prices used by the demo simulator (deterministic seed per symbol)
export const BASE_PRICES: Record<string, number> = {
  AAPL: 232, MSFT: 428, NVDA: 138, AMZN: 205, GOOGL: 178, META: 585, TSLA: 340,
  AMD: 142, AVGO: 178, INTC: 24, MU: 105, QCOM: 165, TXN: 200, AMAT: 190, TSM: 195,
  ORCL: 175, CRM: 330, ADBE: 500, NFLX: 850, UBER: 72, SHOP: 105, SNOW: 175,
  JPM: 245, BAC: 46, WFC: 74, GS: 560, MS: 128, V: 310, MA: 500, 'BRK.B': 465,
  UNH: 560, JNJ: 155, LLY: 790, PFE: 26, MRK: 100, ABBV: 190, TMO: 520, ABT: 115,
  XOM: 118, CVX: 160, COP: 105, SLB: 43, PSX: 130, OXY: 50,
  WMT: 92, COST: 940, PG: 168, KO: 62, PEP: 165, MCD: 295, NKE: 78, SBUX: 98, HD: 400,
  BA: 155, CAT: 390, GE: 190, HON: 215, LMT: 540, RTX: 120, UPS: 130, DE: 410,
  SPY: 590, QQQ: 520, DIA: 445, IWM: 225, XLK: 235, XLF: 48, XLE: 88, XLV: 145, XLI: 128,
  'BTC/USD': 97500, 'ETH/USD': 3450, 'SOL/USD': 215, 'XRP/USD': 2.35, 'DOGE/USD': 0.33,
  'AVAX/USD': 38, 'LINK/USD': 24, 'LTC/USD': 105, 'BCH/USD': 450, 'UNI/USD': 13,
  'AAVE/USD': 320, 'XTZ/USD': 1.1,
}

export function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(2)
  return p.toFixed(4)
}
