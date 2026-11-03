// v2.10.0 — Market Regime shared types (server engine + AgentTab client).
// Kept import-free so both the server engine and client components can use
// them without dragging server-only modules into the client bundle.

export type RegimeState = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF' | 'UNKNOWN'

/** One tape gauge: where the index/vol-proxy sits vs its decision moving average. */
export interface RegimeIndexDetail {
  symbol: string
  last: number | null
  sma: number | null
  smaLabel: string // '50-DMA' | '20-DMA'
  pctFromSma: number | null // + = above the MA, − = below
  above: boolean | null
}

/**
 * The US-tape regime snapshot. `UNKNOWN` (or `stale: true`) means the data
 * could not be trusted (no bars / demo feed / truncated window / bars too
 * old) — every consumer MUST fail open in that case, exactly like the
 * sentiment gate treats a missing snapshot: never brick trading on a bad read.
 */
export interface RegimeSnapshot {
  regime: RegimeState
  asOf: string // when the snapshot was computed
  barsAsOf: string | null // date of the newest closed bar used (QQQ spine)
  stale: boolean // bars older than BAR_STALE_MS → untrustworthy
  reasons: string[] // human-readable "why" bullets for the journal + chip tooltip
  tape: {
    spy: RegimeIndexDetail
    qqq: RegimeIndexDetail
    uvxy: RegimeIndexDetail
  } | null
  error: string | null
}
