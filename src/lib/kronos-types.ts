// Shared Kronos types — imported by BOTH the server lib (lib/kronos.ts) and
// client components (ChartPanel). Kept dependency-free so client bundles never
// pull in the server lib (db import).

export interface KronosBar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface KronosForecastResult {
  ok: boolean
  model: string
  maxContext: number
  contextBars: number
  horizon: number
  samples: number
  tfSec: number
  market: string
  lastClose: number
  lastTime: number
  times: number[]
  closeP10: number[]
  closeP50: number[]
  closeP90: number[]
  pathOpen: number[]
  pathHigh: number[]
  pathLow: number[]
  pathClose: number[]
  upProb: number
  bandPct: number
  latencyMs: number
}

export interface KronosHealth {
  ok: boolean
  ready: boolean
  loading: boolean
  error?: string | null
  lanes?: Record<string, boolean>
  uptimeSec?: number
}

export interface KronosHitRate {
  n: number
  hits: number
  rate: number | null
  avgAbsErrPct: number | null
  pending: number
  /** graded accuracy split per lane (mini vs small) — trust is per-lane, not pooled */
  byModel: KronosModelScore[]
}

export interface KronosModelScore {
  /** sidecar model id, e.g. 'NeoQuasar/Kronos-mini' */
  model: string
  /** lane key: 'mini' | 'small' */
  lane: string
  n: number
  hits: number
  rate: number | null
  avgAbsErrPct: number | null
  pending: number
}

export interface KronosJournalRow {
  id: string
  symbol: string
  tf: string
  model: string
  madeAt: string
  barTime: number
  tfSec: number
  horizonBars: number
  lastClose: number
  endP50: number
  upProb: number
  bandPct: number | null
  realizedClose: number | null
  hit: boolean | null
  absErrPct: number | null
  realizedAt: number | null
}

export interface KronosStatus {
  available: boolean
  loading: boolean
  error: string | null
  lanes: Record<string, boolean>
  uptimeSec: number | null
  hitRate: KronosHitRate
  resolvedNow: number
  recent: KronosJournalRow[]
}
