// Client-side types for the trading feature (mirrors /api/trading/*).
import type { ClosedTrade } from '@/lib/market-types'

export interface ExitInfo {
  orderId: string
  kind: 'sl' | 'tp'
  stopPrice: number | null
  limitPrice: number | null
  trailPercent: number | null
  qty: string
  side: string
  type: string
}

/** Open (unfilled) entry order + its planned/attached TP/SL, for chart lines. */
export interface PendingOrderInfo {
  orderId: string
  symbol: string
  side: string
  type: string
  qty: number
  filledQty: number
  limitPrice: number | null
  status: string
  tpPrice: number | null
  slPrice: number | null
  managed: boolean
  createdAt: string | null
}

export interface PositionRow {
  symbol: string
  tradeSymbol: string
  qty: number
  qtyAvailable: number
  side: string
  avgEntry: number
  current: number
  upl: number
  uplPct: number
  assetClass: string
}

export interface PositionsData {
  mode: string
  positions: PositionRow[]
  exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }>
  pending: PendingOrderInfo[]
}

/** Chart symbol (BTC/USD) <-> trading symbol (BTCUSD) key. */
export function normSym(s: string): string {
  return s.replace('/', '').toUpperCase()
}

export function isCryptoTradeSymbol(symbol: string): boolean {
  return symbol.includes('/')
}

// ---------- Strategy Orders tab (mirrors /api/strategies/history) ----------

/** One recorded strategy fire (success or failure). */
export interface StrategyFireRow {
  id: string
  ok: boolean
  message: string
  /** entry order id of the placed order — attributes the round-trip trades */
  orderId: string | null
  createdAt: string
}

/** A strategy rule enriched with fire history + realized P&L aggregates. */
export interface StrategyRuleDetail {
  id: string
  symbol: string
  kind: string // 'rsi' | 'macd'
  condition: string
  level: number
  timeframe: string
  params: { period?: number; fast?: number; slow?: number; signal?: number } | null
  action: string // 'buy' | 'sell'
  qty: number
  tpMode: string // 'none' | 'price' | 'pct'
  tpValue: number | null
  slMode: string
  slValue: number | null
  repeat: boolean
  status: string
  lastSide: string | null
  triggeredAt: string | null
  orderId: string | null
  fireNote: string | null
  createdAt: string
  fires: StrategyFireRow[]
  /** realized round-trip trades attributed to this rule's fires (newest first) */
  trades: ClosedTrade[]
  realizedPnl: number
  tradeCount: number
  lastFireAt: string | null
  /** fires whose entry order is outside the recent closed-orders window */
  unresolvedFires: number
}

export interface StrategiesHistoryData {
  mode: string
  configured: boolean
  rules: StrategyRuleDetail[]
}
