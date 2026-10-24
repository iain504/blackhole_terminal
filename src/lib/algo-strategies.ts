// Algo Trading strategies (Task 61) — shared catalog used by BOTH the tab UI
// (client) and the engine (server), so parameter definitions can never drift.
//
// Strategy selection is grounded in what the trading community consistently
// recommends for RANGE-BOUND / topping names (Weinstein Stage 3 —
// "distribution": price chops in a range near highs while the 30-week MA
// flattens) during REGULAR trading hours:
//   • Range fade / mean reversion (buy support, sell resistance) — the
//     consensus #1 tactic for sideways markets (Investopedia, TrueData,
//     ClearEdge). Implemented as Bollinger(20,2) + RSI(14) fade.
//   • Larry Connors' RSI-2 — the most-studied retail mean-reversion system
//     (r/algotrading backtests, quantifiedstrategies.com, github
//     example-strategies/RSI2): buy strong-trend dips (RSI(2) < 10), exit on
//     the 5-SMA recapture. Very high win-rate, built for regular hours.
//   • Opening Range Breakout — first 15 minutes (09:30–09:45 ET) define the
//     day's reference range; trade the first close outside it (classic RTH
//     momentum play, works on both range days and trend days).
//   • VWAP fade — institutional benchmark; fade statistically stretched
//     deviations from the session VWAP back toward the mean (LuxAlgo,
//     TrendSpider mean-reversion guides).
import { TIMEFRAMES } from '@/lib/market-types'

export type AlgoStrategyId = 'bb-reversion' | 'rsi2-connors' | 'orb15' | 'vwap-fade'

export interface AlgoParamDef {
  key: string
  label: string
  min: number
  max: number
  step: number
  /** shown when the value is an on/off toggle */
  bool?: boolean
}

export interface AlgoStrategyDef {
  id: AlgoStrategyId
  name: string
  tagline: string
  /** one-line rules summary shown in the UI */
  rules: string
  /** why it fits Stage 3 / regular hours */
  fit: string
  color: string
  /** intraday only (chart timeframe restricted) */
  intradayOnly: true
  defaults: Record<string, number>
  params: AlgoParamDef[]
}

