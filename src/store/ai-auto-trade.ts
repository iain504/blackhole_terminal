// AI 自動交易 (v2.12.18) — periodic EdgeZero-powered scanner over the watchlist.
//
// Loop: every `intervalSec`, pull the first watchlist, fetch bars per symbol
// (existing /api/market/bars), compute the SAME technical snapshots the chart
// adviser uses, and hand them to the model in ONE batched call demanding a
// strict JSON verdict per symbol (direction / confidence / entry / stop /
// target). R:R is recomputed BY THE TERMINAL from those levels — the model's
// own arithmetic is never trusted. A candidate fires only when
// confidence ≥ minConfidence AND R:R ≥ 1:minRR; position size scales with
// confidence (risk budget = equity × risk% × confidence/100, quantity =
// risk amount ÷ |price − stop|, notional capped at 50% equity); the fired
// order is a market entry with the model's levels attached as TP + SL bracket
// via the existing /api/trading/orders route.
//
// v2.12.32 — WIN-RATE CONTEXT PACK. Judging a symbol from its own bars alone
// leaves the classic win-rate killers invisible, so every scan now feeds the
// model: pivot S/R structure + position-in-range + ATR14-vs-ATR50 volatility
// state (computed from the loaded bars — free), the market regime
// (RISK_ON/NEUTRAL/RISK_OFF + why), earnings proximity per symbol with a
// DETERMINISTIC hard gate inside the danger window (report − 2d … + 20h —
// the terminal refuses, not the model; fail-open when the date is unknown),
// high-impact USD events inside 48h, news sentiment where covered, the 52w
// range position, the engine's OWN realized performance (win rate / avg
// win-loss / profit factor / streak / per-direction — the model calibrates
// its confidence against its actual track record), and the current holdings
// (correlation-aware entries). Every source fails open.
//
// Honesty contract: demo-flagged bars are EVALUATION-ONLY — they never fire
// an order (paper or live); every skip/reject is logged with its reason; a
// failed model call kills the round — nothing is invented.
//
// v2.12.23 — tradability gate. The scanner used to fire at symbols the
// broker cannot trade: VIX is a us_index ("trading is not supported for
// us_index asset class") and spot crypto cannot be SHORTED (a bearish
// BTC/USD verdict sent a SELL that died with "insufficient balance …
// available: 0", then the exit-only retry hint invited another blind loop
// every scan). Now a static index/forex filter + a cached broker probe
// (/api/trading/assets → /v2/assets/{sym}) drop un-tradeable symbols BEFORE
// any bars/model call, SHORT verdicts on non-shortable assets are rejected
// at the gate, demo bars never fire, and a failed order cools the symbol
// down (30 min, 12h when the broker says unsupported) instead of retrying
// blindly every scan.
//
// The engine lives at module scope (setTimeout chain), so the scan keeps
// running when the AI Trade tab is unmounted. Config persists in localStorage
// (instant cache); the enabled flag + config are SYNCED to the account via
// /api/settings/ai-ops (v2.12.24) so every signed-in computer sees the same
// toggles, and a server-side heartbeat elects ONE browser as the runner —
// other devices show 「其他裝置運行中」 and never double-fire orders. An enabled
// scanner auto-resumes after reload via resumeAiAutoIfNeeded() (called from
// TerminalRoot once the user session is known).
// v2.12.37 — REACT > RESPOND > REVIEW ENTRY PROTOCOL (default). A confident
// verdict used to fire a market order the moment the scan finished — the
// entry price was whatever the tape looked like mid-scan, and "confidence"
// alone decided. Now the model plans CONDITIONAL ENTRIES: per symbol up to
// one BUY plan (trigger above price — fires when the market goes UP through
// it) and one SELL plan (trigger below — fires on a DOWN-move), each with
// its own TP/SL. Plans persist WAITING in the AiTradePlan ledger; a reactor
// loop (20s) watches quotes: market confirms the trigger → follow the plan
// (Respond); price breaches the plan's stop first → plan invalidated
// (market went against — stand aside); 48h without resolution → expired.
// Every dead plan gets a 24h review pass (good-wait vs missed-run) distilled
// into the permanent lesson memory. entryMode 'instant' keeps the legacy
// immediate-fire behavior for A/B.
import { create } from 'zustand'
import {
  AI_TRADE_DEFAULT_MODEL, buildChartSnapshot, snapshotToText,
  isAiTradeModel, type AiTradeModel, type AiChatMsg,
} from '@/lib/ai-trade'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import { useTerminal, watchlistSymbols } from '@/store/terminal'
import {
  registerAiOpsAdapter, pushAiOpsState, queueAiOpsConfigPut,
  type AiOpsRunnerInfo,
} from '@/lib/ai-ops-sync'
import {
  dynamicThresholds as regimeDynamicThresholds, concentrationCheck,
  validatePlanSide, repairPlanTp, type GateRegime,
  isSpotCryptoSymbol, CRYPTO_NO_SHORT_NOTE,
} from '@/lib/ai-trade-gates'

// ---- config ----------------------------------------------------------------

export interface AiAutoConfig {
  enabled: boolean
  intervalSec: number // scan period
  timeframe: Timeframe // bars the model reads
  model: AiTradeModel
  minConfidence: number // 0–100
  minRR: number // reward:risk multiplier — threshold "1:minRR" (user spec e.g. 1:7)
  /** v2.12.38 — REACT-mode plan-creation gates. In react mode the discipline
   *  lives in the TRIGGER (market confirmation) + terminal-validated geometry
   *  + counter-move invalidation + 48h TTL + review, so the pre-commitment
   *  gate is deliberately SOFTER than the instant-mode thresholds — plans at
   *  moderate confidence are the expected output (the market still gets the
   *  final vote), and size scales with confidence. The old single gate
   *  (60% / 1:7) sat ON TOP of market confirmation and produced the
   *  week-long zero-trade deadlock: every plan died at the numeric gate
   *  before the market could ever confirm it. */
  reactMinConfidence: number
  reactMinRR: number
  riskPct: number // % of equity risked per trade at confidence 100
  maxOpenAuto: number // max concurrent positions opened by the auto trader
  maxSymbols: number // watchlist symbols evaluated per scan
  mode: 'paper' | 'live'
  dryRun: boolean // evaluate + log what WOULD fire, place nothing
  /** v2.12.37 — React > Respond > Review entry protocol. 'react' (default):
   *  the model plans conditional buy/sell entries (trigger + TP/SL), the
   *  terminal watches the market and only FOLLOWS the plan when price moves
   *  through the trigger (market confirms); a move against the plan's stop
   *  first invalidates it; 48h expires it. 'instant': legacy behavior — a
   *  passing verdict fires a market order immediately. */
  entryMode: 'react' | 'instant'
  watchlistId: string | null // which watchlist feeds the scan (null = first)
  /** v2.12.34 — scan pool source: the hand-picked watchlist, the AUTO
   *  WATCHLIST (US-universe screener Top-50 by volatility + liquidity), or
   *  both merged (watchlist first). A screener failure degrades to the
   *  watchlist — never a dead scan. */
  poolSource: 'watchlist' | 'auto' | 'union'
  excludedSymbols: string[] // per-symbol opt-out from the scan list
  /** v2.12.32 — hard-gate new entries inside the earnings danger window
   *  (report − 2d … report + 20h). Deterministic — does not depend on the
   *  model noticing. Fail-open when the date is unknown. Default ON. */
  blockEarnings: boolean
  /** v2.12.33 — regime-dynamic entry thresholds: RISK_OFF longs / RISK_ON
   *  shorts pay +10 confidence and ×1.25 R:R over the configured base. */
  dynamicThresholds: boolean
  /** v2.12.33 — concentration gate: block a candidate that correlates
   *  ≥ 0.85 with a same-direction holding, or when same-direction holdings
   *  already reached maxCorrelated. */
  blockConcentration: boolean
  maxCorrelated: number
}

export const AI_AUTO_DEFAULT_CONFIG: AiAutoConfig = {
  enabled: false,
  intervalSec: 300,
  timeframe: '1h',
  model: AI_TRADE_DEFAULT_MODEL,
  minConfidence: 60,
  minRR: 7,
  // v2.12.38 — react plan gates: 45% confidence ≈ "2 aligned evidence classes
  // with clean structure" on the calibration rubric; 1:1.5 clears fees+
  // slippage while staying reachable for structural stops (trigger-relative
  // R:R: a +1%/−2%/+4% plan = 1.0, +0.5%/−1.5%/+4% = 1.4, +0.5%/−1%/+4% = 2.3
  // — the model is told the exact floor and plans geometry that clears it).
  // Instant keeps 60/7.
  reactMinConfidence: 45,
  reactMinRR: 1.5,
  riskPct: 1,
  maxOpenAuto: 3,
  maxSymbols: 6,
  mode: 'paper',
  dryRun: false,
  entryMode: 'react',
  watchlistId: null,
  poolSource: 'watchlist',
  excludedSymbols: [],
  blockEarnings: true,
  dynamicThresholds: true,
  blockConcentration: true,
  maxCorrelated: 2,
}

const LS_KEY = 'bh-ai-auto-cfg-v1'

const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Sanitize any untrusted object into a valid AiAutoConfig (clamped, typed).
 *  Shared by the localStorage loader AND the cross-device sync adoption so
 *  a config saved on another computer passes through the exact same gates. */
export function sanitizeAiAutoConfig(input: unknown): AiAutoConfig {
  const d = AI_AUTO_DEFAULT_CONFIG
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...d }
  const j = input as Partial<AiAutoConfig>
  return {
    enabled: Boolean(j.enabled),
    intervalSec: clampN(num(j.intervalSec, d.intervalSec), 60, 7200),
    timeframe: (typeof j.timeframe === 'string' && TIMEFRAMES[j.timeframe as Timeframe])
      ? j.timeframe as Timeframe : d.timeframe,
    model: isAiTradeModel(j.model) ? j.model : d.model,
    minConfidence: clampN(num(j.minConfidence, d.minConfidence), 0, 100),
    minRR: clampN(num(j.minRR, d.minRR), 0.1, 100),
    // undefined (old saved configs) → the softer react defaults — the
    // week-long deadlock must not survive a version bump
    reactMinConfidence: clampN(num(j.reactMinConfidence, d.reactMinConfidence), 0, 100),
    reactMinRR: clampN(num(j.reactMinRR, d.reactMinRR), 0.1, 100),
    riskPct: clampN(num(j.riskPct, d.riskPct), 0.01, 10),
    maxOpenAuto: Math.round(clampN(num(j.maxOpenAuto, d.maxOpenAuto), 1, 20)),
    maxSymbols: Math.round(clampN(num(j.maxSymbols, d.maxSymbols), 1, 50)),
    mode: j.mode === 'live' ? 'live' : 'paper',
    dryRun: Boolean(j.dryRun),
    // undefined (old saved config) → 'react' — the React > Respond > Review
    // protocol is the default entry discipline for existing users too
    entryMode: j.entryMode === 'instant' ? 'instant' : 'react',
    watchlistId: typeof j.watchlistId === 'string' && j.watchlistId ? j.watchlistId : null,
    poolSource: j.poolSource === 'auto' || j.poolSource === 'union' ? j.poolSource : 'watchlist',
    excludedSymbols: Array.isArray(j.excludedSymbols)
      ? j.excludedSymbols.filter((s): s is string => typeof s === 'string' && /^[A-Z0-9./:-]{1,15}$/.test(s)).slice(0, 100)
      : [],
    // undefined (old saved config) → default ON — the gap-risk gate must not
    // silently vanish for existing users
    blockEarnings: j.blockEarnings === undefined ? d.blockEarnings : Boolean(j.blockEarnings),
    dynamicThresholds: j.dynamicThresholds === undefined ? d.dynamicThresholds : Boolean(j.dynamicThresholds),
    blockConcentration: j.blockConcentration === undefined ? d.blockConcentration : Boolean(j.blockConcentration),
    maxCorrelated: Math.round(clampN(num(j.maxCorrelated, d.maxCorrelated), 1, 10)),
  }
}

function loadConfig(): AiAutoConfig {
  if (typeof window === 'undefined') return { ...AI_AUTO_DEFAULT_CONFIG }
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return { ...AI_AUTO_DEFAULT_CONFIG }
    return sanitizeAiAutoConfig(JSON.parse(raw))
  } catch {
    return { ...AI_AUTO_DEFAULT_CONFIG }
  }
}

/** v2.12.38 — mode-aware base thresholds. React plans use the softer react
 *  gates (the market must still confirm the trigger before anything orders —
 *  that confirmation IS the hard gate); instant keeps the strict
 *  pre-commitment thresholds (60% / 1:7). Both then pay the regime-dynamic
 *  surcharge when trading against the wind. */
export function baseThresholds(cfg: AiAutoConfig): { minConfidence: number; minRR: number } {
  return cfg.entryMode === 'react'
    ? { minConfidence: cfg.reactMinConfidence, minRR: cfg.reactMinRR }
    : { minConfidence: cfg.minConfidence, minRR: cfg.minRR }
}

function persistConfig(cfg: AiAutoConfig) {
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch { /* private mode */ }
}

// ---- tradability gate (v2.12.23) -------------------------------------------

/** Index/forex symbols the broker can't trade — filtered before ANY fetch so
 *  a watchlist holding VIX stops burning model tokens + broker errors. The
 *  broker probe (/api/trading/assets) is the authoritative second layer; this
 *  static list is the zero-cost first one (also covers the no-broker demo
 *  scan where the probe answers nothing). */
const NON_TRADABLE_STATIC = new Set([
  'VIX', 'VIX3M', 'VVIX', 'SPX', 'NDX', 'RUT', 'DJI', 'NYA',
  'DXY', 'XAU', 'XAG', 'UKX', 'NKY', 'HSI', 'GDAXI', 'CAC40',
])
function staticTradabilityNote(sym: string): string | null {
  if (sym.startsWith('^')) return '指數'
  if (sym.endsWith('=X')) return '外匯'
  if (NON_TRADABLE_STATIC.has(sym)) return '指數'
  return null
}

