// v2.4.0 — Nebula Autopilot shared types (server engine + AgentTab client).
import type { AlgoStrategyId, AlgoTimeframe } from '@/lib/algo-strategies'

export type AgentSessionStatus =
  | 'scanning' // phase 1 — bars + full-catalog sweeps across the universe
  | 'tuning' // phase 2 — optimizer grid on the top candidates
  | 'ranking' // phase 3 — Calmar-score board published
  | 'budget' // phase 4 — account buying-power sizing
  | 'ready' // ranked + sized, waiting for the ENGAGE command
  | 'engaged' // fleet live — AlgoRun engines trading
  | 'stopped' // disengaged (results kept for review)
  | 'error' // pipeline failed (message in error)

export type AgentEventLevel =
  | 'info' | 'scan' | 'tune' | 'rank' | 'budget' | 'trade' | 'warn' | 'error'

export interface AgentSettings {
  includeCrypto: boolean // add the 12 crypto majors to the scan
  topTune: number // candidates promoted to the tuning grid (8..40)
  topN: number // fleet size — slots actually traded on engage (3..15)
  riskPerTradePct: number // % of equity risked per trade (0.1..3)
  deployCapPct: number // % of BUYING POWER the fleet may use (10..95)
  maxPosPct: number // hard cap — max % of equity in ONE position (2..25)
  minScore: number // Calmar-score floor to qualify for the fleet (0..)
  maxTradesDay: number // per-run daily entry cap passed to the engine (1..10)
  sentimentWeight: number // how hard news sentiment re-ranks the board (0..1)
  autoEngage: boolean // engage automatically once budget completes
  flattenOnStop: boolean // disengage flattens the fleet's positions
  mode: 'paper' | 'live' // broker account the fleet trades on
}

export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
  includeCrypto: true,
  topTune: 24,
  topN: 8,
  riskPerTradePct: 0.5,
  deployCapPct: 60,
  maxPosPct: 12,
  minScore: 0.1,
  maxTradesDay: 3,
  sentimentWeight: 0.25,
  autoEngage: false,
  flattenOnStop: true,
  mode: 'paper',
}

/** One ranked setup: the best (strategy × tf × params) found for a symbol. */
export interface AgentCandidate {
  symbol: string
  isCrypto: boolean
  tf: AlgoTimeframe
  strategy: AlgoStrategyId
  params: Record<string, number>
  lane: 'day' | 'swing'
  // ranking metrics
  score: number
  // v2.5.0 — Market Sentiment Engine: scoreBase = the pure backtest score,
  // sent = the freshest news-sentiment snapshot (-1..1) that was blended in
  // (score = scoreBase × (1 + 0.25 × sent); null when never scanned/stale)
  scoreBase?: number | null
  sent?: number | null
  netPct: number
  winRate: number
  pf: number
  maxDDPct: number
  trades: number
  oosNetPct: number | null
  boundary: boolean
  bars: number
  coveredDays: number
  // tuning phase
  tuned: boolean
  // exits used by the backtest AND handed to the live engine (pct legs)
  tpPct: number
  slPct: number
  // fleet membership (set at ranking)
  rank?: number
  selected?: boolean
  allocQty?: number | null
  allocNotional?: number | null
  skipReason?: string | null
  // set on engage
  runId?: string | null
}

/** Account snapshot + derived fleet budget (computed from BUYING POWER). */
export interface AgentBudget {
  mode: 'paper' | 'live'
  equity: number
  cash: number
  buyingPower: number
  currency: string
  deployable: number // buying_power × deployCapPct
  perSlot: number // deployable / topN
  riskPerTrade: number // equity × riskPerTradePct
  maxPosNotional: number // equity × maxPosPct
  fleetNotional: number // Σ planned position notional
  at: string
}

export interface AgentStats {
  scanned: number
  scanTotal: number
  tuned: number
  tuneTotal: number
  fleetStarted: number
  fleetFailed: number
  startedAt: string
  finishedAt: string | null
}

export interface AgentEventDto {
  id: string
  level: string
  message: string
  createdAt: string
}

export interface AgentSessionDto {
  id: string
  status: AgentSessionStatus
  phase: string
  progress: number
  mode: string
  settings: AgentSettings
  stats: AgentStats | null
  budget: AgentBudget | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentRunRow {
  runId: string
  symbol: string
  timeframe: string
  strategy: string
  status: string
  mode: string
  qty: number
  tradesToday: number
  startedAt: string | null
  lastLog: string | null
  lastLogLevel: string | null
}

export interface AgentStateResponse {
  session: AgentSessionDto | null
  candidates: AgentCandidate[]
  events: AgentEventDto[]
  runs: AgentRunRow[]
  mode: string
  configured: boolean
  universeSize: number
  usCount: number
  jobRunning?: boolean
}