export const ALGO_STRATEGIES: Record<AlgoStrategyId, AlgoStrategyDef> = {
  'bb-reversion': {
    id: 'bb-reversion',
    name: 'BB + RSI Mean Reversion',
    tagline: 'Range fade — the Stage 3 bread & butter',
    rules: 'LONG when close < lower Bollinger band AND RSI < oversold · SHORT when close > upper band AND RSI > overbought · exit when price mean-reverts to the band middle (or TP/SL)',
    fit: 'Stage 3 distribution chops between support and resistance — fading band extremes with an RSI filter is the consensus range-market tactic.',
    color: '#f472b6',
    intradayOnly: true,
    defaults: { bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, allowShort: 1 },
    params: [
      { key: 'bbPeriod', label: 'BB period', min: 5, max: 100, step: 1 },
      { key: 'bbStd', label: 'BB std-dev', min: 1, max: 4, step: 0.1 },
      { key: 'rsiPeriod', label: 'RSI period', min: 2, max: 50, step: 1 },
      { key: 'rsiOversold', label: 'RSI oversold <', min: 5, max: 45, step: 1 },
      { key: 'rsiOverbought', label: 'RSI overbought >', min: 55, max: 95, step: 1 },
      { key: 'allowShort', label: 'Allow shorts', min: 0, max: 1, step: 1, bool: true },
    ],
  },
  'rsi2-connors': {
    id: 'rsi2-connors',
    name: 'RSI-2 (Connors)',
    tagline: 'Buy the dip in an uptrend, high win-rate',
    rules: 'LONG when close > SMA(trend) AND RSI(2) < buy level · exit when close > SMA(exit) (the classic Connors recapture) or TP/SL',
    fit: 'Larry Connors\u2019 most-studied mean-reversion system — designed for regular-hours equity trading; buys fear-driven dips inside a rising market.',
    color: '#22c55e',
    intradayOnly: true,
    defaults: { rsiPeriod: 2, rsiBuy: 10, trendSma: 200, exitSma: 5 },
    params: [
      { key: 'rsiPeriod', label: 'RSI period', min: 2, max: 5, step: 1 },
      { key: 'rsiBuy', label: 'RSI buy below', min: 5, max: 30, step: 1 },
      { key: 'trendSma', label: 'Trend SMA', min: 50, max: 300, step: 10 },
      { key: 'exitSma', label: 'Exit SMA', min: 3, max: 20, step: 1 },
    ],
  },
  'orb15': {
    id: 'orb15',
    name: 'Opening Range Breakout',
    tagline: 'Trade the break of the 09:30–09:45 ET range',
    rules: 'High/low of the first 15 minutes after the open = the day\u2019s range · LONG on the first close above the high, SHORT on the first close below the low · one entry per side per day · exits via TP/SL + EOD flatten',
    fit: 'The classic regular-hours momentum play — the opening range sets intraday support/resistance and its break carries the day\u2019s directional bias.',
    color: '#f59e0b',
    intradayOnly: true,
    defaults: { orMinutes: 15, onePerSide: 1 },
    params: [
      { key: 'orMinutes', label: 'Range minutes', min: 5, max: 60, step: 5 },
      { key: 'onePerSide', label: 'One trade per side', min: 0, max: 1, step: 1, bool: true },
    ],
  },
  'vwap-fade': {
    id: 'vwap-fade',
    name: 'VWAP Fade',
    tagline: 'Fade stretched deviations from session VWAP',
    rules: 'Track the session VWAP (RTH bars) · when price closes deviating more than ±X% from VWAP, fade it (LONG below, SHORT above) · exit when price returns to VWAP (or TP/SL)',
    fit: 'VWAP is the institutional execution benchmark — in distribution phases price keeps snapping back to it, making deviation fades high-probability.',
    color: '#38bdf8',
    intradayOnly: true,
    defaults: { devPct: 0.6, allowShort: 1 },
    params: [
      { key: 'devPct', label: 'Deviation %', min: 0.2, max: 5, step: 0.1 },
      { key: 'allowShort', label: 'Allow shorts', min: 0, max: 1, step: 1, bool: true },
    ],
  },
}

export const ALGO_STRATEGY_IDS = Object.keys(ALGO_STRATEGIES) as AlgoStrategyId[]

/** Algo runs trade intraday US sessions — restrict the chart timeframes. */
export const ALGO_TIMEFRAMES = ['1m', '5m', '15m'] as const
export type AlgoTimeframe = (typeof ALGO_TIMEFRAMES)[number]

/**
 * Max backtest history (calendar days) per algo timeframe — shared by the API
 * route (clamp) and the Backtest panel (visible hint), so the cap is never
 * applied silently.
 *
 * Task 9-p — 1m was 120d ≈ 173k bars for 24/7 crypto (fetch + series + TWO
 * caches retaining it) — the single most reliable way to OOM the dev box.
 * 30d ≈ 43k bars keeps 1m studies useful and the heap flat.
 */
export const ALGO_MAX_DAYS: Record<AlgoTimeframe, number> = { '1m': 30, '5m': 365, '15m': 730 }

export function isAlgoStrategyId(v: unknown): v is AlgoStrategyId {
  return typeof v === 'string' && v in ALGO_STRATEGIES
}

/** Normalize + clamp a params object against a strategy's defs. */
export function normalizeAlgoParams(strategy: AlgoStrategyId, raw: unknown): Record<string, number> {
  const def = ALGO_STRATEGIES[strategy]
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const p of def.params) {
    const v = Number(src[p.key])
    if (!Number.isFinite(v)) {
      out[p.key] = def.defaults[p.key]
      continue
    }
    out[p.key] = p.bool ? (v >= 1 ? 1 : 0) : Math.min(p.max, Math.max(p.min, v))
  }
  return out
}