const COOLDOWN_MS_ORDER = 30 * 60_000 // generic order failure → 30 min
const COOLDOWN_MS_UNSUPPORTED = 12 * 3600_000 // broker says "unsupported" → half a day
/** symbol → cooldown-until epoch ms. Session-scope (a reload clears it — the
 *  broker probe + entry-hint fixes make repeat failures rare anyway). */
const orderFailCooldown = new Map<string, number>()

/** After a failed order: cool the symbol down so one broken candidate can't
 *  spam the broker + the activity log every scan. Broker "unsupported"
 *  errors get the long cooldown and a memorable log line. */
function classifyOrderFailure(symbol: string, msg: string) {
  const m = msg.toLowerCase()
  const unsupported = /not supported|asset class|us_index|not found|does not exist|not tradable|cannot open a short/.test(m)
  orderFailCooldown.set(symbol.toUpperCase(), Date.now() + (unsupported ? COOLDOWN_MS_UNSUPPORTED : COOLDOWN_MS_ORDER))
  useAiAutoStore.getState().addLog('info', `${symbol} 進入冷卻 — ${unsupported ? 'broker 不支持該標的/方向，12 小時內不再評估' : '30 分鐘內不再評估'}`)
}

// ---- runtime types ----------------------------------------------------------

export type AiAutoDirection = 'long' | 'short' | 'flat'

/** v2.12.35 — the exact string a verdict carries when its model group call
 *  failed (or the model skipped the symbol). Shared by the store and the
 *  panel so the UI can tell "honest neutral" apart from "not evaluated". */
export const AI_EVAL_FAIL_REASON = '評估失敗（模型組失敗或漏答）'

export interface AiAutoVerdict {
  symbol: string
  direction: AiAutoDirection
  confidence: number
  entry: number | null
  stop: number | null
  target: number | null
  rr: number | null // computed by the terminal from entry/stop/target
  reason: string
  demoBars: boolean
  passed: boolean
  rejectReason: string | null
  dryRunNote: string | null
  /** v2.12.33 — attribution ledger status for NON-FLAT verdicts: what
   *  actually happened to this call (fired / dry-run / gated). */
  verdictStatus?: 'fired' | 'dry-run' | 'gated' | null
  /** v2.12.37 — react mode: the conditional plans this verdict produced. */
  plans?: AiVerdictPlan[]
  /** v2.12.37 — last close when evaluated; the plan's 距觸發% anchor. */
  refPrice?: number
}

/** v2.12.37 — one conditional entry side parsed from a react-mode verdict.
 *  status 'created' = plan validated + persisted WAITING; 'rejected' rows
 *  keep the terminal's honest reason (geometry / threshold / shortability). */
export interface AiVerdictPlan {
  side: 'buy' | 'sell'
  trigger: number
  tp: number
  sl: number
  rr: number
  status: 'created' | 'rejected'
  note: string | null
  /** v2.12.38 — TP re-derived by the terminal as a mechanical R-multiple
   *  target after the model's structural TP came in too close. */
  repaired?: boolean
}

export type AiPlanStatus = 'WAITING' | 'EXECUTED' | 'INVALIDATED' | 'EXPIRED' | 'GATED' | 'CANCELLED' | 'SUPERSEDED'

/** v2.12.37 — one conditional entry plan the terminal is watching (react
 *  mode). Hydrated from the AiTradePlan ledger so plans survive reloads and
 *  runner hand-over; transitions are PATCHed back best-effort. */
export interface AiPlanVM {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  confidence: number
  trigger: number
  tp: number
  sl: number
  rr: number
  refPrice: number
  reason: string | null
  regime: string | null
  mode: string
  status: AiPlanStatus
  statusNote: string | null
  createdAt: number
  closedAt: number | null
  /** dry-run notice logged once per plan (the tick loop would spam) */
  dryRunNoted?: boolean
}

export interface AiAutoFired {
  id: number
  at: number
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  stop: number
  target: number
  confidence: number
  rr: number
  mode: string
}

export interface AiAutoLogEntry {
  id: number
  at: number
  level: 'info' | 'success' | 'warn' | 'error'
  text: string
}

interface AiAutoState {
  config: AiAutoConfig
  scanning: boolean
  lastScanAt: number | null
  nextScanAt: number | null
  log: AiAutoLogEntry[]
  verdicts: AiAutoVerdict[] // latest finished scan
  fired: AiAutoFired[]
  /** v2.12.37 — react mode: plans this session created/adopted + lifecycle */
  plans: AiPlanVM[]
  /** v2.12.24 — who is the elected runner for this engine (cross-device
   *  sync). null = unknown/disabled; isMe:false = another device runs it. */
  runnerInfo: AiOpsRunnerInfo | null
  addLog: (level: AiAutoLogEntry['level'], text: string) => void
  updateConfig: (patch: Partial<AiAutoConfig>) => void
  setEnabled: (on: boolean) => void
  start: (immediate?: boolean) => void
  stop: () => void
  scanOnce: () => Promise<void>
  cancelScan: () => void
  clearLog: () => void
  /** sync-layer hooks (v2.12.24) — not for UI use */
  setRunnerInfo: (info: AiOpsRunnerInfo | null) => void
  adoptConfig: (cfg: unknown) => void
  setEnabledFlag: (on: boolean) => void
}

// ---- module-scope engine ----------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null
let scanning = false
let scanAbort: AbortController | null = null
let logSeq = 0
let fireSeq = 0
let resumed = false

export const useAiAutoStore = create<AiAutoState>((set, get) => ({
  config: loadConfig(),
  scanning: false,
  lastScanAt: null,
  nextScanAt: null,
  log: [],
  verdicts: [],
  fired: [],
  plans: [],
  runnerInfo: null,
  addLog: (level, text) => set((s) => ({ log: [...s.log, { id: ++logSeq, at: Date.now(), level, text }].slice(-250) })),
  updateConfig: (patch) => {
    const next = { ...get().config, ...patch }
    persistConfig(next)
    set({ config: next })
    // v2.12.24 — push the edit to the account (debounced; no runner claim:
    // editing the interval on device 2 must not yank execution off device 1)
    queueAiOpsConfigPut('auto-trade')
    // v2.12.37 — entry-mode flips re-arm or disarm the reactor mid-flight
    if (patch.entryMode !== undefined) {
      if (next.entryMode === 'instant') stopReactor('進場模式改為即時下單 — React 反應器停止')
      else ensureReactorArmed()
    }
    // a period change while running reschedules the pending tick from now
    if (patch.intervalSec !== undefined && timer && next.enabled && !scanning) {
      if (timer) { clearTimeout(timer); timer = null }
      armTimer(next.intervalSec)
    }
  },
  setEnabled: (on) => {
    if (on) {
      startScanner(true) // flips the flag, starts the engine, PUT + claim
    } else {
      // v2.12.24 — flag and engine are separate concerns now: flip the
      // account-level toggle, stop the local engine if it was running here,
      // then publish (the PUT clears the runner slot server-side).
      useAiAutoStore.getState().setEnabledFlag(false)
      stopScanner()
      void pushAiOpsState('auto-trade')
    }
  },
  start: (immediate = true) => startScanner(immediate),
  stop: () => stopScanner(),
  scanOnce: () => runScan(),
  cancelScan: () => scanAbort?.abort(),
  clearLog: () => set({ log: [] }),
  setRunnerInfo: (info) => set({ runnerInfo: info }),
  adoptConfig: (cfg) => {
    // Server-sent config (cross-device sync). `enabled` is owned by the
    // sync layer + toggles, never by the config payload.
    const next = sanitizeAiAutoConfig(cfg)
    next.enabled = get().config.enabled
    persistConfig(next)
    set({ config: next })
  },
  setEnabledFlag: (on) => {
    // Account-level toggle flip WITHOUT touching the local engine — used by
    // the sync layer so followers show the switch ON while idle.
    const cur = get().config
    if (cur.enabled === on) return
    const next = { ...cur, enabled: on }
    persistConfig(next)
    set({ config: next })
  },
}))

function armTimer(intervalSec: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void runScan() }, intervalSec * 1000)
  useAiAutoStore.setState({ nextScanAt: Date.now() + intervalSec * 1000 })
}

function startScanner(immediate: boolean, opts?: { fromSync?: boolean; note?: string }) {
  const st = useAiAutoStore.getState()
  if (st.config.enabled && timer) return // already running
  const next = { ...st.config, enabled: true }
  persistConfig(next)
  useAiAutoStore.setState({ config: next })
  // v2.12.38 — the log names the gates THIS mode actually enforces
  const base = baseThresholds(next)
  st.addLog('info', `${opts?.note ?? '自動交易掃描器啟動'} — 每 ${fmtInterval(next.intervalSec)} 掃描關注清單一次（門檻：信心 ≥ ${base.minConfidence}% · R:R ≥ 1:${base.minRR}${next.entryMode === 'react' ? ' · React 計劃模式' : ' · 即時下單模式'}）`)
  // v2.12.24 — user-facing start publishes to the account AND claims the
  // runner slot for this device; sync-driven starts skip the PUT (the server
  // row is already enabled — that's why we're starting).
  if (!opts?.fromSync) void pushAiOpsState('auto-trade', { claim: true })
  ensureReactorArmed()
  if (immediate) {
    void runScan()
  } else {
    armTimer(Math.min(next.intervalSec, 30)) // auto-resume: first look after ≤30s, then the real cadence
  }
}

function stopScanner(opts?: { fromSync?: boolean; reason?: 'synced-off' | 'yield' }) {
  // v2.12.24 — engine-only stop: the enabled FLAG is managed by setEnabled /
  // setEnabledFlag, this just tears down the local timer/scan. Idempotent:
  // repeated sync ticks on a follower (engine never armed) don't spam logs.
  if (!timer && !scanning) return
  if (timer) { clearTimeout(timer); timer = null }
  if (scanning) scanAbort?.abort() // honest stop mid-flight too
  stopReactor()
  useAiAutoStore.setState({ nextScanAt: null })
  useAiAutoStore.getState().addLog(
    'info',
    opts?.reason === 'synced-off'
      ? '自動交易已於其他裝置關閉 — 本機同步停止'
      : opts?.reason === 'yield'
        ? '自動交易改由其他裝置執行 — 本機待命'
        : '自動交易掃描器已停止',
  )
}

/** Called from TerminalRoot once the user session is known: re-arm an enabled
 *  scanner left on by a previous session (localStorage fallback). The PUT to
 *  the server is deliberately skipped — the cross-device sync layer owns the
 *  account state; if the row is missing it migrates this state up itself. */
export function resumeAiAutoIfNeeded() {
  if (resumed) return
  resumed = true
  const st = useAiAutoStore.getState()
  if (!st.config.enabled || timer || scanning) return
  st.addLog('info', '偵測到上次啟用的自動交易 — 自動恢復掃描')
  startScanner(false, { fromSync: true })
}

// v2.12.24 — register with the cross-device sync layer. The heartbeat tick
// (20s, every signed-in tab) drives start/stop through these hooks, so the
// account's enabled flag and ONE elected runner stay honest everywhere.
registerAiOpsAdapter({
  kind: 'auto-trade',
  isEnabled: () => useAiAutoStore.getState().config.enabled,
  // startScanner's own guard (enabled && timer) makes this idempotent.
  startLocal: () => startScanner(false, { fromSync: true, note: '已同步 — 自動交易於本裝置執行' }),
  stopLocal: (reason) => stopScanner({ fromSync: true, reason }),
  adoptConfig: (cfg) => useAiAutoStore.getState().adoptConfig(cfg),
  setRunnerInfo: (info) => useAiAutoStore.getState().setRunnerInfo(info),
  setEnabledFlag: (on) => useAiAutoStore.getState().setEnabledFlag(on),
  configForServer: () => {
    const { enabled: _enabled, ...rest } = useAiAutoStore.getState().config
    return { ...rest }
  },
})

const fmtInterval = (s: number) => (s % 3600 === 0 ? `${s / 3600}小時` : s % 60 === 0 ? `${s / 60}分鐘` : `${s}秒`)

/** Snapshots per model call — 6 × ~900 chars keeps the DATA block (enriched
 *  v2.12.32 snapshots + the shared win-rate context pack) inside the chat
 *  route's 8k context clamp. */
const SCAN_CHUNK = 6

