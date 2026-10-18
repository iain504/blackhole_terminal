// Client-side types for the trading feature (mirrors /api/trading/*).
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