/** Exit modes: 'none' (strategy-managed only) or 'pct' (bracket % from entry). */
export type AlgoExitMode = 'none' | 'pct'

/** Position sizing (Task 78 — "Risk Money"): 'fixed' trades `qty` units per
 *  entry (legacy) · 'risk' treats the risk budget as the DOLLARS AT RISK per
 *  trade and derives the position size at entry: qty = budget / (entry × SL%).
 *  Risk sizing requires an SL % bracket — without one every consumer (live
 *  engine, backtest) falls back to `qty` and says so. */
export type AlgoSizingMode = 'fixed' | 'risk'

/** Risk-Money budget basis (Task 78e — "Risk Money accepts Percentage%").
 *  'usd' = a fixed dollar amount per trade (`riskMoney`) · 'pct' = a percent
 *  of ACCOUNT EQUITY per trade (`riskMoneyPct`), resolved to dollars at each
 *  entry so risk scales with the account (live: broker equity · backtest:
 *  the simulated equity curve — risk compounds). */
export type AlgoRiskBasis = 'usd' | 'pct'

/** Risk-Money position sizing (Task 78). Returns the entry quantity whose
 *  worst-case loss to the stop ≈ `riskMoney`, or null when sizing is
 *  impossible (non-positive inputs, or the risk budget is too small for the
 *  instrument's minimum increment at this stop distance).
 *  Stocks floor to whole shares; crypto floors to 4 decimals (Alpaca qty_step). */
export function riskSizedQty(riskMoney: number, entryPx: number, slPct: number, isCrypto: boolean): number | null {
  if (!(riskMoney > 0) || !(entryPx > 0) || !(slPct > 0)) return null
  const riskPerUnit = entryPx * (Math.min(100, slPct) / 100)
  if (!(riskPerUnit > 0)) return null
  const raw = riskMoney / riskPerUnit
  if (!Number.isFinite(raw) || raw <= 0) return null
  if (isCrypto) {
    const q = Math.floor(raw * 1e4) / 1e4
    return q >= 0.0001 ? q : null
  }
  const q = Math.floor(raw)
  return q >= 1 ? q : null
}

export interface AlpoRunConfig {
  symbol: string
  timeframe: AlgoTimeframe
  strategy: AlgoStrategyId
  params: Record<string, number>
  qty: number
  // Task 78 — Risk Money sizing ('fixed' keeps qty as the per-entry size)
  sizingMode: AlgoSizingMode
  // Task 78e — budget basis + payload ('usd' → riskMoney, 'pct' → riskMoneyPct)
  riskBasis: AlgoRiskBasis
  riskMoney: number | null
  riskMoneyPct: number | null
  tpMode: AlgoExitMode
  tpValue: number | null
  slMode: AlgoExitMode
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  // re-entry control (Task 70-c): cooldown minutes after a position close
  // (0 = current behavior) + edge-triggered re-entry (wait for a fresh signal)
  cooldownMin: number
  requireNewSignal: boolean
}

// ---------------------------------------------------------------------------
// Config import / export (Task 66) — portable, versioned JSON envelope shared
// by the Algo tab (client) and any future server-side import path. The parser
// is deliberately strict on identity fields (strategy/symbol/timeframe/qty —
// a wrong value silently changes what the engine trades) and liberal on
// numeric/binary fields (params + TP/SL + guards are clamped to the same
// ranges the live API enforces), so a hand-edited file can never start a run
// with out-of-band values.
// ---------------------------------------------------------------------------

const CONFIG_ENVELOPE_KIND = 'blackhole-algo-config'
// v2 (Task 70-c): adds `rules` (strategy-drawer StrategyRule rows) alongside
// `configs`. v1 files (configs only) remain importable. Task 79: entries may
// carry `enabled` (export-time run state) — still version 2, purely additive
// (older terminals ignore the field; legacy files import as running).
const CONFIG_ENVELOPE_VERSION = 2
/** Envelope versions parseAlgoConfigImport accepts. */
const SUPPORTED_ENVELOPE_VERSIONS = [1, 2]