function scanInstruction(n: number, minConf: number, minRR: number): string {
  return [
    `以下是關注清單 ${n} 個標的的資料（DATA 區：每標的技術快照 + 共用「市場環境/近期表現/持倉」區）。請擔任量化評估引擎，遵循紀律 Plan your trade, trade your plan（先計劃後交易：entry/stop/target 就是你開出的作戰計劃，終端按此執行與護倉），逐一判斷短期（此時間框架）方向，只輸出 JSON 陣列，禁止任何其他文字或說明：`,
    `[{"symbol":"<快照中的標的>","direction":"long|short|flat","confidence":<0-100 整數>,"entry":<數字>,"stop":<數字>,"target":<數字>,"reason":"<繁體中文 ≤ 30 字>"}]`,
    `規則：`,
    `- 證據計數：方向需要「至少 2 類獨立證據同向」才可 non-flat（趨勢/動量、量能、結構 S/R、高週期、情緒/環境）。證據互相矛盾或只有單一訊號 → 誠實 flat 或低 confidence。`,
    `- 信心校準表（終端門檻：non-flat 需信心 ≥ ${minConf}% 且 R:R ≥ 1:${minRR}，R:R 由終端以現價重算）：0–20 = 無優勢（flat）；25–40 = 單一證據類、投機性；45–60 = 兩類獨立證據同向且結構清楚；65–80 = 三類以上＋量能或高週期確認；85+ = 罕見（全部對齊）。誠實校準 — 證據足夠就給出對應數字，禁止把信心一律壓在 0 或 30。`,
    `- 市場環境：RISK_OFF 時做多需更高證據門檻（逆風交易勝率低）；區間位置 >90% 追高 / <10% 追跌要特別保守；波動緊縮（ATR14 < ATR50）時假突破多 — flat 傾向提高。`,
    `- 近期表現：這是本引擎最近已平倉交易的真實成績。用它校準 confidence — 某方向勝率明顯差時，對該方向新訊號信心降 10–15 而非一律歸零（完全停止出手會讓引擎失去校準資料）。`,
    `- entry 取現價附近；stop 掛在最近支撐之下 / 最近阻力之上（結構外），距離參考 ATR — 不可緊貼現價；target 放在到達下一個 S/R 之前。long 必須 stop < entry < target；short 必須 target < entry < stop。`,
    `- 現貨加密（標的含「/」如 BTC/USD、ETH/USD）在 Alpaca 只能做多、不可做空：加密標的不可判 short — 看空時誠實 flat，reason 註明「加密不可做空」。`,
    `- 財報/事件：快照標明「財報臨近（block）」的標的必然被終端硬閘拒絕 — 直接給 flat；「財報: N 天後」N ≤ 5 時 confidence 上限 55（跳空風險）；共用區列出的 48 小時內高影響事件同樣壓低所有相關方向信心。`,
    `- 目前持倉：已持有標的不會再下單，但請避免建議與現有持倉高度相關的新方向（同板塊同向 = 集中風險）；[集中風險] 標明 ⚠ 的持倉對彼此高度相關，不要再建議與其同向的新標的。`,
    `- 覆盤統計：這是本引擎過往判斷 24 小時後的真實對帳結果（依 regime×方向分組）。用它選擇證據組合 — 某組合勝率明顯差時，同組合的新訊號給 flat 或低 confidence。`,
    `- confidence 是你對該方向的把握度，並已用近期勝率校準；direction 為 flat 時，entry/stop/target 與 confidence 全部填 0，reason 必須說出為何不交易的關鍵原因（如：證據不足/互相矛盾、區間中段無優勢、量價背離、事件風險）。`,
    `- 本引擎以勝率優先：無證據的標的判 flat 是正確輸出（寧可錯過、不可做錯），但「寧可錯過」指不降低證據標準，不是把信心一律壓到門檻之下 — 證據充分、風險可控的標的必須給出達標的信心與數字。`,
    `- DATA 區已提供 MACD(12,26,9)、RSI、量能分布（up/down-bar volume、5/20-bar 量能趨勢）、4× 高週期趨勢、最近測試的支撐/阻力（含觸及次數）、52 週區間位置，以及「選股」行（全宇宙篩選排名 · ATR14% 波動 · 量比 · 成交額）— 請一併考慮；高週期與短週期矛盾時誠實反映在 confidence 與 reason；高 ATR 標的的停損距離需按波動放寬，量比爆量代表事件驅動行情、留意假突破。`,
    `- 只能使用 DATA 區的數字，不可杜撰資料；每個標的都要有對應項目。`,
  ].join('\n')
}

/** v2.12.37 — react-mode planning instruction (React > Respond > Review).
 *  Same DATA block as the instant scan, but the model now outputs
 *  CONDITIONAL PLANS instead of a market-order command: per symbol a bias +
 *  confidence + up to ONE buy plan (fires when the market goes UP through
 *  the trigger) and ONE sell plan (fires on a DOWN-move through it), each
 *  with its own TP/SL. The terminal validates geometry, watches the market,
 *  and only follows a plan the market actually confirms — then reviews. */
function scanInstructionPlans(
  n: number,
  longGate: { minConfidence: number; minRR: number },
  shortGate: { minConfidence: number; minRR: number },
): string {
  // v2.12.38 — the model is told the EFFECTIVE per-direction gates (base
  // config + regime surcharge already applied), so its planned geometry can
  // clear exactly what the terminal will enforce — the v2.12.38 E2E scan
  // caught the mismatch: the prompt said 1:1.6 while RISK_OFF longs were
  // gated at 1:2.0, silently killing every well-formed plan.
  const g = (x: { minConfidence: number; minRR: number }) => `信心 ≥ ${x.minConfidence}% 且 R:R ≥ 1:${x.minRR}`
  const sameGate = longGate.minConfidence === shortGate.minConfidence && longGate.minRR === shortGate.minRR
  const gateLine = sameGate
    ? `終端門檻（買賣計劃相同）：${g(longGate)}`
    : `終端門檻（依 regime 分方向）：buy 計劃 ${g(longGate)} · sell 計劃 ${g(shortGate)}`
  return [
    `以下是關注清單 ${n} 個標的的資料（DATA 區：每標的技術快照 + 共用「市場環境/近期表現/持倉」區）。請擔任量化作戰規劃引擎，遵循紀律 Plan your trade, trade your plan — React > Respond > Review：先分析、出「條件作戰計劃」（無計劃不下單）；終端會監控市場，價格觸及計劃觸發價才跟進下單，市場反向則計劃作廢。只輸出 JSON 陣列，禁止任何其他文字：`,
    `[{"symbol":"<快照中的標的>","direction":"long|short|flat","confidence":<0-100 整數>,"buyTrigger":<數字>,"buyTp":<數字>,"buySl":<數字>,"sellTrigger":<數字>,"sellTp":<數字>,"sellSl":<數字>,"reason":"<繁體中文 ≤ 30 字>"}]`,
    `計劃規則：`,
    `- ${gateLine}。R:R 由終端以觸發價重算：buy R:R = (buyTp − buyTrigger) ÷ (buyTrigger − buySl)；sell R:R = (sellTrigger − sellTp) ÷ (sellSl − sellTrigger)。例：現價 100，buyTrigger 100.5 / buySl 99 / buyTp 104 → R:R = 3.5 ÷ 1.5 = 2.33 ✓。送出前先代入算式自查；達不到門檻的側直接填 0（不要送會被拒的幾何）。`,
    `- R:R 幾何技巧：TP 由結構（下一個 S/R）決定後，把觸發價「貼近現價」（+0.3% ~ +1%）可同時縮小風險距離並拉高 R:R — SL 距離遠時尤其有效；若貼近後仍達不到門檻，代表 TP 空間不足，該側不給計劃。`,
    `- buy 計劃 = 突破/動能確認：buyTrigger 必須高於現價（+0.3% ~ +4%），市場「上攻」觸及才成立；buySl 掛在最近支撐之下（結構外，距離參考 ATR — 不可緊貼現價），buyTp 放在到達下一個阻力之前。`,
    `- sell 計劃 = 跌破確認：sellTrigger 必須低於現價（−0.3% ~ −4%），市場「跌破」觸及才成立；sellSl 掛在最近阻力之上，sellTp 放在到達下一個支撐之前。`,
    `- 現貨加密（標的含「/」如 BTC/USD、ETH/USD）在 Alpaca 只能做多、不可做空：不為加密標的給 sell 計劃 — 看空時 sell 側各數字填 0，reason 註明「加密不可做空，僅觀察」。`,
    `- 只給證據支持的側：偏多證據給 buy 計劃、偏空證據給 sell 計劃；區間且雙向證據都成立時可同時給兩側（市場自己選方向，we follow the plan）。無計劃的一側該組數字填 0。`,
    `- direction 是你的主要傾向（long/short/flat）；confidence 是對主要傾向的把握度，並已用近期勝率校準。`,
    `- 信心校準表：0–20 = 無優勢（flat）；25–40 = 單一證據類、投機性；45–60 = 兩類獨立證據同向且結構清楚；65–80 = 三類以上＋量能或高週期確認；85+ = 罕見（全部對齊）。誠實校準 — 證據足夠就給出對應數字，禁止把信心一律壓在 0 或 30。`,
    `- react 紀律 = 市場確認才執行：計劃建立後須價格「觸及觸發價」才會下單，反向先破停損區即作廢、48 小時未觸發逾期作廢 — 因此「中等信心的條件計劃」是預期且正確的輸出，倉位會按信心自動縮小；不要自我審查到 flat，只有真正無證據才 flat（flat 時全部數字填 0，reason 說明關鍵原因）。`,
    `- 證據計數：non-flat 方向需要「至少 2 類獨立證據同向」（趨勢/動量、量能、結構 S/R、高週期、情緒/環境）；證據互相矛盾或只有單一訊號 → 誠實 flat，所有數字填 0，reason 說明關鍵原因。`,
    `- 市場環境：RISK_OFF 做多、RISK_ON 做空屬逆風 — 逆風側門檻已在上列分方向門檻中上調；區間位置 >90% 追高 / <10% 追跌要特別保守；波動緊縮（ATR14 < ATR50）假突破多 — buyTrigger 需更貼近確認位。`,
    `- 近期表現/覆盤統計：這是本引擎真實成績與過往判斷 24 小時後的對帳結果。用它校準信心並選擇證據組合 — 某組合勝率明顯差時，同組合新訊號信心降 10–15 或改給反向側計劃，而非一律 flat（完全不出手會讓引擎失去校準資料）。`,
    `- 財報/事件：「財報臨近（block）」標的必然被終端硬閘拒絕 — 直接 flat；「財報: N 天後」N ≤ 5 時 confidence 上限 55；共用區列出的 48 小時內高影響事件同樣壓低相關方向信心。`,
    `- 目前持倉：已持有標的不會再進場；避免與現有持倉高度相關的新方向；[集中風險] 標明 ⚠ 的持倉對不要再建同向計劃。`,
    `- 數字只能取自 DATA 區，不可杜撰資料；每個標的都要有對應項目；無證據的標的判 flat 是正確輸出，但不要為了保守把有證據的標的也壓成 flat — 每輪請對證據最充分的標的給出計劃（若兩類證據同向）。`,
  ].join('\n')
}

// ---- one scan round ---------------------------------------------------------

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; j: Record<string, unknown> | null }> {
  const res = await fetch(url, init)
  const j = await res.json().catch(() => null)
  return { status: res.status, j }
}

/** v2.12.34 — why a symbol made the auto-watchlist cut (screener metrics).
 *  Filled from /api/market/screener when the pool source is auto/union. */
interface PickMeta {
  rank: number | null
  atrPct: number | null
  relVol: number | null
  dollarVol: number | null
  chgPct: number | null
  kind: 'stock' | 'etf' | null
}

