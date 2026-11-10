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
import { dynamicThresholds as regimeDynamicThresholds, concentrationCheck, type GateRegime } from '@/lib/ai-trade-gates'

// ---- config ----------------------------------------------------------------

export interface AiAutoConfig {
  enabled: boolean
  intervalSec: number // scan period
  timeframe: Timeframe // bars the model reads
  model: AiTradeModel
  minConfidence: number // 0–100
  minRR: number // reward:risk multiplier — threshold "1:minRR" (user spec e.g. 1:7)
  riskPct: number // % of equity risked per trade at confidence 100
  maxOpenAuto: number // max concurrent positions opened by the auto trader
  maxSymbols: number // watchlist symbols evaluated per scan
  mode: 'paper' | 'live'
  dryRun: boolean // evaluate + log what WOULD fire, place nothing
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
  riskPct: 1,
  maxOpenAuto: 3,
  maxSymbols: 6,
  mode: 'paper',
  dryRun: false,
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
    riskPct: clampN(num(j.riskPct, d.riskPct), 0.01, 10),
    maxOpenAuto: Math.round(clampN(num(j.maxOpenAuto, d.maxOpenAuto), 1, 20)),
    maxSymbols: Math.round(clampN(num(j.maxSymbols, d.maxSymbols), 1, 50)),
    mode: j.mode === 'live' ? 'live' : 'paper',
    dryRun: Boolean(j.dryRun),
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
  runnerInfo: null,
  addLog: (level, text) => set((s) => ({ log: [...s.log, { id: ++logSeq, at: Date.now(), level, text }].slice(-250) })),
  updateConfig: (patch) => {
    const next = { ...get().config, ...patch }
    persistConfig(next)
    set({ config: next })
    // v2.12.24 — push the edit to the account (debounced; no runner claim:
    // editing the interval on device 2 must not yank execution off device 1)
    queueAiOpsConfigPut('auto-trade')
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
  st.addLog('info', `${opts?.note ?? '自動交易掃描器啟動'} — 每 ${fmtInterval(next.intervalSec)} 掃描關注清單一次（門檻：信心 ≥ ${next.minConfidence}% · R:R ≥ 1:${next.minRR}）`)
  // v2.12.24 — user-facing start publishes to the account AND claims the
  // runner slot for this device; sync-driven starts skip the PUT (the server
  // row is already enabled — that's why we're starting).
  if (!opts?.fromSync) void pushAiOpsState('auto-trade', { claim: true })
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

function scanInstruction(n: number): string {
  return [
    `以下是關注清單 ${n} 個標的的資料（DATA 區：每標的技術快照 + 共用「市場環境/近期表現/持倉」區）。請擔任量化評估引擎，逐一判斷短期（此時間框架）方向，只輸出 JSON 陣列，禁止任何其他文字或說明：`,
    `[{"symbol":"<快照中的標的>","direction":"long|short|flat","confidence":<0-100 整數>,"entry":<數字>,"stop":<數字>,"target":<數字>,"reason":"<繁體中文 ≤ 30 字>"}]`,
    `規則：`,
    `- 證據計數：方向需要「至少 2 類獨立證據同向」才可 non-flat（趨勢/動量、量能、結構 S/R、高週期、情緒/環境）。證據互相矛盾或只有單一訊號 → 誠實 flat 或低 confidence。`,
    `- 市場環境：RISK_OFF 時做多需更高證據門檻（逆風交易勝率低）；區間位置 >90% 追高 / <10% 追跌要特別保守；波動緊縮（ATR14 < ATR50）時假突破多 — flat 傾向提高。`,
    `- 近期表現：這是本引擎最近已平倉交易的真實成績。用它校準 confidence — 勝率低於 45% 時全面調低信心並提高 flat 比例；某方向勝率明顯差時對該方向更保守。`,
    `- entry 取現價附近；stop 掛在最近支撐之下 / 最近阻力之上（結構外），距離參考 ATR — 不可緊貼現價；target 放在到達下一個 S/R 之前。long 必須 stop < entry < target；short 必須 target < entry < stop。`,
    `- 財報/事件：快照標明「財報臨近（block）」的標的必然被終端硬閘拒絕 — 直接給 flat；「財報: N 天後」N ≤ 5 時 confidence 上限 55（跳空風險）；共用區列出的 48 小時內高影響事件同樣壓低所有相關方向信心。`,
    `- 目前持倉：已持有標的不會再下單，但請避免建議與現有持倉高度相關的新方向（同板塊同向 = 集中風險）；[集中風險] 標明 ⚠ 的持倉對彼此高度相關，不要再建議與其同向的新標的。`,
    `- 覆盤統計：這是本引擎過往判斷 24 小時後的真實對帳結果（依 regime×方向分組）。用它選擇證據組合 — 某組合勝率明顯差時，同組合的新訊號給 flat 或低 confidence。`,
    `- confidence 是你對該方向的把握度，並已用近期勝率校準；direction 為 flat 時，entry/stop/target 與 confidence 全部填 0，reason 必須說出為何不交易的關鍵原因（如：證據不足/互相矛盾、區間中段無優勢、量價背離、事件風險）。`,
    `- 本引擎以勝率優先：大多數標的判 flat 是正常且預期的輸出（寧可錯過、不可做錯），不要為了凑 non-flat 而放寬證據標準；只有證據充分、風險可控的少數標的才給 non-flat。`,
    `- DATA 區已提供 MACD(12,26,9)、RSI、量能分布（up/down-bar volume、5/20-bar 量能趨勢）、4× 高週期趨勢、最近測試的支撐/阻力（含觸及次數）、52 週區間位置，以及「選股」行（全宇宙篩選排名 · ATR14% 波動 · 量比 · 成交額）— 請一併考慮；高週期與短週期矛盾時誠實反映在 confidence 與 reason；高 ATR 標的的停損距離需按波動放寬，量比爆量代表事件驅動行情、留意假突破。`,
    `- 只能使用 DATA 區的數字，不可杜撰資料；每個標的都要有對應項目。`,
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
  setScanning(true)
  st0.addLog('info', `掃描開始 — ${cfg.maxSymbols} 標的上限 · ${cfg.timeframe} K線 · ${cfg.model}${cfg.dryRun ? ' · 試運行（不下單）' : ''}`)
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
    const posJ = pos.j as { positions?: { symbol?: string; side?: string; qty?: number | string; uplPct?: number }[] } | null
    // POSITION symbols drop the crypto slash (BTCUSD) while ORDER/watchlist
    // symbols keep it (BTC/USD) — index BOTH spellings so a held BTC position
    // actually blocks a new BTC/USD entry (v2.12.23).
    for (const p of posJ?.positions ?? []) { const s = String(p.symbol ?? '').toUpperCase(); if (s) { openSyms.add(s); openSyms.add(s.replace('/', '')) } }
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
      const probe = await fetchJson(`/api/trading/assets?mode=${cfg.mode}&symbols=${encodeURIComponent(scanSyms.slice(0, 30).join(','))}`, { signal: sig })
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
      const dataBlock = (contextPack ? `${contextPack}\n\n` : '') + grp.map((s) => s.text + (s.demo ? '\n(note: DEMO bars — synthetic sample data)' : '')).join('\n\n')
      const res = await fetch('/api/ai-trade/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: scanInstruction(grp.length) }] as AiChatMsg[],
          context: dataBlock,
          maxTokens: Math.min(2000, 200 * grp.length + 300),
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

      const v: AiAutoVerdict = { symbol: snap.symbol, direction, confidence, entry, stop, target, rr: null, reason, demoBars: snap.demo, passed: false, rejectReason: null, dryRunNote: null }

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
      // geometry: long stop<entry<target / short target<entry<stop
      const geoOk = entry != null && stop != null && target != null && (
        direction === 'long' ? stop < entry && entry < target : target < entry && entry < stop
      )
      if (!geoOk) { v.rejectReason = '停損/目標方位不合理'; return v }
      // v2.12.23 — non-shortable assets (Alpaca spot crypto): reject the
      // SHORT verdict here instead of sending a SELL the broker refuses.
      if (direction === 'short' && noShort.has(snap.symbol)) {
        v.rejectReason = `該標的不可做空${assetMap.get(snap.symbol)?.assetClass === 'crypto' ? '（現貨加密）' : ''} — 偏空訊號跳過`
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
        ? regimeDynamicThresholds(cfg.minConfidence, cfg.minRR, regimeState, direction)
        : { minConfidence: cfg.minConfidence, minRR: cfg.minRR, note: null }
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
      const openAuto = st0.fired.length + fireCount
      if (openAuto >= cfg.maxOpenAuto) { v.rejectReason = `達自動倉上限（${cfg.maxOpenAuto}）`; return v }
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
            v.passed = false
            v.rejectReason = chk.note
            passCount--
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

    // 6) fire the passes (sizing by confidence → bracket order)
    for (const v of verdicts) {
      if (!v.passed) continue
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
          gateNote: v.rejectReason,
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
    st0.addLog('info', `掃描完成 — 評估 ${verdicts.length} 標的 · 中性 ${flatCount} · 達標 ${passCount} · 觸發 ${fireCount} 筆${failCount > 0 ? ` · 評估失敗 ${failCount}` : ''}${cfg.dryRun ? '（試運行）' : ''} · 耗時 ${secs}s`)
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