/** One named config inside an export file. `enabled` (Task 79) records the
 *  RUN-STATE at export time — true = the run was RUNNING, false = it was
 *  STOPPED — so an import can recreate the same enable/disable state instead
 *  of blindly starting every config. Legacy files omit it → imports behave
 *  exactly as before (start on import). */
export interface AlgoConfigFileEntry {
  name: string
  config: AlpoRunConfig
  enabled?: boolean
}

/** One named strategy-drawer rule inside an export file (v2). */
export interface AlgoRuleFileEntry {
  name: string
  rule: AlgoRuleImportPayload
}

/** Versioned envelope written by every export. */
export interface AlgoConfigEnvelope {
  kind: typeof CONFIG_ENVELOPE_KIND
  version: typeof CONFIG_ENVELOPE_VERSION
  exportedAt: string
  configs: AlgoConfigFileEntry[]
  rules: AlgoRuleFileEntry[]
}

/** Minimal structural shape of an AlgoRun row (no import of the API module). */
export interface AlgoRunLike {
  symbol: string
  timeframe: string
  strategy: string
  params: unknown
  qty: number
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin?: number
  requireNewSignal?: boolean
  // Task 78 — optional so legacy rows/DTOs (pre-Risk-Money) still satisfy it
  sizingMode?: string
  riskMoney?: number | null
  // Task 78e — optional for the same reason (legacy rows default to 'usd')
  riskBasis?: string
  riskMoneyPct?: number | null
}

/** Human label used as the default entry name ("BB + RSI Mean Reversion · TSLA 5m").
 *  Risk-Money configs carry the sizing in the name so exports/imports stay legible. */
export function algoConfigSummaryName(cfg: AlpoRunConfig): string {
  const sizing = cfg.sizingMode === 'risk'
    ? (cfg.riskBasis === 'pct'
        ? (cfg.riskMoneyPct != null ? ` · risk ${cfg.riskMoneyPct}%` : '')
        : (cfg.riskMoney != null ? ` · risk $${cfg.riskMoney}` : ''))
    : ''
  return `${ALGO_STRATEGIES[cfg.strategy].name} · ${cfg.symbol} ${cfg.timeframe}${sizing}`
}

/** Compact risk-budget label for journals/diffs/cards: "$250" or "1%". */
export function riskMoneyLabel(basis: string, riskMoney: number | null | undefined, riskMoneyPct: number | null | undefined): string {
  return basis === 'pct' ? `${riskMoneyPct ?? 0}%` : `$${riskMoney ?? 0}`
}

/** Resolve the USD risk budget for ONE entry (Task 78e). basis 'usd' →
 *  `riskMoney` as-is · 'pct' → equity × pct/100 (null when equity is unknown
 *  or the pct is unset). All sizing consumers route through this so the two
 *  bases stay semantically identical everywhere. */
export function riskBudgetUsd(basis: string, riskMoney: number | null | undefined, riskMoneyPct: number | null | undefined, equity: number | null | undefined): number | null {
  if (basis === 'pct') {
    if (!(equity != null && equity > 0) || !(riskMoneyPct != null && riskMoneyPct > 0)) return null
    return (equity * Math.min(100, riskMoneyPct)) / 100
  }
  return riskMoney != null && riskMoney > 0 ? Math.min(10_000_000, riskMoney) : null
}