const fmtM = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1e3)}K`)

export async function runScan(): Promise<void> {
  const st0 = useAiAutoStore.getState()
  if (scanning) return
  scanning = true
  scanAbort = new AbortController()
  const sig = scanAbort.signal
  const cfg = st0.config
  const t0 = Date.now()
  // v2.12.37 — which entry protocol this round runs under
  const useReact = cfg.entryMode === 'react'
  // v2.12.38 — mode-aware plan/verdict gates (react: 45/1.8, instant: 60/7)
  const base = baseThresholds(cfg)
  setScanning(true)
  st0.addLog('info', `掃描開始 — ${cfg.maxSymbols} 標的上限 · ${cfg.timeframe} K線 · ${cfg.model}${useReact ? ' · React 計劃模式' : ''}${cfg.dryRun ? ' · 試運行（不下單）' : ''}`)
  // v2.12.34 — auto-watchlist pool state (declared here so snapshotExtras
  // and the context pack below can read it): symbol → why it made the cut.
  const pickBySym = new Map<string, PickMeta>()
  let poolNote = ''

  try {
    // 1) scan pool — v2.12.34: the user's watchlist, the AUTO WATCHLIST
    //    (US-universe screener Top-50 by volatility+liquidity), or both
    //    merged (watchlist first). Every source fails open: a screener
    //    failure degrades to the watchlist with an honest log line, never
    //    a dead scan. '#Group' separators and the panel's per-symbol
    //    exclusions apply to whichever pool was chosen.
    const lists = useTerminal.getState().watchlists
    const list = lists.find((l) => l.id === cfg.watchlistId) ?? lists[0]
    const excl = new Set(cfg.excludedSymbols)
    const watchSyms = watchlistSymbols(list?.items ?? [])
    let poolSyms: string[] = watchSyms
    if (cfg.poolSource !== 'watchlist') {
      const scr = await fetchJson('/api/market/screener', { signal: sig }).catch(() => ({ status: 0, j: null as Record<string, unknown> | null }))
      const rawPicks = Array.isArray((scr.j as { picks?: unknown[] } | null)?.picks) ? ((scr.j as { picks: Record<string, unknown>[] }).picks) : []
      for (const p of rawPicks) {
        if (!p || typeof p.symbol !== 'string') continue
        const sym = p.symbol.toUpperCase()
        pickBySym.set(sym, {
          rank: Number.isFinite(Number(p.rank)) ? Number(p.rank) : null,
          atrPct: Number.isFinite(Number(p.atrPct)) ? Number(p.atrPct) : null,
          relVol: Number.isFinite(Number(p.relVol)) ? Number(p.relVol) : null,
          dollarVol: Number.isFinite(Number(p.dollarVol)) ? Number(p.dollarVol) : null,
          chgPct: Number.isFinite(Number(p.chgPct)) ? Number(p.chgPct) : null,
          kind: p.kind === 'etf' ? 'etf' : p.kind === 'stock' ? 'stock' : null,
        })
      }
      const syms = [...pickBySym.keys()]
      if (syms.length === 0) {
        st0.addLog('warn', '自動選股清單不可用（篩選失敗或仍在運算）— 退回關注清單。')
      } else {
        poolSyms = cfg.poolSource === 'union'
          ? [...watchSyms, ...syms.filter((s) => !watchSyms.includes(s))]
          : syms
        const meta = (scr.j ?? {}) as { universeSize?: unknown; feed?: unknown; computedAt?: unknown }
        const uni = Number(meta.universeSize) || 0
        const t = typeof meta.computedAt === 'string' ? new Date(meta.computedAt) : null
        const hhmm = t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '?'
        poolNote = `自動選股 Top ${syms.length}${uni ? `（篩選自 ${uni} 檔美股）` : ''} · 更新 ${hhmm}`
        if ((scr.j as { source?: unknown } | null)?.source !== 'real') {
          st0.addLog('warn', '自動選股為模擬宇宙（無真實行情 / 未經篩選）— 僅供流程驗證。')
        }
      }
    }
    const symbols = poolSyms
      .filter((s) => !excl.has(s))
      .slice(0, cfg.maxSymbols)
    // honest pool label: a screener failure falls back to the watchlist, so
    // the log must name what ACTUALLY got scanned
    const poolLabel = cfg.poolSource === 'watchlist' || pickBySym.size === 0
      ? list?.name ?? '?'
      : poolNote
    if (symbols.length === 0) {
      st0.addLog('warn', list || pickBySym.size > 0
        ? `掃描池「${poolLabel}」沒有可掃描標的（空、全被排除或只剩分隔線）。`
        : '沒有關注清單 — 先在圖表建立清單並加入符號，或在下方改用自動選股池。')
      return
    }
    st0.addLog('info', `掃描池「${poolLabel}」— ${symbols.length} 標的${excl.size ? `（排除 ${excl.size} 個）` : ''}`)

    // v2.12.23 — cooldown + static tradability filters BEFORE anything else
    const nowTs = Date.now()
    const cooledSyms: string[] = []
    const staticBlocked: string[] = []
    const scanSyms: string[] = []
    for (const s of symbols) {
      const until = orderFailCooldown.get(s)
      if (until != null && until > nowTs) { cooledSyms.push(s); continue }
      const note = staticTradabilityNote(s)
      if (note) { staticBlocked.push(`${s}（${note}）`); continue }
      scanSyms.push(s)
    }
    if (cooledSyms.length > 0) st0.addLog('info', `冷卻中 — 先前下單失敗，本輪跳過：${cooledSyms.join('、')}`)
    if (staticBlocked.length > 0) st0.addLog('info', `不可交易 — 跳過：${staticBlocked.join('、')}`)

    // 2) account (for sizing) + open positions (skip symbols already held)
    let equity: number | null = null
    // v2.12.25 — in-round buying-power budget. Every order in THIS scan used
    // to size off the same account snapshot taken before ANY order fired, so
    // two passes could both spend the full budget (the 'repeated buying /
    // wrong position sizing' report). bpLeft shrinks as orders fire.
    let bpLeft: number | null = null
    const openSyms = new Set<string>()
    const [acc, pos] = await Promise.all([
      fetchJson('/api/trading/account', { signal: sig }).catch(() => ({ status: 0, j: null })),
      fetchJson('/api/trading/positions', { signal: sig }).catch(() => ({ status: 0, j: null })),
    ])
    const accJ = acc.j as { account?: { equity?: unknown; buyingPower?: unknown }; error?: string } | null
    const eqRaw = accJ?.account?.equity
    if (eqRaw != null) { const n = Number(eqRaw); if (Number.isFinite(n) && n > 0) equity = n }
    const bpRaw = accJ?.account?.buyingPower
    if (bpRaw != null) { const n = Number(bpRaw); if (Number.isFinite(n) && n > 0) bpLeft = n }
    if (bpLeft == null && equity != null) bpLeft = equity // no BP field — degrade to equity
    const posJ = pos.j as { positions?: { symbol?: string; side?: string; qty?: number | string; uplPct?: number; source?: string; sources?: { source?: string }[] }[] } | null
    // POSITION symbols drop the crypto slash (BTCUSD) while ORDER/watchlist
    // symbols keep it (BTC/USD) — index BOTH spellings so a held BTC position
    // actually blocks a new BTC/USD entry (v2.12.23).
    for (const p of posJ?.positions ?? []) { const s = String(p.symbol ?? '').toUpperCase(); if (s) { openSyms.add(s); openSyms.add(s.replace('/', '')) } }
    // v2.12.44 — LIVE AI-managed position count: the cap's semantic is "max
    // concurrent positions opened by the auto trader", so it must count the
    // broker's live positions tagged source=ai — NOT the session's fired
    // bookkeeping, which never decrements when a position closes (TWST/ALAB
    // closed at 14:46 yet still counted at 17:44 → META gated with empty seats).
    const liveAiCount = posJ ? (posJ.positions ?? []).filter(isAiPosition).length : null
    if (equity == null) st0.addLog('warn', '取得帳戶權益失敗 — 候選即使達標也無法計算倉位')

    // 2.5) broker tradability probe — one batched call, server-cached 6h
    // (including 404s). tradable:false drops the symbol NOW (before bars / a
    // model call); shortable:false feeds the verdict gate — Alpaca spot
    // crypto cannot short, so a bearish BTC/USD verdict must die here, not
    // as a broker error. probeFailed/empty → degrade to the static filters.
    interface AssetProbe { tradable: boolean; shortable: boolean; assetClass: string }
    const assetMap = new Map<string, AssetProbe>()
    const noShort = new Set<string>()
    {
      const probe = await fetchJson(`/api/trading/assets?mode=${cfg.mode}&symbols=${encodeURIComponent(scanSyms.slice(0, 50).join(','))}`, { signal: sig })
        .catch(() => ({ status: 0, j: null as Record<string, unknown> | null }))
      const assets = (probe.j as { assets?: Record<string, AssetProbe> } | null)?.assets
      if (assets && typeof assets === 'object') {
        const brokerBlocked: { sym: string; label: string }[] = []
        // iterate what WE asked for — never trust extra keys a (mock/proxy)
        // response may carry for symbols already dropped upstream
        for (const sym of scanSyms) {
          const info = assets[sym]
          if (!info || typeof info !== 'object') continue
          assetMap.set(sym.toUpperCase(), info)
          if (info.tradable === false) {
            brokerBlocked.push({ sym: sym.toUpperCase(), label: info.assetClass === 'unknown' ? '非 Alpaca 資產' : info.assetClass })
            continue
          }
          if (info.shortable === false) noShort.add(sym.toUpperCase())
        }
        if (brokerBlocked.length > 0) {
          for (const { sym } of brokerBlocked) {
            const idx = scanSyms.indexOf(sym)
            if (idx >= 0) scanSyms.splice(idx, 1)
          }
          st0.addLog('info', `broker 不可交易 — 跳過：${brokerBlocked.map(({ sym, label }) => `${sym}（${label}）`).join('、')}`)
        }
      }
    }
    if (scanSyms.length === 0) {
      st0.addLog('warn', '本輪沒有可評估標的（全部不可交易、冷卻中或被排除）。')
      return
    }

    // 2.6) v2.12.32 — WIN-RATE CONTEXT PACK. The model used to judge each
    // symbol from its own bars alone: no idea what the broader tape is doing,
    // whether earnings land tomorrow, how its OWN recent calls performed, or
    // where the tested S/R walls sit. Those blind spots are the classic
    // win-rate killers — counter-trend longs in RISK_OFF, entries 1 day
    // before an earnings gap, stops inside structure, confidence never
    // calibrated against realized results. One batched round of best-effort
    // fetches; EVERY source fails open (missing → the line is omitted, the
    // scan never dies because a side-channel hiccups).
    interface EarningsInfo { daysAway: number | null; inBlock: boolean; known: boolean }
    const earningsBySym = new Map<string, EarningsInfo>()
    const w52BySym = new Map<string, { high: number | null; low: number | null }>()
    const sentBySym = new Map<string, { score: number; momentum: number | null; headlines: number }>()
    let regimeLine: string | null = null
    let regimeState: GateRegime = null
    let calendarLine: string | null = null
    let perfLine: string | null = null
    let holdingsLine: string | null = null
    let concLine: string | null = null
    let retroLine: string | null = null
    // holdings live OUTSIDE the fetch block — the concentration gate below
    // reuses them (declared here so its scope reaches section 5.5)
    const heldRaw: { symbol: string; side: 'long' | 'short'; qty: string; uplPct: number | null }[] = []
    {
      const normSym = (s: string) => s.replace('/', '').toUpperCase()
      const [regRes, calRes, senRes, eaRes, qRes, hRes, vRes] = await Promise.all([
        fetchJson('/api/agent/regime', { signal: sig }).catch(() => ({ status: 0, j: null })),
        fetchJson('/api/market/calendar', { signal: sig }).catch(() => ({ status: 0, j: null })),
        fetchJson('/api/sentiment?scope=market', { signal: sig }).catch(() => ({ status: 0, j: null })),
        fetchJson(`/api/market/earnings?symbols=${encodeURIComponent(scanSyms.slice(0, 30).join(','))}`, { signal: sig }).catch(() => ({ status: 0, j: null })),
        fetch('/api/market/quote', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: scanSyms.slice(0, 30) }), signal: sig,
        }).then((r) => r.json() as Promise<Record<string, unknown> | null>).catch(() => null),
        fetchJson(`/api/trading/history?mode=${cfg.mode}&limit=150`, { signal: sig }).catch(() => ({ status: 0, j: null })),
        // v2.12.33 — 24h reconciliation pass + resolved history for the
        // [覆盤統計] pack line (server-side; no due rows → cheap no-op)
        fetchJson('/api/ai-trade/verdicts?resolve=1&history=1', { signal: sig }).catch(() => ({ status: 0, j: null })),
      ])
      // regime — RISK_ON/NEUTRAL/RISK_OFF + why (server-cached 15 min)
      const reg = regRes.j as { regime?: string; stale?: boolean; reasons?: string[] } | null
      if (reg?.regime && reg.regime !== 'UNKNOWN') {
        regimeState = (reg.regime === 'RISK_ON' || reg.regime === 'RISK_OFF' || reg.regime === 'NEUTRAL') ? reg.regime : 'UNKNOWN'
        const why = (Array.isArray(reg.reasons) ? reg.reasons : []).slice(0, 2).join('；')
        regimeLine = `regime: ${reg.regime}${reg.stale ? '（資料過期）' : ''}${why ? ` — ${why}` : ''}`
      }
      // calendar — high-impact USD events within the next 48h (recent ones
      // count too). The feed degrades to bundled SAMPLE rows when both FF
      // mirrors fail — sample data must NEVER be fed to the model as real
      // events, so the line only renders when source is the live feed.
      const cal = calRes.j as { events?: { time: string; country: string; importance: string; event: string }[]; source?: string } | null
      {
        const now = Date.now()
        const soon = cal?.source === 'forexfactory'
          ? (cal?.events ?? [])
            .filter((e) => e && e.importance === 'high' && e.country === 'USD')
            .map((e) => ({ e, t: Date.parse(e.time) }))
            .filter(({ t }) => Number.isFinite(t) && t > now - 2 * 3600_000 && t < now + 48 * 3600_000)
            .sort((a, b) => a.t - b.t)
            .slice(0, 4)
          : []
        if (soon.length > 0) {
          calendarLine = `48h 高影響事件：${soon.map(({ e, t }) => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC ${e.event}` }).join(' · ')}`
        }
      }
      // sentiment — only where the news engine actually covers a scan symbol
      const sen = senRes.j as { summary?: { symbol?: string; score?: number; momentum?: number | null; headlines?: number }[] } | null
      for (const s of sen?.summary ?? []) {
        if (!s || typeof s.symbol !== 'string' || typeof s.score !== 'number') continue
        const key = normSym(s.symbol)
        if (!scanSyms.some((x) => normSym(x) === key)) continue
        sentBySym.set(key, { score: s.score, momentum: typeof s.momentum === 'number' ? s.momentum : null, headlines: Number(s.headlines) || 0 })
      }
      // earnings — days away + hard-block flag (fail-open)
      const ea = eaRes.j as { events?: Record<string, EarningsInfo> } | null
      if (ea?.events && typeof ea.events === 'object') {
        for (const [sym, ev] of Object.entries(ea.events)) {
          if (ev && typeof ev === 'object') earningsBySym.set(sym.toUpperCase(), { daysAway: ev.daysAway ?? null, inBlock: Boolean(ev.inBlock), known: Boolean(ev.known) })
        }
      }
      // 52-week range — breakout vs mean-reversion context (30-min cached)
      const q = qRes as { quotes?: { symbol?: string; weekHigh?: number; weekLow?: number }[] } | null
      for (const it of q?.quotes ?? []) {
        if (!it || typeof it.symbol !== 'string') continue
        const hi = Number(it.weekHigh)
        const lo = Number(it.weekLow)
        w52BySym.set(normSym(it.symbol), { high: Number.isFinite(hi) && hi > 0 ? hi : null, low: Number.isFinite(lo) && lo > 0 ? lo : null })
      }
      // recent performance — the engine's OWN realized results (calibration)
      const hist = hRes.j as { trades?: { pnl?: number; side?: string }[] } | null
      const trades = (Array.isArray(hist?.trades) ? hist.trades : [])
        .filter((t) => t && Number.isFinite(Number(t.pnl)))
        .map((t) => ({ pnl: Number(t.pnl), side: t.side === 'short' ? 'short' : 'long' }))
      if (trades.length > 0) {
        const ts = trades.slice(0, 100)
        const wins = ts.filter((t) => t.pnl > 0)
        const losses = ts.filter((t) => t.pnl <= 0)
        const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0
        const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0
        const grossWin = wins.reduce((a, t) => a + t.pnl, 0)
        const grossLoss = losses.reduce((a, t) => a + Math.abs(t.pnl), 0)
        const pf = grossLoss > 0 ? grossWin / grossLoss : null
        let streak: string | null = null
        if (ts.length > 0) {
          const win0 = ts[0].pnl > 0
          let n = 0
          for (const t of ts) { if ((t.pnl > 0) === win0) n++; else break }
          streak = `${win0 ? 'W' : 'L'}${n}`
        }
        const wr = (xs: typeof ts) => (xs.length ? Math.round((xs.filter((t) => t.pnl > 0).length / xs.length) * 100) : null)
        const longs = ts.filter((t) => t.side === 'long')
        const shorts = ts.filter((t) => t.side === 'short')
        perfLine = `近 ${ts.length} 筆已平倉：勝率 ${Math.round((wins.length / ts.length) * 100)}% · 平均獲利 $${avgWin.toFixed(0)} / 平均虧損 $${avgLoss.toFixed(0)} · 盈虧比 ${pf == null ? 'n/a' : pf.toFixed(2)} · 目前連續 ${streak ?? 'n/a'} · 做多勝率 ${wr(longs) == null ? 'n/a' : `${wr(longs)}%`} · 做空勝率 ${wr(shorts) == null ? 'n/a' : `${wr(shorts)}%`}`
      }
      // current holdings — correlation-aware entries
      for (const p of (posJ?.positions ?? [])) {
        if (typeof p.symbol !== 'string' || !p.symbol) continue
        heldRaw.push({
          symbol: String(p.symbol).replace('/', '').toUpperCase(),
          side: p.side === 'short' ? 'short' : 'long',
          qty: String(p.qty ?? ''),
          uplPct: typeof p.uplPct === 'number' ? p.uplPct : null,
        })
      }
      if (heldRaw.length > 0) holdingsLine = heldRaw.map((h) => `${h.symbol} ${h.side === 'short' ? '空' : '多'} ${h.qty}${h.uplPct != null ? `（${h.uplPct >= 0 ? '+' : ''}${h.uplPct.toFixed(1)}%）` : ''}`).join(' · ')
      // v2.12.33 — holdings↔holdings price correlation (concentration
      // context for the model; the candidate gate fetches its own matrix
      // below, only when a candidate survives the numeric gates)
      if (heldRaw.length >= 2 && cfg.blockConcentration) {
        try {
          const corr = await fetchJson(`/api/market/correlation?symbols=${encodeURIComponent(heldRaw.slice(0, 8).map((h) => h.symbol).join(','))}`, { signal: sig })
          const mx = (corr.j as { matrix?: Record<string, Record<string, number>>; source?: string } | null)?.matrix
          if (mx && (corr.j as { source?: string }).source === 'real') {
            const pairs: { a: string; b: string; r: number }[] = []
            for (let x = 0; x < heldRaw.length; x++) for (let y = x + 1; y < heldRaw.length; y++) {
              const r = mx[heldRaw[x].symbol]?.[heldRaw[y].symbol]
              if (typeof r === 'number' && Number.isFinite(r)) pairs.push({ a: heldRaw[x].symbol, b: heldRaw[y].symbol, r })
            }
            pairs.sort((p, q) => q.r - p.r)
            if (pairs.length > 0) {
              concLine = `持倉相關性：${pairs.slice(0, 3).map((p) => `${p.a}↔${p.b} r=${p.r.toFixed(2)}${p.r >= 0.85 ? ' ⚠' : ''}`).join(' · ')}`
            }
          }
        } catch { /* correlation context is best-effort */ }
      }
      // v2.12.33 — 覆盤統計 from the resolved verdict ledger (24h mark-to-market)
      {
        const hist = vRes.j as { resolved?: number; lessonsWritten?: number; history?: { symbol: string; direction: string; confidence: number; regime: string | null; status: string; outcome: string | null; pnlPct: number | null }[] } | null
        const histRows = Array.isArray(hist?.history) ? hist.history : []
        const resolvedNow = typeof hist?.resolved === 'number' ? hist.resolved : 0
        if (histRows.length > 0) {
          const wins = histRows.filter((r) => r.outcome === 'win').length
          const losses = histRows.filter((r) => r.outcome === 'loss').length
          const decided = wins + losses
          const avgPnl = histRows.filter((r) => typeof r.pnlPct === 'number')
          const avg = avgPnl.length ? avgPnl.reduce((a, r) => a + (r.pnlPct ?? 0), 0) / avgPnl.length : null
          // regime×direction buckets (≥3 samples only)
          const buckets = new Map<string, { n: number; w: number }>()
          for (const r of histRows) {
            if (!r.regime || r.outcome === 'flat') continue
            const key = `${r.regime} ${r.direction === 'short' ? '做空' : '做多'}`
            const b = buckets.get(key) ?? { n: 0, w: 0 }
            b.n++
            if (r.outcome === 'win') b.w++
            buckets.set(key, b)
          }
          const top = [...buckets.entries()].filter(([, b]) => b.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 3)
          retroLine = `近 ${histRows.length} 筆已對帳${decided > 0 ? `（贏 ${wins} / 輸 ${losses}，勝率 ${Math.round((wins / decided) * 100)}%）` : ''}${avg != null ? ` · 平均 24h ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%` : ''}${top.length > 0 ? ` · ${top.map(([k, b]) => `${k} ${b.w}/${b.n} 勝`).join(' · ')}` : ''}`
          if (resolvedNow > 0) { const lw = typeof hist?.lessonsWritten === 'number' ? hist.lessonsWritten : 0; st0.addLog('info', `覆盤對帳 — ${resolvedNow} 筆 24h 前的判斷已歸檔${lw > 0 ? `，寫入永久教訓 ${lw} 條` : ''}`) }
        }
      }
    }
    // per-symbol context lines appended to every snapshot
    const snapshotExtras = (sym: string, lastClose: number): string => {
      const lines: string[] = []
      const key = sym.replace('/', '').toUpperCase()
      // v2.12.34 — auto-watchlist credentials: rank + the liquidity/volatility
      // profile that earned it, so the model knows it is trading an active,
      // tradeable name (and how wide its stops must breathe)
      const pk = pickBySym.get(key)
      if (pk) {
        const parts = [`選股 #${pk.rank ?? '?'}/${pickBySym.size}`]
        if (pk.atrPct != null) parts.push(`ATR14 ${pk.atrPct.toFixed(1)}%`)
        if (pk.relVol != null) parts.push(`量比 ${pk.relVol.toFixed(1)}×`)
        if (pk.dollarVol != null) parts.push(`額 $${fmtM(pk.dollarVol)}`)
        if (pk.chgPct != null) parts.push(`日 ${pk.chgPct >= 0 ? '+' : ''}${pk.chgPct.toFixed(1)}%`)
        if (pk.kind) parts.push(pk.kind === 'etf' ? 'ETF' : '股票')
        lines.push(parts.join(' · '))
      }
      const ea = earningsBySym.get(key)
      if (ea) {
        if (ea.known && ea.daysAway != null) lines.push(ea.inBlock ? `earnings: 財報臨近（block，${ea.daysAway} 天後）` : `earnings: ${ea.daysAway} 天後`)
        else if (!ea.known) lines.push('earnings: 日期未知（加密或無資料）')
      }
      const w = w52BySym.get(key)
      if (w && w.high != null && w.low != null && lastClose > 0) {
        const fromHigh = ((lastClose - w.high) / w.high) * 100
        const fromLow = ((lastClose - w.low) / w.low) * 100
        lines.push(`52w range: 距高 ${fromHigh.toFixed(1)}% / 距低 ${fromLow >= 0 ? '+' : ''}${fromLow.toFixed(1)}%`)
      }
      const s = sentBySym.get(key)
      if (s) lines.push(`news sentiment: ${s.score >= 0 ? '+' : ''}${s.score.toFixed(2)}${s.momentum != null ? ` (momentum ${s.momentum >= 0 ? '+' : ''}${s.momentum.toFixed(2)})` : ''} · ${s.headlines} 則`)
      return lines.length ? `\n${lines.join(' · ')}` : ''
    }
    // the shared block rides EVERY model call (identical across chunks)
    const contextPack = [
      regimeLine ? `[市場環境] ${regimeLine}` : null,
      calendarLine ? `[事件] ${calendarLine}` : null,
      perfLine ? `[近期表現（本引擎真實成績 — 校準 confidence 用）] ${perfLine}` : null,
      retroLine ? `[覆盤統計（24h 標記對帳）] ${retroLine}` : null,
      concLine ? `[集中風險] ${concLine}` : null,
      holdingsLine ? `[目前持倉] ${holdingsLine}` : '[目前持倉] 無',
      poolNote ? `[選股池] ${poolNote} · 標準 ATR波動40%+成交額30%+量比15%+日內振幅15%（橫斷面百分位）— 全宇宙流動性+波動候選，非投資建議` : null,
    ].filter(Boolean).join('\n')
    if (regimeLine) st0.addLog('info', `市場環境 — ${regimeLine}`)
    if (calendarLine) st0.addLog('info', `事件 — ${calendarLine}`)
    if (perfLine) st0.addLog('info', `近期表現 — ${perfLine}`)
    {
      const blockedSyms = scanSyms.filter((s) => earningsBySym.get(s.replace('/', '').toUpperCase())?.inBlock)
      if (blockedSyms.length > 0) st0.addLog('info', `財報窗口 — 本輪禁止開倉：${blockedSyms.join('、')}`)
    }

    // 3) bars → snapshots (concurrency 3, demo-flagged kept but marked)
    interface Snap { symbol: string; text: string; demo: boolean; lastClose: number }
    const snaps: Snap[] = []
    const skipped: string[] = []
    for (const group of chunk(scanSyms, 3)) {
      const settled = await Promise.allSettled(
        group.map(async (sym): Promise<Snap | null> => {
          const { j } = await fetchJson(`/api/market/bars?symbol=${encodeURIComponent(sym)}&tf=${cfg.timeframe}`, { signal: sig })
          const bars = (j?.bars ?? []) as { close: number; high: number; low: number; open: number; volume: number; time: number }[]
          if (!Array.isArray(bars) || bars.length < 30) { skipped.push(sym); return null }
          const meta = (j?.meta ?? {}) as { demo?: boolean }
          const snap = buildChartSnapshot(bars as never, sym, cfg.timeframe, bars[bars.length - 1].close)
          return { symbol: sym, text: snapshotToText(snap) + snapshotExtras(sym, snap.lastClose), demo: Boolean(meta.demo), lastClose: snap.lastClose }
        }),
      )
      for (const r of settled) if (r.status === 'fulfilled' && r.value) snaps.push(r.value)
    }
    if (skipped.length > 0) st0.addLog('warn', `K線不足或取得失敗（≥30 根才評估）：${skipped.join('、')}`)
    if (snaps.length === 0) {
      st0.addLog('warn', '本輪無可用K線 — 未呼叫模型。')
      return
    }

    // 4) batched verdict calls — 6 enriched snapshots + the shared context
    //    pack per call (keeps the DATA block inside the route's 8k context
    //    clamp), up to 2 calls in flight; a failed chunk degrades honestly:
    //    its symbols report 評估失敗.
    //    v2.12.35 — a 50-symbol pool means ~9 model calls in quick succession;
    //    a single 429/timeout/parse hiccup used to cost SIX symbols their
    //    evaluation with NO second chance. Each chunk now retries twice with
    //    backoff (3s → 8s) before it is allowed to fail, and symbols the
    //    model silently skipped inside a SUCCESSFUL reply (漏答) are named
    //    in the log instead of failing anonymously.
    const groups = chunk(snaps, SCAN_CHUNK)
    const bySym = new Map<string, Partial<Record<'symbol' | 'direction' | 'confidence' | 'entry' | 'stop' | 'target' | 'reason', unknown>>>()
    const answered = new Set<string>()
    const CHUNK_ATTEMPTS = 3
    const CHUNK_BACKOFF_MS = [3_000, 8_000]
    const sleepAbortable = (ms: number) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      sig.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
    const callChunk = async (grp: Snap[]): Promise<void> => {
      // v2.12.38 — per-direction EFFECTIVE gates (base + regime surcharge),
      // computed at call time so the prompt quotes exactly what the terminal
      // will enforce for the current regime.
      const dynGate = (dir: 'long' | 'short') => cfg.dynamicThresholds
        ? regimeDynamicThresholds(base.minConfidence, base.minRR, regimeState, dir)
        : { minConfidence: base.minConfidence, minRR: base.minRR }
      const longGate = dynGate('long')
      const shortGate = dynGate('short')
      const dataBlock = (contextPack ? `${contextPack}\n\n` : '') + grp.map((s) => s.text + (s.demo ? '\n(note: DEMO bars — synthetic sample data)' : '')).join('\n\n')
      const res = await fetch('/api/ai-trade/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: useReact
            ? scanInstructionPlans(grp.length, longGate, shortGate)
            : scanInstruction(grp.length, base.minConfidence, base.minRR) }] as AiChatMsg[],
          context: dataBlock,
          maxTokens: useReact ? Math.min(2400, 240 * grp.length + 400) : Math.min(2000, 200 * grp.length + 300),
        }),
        signal: sig,
      })
      const j = await res.json().catch(() => null) as { ok?: boolean; content?: string; error?: string } | null
      if (!res.ok || !j?.ok || typeof j.content !== 'string') throw new Error(j?.error || `HTTP ${res.status}`)
      const raw = parseJsonArray(j.content)
      if (!raw) throw new Error('模型回覆無法解析為 JSON 陣列')
      for (const it of raw) {
        if (it && typeof it === 'object') {
          const s = String((it as Record<string, unknown>).symbol ?? '').toUpperCase()
          if (s) { bySym.set(s, it as Record<string, unknown>); answered.add(s) }
        }
      }
    }
    const evalChunkWithRetry = async (grp: Snap[]): Promise<void> => {
      let lastErr: unknown = null
      for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          st0.addLog('warn', `評估組重試（${attempt}/${CHUNK_ATTEMPTS - 1}）— ${lastErr instanceof Error ? lastErr.message : String(lastErr)} · ${grp.map((s) => s.symbol).join('、')}`)
          await sleepAbortable(CHUNK_BACKOFF_MS[Math.min(attempt - 1, CHUNK_BACKOFF_MS.length - 1)])
        }
        try {
          await callChunk(grp)
          return
        } catch (e) {
          lastErr = e
          if (sig.aborted) throw e
        }
      }
      throw lastErr
    }
    let okChunks = 0
    let failChunks = 0
    const failedSyms = new Set<string>()
    for (const pair of chunk(groups, 2)) {
      const settled = await Promise.allSettled(pair.map((grp) => evalChunkWithRetry(grp)))
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]
        if (r.status === 'fulfilled') okChunks++
        else {
          failChunks++
          for (const s of pair[i]) failedSyms.add(s.symbol)
          st0.addLog('warn', `評估組失敗 — ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
      }
    }
    if (okChunks === 0) {
      st0.addLog('error', '模型評估全部失敗 — 本輪放棄（不猜測）。')
      return
    }
    if (failChunks > 0) st0.addLog('warn', `部分評估組失敗（${failChunks}/${okChunks + failChunks} 組）— 相關標的記為「評估失敗」`)
    const missedSyms = snaps.filter((s) => !failedSyms.has(s.symbol) && !answered.has(s.symbol)).map((s) => s.symbol)
    if (missedSyms.length > 0) st0.addLog('warn', `模型漏答 ${missedSyms.length} 標的（回覆中缺少對應項目）— 記為「評估失敗」：${missedSyms.join('、')}`)

    // 5) parse + validate (geometry checked HERE, not trusted from the model)
    let passCount = 0
    let fireCount = 0
    const verdicts: AiAutoVerdict[] = snaps.map((snap) => {
      const it = bySym.get(snap.symbol)
      const direction: AiAutoDirection = it?.direction === 'long' || it?.direction === 'short' ? it.direction : 'flat'
      const confidence = clampN(Math.round(num(it?.confidence, 0)), 0, 100)
      const entry = it?.entry != null && Number.isFinite(Number(it.entry)) && Number(it.entry) > 0 ? Number(it.entry) : null
      const stop = it?.stop != null && Number.isFinite(Number(it.stop)) && Number(it.stop) > 0 ? Number(it.stop) : null
      const target = it?.target != null && Number.isFinite(Number(it.target)) && Number(it.target) > 0 ? Number(it.target) : null
      const reason = String(it?.reason ?? '').slice(0, 80)

      const v: AiAutoVerdict = { symbol: snap.symbol, direction, confidence, entry, stop, target, rr: null, reason, demoBars: snap.demo, passed: false, rejectReason: null, dryRunNote: null, refPrice: snap.lastClose }

      if (!it) { v.rejectReason = AI_EVAL_FAIL_REASON; return v }
      if (direction === 'flat') { v.rejectReason = '模型判中性'; return v }
      // v2.12.32 — earnings gap-risk gate (DETERMINISTIC, not model-dependent):
      // an entry inside [report − 2d, report + 20h] owns the overnight
      // re-pricing with no stop that can protect it — the terminal refuses it
      // even if the model got excited. Fail-open when the date is unknown
      // (known:false → the map simply has no inBlock entry).
      if (cfg.blockEarnings) {
        const ea = earningsBySym.get(snap.symbol.replace('/', '').toUpperCase())
        if (ea?.inBlock) {
          v.rejectReason = `財報窗口（${ea.daysAway ?? '?'} 天後發布）— 跳空風險，禁止開新倉`
          return v
        }
      }
      // v2.12.37 — REACT MODE: the verdict becomes conditional PLANS instead
      // of a market-order command. Each side the model supplied is validated
      // HERE (geometry + trigger band + terminal R:R — never the model's
      // arithmetic), gated per side (dyn thresholds, shortability, holdings,
      // demo bars), and surviving plans go WAITING in the ledger — the
      // reactor executes only when the market actually confirms.
      if (useReact) {
        const plans: AiVerdictPlan[] = []
        for (const side of ['buy', 'sell'] as const) {
          const raw = reactPlanFromItem(it, side)
          if (!raw) continue
          const geo = validatePlanSide(side, snap.lastClose, raw.trigger, raw.tp, raw.sl)
          const reject = (note: string) => plans.push({ side, trigger: raw.trigger, tp: raw.tp, sl: raw.sl, rr: geo.rr ?? 0, status: 'rejected', note })
          if (!geo.ok || geo.rr == null) { reject(geo.reason ?? '計劃未通過驗證'); continue }
          // v2.12.40 — Alpaca spot crypto cannot be shorted: a sell plan the
          // broker can NEVER take dies here with the honest reason, before any
          // numeric gate dresses it up. The asset probe that feeds noShort is
          // transient (auth breaker) and windowed (first N symbols), so the
          // static slash test backs it up — Plan your trade, but never plan a
          // trade the broker physically cannot fill.
          if (side === 'sell' && isSpotCryptoSymbol(snap.symbol)) { reject(CRYPTO_NO_SHORT_NOTE); continue }
          // v2.12.38 — mode-aware base gates (react: 45/1.5, instant: 60/7),
          // then the regime-dynamic surcharge applies on top as before.
          const dyn = cfg.dynamicThresholds
            ? regimeDynamicThresholds(base.minConfidence, base.minRR, regimeState, side === 'buy' ? 'long' : 'short')
            : { minConfidence: base.minConfidence, minRR: base.minRR }
          if (confidence < dyn.minConfidence) { reject(`信心未達 ${dyn.minConfidence}%`); continue }
          // v2.12.38 — R:R gate + GEOMETRY REPAIR. The model's trigger and
          // structural SL stand; a TP that falls short of the floor is
          // replaced by the mechanical R-multiple target (capped, honestly
          // tagged) instead of silently killing the plan — the discipline
          // lives in code, not in an 8B planner's arithmetic.
          if (geo.rr < dyn.minRR) {
            const fix = repairPlanTp(side, raw.trigger, raw.sl, dyn.minRR)
            if (fix) {
              raw.tp = fix.tp
              plans.push({ side, trigger: raw.trigger, tp: raw.tp, sl: raw.sl, rr: fix.rr, status: 'created', note: null, repaired: true })
              continue
            }
            reject(`R:R ${geo.rr.toFixed(2)} 未達 1:${dyn.minRR}（修復後仍超界 — 風險距離過寬）`)
            continue
          }
          if (side === 'sell' && noShort.has(snap.symbol)) { reject(`該標的不可做空${assetMap.get(snap.symbol)?.assetClass === 'crypto' ? '（現貨加密）' : ''}`); continue }
          if (openSyms.has(snap.symbol) || openSyms.has(snap.symbol.replace('/', ''))) { reject('已有該標的持倉'); continue }
          if (snap.demo) { reject('⚠示範K線 — 非真實行情'); continue }
          plans.push({ side, trigger: raw.trigger, tp: raw.tp, sl: raw.sl, rr: geo.rr, status: 'created', note: null })
        }
        v.plans = plans
        const created = plans.filter((p) => p.status === 'created')
        if (created.length === 0) {
          v.rejectReason = plans.length > 0 ? (plans[0].note ?? '計劃未通過驗證') : '模型未給有效計劃（數字缺失）'
          return v
        }
        // ledger levels = the bias-side plan (falls back to the first created)
        // so the 24h reconciliation keeps measuring the CALL's quality
        const primary = created.find((p) => p.side === (direction === 'long' ? 'buy' : 'sell')) ?? created[0]
        v.entry = primary.trigger
        v.stop = primary.sl
        v.target = primary.tp
        v.rr = primary.rr
        v.passed = true
        v.verdictStatus = 'dry-run' // evaluated, NOT ordered — ordering waits for the market
        passCount++
        return v
      }
      // geometry: long stop<entry<target / short target<entry<stop
      const geoOk = entry != null && stop != null && target != null && (
        direction === 'long' ? stop < entry && entry < target : target < entry && entry < stop
      )
      if (!geoOk) { v.rejectReason = '停損/目標方位不合理'; return v }
      // v2.12.23 — non-shortable assets (Alpaca spot crypto): reject the
      // SHORT verdict here instead of sending a SELL the broker refuses.
      // v2.12.40 — the probe is transient + windowed, so the static slash
      // test (crypto display spelling carries '/') backs it up.
      if (direction === 'short' && (noShort.has(snap.symbol) || isSpotCryptoSymbol(snap.symbol))) {
        v.rejectReason = isSpotCryptoSymbol(snap.symbol)
          ? `${CRYPTO_NO_SHORT_NOTE} — 偏空訊號跳過`
          : `該標的不可做空${assetMap.get(snap.symbol)?.assetClass === 'crypto' ? '（現貨加密）' : ''} — 偏空訊號跳過`
        return v
      }
      if (Math.abs(entry - snap.lastClose) / snap.lastClose > 0.05) { v.rejectReason = '進場價偏離現價 >5%'; return v }
      // terminal-computed R:R (fill assumed ≈ live close)
      const rr = Math.abs(target - snap.lastClose) / Math.abs(snap.lastClose - stop)
      v.rr = Number.isFinite(rr) && rr > 0 ? rr : null
      if (v.rr == null) { v.rejectReason = 'R:R 無法計算'; return v }

      // v2.12.33 — REGIME-DYNAMIC thresholds: the base config values are what
      // a NEUTRAL tape demands; the against-the-wind direction pays more
      // (RISK_OFF longs / RISK_ON shorts: +10 confidence, ×1.25 R:R) because
      // counter-trend entries into a hostile tape are the classic win-rate
      // killer. Toggleable — off = the raw config thresholds.
      const dyn = cfg.dynamicThresholds
        ? regimeDynamicThresholds(base.minConfidence, base.minRR, regimeState, direction)
        : { minConfidence: base.minConfidence, minRR: base.minRR, note: null }
      const effMinConf = dyn.minConfidence
      const effMinRR = dyn.minRR
      const dynNote = dyn.note

      const confOk = confidence >= effMinConf
      const rrOk = v.rr >= effMinRR
      if (!confOk && !rrOk) v.rejectReason = `信心與 R:R 均未達門檻${dynNote ? `（動態：${dynNote}）` : ''}`
      else if (!confOk) v.rejectReason = `信心未達 ${effMinConf}%${dynNote ? `（動態：${dynNote}）` : ''}`
      else if (!rrOk) v.rejectReason = `R:R 未達 1:${effMinRR}${dynNote ? `（動態：${dynNote}）` : ''}`
      if (!confOk || !rrOk) return v

      // passed the numeric gate — execution checks
      if (openSyms.has(snap.symbol) || openSyms.has(snap.symbol.replace('/', ''))) { v.rejectReason = '已有該標的持倉'; return v }
      // v2.12.44 — cap counts live AI positions (fetch failed → old fired
      // bookkeeping as the conservative fallback); + fireCount for orders this
      // round that just became live positions.
      const openAuto = (liveAiCount ?? st0.fired.length) + fireCount
      if (openAuto >= cfg.maxOpenAuto) { v.rejectReason = `達自動倉上限（${openAuto}/${cfg.maxOpenAuto} 個 AI 持倉）`; return v }
      // v2.12.23 — demo bars are evaluation-only: firing an order on
      // synthetic data (upstream rate-limited → generated fallback) would
      // trade a market that does not exist. The verdict still shows the
      // direction/confidence with an honest reject reason.
      if (snap.demo) { v.rejectReason = '⚠示範K線 — 非真實行情，僅評估不下單'; return v }
      v.passed = true
      passCount++
      return v
    })

    // 5.5) v2.12.33 — CONCENTRATION GATE (deterministic): a candidate that
    // correlates ≥ 0.85 with a same-direction holding is the same trade in
    // disguise; and same-direction stacking beyond maxCorrelated is refused
    // even without correlation data (count rule). ONE correlation fetch for
    // all surviving candidates × holdings (cached 30min server-side); sim
    // data fails open for the correlation rule (the count rule stands).
    if (cfg.blockConcentration && verdicts.some((v) => v.passed) && heldRaw.length > 0) {
      try {
        const cands = verdicts.filter((v) => v.passed)
        const syms = [...new Set([...cands.map((v) => v.symbol.replace('/', '').toUpperCase()), ...heldRaw.slice(0, 8).map((h) => h.symbol)])].slice(0, 8)
        const corr = await fetchJson(`/api/market/correlation?symbols=${encodeURIComponent(syms.join(','))}`, { signal: sig })
        const mx = (corr.j as { matrix?: Record<string, Record<string, number>>; source?: string } | null)?.matrix
        for (const v of cands) {
          const csym = v.symbol.replace('/', '').toUpperCase()
          const cdir = v.direction as 'long' | 'short'
          const sameDir = heldRaw.filter((h) => h.side === cdir).map((h) => ({
            symbol: h.symbol,
            r: mx && mx[csym] && typeof mx[csym][h.symbol] === 'number' ? mx[csym][h.symbol] : null,
          }))
          const chk = concentrationCheck(csym, cdir, sameDir, cfg.maxCorrelated)
          if (chk.blocked) {
            // react mode: reject only the matching SIDE's plan, not the
            // whole verdict — the other side (if any) may still be valid
            if (useReact && v.plans) {
              const pl = v.plans.find((x) => x.side === (cdir === 'long' ? 'buy' : 'sell') && x.status === 'created')
              if (pl) { pl.status = 'rejected'; pl.note = chk.note }
              if (!v.plans.some((x) => x.status === 'created')) {
                v.passed = false
                v.rejectReason = chk.note
                passCount--
              }
            } else {
              v.passed = false
              v.rejectReason = chk.note
              passCount--
            }
            st0.addLog('info', `${v.symbol} — ${chk.note}`)
          }
        }
      } catch { /* concentration check must never fail the scan */ }
    }

    useAiAutoStore.setState({ verdicts })
    const shortSkips = verdicts.filter((v) => v.rejectReason?.includes('不可做空')).length
    if (shortSkips > 0) st0.addLog('warn', `${shortSkips} 個偏空訊號被跳過 — 標的不可做空（現貨加密僅能做多）`)
    const demoSkips = verdicts.filter((v) => v.rejectReason?.includes('示範K線')).length
    if (demoSkips > 0) st0.addLog('warn', `示範K線 — ${demoSkips} 個訊號僅評估不下單（非真實行情）`)

    // 6) v2.12.37 — react mode: persist the WAITING plans + arm the reactor
    //    (NO orders here — ordering is the reactor's job when the market
    //    confirms). instant mode: fire the passes unchanged below.
    let plansCreated = 0
    let createdBuy = 0
    let createdSell = 0
    if (useReact) {
      const payload = verdicts.flatMap((v) => (v.plans ?? [])
        .filter((p) => p.status === 'created')
        .map((p) => ({
          symbol: v.symbol,
          side: p.side,
          bias: v.direction,
          confidence: v.confidence,
          trigger: p.trigger,
          tp: p.tp,
          sl: p.sl,
          rr: p.rr,
          refPrice: v.refPrice ?? 0,
          reason: v.reason,
          regime: regimeState,
          earnings: (() => { const ea = earningsBySym.get(v.symbol.replace('/', '').toUpperCase()); return ea ? (ea.inBlock ? 'block' : ea.known && ea.daysAway != null ? String(Math.min(ea.daysAway, 999)) : 'unknown') : null })(),
          mode: cfg.mode,
        })))
      if (payload.length > 0) {
        const post = await fetchJson('/api/ai-trade/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plans: payload }),
          signal: sig,
        }).catch(() => ({ status: 0, j: null as Record<string, unknown> | null }))
        if (post.status === 200) {
          plansCreated = payload.length
          createdBuy = payload.filter((p) => p.side === 'buy').length
          createdSell = payload.length - createdBuy
          await hydratePlans(sig)
          st0.addLog('info', `計劃已建立 ${plansCreated} 筆（▲buy ${createdBuy} / ▼sell ${createdSell}）— React 反應器監控市場，確認觸發才跟進`)
          for (const v of verdicts) {
            for (const p of v.plans ?? []) {
              if (p.status !== 'created') continue
              const dist = v.refPrice ? ((p.trigger - v.refPrice) / v.refPrice) * 100 : 0
              st0.addLog('info', `${v.symbol} ${p.side === 'buy' ? '▲buy' : '▼sell'} 觸發 ${p.trigger} · TP ${p.tp} / SL ${p.sl}（R:R 1:${p.rr.toFixed(1)} · 距現價 ${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%${p.repaired ? ' · TP 終端重推' : ''}）`)
            }
          }
          if (!cfg.enabled) st0.addLog('info', '自動交易開關未開 — 計劃保留，開啟後反應器開始監控')
        } else {
          st0.addLog('error', `計劃持久化失敗 HTTP ${post.status} — 本輪計劃未保存（不猜測）`)
          for (const v of verdicts) {
            if (v.plans?.some((p) => p.status === 'created')) {
              v.passed = false
              v.rejectReason = '計劃保存失敗'
              passCount--
            }
          }
        }
      }
    }
    // fire the passes (sizing by confidence → bracket order) — instant mode only
    for (const v of verdicts) {
      if (useReact || !v.passed) continue
      st0.addLog('success', `${v.symbol} 達標 — ${dirLabel(v.direction)} · 信心 ${v.confidence}% · R:R 1:${v.rr?.toFixed(1)}${v.demoBars ? ' · ⚠示範K線' : ''}`)
      if (equity == null) { v.passed = false; v.rejectReason = '無帳戶權益 — 無法計算倉位'; continue }
      const price = v.entry!
      const riskAmt = equity * (cfg.riskPct / 100) * (v.confidence / 100)
      const perRisk = Math.abs(price - v.stop!)
      let qty = perRisk > 0 ? Math.floor((riskAmt / perRisk) * 1e4) / 1e4 : 0
      const maxNotional = equity * 0.5
      if (qty * price > maxNotional) qty = Math.floor((maxNotional / price) * 1e4) / 1e4
      // v2.12.25 — spend only what THIS round still has: earlier fires in the
      // same scan already committed their cost against buying power
      if (bpLeft != null && qty * price > bpLeft) {
        const scaled = Math.floor((bpLeft / price) * 1e4) / 1e4
        if (scaled <= 0 || scaled * price < 1) {
          v.passed = false
          v.rejectReason = `Buying power 不足（餘 $${bpLeft.toFixed(2)}）— 無法建立倉位`
          st0.addLog('warn', `${v.symbol} 跳過 — ${v.rejectReason}`)
          continue
        }
        st0.addLog('info', `${v.symbol} 倉位縮減 — 本輪 buying power 餘 $${bpLeft.toFixed(2)}，qty ${qty} → ${scaled}`)
        qty = scaled
      }
      if (qty <= 0 || qty * price < 1) {
        v.passed = false
        v.rejectReason = `風險預算太小（$${riskAmt.toFixed(2)} ÷ $${perRisk.toFixed(2)}）無法形成倉位`
        st0.addLog('warn', `${v.symbol} 通過門檻但倉位過小 — ${v.rejectReason}`)
        continue
      }
      if (cfg.dryRun) {
        v.dryRunNote = `試運行：${v.direction === 'long' ? 'buy' : 'sell'} ${qty} @市價 · TP ${v.target} / SL ${v.stop}`
        st0.addLog('info', `${v.symbol} ${v.dryRunNote}（試運行 — 未送單）`)
        v.verdictStatus = 'dry-run'
        continue
      }
      const side = v.direction === 'long' ? 'buy' : 'sell'
      try {
        const { status, j } = await fetchJson('/api/trading/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: cfg.mode,
            symbol: v.symbol,
            side,
            qty,
            type: 'market',
            time_in_force: 'gtc',
            take_profit: v.target,
            stop_loss: v.stop,
            // v2.12.25 — attribute this entry to the AI Trade Adviser: the
            // `tta-` client_order_id makes Positions SOURCE + trade history
            // render it as AI instead of Manual
            sourceKind: 'ai',
          }),
          signal: sig,
        })
        const ok = status === 200 && Array.isArray((j as { orders?: unknown[] } | null)?.orders) && ((j as { orders: unknown[] }).orders.length > 0)
        if (ok) {
          fireCount++
          v.verdictStatus = 'fired'
          // v2.12.25 — commit this order's cost against the in-round budget
          if (bpLeft != null) bpLeft = Math.max(0, bpLeft - qty * price)
          const rec: AiAutoFired = { id: ++fireSeq, at: Date.now(), symbol: v.symbol, side, qty, price, stop: v.stop!, target: v.target!, confidence: v.confidence, rr: v.rr!, mode: cfg.mode }
          useAiAutoStore.setState((s) => ({ fired: [rec, ...s.fired].slice(0, 50) }))
          st0.addLog('success', `已下單 ${v.symbol} ${side} ${qty} @市價 · TL ${v.target} / SL ${v.stop}（信心 ${v.confidence}% · R:R 1:${v.rr?.toFixed(1)} · ${cfg.mode}）`)
        } else {
          v.passed = false
          v.rejectReason = String((j as { error?: string } | null)?.error || `下單失敗 HTTP ${status}`)
          st0.addLog('error', `${v.symbol} 下單失敗 — ${v.rejectReason}`)
          classifyOrderFailure(v.symbol, v.rejectReason)
        }
      } catch (e) {
        v.passed = false
        v.rejectReason = e instanceof DOMException && e.name === 'AbortError' ? '掃描被取消' : '下單連線失敗'
        st0.addLog('error', `${v.symbol} ${v.rejectReason}`)
        if (v.rejectReason !== '掃描被取消') classifyOrderFailure(v.symbol, v.rejectReason)
      }
    }

    // 6.5) v2.12.33 — POST-HOC ATTRIBUTION LEDGER: every NON-FLAT verdict is
    // persisted with the context it was decided under (regime, earnings,
    // fired/dry-run/gated + the gate note); the server reconciles them
    // against live quotes after 24h and distills 「自動交易覆盤」 lines into
    // the PERMANENT lesson memory — so "which evidence combinations actually
    // win" is fed back into every future review instead of evaporating.
    {
      const rows = verdicts
        .filter((v) => v.direction !== 'flat' && v.rejectReason !== AI_EVAL_FAIL_REASON)
        .map((v) => ({
          symbol: v.symbol,
          direction: v.direction as 'long' | 'short',
          confidence: v.confidence,
          entry: v.entry,
          stop: v.stop,
          target: v.target,
          rr: v.rr,
          regime: regimeState,
          earnings: (() => { const ea = earningsBySym.get(v.symbol.replace('/', '').toUpperCase()); return ea ? (ea.inBlock ? 'block' : ea.known && ea.daysAway != null ? String(Math.min(ea.daysAway, 999)) : 'unknown') : null })(),
          status: v.verdictStatus ?? 'gated',
          gateNote: v.rejectReason ?? (useReact && v.plans?.some((p) => p.status === 'created')
            ? `計劃 ${v.plans.filter((p) => p.status === 'created').map((p) => `${p.side === 'buy' ? '▲' : '▼'}${p.trigger}`).join(' ')}`
            : null),
        }))
      if (rows.length > 0) {
        void fetchJson('/api/ai-trade/verdicts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verdicts: rows }),
          signal: sig,
        }).catch(() => { /* the ledger is best-effort */ })
      }
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const flatCount = verdicts.filter((v) => v.direction === 'flat' && v.rejectReason !== AI_EVAL_FAIL_REASON).length
    const failCount = verdicts.filter((v) => v.rejectReason === AI_EVAL_FAIL_REASON).length
    st0.addLog('info', useReact
      ? `掃描完成 — 評估 ${verdicts.length} 標的 · 中性 ${flatCount} · 建計劃 ${plansCreated}${plansCreated ? `（▲${createdBuy}/▼${createdSell}）` : ''}${failCount > 0 ? ` · 評估失敗 ${failCount}` : ''}${cfg.dryRun ? '（試運行）' : ''} · 耗時 ${secs}s`
      : `掃描完成 — 評估 ${verdicts.length} 標的 · 中性 ${flatCount} · 達標 ${passCount} · 觸發 ${fireCount} 筆${failCount > 0 ? ` · 評估失敗 ${failCount}` : ''}${cfg.dryRun ? '（試運行）' : ''} · 耗時 ${secs}s`)
    // v2.12.35 — a no-fire round with a wall of neutrals is the engine
    // working as designed (win-rate first), not a malfunction. Say so once,
    // where the user is actually looking.
    if (fireCount === 0 && passCount === 0 && flatCount >= Math.max(3, Math.ceil(verdicts.length * 0.5))) {
      st0.addLog('info', '本輪無觸發 — 大多數標的證據不足判中性，屬預期行為（寧可錯過、不可做錯）；引擎只在證據充分且 R:R 達標時出手。')
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') st0.addLog('warn', '掃描已取消')
    else st0.addLog('error', `掃描異常 — ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    scanning = false
    scanAbort = null
    setScanning(false)
    const cur = useAiAutoStore.getState().config
    const ri = useAiAutoStore.getState().runnerInfo
    useAiAutoStore.setState({ lastScanAt: Date.now() })
    // v2.12.24 — re-arm only when the engine is supposed to run HERE: a
    // manual scan on a follower device (or with the toggle off) must never
    // start a second periodic loop behind the elected runner's back.
    if (cur.enabled && (!ri || ri.isMe)) armTimer(cur.intervalSec)
  }
}

// ---- v2.12.37 REACTOR — the 'React' in React > Respond > Review -------------
//
// A 20s loop (armed whenever the engine is enabled in react mode, on the
// elected runner browser only) that watches every WAITING plan's symbol:
//
//   REACT   — quote each symbol every tick; the market's move decides:
//   RESPOND — price rises through a buy trigger / falls through a sell
//             trigger → FOLLOW the plan: re-run the execution gates at
//             trigger time (holdings, max-open, earnings window, buying
//             power), then a market entry with the plan's TP/SL bracket.
//             Price breaches the plan's stop BEFORE the trigger → the plan
//             is INVALIDATED (market went against — stand aside, no order).
//   REVIEW  — 48h without resolution expires the plan; the ledger's 24h
//             review pass (plans?resolve=1) grades every dead plan
//             good-wait vs missed-run into the permanent lesson memory.

const REACT_TICK_MS = 20_000
const PLAN_TTL_MS = 48 * 3600_000
let reactTimer: ReturnType<typeof setInterval> | null = null
let reactBusy = false
let plansHydrated = false

const fmtPx = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4))

