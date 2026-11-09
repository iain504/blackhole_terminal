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
  excludedSymbols: string[] // per-symbol opt-out from the scan list
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
  excludedSymbols: [],
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
    excludedSymbols: Array.isArray(j.excludedSymbols)
      ? j.excludedSymbols.filter((s): s is string => typeof s === 'string' && /^[A-Z0-9./:-]{1,15}$/.test(s)).slice(0, 100)
      : [],
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

/** Snapshots per model call — 8 × ~650 chars keeps the DATA block inside the chat route's 8k context clamp. */
const SCAN_CHUNK = 8

function scanInstruction(n: number): string {
  return [
    `以下是關注清單 ${n} 個標的的技術快照（DATA 區）。請擔任量評估引擎，逐一判斷短期（此時間框架）方向，只輸出 JSON 陣列，禁止任何其他文字或說明：`,
    `[{"symbol":"<快照中的標的>","direction":"long|short|flat","confidence":<0-100 整數>,"entry":<數字>,"stop":<數字>,"target":<數字>,"reason":"<繁體中文 ≤ 30 字>"}]`,
    `規則：`,
    `- entry 取現價附近；stop/target 用 ATR 概念給合理距離。long 必須 stop < entry < target；short 必須 target < entry < stop。`,
    `- direction 為 flat 時，entry/stop/target 全部填 0，並在 reason 說明原因。`,
    `- confidence 是你對該方向的把握度；證據不足或訊號矛盾時誠實給低分或 flat。`,
    `- DATA 區已提供 MACD(12,26,9)、量能分布（up/down-bar volume、5/20-bar 量能趨勢）與 4× 高週期趨勢 — 請一併考慮；高週期與短週期矛盾時誠實反映在 confidence 與 reason。`,
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

  try {
    // 1) watchlist symbols — user-selected list (null = first), '#Group'
    //    separators filtered out, then the panel's per-symbol exclusions
    const lists = useTerminal.getState().watchlists
    const list = lists.find((l) => l.id === cfg.watchlistId) ?? lists[0]
    const excl = new Set(cfg.excludedSymbols)
    const symbols = watchlistSymbols(list?.items ?? [])
      .filter((s) => !excl.has(s))
      .slice(0, cfg.maxSymbols)
    if (symbols.length === 0) {
      st0.addLog('warn', list
        ? `清單「${list.name}」沒有可掃描標的（空、全被排除或只剩分隔線）。`
        : '沒有關注清單 — 先在圖表建立清單並加入符號。')
      return
    }
    st0.addLog('info', `掃描清單「${list?.name ?? '?'}」— ${symbols.length} 標的${excl.size ? `（排除 ${excl.size} 個）` : ''}`)

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
    const openSyms = new Set<string>()
    const [acc, pos] = await Promise.all([
      fetchJson('/api/trading/account', { signal: sig }).catch(() => ({ status: 0, j: null })),
      fetchJson('/api/trading/positions', { signal: sig }).catch(() => ({ status: 0, j: null })),
    ])
    const accJ = acc.j as { account?: { equity?: unknown }; error?: string } | null
    const eqRaw = accJ?.account?.equity
    if (eqRaw != null) { const n = Number(eqRaw); if (Number.isFinite(n) && n > 0) equity = n }
    const posJ = pos.j as { positions?: { symbol?: string }[] } | null
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
          return { symbol: sym, text: snapshotToText(snap), demo: Boolean(meta.demo), lastClose: snap.lastClose }
        }),
      )
      for (const r of settled) if (r.status === 'fulfilled' && r.value) snaps.push(r.value)
    }
    if (skipped.length > 0) st0.addLog('warn', `K線不足或取得失敗（≥30 根才評估）：${skipped.join('、')}`)
    if (snaps.length === 0) {
      st0.addLog('warn', '本輪無可用K線 — 未呼叫模型。')
      return
    }

    // 4) batched verdict calls — 8 snapshots per call (keeps the DATA block
    //    inside the route's 8k context clamp), up to 2 calls in flight; a
    //    failed chunk degrades honestly: its symbols report 評估失敗
    const groups = chunk(snaps, SCAN_CHUNK)
    const bySym = new Map<string, Partial<Record<'symbol' | 'direction' | 'confidence' | 'entry' | 'stop' | 'target' | 'reason', unknown>>>()
    let okChunks = 0
    let failChunks = 0
    for (const pair of chunk(groups, 2)) {
      const settled = await Promise.allSettled(
        pair.map(async (grp) => {
          const dataBlock = grp.map((s) => s.text + (s.demo ? '\n(note: DEMO bars — synthetic sample data)' : '')).join('\n\n')
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
              if (s) bySym.set(s, it as Record<string, unknown>)
            }
          }
        }),
      )
      for (const r of settled) {
        if (r.status === 'fulfilled') okChunks++
        else {
          failChunks++
          st0.addLog('warn', `評估組失敗 — ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
      }
    }
    if (okChunks === 0) {
      st0.addLog('error', '模型評估全部失敗 — 本輪放棄（不猜測）。')
      return
    }
    if (failChunks > 0) st0.addLog('warn', `部分評估組失敗（${failChunks}/${okChunks + failChunks} 組）— 相關標的記為「評估失敗」`)

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

      if (!it) { v.rejectReason = '評估失敗（模型組失敗或漏答）'; return v }
      if (direction === 'flat') { v.rejectReason = '模型判中性'; return v }
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

      const confOk = confidence >= cfg.minConfidence
      const rrOk = v.rr >= cfg.minRR
      if (!confOk && !rrOk) v.rejectReason = `信心與 R:R 均未達門檻`
      else if (!confOk) v.rejectReason = `信心未達 ${cfg.minConfidence}%`
      else if (!rrOk) v.rejectReason = `R:R 未達 1:${cfg.minRR}`
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
      if (qty <= 0 || qty * price < 1) {
        v.passed = false
        v.rejectReason = `風險預算太小（$${riskAmt.toFixed(2)} ÷ $${perRisk.toFixed(2)}）無法形成倉位`
        st0.addLog('warn', `${v.symbol} 通過門檻但倉位過小 — ${v.rejectReason}`)
        continue
      }
      if (cfg.dryRun) {
        v.dryRunNote = `試運行：${v.direction === 'long' ? 'buy' : 'sell'} ${qty} @市價 · TP ${v.target} / SL ${v.stop}`
        st0.addLog('info', `${v.symbol} ${v.dryRunNote}（試運行 — 未送單）`)
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
          }),
          signal: sig,
        })
        const ok = status === 200 && Array.isArray((j as { orders?: unknown[] } | null)?.orders) && ((j as { orders: unknown[] }).orders.length > 0)
        if (ok) {
          fireCount++
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

    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    st0.addLog('info', `掃描完成 — 評估 ${verdicts.length} 標的 · 達標 ${passCount} · 觸發 ${fireCount} 筆${cfg.dryRun ? '（試運行）' : ''} · 耗時 ${secs}s`)
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