/** Map a persisted run (or its DTO) to a portable config. */
export function runToAlgoConfig(run: AlgoRunLike): AlpoRunConfig {
  const strategy = isAlgoStrategyId(run.strategy) ? run.strategy : 'bb-reversion'
  const timeframe = (ALGO_TIMEFRAMES as readonly string[]).includes(run.timeframe)
    ? (run.timeframe as AlgoTimeframe)
    : '5m'
  return {
    symbol: run.symbol,
    timeframe,
    strategy,
    params: normalizeAlgoParams(strategy, run.params),
    qty: run.qty,
    sizingMode: run.sizingMode === 'risk' ? 'risk' : 'fixed',
    riskBasis: run.sizingMode === 'risk' && run.riskBasis === 'pct' ? 'pct' : 'usd',
    riskMoney: run.sizingMode === 'risk' && run.riskBasis !== 'pct' ? (run.riskMoney ?? null) : null,
    riskMoneyPct: run.sizingMode === 'risk' && run.riskBasis === 'pct' ? (run.riskMoneyPct ?? null) : null,
    tpMode: run.tpMode === 'pct' ? 'pct' : 'none',
    tpValue: run.tpMode === 'pct' ? run.tpValue : null,
    slMode: run.slMode === 'pct' ? 'pct' : 'none',
    slValue: run.slMode === 'pct' ? run.slValue : null,
    maxTradesDay: run.maxTradesDay,
    rthOnly: run.rthOnly,
    flattenEod: run.flattenEod,
    cooldownMin: clampCooldown(run.cooldownMin),
    requireNewSignal: run.requireNewSignal === true,
  }
}

/** Cooldown clamp shared by the import parser + run mapping (0..240 min). */
function clampCooldown(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(240, n) : 0
}