/** v2.12.44 — does this broker position belong to the AI auto trader?
 *  Multi-source inventory (an AI slice + an algo slice on one position) is
 *  AI's too — check the winner badge AND every source slice. */
function isAiPosition(p: { source?: string; sources?: { source?: string }[] }): boolean {
  return p.source === 'ai' || (Array.isArray(p.sources) && p.sources.some((s) => s.source === 'ai'))
}

/** v2.12.37 — extract one side's plan numbers from a react-mode model item.
 *  Flat fields preferred (buyTrigger/buyTp/buySl); a nested {"buy":{...}}
 *  object is tolerated. Any number missing/≤0 → no plan for that side. */
function reactPlanFromItem(it: Record<string, unknown>, side: 'buy' | 'sell'): { trigger: number; tp: number; sl: number } | null {
  const pick = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0 }
  const nested = (it[side] ?? null)
  const src = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : it
  const trigger = pick(src[side === 'buy' ? 'buyTrigger' : 'sellTrigger'] ?? src['trigger'])
  const tp = pick(src[side === 'buy' ? 'buyTp' : 'sellTp'] ?? src['tp'])
  const sl = pick(src[side === 'buy' ? 'buySl' : 'sellSl'] ?? src['sl'])
  if (!trigger || !tp || !sl) return null
  return { trigger, tp, sl }
}

/** Adopt every WAITING plan this account owns (real server ids — the PATCH
 *  transitions need them). Called when the reactor arms, right after a scan
 *  posts fresh plans, and once per tick until it succeeds. Session-closed
 *  plans (EXECUTED/…) are kept for the panel's lifecycle view. */
async function hydratePlans(sig?: AbortSignal): Promise<void> {
  try {
    const { j } = await fetchJson('/api/ai-trade/plans?active=1', { signal: sig })
    const rows = (j as { plans?: Record<string, unknown>[] } | null)?.plans
    if (!Array.isArray(rows)) return
    const vms: AiPlanVM[] = []
    for (const r of rows) {
      const id = typeof r.id === 'string' ? r.id : null
      const symbol = typeof r.symbol === 'string' ? r.symbol : null
      const side = r.side === 'sell' ? 'sell' : r.side === 'buy' ? 'buy' : null
      const trigger = Number(r.trigger); const tp = Number(r.tp); const sl = Number(r.sl)
      const rr = Number(r.rr); const refPrice = Number(r.refPrice)
      if (!id || !symbol || !side || ![trigger, tp, sl, rr, refPrice].every((n) => Number.isFinite(n) && n > 0)) continue
      vms.push({
        id, symbol, side, confidence: Math.round(Number(r.confidence) || 0),
        trigger, tp, sl, rr, refPrice,
        reason: typeof r.reason === 'string' ? r.reason : null,
        regime: typeof r.regime === 'string' ? r.regime : null,
        mode: r.mode === 'live' ? 'live' : 'paper',
        status: 'WAITING', statusNote: null,
        createdAt: Number(r.createdAt) || Date.now(),
        closedAt: null,
      })
    }
    const closedPrev = useAiAutoStore.getState().plans.filter((x) => x.status !== 'WAITING')
    useAiAutoStore.setState({ plans: [...vms, ...closedPrev] })
    plansHydrated = true
  } catch { /* hydration is best-effort; the next tick retries */ }
}