/** File-name stamp "blackhole-algo-configs-20261021-1412". */
export function algoExportFileBase(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `blackhole-algo-configs-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** Build the export envelope from named configs (+ optional drawer rules). */
export function buildAlgoConfigExport(entries: AlgoConfigFileEntry[], rules: AlgoRuleFileEntry[] = []): AlgoConfigEnvelope {
  return {
    kind: CONFIG_ENVELOPE_KIND,
    version: CONFIG_ENVELOPE_VERSION,
    exportedAt: new Date().toISOString(),
    configs: entries,
    rules,
  }
}

export interface AlgoImportResult {
  /** Validated + normalized configs, ready to load into the form or start. */
  entries: AlgoConfigFileEntry[]
  /** Rejected items with the reason (index refers to the source order). */
  errors: { index: number; reason: string }[]
  /** Validated strategy-drawer rules (v2 envelopes) — recreated as PAUSED. */
  rules: AlgoRuleImportPayload[]
  /** Rule names in the same order as `rules` (for the dialog listing). */
  ruleNames: string[]
  /** Rejected rules with the reason (index refers to the source rule order). */
  ruleErrors: { index: number; reason: string }[]
}

const SYMBOL_RE = /^[A-Za-z0-9./-]{1,24}$/

function clampPct(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(0.01, n)) : null
}

/**
 * Validate + normalize one raw config object. Returns the reason string on
 * rejection (identity fields) or the normalized config.
 */
export function normalizeAlgoRunConfig(raw: unknown): AlpoRunConfig | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a config object'
  const r = raw as Record<string, unknown>
  if (!isAlgoStrategyId(r.strategy)) {
    return `unknown strategy${typeof r.strategy === 'string' ? ` "${r.strategy}"` : ''}`
  }
  const strategy = r.strategy
  const symbol = String(r.symbol ?? '').trim().toUpperCase()
  if (!SYMBOL_RE.test(symbol)) return `invalid symbol${r.symbol ? ` "${String(r.symbol)}"` : ''}`
  const tf = String(r.timeframe ?? '')
  if (!(ALGO_TIMEFRAMES as readonly string[]).includes(tf)) {
    return `unsupported timeframe${tf ? ` "${tf}"` : ' (missing)'}`
  }
  const qty = Number(r.qty)
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) return 'qty must be a positive number'
  const tpRaw = clampPct(r.tpValue)
  const slRaw = clampPct(r.slValue)
  // Task 78 — Risk Money: sizing is an identity field here (silently downgrading
  // a risk-sized config to fixed qty would change what the engine trades).
  // Task 78e — the budget basis is identity too: '$250' and '1% of equity'
  // are different risk models, never silently swapped on import.
  const sizingMode: AlgoSizingMode = r.sizingMode === 'risk' ? 'risk' : 'fixed'
  const riskBasis: AlgoRiskBasis = r.riskBasis === 'pct' ? 'pct' : 'usd'
  const riskRaw = Number(r.riskMoney)
  const riskMoney = Number.isFinite(riskRaw) && riskRaw > 0 ? Math.min(10_000_000, riskRaw) : null
  const riskPctRaw = Number(r.riskMoneyPct)
  const riskMoneyPct = Number.isFinite(riskPctRaw) && riskPctRaw > 0 ? Math.min(100, riskPctRaw) : null
  if (sizingMode === 'risk' && riskBasis === 'pct' && riskMoneyPct == null) return 'risk % sizing requires a positive riskMoneyPct (percent of equity)'
  if (sizingMode === 'risk' && riskBasis !== 'pct' && riskMoney == null) return 'risk sizing requires a positive riskMoney'
  return {
    symbol,
    timeframe: tf as AlgoTimeframe,
    strategy,
    params: normalizeAlgoParams(strategy, r.params),
    qty,
    sizingMode,
    riskBasis: sizingMode === 'risk' ? riskBasis : 'usd',
    riskMoney: sizingMode === 'risk' && riskBasis !== 'pct' ? riskMoney : null,
    riskMoneyPct: sizingMode === 'risk' && riskBasis === 'pct' ? riskMoneyPct : null,
    tpMode: r.tpMode === 'pct' && tpRaw != null ? 'pct' : 'none',
    tpValue: r.tpMode === 'pct' ? tpRaw : null,
    slMode: r.slMode === 'pct' && slRaw != null ? 'pct' : 'none',
    slValue: r.slMode === 'pct' ? slRaw : null,
    maxTradesDay: Math.min(50, Math.max(1, Math.round(Number(r.maxTradesDay) || 3))),
    rthOnly: r.rthOnly !== false,
    flattenEod: r.flattenEod !== false,
    cooldownMin: clampCooldown(r.cooldownMin),
    requireNewSignal: r.requireNewSignal === true,
  }
}

/**
 * Parse any supported import payload:
 *   • the versioned envelope v2 ({ kind: 'blackhole-algo-config', configs: [...], rules: [...] })
 *   • the legacy v1 envelope (configs only — rules default to empty)
 *   • a bare array of configs (or { name, config } wrappers)
 *   • a single bare config object
 * Each item is validated independently — one bad entry never blocks the rest.
 */
export function parseAlgoConfigImport(raw: unknown): AlgoImportResult {
  const entries: AlgoConfigFileEntry[] = []
  const errors: AlgoImportResult['errors'] = []
  const rules: AlgoRuleImportPayload[] = []
  const ruleNames: string[] = []
  const ruleErrors: AlgoImportResult['ruleErrors'] = []
  const empty = (): AlgoImportResult => ({ entries, errors, rules, ruleNames, ruleErrors })

  let items: unknown[]
  let ruleItems: unknown[] = []
  if (Array.isArray(raw)) {
    items = raw
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    if (r.kind === CONFIG_ENVELOPE_KIND) {
      const ver = Number(r.version)
      if (!SUPPORTED_ENVELOPE_VERSIONS.includes(ver)) {
        return { entries, errors: [{ index: 0, reason: `unsupported envelope version: ${ver}` }], rules, ruleNames, ruleErrors }
      }
      items = Array.isArray(r.configs) ? r.configs : []
      ruleItems = Array.isArray(r.rules) ? r.rules : [] // v1 files carry no rules
    } else {
      items = [raw] // single bare config (or { name, config })
    }
  } else {
    return { entries, errors: [{ index: 0, reason: 'not valid JSON' }], rules, ruleNames, ruleErrors }
  }

  items.forEach((item, i) => {
    const wrapped = item && typeof item === 'object' && !Array.isArray(item)
      && 'config' in (item as Record<string, unknown>)
    const cfgRaw = wrapped ? (item as Record<string, unknown>).config : item
    const nameRaw = wrapped ? (item as Record<string, unknown>).name : undefined
    // Task 79 — the export-time run state rides the wrapper (absent on legacy
    // files / bare configs, which then import as startable as before)
    const enabledRaw = wrapped ? (item as Record<string, unknown>).enabled : undefined
    const norm = normalizeAlgoRunConfig(cfgRaw)
    if (typeof norm === 'string') {
      errors.push({ index: i, reason: norm })
    } else {
      const name = typeof nameRaw === 'string' && nameRaw.trim()
        ? nameRaw.trim().slice(0, 80)
        : algoConfigSummaryName(norm)
      entries.push({
        name,
        config: norm,
        ...(typeof enabledRaw === 'boolean' ? { enabled: enabledRaw } : {}),
      })
    }
  })

  ruleItems.forEach((item, i) => {
    const wrapped = item && typeof item === 'object' && !Array.isArray(item)
      && 'rule' in (item as Record<string, unknown>)
    const ruleRaw = wrapped ? (item as Record<string, unknown>).rule : item
    const nameRaw = wrapped ? (item as Record<string, unknown>).name : undefined
    const norm = normalizeStrategyRuleImport(ruleRaw)
    if (typeof norm === 'string') {
      ruleErrors.push({ index: i, reason: norm })
    } else {
      const name = typeof nameRaw === 'string' && nameRaw.trim()
        ? nameRaw.trim().slice(0, 80)
        : strategyRuleSummaryName(norm)
      rules.push(norm)
      ruleNames.push(name)
    }
  })
  return { entries, errors, rules, ruleNames, ruleErrors }
}

// ---------------------------------------------------------------------------
// Strategy-drawer rules (Task 70-c) — the StrategyRule rows behind the chart
// "IF <indicator condition> → BUY/SELL with TP/SL" bot. "All strategies"
// exports include them; imports recreate them as PAUSED (never auto-arm).
// Validation mirrors POST /api/strategies so a hand-edited file cannot create
// an out-of-band rule.
// ---------------------------------------------------------------------------

export type StrategyRuleExitMode = 'none' | 'price' | 'pct'

/** Portable rule payload — everything needed to recreate a StrategyRule row. */
export interface AlgoRuleImportPayload {
  symbol: string
  kind: 'rsi' | 'macd'
  condition: string
  level: number
  timeframe: string
  params: Record<string, number>
  action: 'buy' | 'sell'
  qty: number
  tpMode: StrategyRuleExitMode
  tpValue: number | null
  slMode: StrategyRuleExitMode
  slValue: number | null
  repeat: boolean
}

/** Minimal structural shape of a StrategyRule row/DTO (no API import). */
export interface AlgoRuleLike {
  symbol: string
  kind: string
  condition: string
  level: number
  timeframe: string
  params: unknown
  action: string
  qty: number
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  repeat: boolean
  status?: string
}

const RSI_CONDITIONS = ['cross_above', 'cross_below']
const MACD_CONDITIONS = ['bull_cross', 'bear_cross', 'cross_above', 'cross_below']
const RULE_EXIT_MODES: StrategyRuleExitMode[] = ['none', 'price', 'pct']
const clampIntIn = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}

/**
 * Validate + normalize one raw rule object (mirrors POST /api/strategies).
 * Returns the reason string on rejection or the normalized payload.
 */
export function normalizeStrategyRuleImport(raw: unknown): AlgoRuleImportPayload | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a rule object'
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'macd' ? 'macd' : r.kind === 'rsi' ? 'rsi' : null
  if (!kind) return `unknown indicator kind${typeof r.kind === 'string' ? ` "${r.kind}"` : ''}`
  const symbol = String(r.symbol ?? '').trim().toUpperCase()
  if (!SYMBOL_RE.test(symbol)) return `invalid symbol${r.symbol ? ` "${String(r.symbol)}"` : ''}`
  const action = r.action === 'sell' ? 'sell' : r.action === 'buy' ? 'buy' : null
  if (!action) return `invalid action${typeof r.action === 'string' ? ` "${r.action}"` : ''}`
  const qty = Number(r.qty)
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) return 'qty must be a positive number'

  let condition = String(r.condition ?? '')
  if (kind === 'rsi' && !RSI_CONDITIONS.includes(condition)) return `invalid RSI condition "${condition}"`
  if (kind === 'macd' && !MACD_CONDITIONS.includes(condition)) return `invalid MACD condition "${condition}"`
  let level = Number(r.level)
  if (kind === 'rsi') {
    if (!Number.isFinite(level) || level <= 0 || level >= 100) return 'RSI level must be between 0 and 100'
  } else if (condition === 'cross_above' || condition === 'cross_below') {
    if (!Number.isFinite(level)) return 'MACD cross level required'
  } else {
    level = 0 // bull/bear crossovers carry no level (same as the create API)
  }
  const tf = String(r.timeframe ?? '1D')
  const timeframe = (tf in TIMEFRAMES) ? tf : '1D'

  let params: Record<string, number>
  const p = (r.params && typeof r.params === 'object' ? r.params : {}) as Record<string, unknown>
  if (kind === 'rsi') {
    params = { period: clampIntIn(p.period, 2, 200, 14) }
  } else {
    let fast = clampIntIn(p.fast, 1, 200, 12)
    let slow = clampIntIn(p.slow, 2, 400, 26)
    if (slow <= fast) slow = fast + 1
    params = { fast, slow, signal: clampIntIn(p.signal, 1, 200, 9) }
  }

  const exit = (modeRaw: unknown, value: unknown, label: 'TP' | 'SL'): { mode: StrategyRuleExitMode; value: number | null } | string => {
    const mode = RULE_EXIT_MODES.includes(modeRaw as StrategyRuleExitMode) ? (modeRaw as StrategyRuleExitMode) : null
    if (!mode) return `${label} mode must be none, price or pct`
    if (mode === 'none') return { mode, value: null }
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return `${label} value must be a positive number`
    if (mode === 'pct' && n > 100) return `${label} % must be ≤ 100`
    return { mode, value: Math.min(1_000_000_000, n) }
  }
  const tp = exit(r.tpMode, r.tpValue, 'TP')
  if (typeof tp === 'string') return tp
  const sl = exit(r.slMode, r.slValue, 'SL')
  if (typeof sl === 'string') return sl

  return {
    symbol,
    kind,
    condition,
    level: Math.min(1_000_000_000, Math.max(-1_000_000_000, level)),
    timeframe,
    params,
    action,
    qty,
    tpMode: tp.mode,
    tpValue: tp.value,
    slMode: sl.mode,
    slValue: sl.value,
    repeat: r.repeat === true,
  }
}

/** Human condition text ("RSI(14) crosses above 30" / "MACD bull crossover"). */
export function strategyRuleConditionSummary(rule: AlgoRuleImportPayload): string {
  const tf = ` · ${rule.timeframe}`
  if (rule.kind === 'rsi') {
    const dir = rule.condition === 'cross_below' ? 'crosses below' : 'crosses above'
    return `RSI(${rule.params.period ?? 14}) ${dir} ${rule.level}${tf}`
  }
  const text: Record<string, string> = {
    bull_cross: 'bull crossover (line ↑ signal)',
    bear_cross: 'bear crossover (line ↓ signal)',
    cross_above: `crosses above ${rule.level}`,
    cross_below: `crosses below ${rule.level}`,
  }
  return `MACD(${rule.params.fast ?? 12},${rule.params.slow ?? 26},${rule.params.signal ?? 9}) ${text[rule.condition] ?? rule.condition}${tf}`
}

/** Human label used as the default rule name in exports/dialogs. */
export function strategyRuleSummaryName(rule: AlgoRuleImportPayload): string {
  return `${strategyRuleConditionSummary(rule)} · ${rule.symbol} ${rule.action.toUpperCase()} ${rule.qty}`
}

/** Map a StrategyRule row/DTO to the export-file entry (name + payload). */
export function ruleToExportEntry(rule: AlgoRuleLike): AlgoRuleFileEntry | string {
  const norm = normalizeStrategyRuleImport(rule)
  if (typeof norm === 'string') return norm
  return { name: strategyRuleSummaryName(norm), rule: norm }
}