function ensureReactorArmed() {
  const cfg = useAiAutoStore.getState().config
  if (!cfg.enabled || cfg.entryMode !== 'react') return
  if (reactTimer) return
  plansHydrated = false // re-adopt WAITING plans from the ledger on arm
  reactTimer = setInterval(() => { void reactTick() }, REACT_TICK_MS)
  useAiAutoStore.getState().addLog('info', `React 反應器啟動 — 每 ${Math.round(REACT_TICK_MS / 1000)}s 監控計劃觸發（市場確認才跟進；反向否定 · 48h 逾期作廢）`)
}

function stopReactor(reason?: string) {
  if (!reactTimer) return
  clearInterval(reactTimer)
  reactTimer = null
  reactBusy = false
  useAiAutoStore.getState().addLog('info', reason ?? 'React 反應器停止 — 等候中計劃保留，重新啟用後繼續監控')
}

async function patchPlan(id: string, status: AiPlanStatus, note: string | null) {
  await fetchJson('/api/ai-trade/plans', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status, note }),
  }).catch(() => { /* the ledger transition is best-effort */ })
}

/** One lifecycle transition: store + activity log + ledger PATCH. */
function closePlan(p: AiPlanVM, status: AiPlanStatus, note: string) {
  useAiAutoStore.setState((s) => ({
    plans: s.plans.map((x) => (x.id === p.id ? { ...x, status, statusNote: note, closedAt: Date.now() } : x)),
  }))
  const lvl = status === 'EXECUTED' ? 'success' : status === 'GATED' ? 'warn' : 'info'
  const verb = status === 'EXECUTED' ? '執行' : status === 'INVALIDATED' ? '反向作廢' : status === 'EXPIRED' ? '逾期作廢' : status === 'GATED' ? '閘門擋下' : '關閉'
  useAiAutoStore.getState().addLog(lvl, `${p.symbol} ${p.side === 'buy' ? '▲' : '▼'}計劃${verb} — ${note}`)
  void patchPlan(p.id, status, note)
}

async function reactTick(): Promise<void> {
  if (reactBusy) return
  const st = useAiAutoStore.getState()
  const cfg = st.config
  if (!cfg.enabled || cfg.entryMode !== 'react') { stopReactor(); return }
  if (!plansHydrated) await hydratePlans()
  let waiting = useAiAutoStore.getState().plans.filter((p) => p.status === 'WAITING')
  if (waiting.length === 0) return
  reactBusy = true
  try {
    const now = Date.now()
    // REVIEW housekeeping — TTL expiry + broker-impossible cleanup need no quote
    for (const p of waiting) {
      // v2.12.40 — a sell plan on Alpaca spot crypto can never be followed
      // (the broker refuses every crypto SELL): close it GATED with the
      // honest remark — the ledger records WHY the plan was ignored, and the
      // 24h review pass skips broker-impossible closures (crypto physics is
      // not a discipline lesson). Sweeps legacy plans created before the gate.
      if (p.side === 'sell' && isSpotCryptoSymbol(p.symbol)) {
        closePlan(p, 'GATED', `${CRYPTO_NO_SHORT_NOTE} — 此計劃無法被跟進，作廢`)
        continue
      }
      if (now - p.createdAt > PLAN_TTL_MS) closePlan(p, 'EXPIRED', '48 小時未觸發 — 計劃作廢（24h 後覆盤等待是否正確）')
    }
    waiting = useAiAutoStore.getState().plans.filter((p) => p.status === 'WAITING')
    if (waiting.length === 0) return
    // one quote round for every watched symbol (crypto slash spellings both)
    const symbols = [...new Set(waiting.map((p) => p.symbol))].slice(0, 30)
    const { j } = await fetchJson('/api/market/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    })
    const priceBySym = new Map<string, number>()
    for (const q of ((j as { quotes?: { symbol?: string; price?: number }[] } | null)?.quotes ?? [])) {
      const px = Number(q?.price)
      if (q?.symbol && Number.isFinite(px) && px > 0) {
        priceBySym.set(q.symbol.toUpperCase(), px)
        priceBySym.set(q.symbol.replace('/', '').toUpperCase(), px)
      }
    }
    // REACT — invalidation first (market went against), then confirmation
    const toExecute: { plan: AiPlanVM; last: number }[] = []
    for (const p of waiting) {
      const last = priceBySym.get(p.symbol) ?? priceBySym.get(p.symbol.replace('/', ''))
      if (last == null) continue
      if (p.side === 'buy') {
        if (last <= p.sl) closePlan(p, 'INVALIDATED', `市場反向 — 跌破停損區 ${fmtPx(p.sl)}，等待紀律生效（24h 後覆盤）`)
        else if (last >= p.trigger) toExecute.push({ plan: p, last })
      } else {
        if (last >= p.sl) closePlan(p, 'INVALIDATED', `市場反向 — 漫過停損區 ${fmtPx(p.sl)}，等待紀律生效（24h 後覆盤）`)
        else if (last <= p.trigger) toExecute.push({ plan: p, last })
      }
    }
    for (const { plan, last } of toExecute) await executePlan(plan, last)
  } catch (e) {
    useAiAutoStore.getState().addLog('warn', `React 監控異常 — ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    reactBusy = false
  }
}

/** RESPOND — the market confirmed the plan. Re-run the execution gates at
 *  trigger time (the tape can change between planning and triggering), then
 *  follow the plan with a market entry + the plan's TP/SL bracket. */
async function executePlan(p: AiPlanVM, last: number): Promise<void> {
  const st = useAiAutoStore.getState()
  const cfg = st.config
  const normSym = (s: string) => s.replace('/', '').toUpperCase()
  // v2.12.40 — broker-impossible, checked FIRST (even dry-run never notes it):
  // Alpaca spot crypto cannot be shorted, so a sell plan on a slash symbol
  // must never reach the order lane, no matter how it got here.
  if (p.side === 'sell' && isSpotCryptoSymbol(p.symbol)) { closePlan(p, 'GATED', CRYPTO_NO_SHORT_NOTE); return }
  if (cfg.dryRun) {
    if (!p.dryRunNoted) {
      useAiAutoStore.setState((s) => ({ plans: s.plans.map((x) => (x.id === p.id ? { ...x, dryRunNoted: true } : x)) }))
      st.addLog('info', `${p.symbol} ${p.side === 'buy' ? '▲' : '▼'}計劃觸發 ${fmtPx(p.trigger)}（現價 ${fmtPx(last)}）— 試運行：不送單，計劃保持等候`)
    }
    return
  }
  const [pos, acc, eaRes] = await Promise.all([
    fetchJson('/api/trading/positions').catch(() => ({ status: 0, j: null as Record<string, unknown> | null })),
    fetchJson('/api/trading/account').catch(() => ({ status: 0, j: null as Record<string, unknown> | null })),
    fetchJson(`/api/market/earnings?symbols=${encodeURIComponent(p.symbol)}`).catch(() => ({ status: 0, j: null as Record<string, unknown> | null })),
  ])
  const posJ = pos.j as { positions?: { symbol?: string; source?: string; sources?: { source?: string }[] }[] } | null
  const posArr = posJ?.positions ?? []
  const held = posArr.some((x) => { const s = String(x?.symbol ?? '').toUpperCase(); return s === p.symbol || s === normSym(p.symbol) })
  if (held) { closePlan(p, 'GATED', '觸發時已有該標的持倉 — 跟進取消'); return }
  // v2.12.44 — the cap counts LIVE AI-managed positions straight off the
  // broker payload. The old heuristic (fired records + EXECUTED plans) was
  // session bookkeeping: every successful follow was counted TWICE (once in
  // each list) and closed positions kept occupying seats forever — five
  // follows (even all closed) saturated a cap of 10 and META got 「跟進取消」
  // with the desk effectively empty. Positions fetch failed → fall back to
  // the larger of the two bookkeeping lists (no double-count, still ≥ live).
  const liveAi = posJ ? posArr.filter(isAiPosition).length : null
  const openCount = liveAi ?? Math.max(st.fired.length, useAiAutoStore.getState().plans.filter((x) => x.status === 'EXECUTED').length)
  if (openCount >= cfg.maxOpenAuto) { closePlan(p, 'GATED', `觸發時達自動倉上限（${openCount}/${cfg.maxOpenAuto} 個 AI 持倉）— 跟進取消`); return }
  const ea = eaRes.j as { events?: Record<string, { inBlock?: boolean; daysAway?: number | null }> } | null
  const ev = ea?.events?.[normSym(p.symbol)]
  if (cfg.blockEarnings && ev?.inBlock) { closePlan(p, 'GATED', `觸發時落入財報窗口（${ev?.daysAway ?? '?'} 天後發布）— 跳空風險取消`); return }
  // v2.12.42 — re-price the plan at the ACTUAL follow price before ordering.
  // The planned R:R is priced at the trigger, but the tape can gap THROUGH
  // the trigger between 20s ticks (TWST: trigger 113.77 → follow-side 110.79
  // turns the planned 1:2.0 into a real 1:1.15 and blows the risk budget by
  // +38%). Plan your trade, trade your plan: a fill far from the plan's
  // entry is a DIFFERENT trade — if the real R:R at the last price is below
  // the plan gate, refuse to chase (INVALIDATED → the 24h review pass grades
  // it good-wait vs missed-run like any other market-discipline close).
  const gate = baseThresholds(cfg)
  const riskAtFill = Math.abs(last - p.sl)
  const rewardAtFill = p.side === 'buy' ? p.tp - last : last - p.tp
  const realRR = riskAtFill > 0 ? rewardAtFill / riskAtFill : 0
  if (!(realRR >= gate.minRR)) {
    closePlan(p, 'INVALIDATED', `滑價穿觸發價 — 實際跟進 R:R 1:${realRR.toFixed(2)} 低於門檻 1:${gate.minRR}（觸發 ${fmtPx(p.trigger)} → 現價 ${fmtPx(last)}）— 不追價，計劃作廢並覆盤`)
    return
  }
  // sizing — same math as the instant path (risk budget ÷ per-risk, 50% cap)
  // but anchored to the REAL fill-side price so the dollar risk budget holds
  // even when the market slipped past the trigger.
  const accJ = acc.j as { account?: { equity?: unknown; buyingPower?: unknown } } | null
  const equity = Number(accJ?.account?.equity)
  if (!Number.isFinite(equity) || equity <= 0) { closePlan(p, 'GATED', '無帳戶權益 — 無法計算倉位'); return }
  let bp = Number(accJ?.account?.buyingPower)
  if (!Number.isFinite(bp) || bp <= 0) bp = equity
  const price = last
  const riskAmt = equity * (cfg.riskPct / 100) * (p.confidence / 100)
  const perRisk = Math.abs(price - p.sl)
  let qty = perRisk > 0 ? Math.floor((riskAmt / perRisk) * 1e4) / 1e4 : 0
  const maxNotional = equity * 0.5
  if (qty * price > maxNotional) qty = Math.floor((maxNotional / price) * 1e4) / 1e4
  if (qty * price > bp) {
    const scaled = Math.floor((bp / price) * 1e4) / 1e4
    if (scaled <= 0 || scaled * price < 1) { closePlan(p, 'GATED', `Buying power 不足（餘 $${bp.toFixed(2)}）— 無法建立倉位`); return }
    st.addLog('info', `${p.symbol} 倉位縮減 — buying power 餘 $${bp.toFixed(2)}，qty ${qty} → ${scaled}`)
    qty = scaled
  }
  if (qty <= 0 || qty * price < 1) { closePlan(p, 'GATED', `風險預算太小（$${riskAmt.toFixed(2)} ÷ $${perRisk.toFixed(2)}）無法形成倉位`); return }
  // stocks fill whole shares at the broker — show/record the REAL qty
  const qtySent = p.symbol.includes('/') ? qty : Math.floor(qty)
  st.addLog('success', `${p.symbol} 市場確認 — ${p.side === 'buy' ? '上攻' : '跌破'}觸發 ${fmtPx(p.trigger)}（現價 ${fmtPx(last)}）— Respond：跟進計劃（實際 R:R 1:${realRR.toFixed(2)}）`)
  try {
    const { status, j } = await fetchJson('/api/trading/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: cfg.mode,
        symbol: p.symbol,
        side: p.side,
        qty: qtySent,
        type: 'market',
        time_in_force: 'gtc',
        take_profit: p.tp,
        stop_loss: p.sl,
        sourceKind: 'ai',
      }),
    })
    const ok = status === 200 && Array.isArray((j as { orders?: unknown[] } | null)?.orders) && ((j as { orders: unknown[] }).orders.length > 0)
    if (ok) {
      closePlan(p, 'EXECUTED', `跟進 ${p.side} ${qtySent} @市價 · TL ${fmtPx(p.tp)} / SL ${fmtPx(p.sl)}（${cfg.mode} · 實際 R:R 1:${realRR.toFixed(2)}）`)
      const rec: AiAutoFired = { id: ++fireSeq, at: Date.now(), symbol: p.symbol, side: p.side, qty: qtySent, price, stop: p.sl, target: p.tp, confidence: p.confidence, rr: p.rr, mode: cfg.mode }
      useAiAutoStore.setState((s) => ({ fired: [rec, ...s.fired].slice(0, 50) }))
      // the executed plan also feeds the verdict ledger → 24h reconciliation
      void fetchJson('/api/ai-trade/verdicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdicts: [{ symbol: p.symbol, direction: p.side === 'buy' ? 'long' : 'short', confidence: p.confidence, entry: p.trigger, stop: p.sl, target: p.tp, rr: p.rr, regime: p.regime, earnings: null, status: 'fired', gateNote: `計劃觸發跟進（實際 R:R 1:${realRR.toFixed(2)} @ 現價 ${fmtPx(last)}）` }] }),
      }).catch(() => { /* the ledger is best-effort */ })
    } else {
      const msg = String((j as { error?: string } | null)?.error || `下單失敗 HTTP ${status}`)
      closePlan(p, 'GATED', `跟進失敗 — ${msg}`)
      classifyOrderFailure(p.symbol, msg)
    }
  } catch {
    closePlan(p, 'GATED', '跟進連線失敗 — 計劃關閉（避免盲試循環）')
  }
}

function setScanning(on: boolean) { useAiAutoStore.setState({ scanning: on }) }
function dirLabel(d: AiAutoDirection) { return d === 'long' ? '偏多' : d === 'short' ? '偏空' : '中性' }

/** Pull the first JSON array out of a model reply (tolerates ```json fences / prose around it). */
function parseJsonArray(text: string): unknown[] | null {
  const s = text.indexOf('[')
  const e = text.lastIndexOf(']')
  if (s === -1 || e === -1 || e <= s) return null
  try {
    const arr = JSON.parse(text.slice(s, e + 1))
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}
