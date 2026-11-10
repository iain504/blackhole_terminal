// AI 護倉 (v2.12.22) — the AI Trade adviser's autonomous portfolio steward.
//
// The user asked for the adviser to ALSO periodically:
//   1. review open positions and update TP/SL based on performance, the US
//      market, VIX, etc.
//   2. babysit pending orders — re-price entry/TP/SL when the market moved
//      away, or cancel when the setup is gone
//   3. review today's closed trades and distil reusable lessons (remembered)
//   4. store every action in the DB and purge it periodically
//
// Loop (module-scope setTimeout chain, like the auto-trade engine): every
// `intervalSec` pull positions+exits+pending (ONE /api/trading/positions
// call), today's realized round-trips (/api/trading/history), live quotes for
// the market context (SPY/QQQ/VIX + every held/pending symbol) and the last
// stored lessons (the 記憶), hand ONE batched DATA block to the model and
// demand a strict JSON verdict. THE TERMINAL VALIDATES EVERYTHING: geometry
// (long stop < current < target, mirrored for short), minimum-amplitude
// (≥0.15% churn guard), confidence gate, per-cycle action cap, and a hard
// safety rule — only MANUAL-source positions/orders are ever touched; algo-/
// grid-managed inventory is listed for context but protected. Executed
// actions ride the existing PATCH/DELETE trading routes, then the whole
// cycle is POSTed to /api/ai-steward/events which stores + prunes.
// v2.12.26 — the distilled 記憶 (lessons) are PERMANENT now: the events POST
// mirrors every lesson row into the AiStewardLesson table (never retention-
// purged), and each cycle feeds the newest-reinforced slice from that table
// back into the prompt — the memory survives days, months, reloads, devices.
//
// Honesty contract: dry-run logs what WOULD happen without touching the
// broker; every skip/refusal is recorded with its reason; a failed model
// call aborts the cycle (an error event is stored) — nothing is invented.
//
// v2.12.24 — cross-device sync: enabled + config live in the account
// (AiOpsState via /api/settings/ai-ops, localStorage stays the instant
// cache) so every signed-in computer sees the same 護倉 toggle, and a
// server-side heartbeat elects ONE browser as the runner — other devices
// show 「其他裝置運行中」 and never double-run the steward.
import { create } from 'zustand'
import type { AiChatMsg } from '@/lib/ai-trade'
import { CORE_DISCIPLINES } from '@/lib/ai-steward-disciplines'
import {
  registerAiOpsAdapter, pushAiOpsState, queueAiOpsConfigPut,
  type AiOpsRunnerInfo,
} from '@/lib/ai-ops-sync'

// ---- config ----------------------------------------------------------------

export interface AiStewardConfig {
  enabled: boolean
  intervalSec: number // review period
  mode: 'paper' | 'live'
  dryRun: boolean // evaluate + record what WOULD change, touch nothing
  amendPositions: boolean // allow TP/SL updates on open positions
  amendOrders: boolean // allow pending entry/TP/SL re-pricing
  cancelOrders: boolean // allow cancelling stale/unfavourable orders
  closePositions: boolean // allow market-closing a position (dangerous — opt-in)
  minConfidence: number // mutating actions need model confidence ≥ this
  maxActionsPerCycle: number // hard cap on broker mutations per cycle
  purgeDays: number // DB retention for steward events (server clamps 3–60)
}

export const AI_STEWARD_DEFAULT_CONFIG: AiStewardConfig = {
  enabled: false,
  intervalSec: 600,
  mode: 'paper',
  dryRun: false,
  amendPositions: true,
  amendOrders: true,
  cancelOrders: true,
  closePositions: false,
  minConfidence: 60,
  maxActionsPerCycle: 3,
  purgeDays: 14,
}

const LS_KEY = 'bh-ai-steward-cfg-v1'

const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Sanitize any untrusted object into a valid AiStewardConfig (clamped,
 *  typed). Shared by the localStorage loader AND the cross-device sync
 *  adoption so a config saved on another computer passes the same gates. */
export function sanitizeAiStewardConfig(input: unknown): AiStewardConfig {
  const d = AI_STEWARD_DEFAULT_CONFIG
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...d }
  const j = input as Partial<AiStewardConfig>
  return {
    enabled: Boolean(j.enabled),
    intervalSec: clampN(num(j.intervalSec, d.intervalSec), 120, 21600),
    mode: j.mode === 'live' ? 'live' : 'paper',
    dryRun: Boolean(j.dryRun),
    amendPositions: j.amendPositions !== false,
    amendOrders: j.amendOrders !== false,
    cancelOrders: j.cancelOrders !== false,
    closePositions: Boolean(j.closePositions),
    minConfidence: clampN(num(j.minConfidence, d.minConfidence), 0, 100),
    maxActionsPerCycle: Math.round(clampN(num(j.maxActionsPerCycle, d.maxActionsPerCycle), 1, 10)),
    purgeDays: clampN(num(j.purgeDays, d.purgeDays), 3, 60),
  }
}

function loadConfig(): AiStewardConfig {
  if (typeof window === 'undefined') return { ...AI_STEWARD_DEFAULT_CONFIG }
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return { ...AI_STEWARD_DEFAULT_CONFIG }
    return sanitizeAiStewardConfig(JSON.parse(raw))
  } catch {
    return { ...AI_STEWARD_DEFAULT_CONFIG }
  }
}

function persistConfig(cfg: AiStewardConfig) {
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch { /* private mode */ }
}

// ---- runtime types ----------------------------------------------------------

export type StewardKind = 'position' | 'order' | 'lesson' | 'cycle' | 'error'
export type StewardStatus = 'executed' | 'skipped' | 'failed' | 'dry_run' | 'stored'

export interface StewardEvent {
  id: string
  kind: StewardKind
  action: string
  symbol: string | null
  status: StewardStatus
  detail: string
  createdAt: string
}

/** A queued DB row before the POST (id/createdAt filled by the server). */
type StewardEventDraft = {
  kind: StewardKind
  action: string
  symbol?: string
  status: StewardStatus
  detail: string
  payload?: Record<string, unknown>
}

// v2.12.26 — lessons are PERMANENT memory now: they live in the
// AiStewardLesson table (never retention-purged; only a generous 300-row cap
// trims the oldest never-reinforced ones). Every cycle distils lessons from
// today's closed trades into that table (mirrored by the events POST) and
// feeds the newest-reinforced slice back into the review prompt.
export interface StewardLesson {
  id: string
  text: string
  createdAt: string // first learned
  lastSeenAt: string // last reinforced
}

export interface StewardLogEntry {
  id: number
  at: number
  level: 'info' | 'success' | 'warn' | 'error'
  text: string
}

interface AiStewardState {
  config: AiStewardConfig
  running: boolean // cycle in flight
  lastRunAt: number | null
  nextRunAt: number | null
  lastSummary: string | null
  events: StewardEvent[] // latest DB events (newest first)
  lessons: StewardLesson[] // PERMANENT memory (v2.12.26) — fed back each cycle
  log: StewardLogEntry[]
  /** v2.12.24 — who is the elected runner for this engine (cross-device
   *  sync). null = unknown/disabled; isMe:false = another device runs it. */
  runnerInfo: AiOpsRunnerInfo | null
  addLog: (level: StewardLogEntry['level'], text: string) => void
  updateConfig: (patch: Partial<AiStewardConfig>) => void
  setEnabled: (on: boolean) => void
  runOnce: () => Promise<void>
  cancelRun: () => void
  clearLog: () => void
  setEvents: (events: StewardEvent[]) => void
  setLessons: (lessons: StewardLesson[]) => void
  /** curate the memory: remove one lesson (DELETE /api/ai-steward/lessons?id=) */
  deleteLesson: (id: string) => Promise<void>
  /** v2.12.26 — MANUAL lesson: the user types their own rule into the panel
   *  (POST /api/ai-steward/lessons). Returns false when the server refused. */
  addLesson: (text: string) => Promise<boolean>
  /** sync-layer hooks (v2.12.24) — not for UI use */
  setRunnerInfo: (info: AiOpsRunnerInfo | null) => void
  adoptConfig: (cfg: unknown) => void
  setEnabledFlag: (on: boolean) => void
}

// ---- module-scope engine ----------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let runAbort: AbortController | null = null
let logSeq = 0
let resumed = false
// v2.12.29 — last observed US session phase (pre/regular/post/closed): a
// regular ↔ extended transition is the known TP/SL killer (DAY-tif legs die
// at the close), so the cycle that SEES a transition forces a full
// protection audit.
let lastSessionPhase: string | null = null

export const useAiStewardStore = create<AiStewardState>((set, get) => ({
  config: loadConfig(),
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  lastSummary: null,
  events: [],
  lessons: [],
  log: [],
  runnerInfo: null,
  addLog: (level, text) => set((s) => ({ log: [...s.log, { id: ++logSeq, at: Date.now(), level, text }].slice(-250) })),
  updateConfig: (patch) => {
    const next = { ...get().config, ...patch }
    persistConfig(next)
    set({ config: next })
    // v2.12.24 — push the edit to the account (debounced; no runner claim:
    // editing the interval on device 2 must not yank execution off device 1)
    queueAiOpsConfigPut('steward')
    if (patch.intervalSec !== undefined && timer && next.enabled && !running) {
      if (timer) { clearTimeout(timer); timer = null }
      armTimer(next.intervalSec)
    }
  },
  setEnabled: (on) => {
    if (on) {
      startSteward(true) // flips the flag, starts the engine, PUT + claim
    } else {
      // v2.12.24 — flag and engine are separate concerns now: flip the
      // account-level toggle, stop the local engine if it was running here,
      // then publish (the PUT clears the runner slot server-side).
      useAiStewardStore.getState().setEnabledFlag(false)
      stopSteward()
      void pushAiOpsState('steward')
    }
  },
  runOnce: () => runStewardOnce(),
  cancelRun: () => runAbort?.abort(),
  clearLog: () => set({ log: [] }),
  setEvents: (events) => set({ events }),
  setLessons: (lessons) => set({ lessons }),
  deleteLesson: async (id) => {
    // optimistic remove, then the server call; on failure refetch the truth
    const prev = get().lessons
    set({ lessons: prev.filter((l) => l.id !== id) })
    try {
      const r = await fetch(`/api/ai-steward/lessons?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    } catch {
      set({ lessons: prev })
      useAiStewardStore.getState().addLog('warn', '教訓刪除失敗 — 已還原')
    }
  },
  addLesson: async (raw) => {
    const text = raw.trim().replace(/\s+/g, ' ').slice(0, 200)
    if (!text) return false
    try {
      const r = await fetch('/api/ai-steward/lessons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessons: [text] }),
      })
      const j = await r.json() as { ok?: boolean; lessons?: StewardLesson[]; error?: string } | null
      if (r.ok && j?.ok && Array.isArray(j.lessons)) {
        set({ lessons: j.lessons })
        useAiStewardStore.getState().addLog('success', `已加入教訓（永久記憶）：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`)
        return true
      }
      useAiStewardStore.getState().addLog('warn', `教訓加入失敗 — ${j?.error || `HTTP ${r.status}`}`)
      return false
    } catch {
      useAiStewardStore.getState().addLog('warn', '教訓加入失敗 — 連線問題')
      return false
    }
  },
  setRunnerInfo: (info) => set({ runnerInfo: info }),
  adoptConfig: (cfg) => {
    // Server-sent config (cross-device sync). `enabled` is owned by the
    // sync layer + toggles, never by the config payload.
    const next = sanitizeAiStewardConfig(cfg)
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
  timer = setTimeout(() => { timer = null; void runStewardOnce() }, intervalSec * 1000)
  useAiStewardStore.setState({ nextRunAt: Date.now() + intervalSec * 1000 })
}

function startSteward(immediate: boolean, opts?: { fromSync?: boolean; note?: string }) {
  const st = useAiStewardStore.getState()
  if (st.config.enabled && timer) return // already running
  const next = { ...st.config, enabled: true }
  persistConfig(next)
  useAiStewardStore.setState({ config: next })
  st.addLog('info', `${opts?.note ?? 'AI 護倉啟動'} — 每 ${fmtInterval(next.intervalSec)} 檢視一次${next.dryRun ? ' · 試運行（只建議不動單）' : ''}（信心門檻 ${next.minConfidence}% · 每輪最多 ${next.maxActionsPerCycle} 個動作）`)
  // v2.12.24 — user-facing start publishes to the account AND claims the
  // runner slot for this device; sync-driven starts skip the PUT.
  if (!opts?.fromSync) void pushAiOpsState('steward', { claim: true })
  if (immediate) {
    void runStewardOnce()
  } else {
    armTimer(Math.min(next.intervalSec, 30)) // auto-resume: first look soon, then the real cadence
  }
}

function stopSteward(opts?: { fromSync?: boolean; reason?: 'synced-off' | 'yield' }) {
  // v2.12.24 — engine-only stop: the enabled FLAG is managed by setEnabled /
  // setEnabledFlag, this just tears down the local timer/cycle. Idempotent:
  // repeated sync ticks on a follower (engine never armed) don't spam logs.
  if (!timer && !running) return
  if (timer) { clearTimeout(timer); timer = null }
  if (running) runAbort?.abort()
  useAiStewardStore.setState({ nextRunAt: null })
  useAiStewardStore.getState().addLog(
    'info',
    opts?.reason === 'synced-off'
      ? 'AI 護倉已於其他裝置關閉 — 本機同步停止'
      : opts?.reason === 'yield'
        ? 'AI 護倉改由其他裝置執行 — 本機待命'
        : 'AI 護倉已停止',
  )
}

/** Called from TerminalRoot once the user session is known: re-arm an enabled
 *  steward left on by a previous session (localStorage fallback). The PUT to
 *  the server is deliberately skipped — the cross-device sync layer owns the
 *  account state; if the row is missing it migrates this state up itself. */
export function resumeAiStewardIfNeeded() {
  if (resumed) return
  resumed = true
  const st = useAiStewardStore.getState()
  if (!st.config.enabled || timer || running) return
  st.addLog('info', '偵測到上次啟用的 AI 護倉 — 自動恢復巡檢')
  startSteward(false, { fromSync: true })
}

// v2.12.24 — register with the cross-device sync layer. The heartbeat tick
// (20s, every signed-in tab) drives start/stop through these hooks, so the
// account's enabled flag and ONE elected runner stay honest everywhere.
registerAiOpsAdapter({
  kind: 'steward',
  isEnabled: () => useAiStewardStore.getState().config.enabled,
  // startSteward's own guard (enabled && timer) makes this idempotent.
  startLocal: () => startSteward(false, { fromSync: true, note: '已同步 — AI 護倉於本裝置執行' }),
  stopLocal: (reason) => stopSteward({ fromSync: true, reason }),
  adoptConfig: (cfg) => useAiStewardStore.getState().adoptConfig(cfg),
  setRunnerInfo: (info) => useAiStewardStore.getState().setRunnerInfo(info),
  setEnabledFlag: (on) => useAiStewardStore.getState().setEnabledFlag(on),
  configForServer: () => {
    const { enabled: _enabled, ...rest } = useAiStewardStore.getState().config
    return { ...rest }
  },
})

const fmtInterval = (s: number) => (s % 3600 === 0 ? `${s / 3600}小時` : s % 60 === 0 ? `${s / 60}分鐘` : `${s}秒`)

// ---- one steward cycle ------------------------------------------------------

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; j: Record<string, unknown> | null }> {
  const res = await fetch(url, init)
  const j = await res.json().catch(() => null)
  return { status: res.status, j }
}

interface ExitInfo {
  orderId: string
  kind: 'sl' | 'tp'
  stopPrice: number | null
  limitPrice: number | null
  trailPercent: number | null
  qty: string
  side: string
  type: string
}

interface PendingRow {
  orderId: string
  symbol: string
  side: string
  type: string
  qty: number
  limitPrice: number | null
  status: string
  tpPrice: number | null
  slPrice: number | null
  source?: 'manual' | 'algo' | 'grid' | 'ai'
  createdAt: string | null
}

interface PositionRow {
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
  openedAt: string | null
  source?: 'manual' | 'algo' | 'grid' | 'ai'
  strategy?: string
  /** v2.12.30 — per-source inventory slices (server decays removed/stopped
   * engine slices to 'manual' via the engine-liveness check) */
  sources?: { source: 'manual' | 'algo' | 'grid' | 'ai'; qty: number; runRef?: string | null; strategy?: string }[]
}

interface ClosedTrade {
  symbol: string
  side: 'long' | 'short'
  qty: number
  entryPrice: number
  exitPrice: number
  exitAt: string
  pnl: number
  pnlPct: number
  durationMs: number
  source?: 'manual' | 'algo' | 'grid' | 'ai'
}

function stewardInstruction(): string {
  return [
    `你是 BLACKHOLE 終端的「AI 護倉」。定期審視持倉、待成交訂單與今日已平倉交易，提出保守、可執行的維護決策。只輸出一個 JSON 物件，禁止任何其他文字或說明：`,
    `{"positions":[{"symbol":"AAPL","action":"hold|tighten|widen|exit|reattach","new_stop":<數字或0>,"new_target":<數字或0>,"confidence":<0-100整數>,"reason":"<繁中≤40字>"}],`,
    ` "orders":[{"id":"<DATA中的id>","action":"keep|amend|cancel","new_entry":<數字或0>,"new_tp":<數字或0>,"new_sl":<數字或0>,"confidence":<0-100整數>,"reason":"<繁中≤40字>"}],`,
    ` "lessons":["<繁中≤60字>"]}`,
    `規則：`,
    `- positions/orders 只回覆需要處理的項目；沒問題的不必列出。action=hold/keep 時 new_* 全部填 0。`,
    `- tighten=把 SL/TP 往現價收緊以鎖定保護；widen=放寬距離避開震盪。`,
    `- reattach=持倉的 SL 或 TP 缺失（DATA 顯示「無」或出現 ⚠ 保護缺失區）時重新掛上保護：SL 缺失用 new_stop（long: <現價；short: >現價），TP 缺失用 new_target（long: >現價；short: <現價），兩者皆缺可一併填。SL 缺失＝全倉清盤風險，是最高優先級動作。`,
    `- long 倉：new_stop 必須 < 現價 且 new_target 必須 > 現價；short 倉相反。禁止把 stop 移過現價。`,
    `- 修改幅度 <0.5% 沒有意義，請勿提出。exit（市價平倉）只在風險明確時提出且 confidence ≥ 70。`,
    `- VIX 偏高或大盤急跌時傾向 tighten/exit 高風險持倉；數據不足時誠實 hold。`,
    `- 主動檢查：持倉有明顯浮盈而 SL 仍在進場價下方、或 SL 距現價 >3% → 應考慮 tighten 鎖定保護；掛單偏離現價 >3% 或形勢已變 → 除非有明確理由保留，否則提出 amend 新價或 cancel。`,
    `- orders：現價已遠離掛單價（>3%）或形勢改變 → amend 新價或 cancel；reason 必須引用 DATA 區數字。`,
    `- lessons：從今日已平倉交易歸納 ≤3 梄可執行的改善（停損紀律、進場時機、部位控制…），不要空話。`,
    `- 只能使用 DATA 區的數字，不可杜撰；誠實保守優先於頻繁操作。`,
    `核心紀律（系統內建 · 永遠遵守 · 優先於一切其他考量）：`,
    ...CORE_DISCIPLINES.map((d, i) => `${i + 1}. ${d}`),
  ].join('\n')
}

function fmtPrice(n: number): string {
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(5)
}

function fmtDur(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分鐘`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}小時`
  return `${(ms / 86_400_000).toFixed(1)}天`
}

function ago(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return fmtDur(Math.max(0, Date.now() - t))
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences / prose). */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s === -1 || e === -1 || e <= s) return null
  try {
    const j = JSON.parse(text.slice(s, e + 1))
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// v2.12.25 — AI Trade Adviser positions ARE maintained by the steward: the
// auto-trader fires a bracket and never revisits it, so the steward is the
// follow-up caretaker for 'ai' inventory too. Algo/grid keep their own
// engines — the steward never touches those.
// v2.12.30 — the server now DECAYS removed/stopped-engine slices to 'manual'
// (engine-liveness check on AlgoRun/GridTrade rows), so a deleted algo/grid
// no longer blocks the steward. The slice-aware helpers make MIXED inventory
// safe too: protection actions (reattach SL/TP) may act when ANY slice is
// unmanaged (a naked half must not hide behind a live engine half — adding
// protection is always safe), while inventory actions (exit/close) still
// require EVERY slice to be unmanaged so a running engine's inventory is
// never killed out from under it.
const manualSrc = (src?: string) => src === undefined || src === null || src === 'manual' || src === 'ai'
const isManual = manualSrc
const protectionManageable = (p: PositionRow) =>
  p.sources?.length ? p.sources.some((s) => manualSrc(s.source)) : manualSrc(p.source)
const fullyManageable = (p: PositionRow) =>
  p.sources?.length ? p.sources.every((s) => manualSrc(s.source)) : manualSrc(p.source)
const isCryptoSym = (s: string) => s.includes('/') || s.endsWith('USD') && /^[A-Z0-9]{2,5}USD$/.test(s)

export async function runStewardOnce(): Promise<void> {
  const st0 = useAiStewardStore.getState()
  if (running) return
  running = true
  runAbort = new AbortController()
  const sig = runAbort.signal
  const cfg = st0.config
  const t0 = Date.now()
  useAiStewardStore.setState({ running: true })
  st0.addLog('info', `護倉檢視開始 — ${cfg.mode}${cfg.dryRun ? ' · 試運行（不動單）' : ''}`)

  const drafts: StewardEventDraft[] = []
  let executed = 0
  let failed = 0
  let skipped = 0
  let lessonCount = 0

  try {
    // 1) data pulls — positions(+exits+pending), today's realized trades,
    //    stored memory (v2.12.26 — PERMANENT lessons, never retention-purged),
    //    and the US session state (v2.12.29 — extended-hours discipline:
    //    pre/post bans market orders; transitions kill DAY-tif TP/SL legs)
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const [posRes, histRes, memRes, hoursRes] = await Promise.all([
      fetchJson(`/api/trading/positions?mode=${cfg.mode}`, { signal: sig }).catch(() => ({ status: 0, j: null })),
      fetchJson(`/api/trading/history?mode=${cfg.mode}&from=${encodeURIComponent(midnight.toISOString())}&limit=100`, { signal: sig }).catch(() => ({ status: 0, j: null })),
      fetchJson('/api/ai-steward/lessons', { signal: sig }).catch(() => ({ status: 0, j: null })),
      // /api/market/hours is POST-only (shared with the chart session badge)
      fetchJson('/api/market/hours', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols: ['SPY'] }), signal: sig }).catch(() => ({ status: 0, j: null })),
    ])

    const posJ = posRes.j as { positions?: PositionRow[]; exits?: Record<string, { sl?: ExitInfo; tp?: ExitInfo }>; pending?: PendingRow[]; keysMissing?: unknown; authError?: unknown } | null
    const positions = Array.isArray(posJ?.positions) ? posJ!.positions : []
    const exits = posJ?.exits && typeof posJ.exits === 'object' ? posJ!.exits : {}
    const pending = Array.isArray(posJ?.pending) ? posJ!.pending : []
    const histJ = histRes.j as { trades?: ClosedTrade[]; configured?: boolean } | null
    const trades = Array.isArray(histJ?.trades) ? histJ!.trades.slice(0, 12) : []
    const memJ = memRes.j as { lessons?: StewardLesson[] } | null
    const memLessons = Array.isArray(memJ?.lessons) ? memJ!.lessons : []
    // permanent memory: newest-reinforced first, top slice into the prompt
    const lessons = memLessons.slice(0, 16).map((l) => l.text)

    // v2.12.29 — session phase + transition detection + the deterministic
    // TP/SL guard. A regular ↔ pre/post transition is the known protective-leg
    // killer (DAY-tif legs die at the session close) and a steward cancel-
    // replace failure can leave a position naked too — a missing SL carries
    // full-liquidation risk (全倉清盤), so it is audited EVERY cycle.
    const hoursJ = hoursRes.j as { hours?: Record<string, { state?: string }> } | null
    const session = hoursJ?.hours?.SPY?.state ?? 'unknown'
    const prevPhase = lastSessionPhase
    const sessionChanged = prevPhase !== null && session !== 'unknown' && session !== prevPhase
    if (session !== 'unknown') lastSessionPhase = session
    const sessionLabel = session === 'pre' ? 'Pre-market（延長時段 04:00-09:30 ET · 禁市價單）'
      : session === 'post' ? 'Post-market（延長時段 16:00-20:00 ET · 禁市價單）'
      : session === 'regular' ? 'Regular Trading Hour（常規時段）'
      : session === 'closed' ? '市場休市'
      : session === 'open24' ? '24小時交易（crypto）'
      : '未知'
    const slMissingRows = positions.filter((p) => {
      // v2.12.30 — slice-aware: a position with ANY unmanaged slice (incl.
      // dead-engine slices the server decayed to manual) must be guarded;
      // live algo/grid engines still protect their own
      if (!protectionManageable(p)) return false
      const ex = exits[p.symbol] ?? exits[p.tradeSymbol] ?? {}
      return !ex.sl
    })
    // symbols whose missing SL the model re-attaches THIS cycle — their guard
    // event is then dropped (the feed shows the fix, not a stale complaint)
    const slFixed = new Set<string>()

    // 2) live quotes: market context + every held/pending symbol
    const heldSyms = positions.map((p) => p.tradeSymbol || p.symbol)
    const pendSyms = pending.map((o) => o.symbol)
    const quoteSyms = [...new Set(['SPY', 'QQQ', 'VIX', ...heldSyms, ...pendSyms])].slice(0, 60)
    let quotes: { symbol: string; price: number; changePct: number }[] = []
    if (quoteSyms.length > 0) {
      const qRes = await fetch('/api/market/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: quoteSyms }),
        signal: sig,
      }).catch(() => null)
      const qJ = qRes ? await qRes.json().catch(() => null) as { quotes?: { symbol?: string; price?: number; changePct?: number }[] } | null : null
      quotes = (qJ?.quotes ?? [])
        .filter((q): q is { symbol: string; price: number; changePct: number } =>
          Boolean(q) && typeof q.symbol === 'string' && Number.isFinite(Number(q.price)) && Number(q.price) > 0)
        .map((q) => ({ symbol: q.symbol, price: Number(q.price), changePct: Number(q.changePct) || 0 }))
    }
    const qOf = (sym: string) => quotes.find((q) => q.symbol.replace(/[^A-Z0-9]/gi, '').toUpperCase() === sym.replace(/[^A-Z0-9]/gi, '').toUpperCase())

    if (positions.length === 0 && pending.length === 0) {
      st0.addLog('info', '無持倉、無待成交訂單 — 無事可護。')
      useAiStewardStore.setState({ lastSummary: `無持倉/訂單 · 今日平倉 ${trades.length} 筆` })
      return
    }
    if (posJ?.keysMissing) st0.addLog('warn', `${cfg.mode} 模式未設定 Alpaca keys — 持倉/訂單資料為空，僅能回顧歷史。`)
    if (posJ?.authError) st0.addLog('warn', 'Alpaca 認證問題 — 持倉/訂單可能不完整（見持倉頁橫幅）。')

    // v2.12.29 — persistent guard events + warn logs for every NAKED
    // position (no SL). Recorded even if the model call fails below — the
    // detection is deterministic and must not depend on the model. Dropped
    // later only if this same cycle re-attaches the missing leg.
    if (sessionChanged) st0.addLog('warn', `市場時段轉換：${prevPhase} → ${session} — 本輪強制複查所有持倉的 TP/SL 保護單`)
    for (const p of slMissingRows) {
      drafts.push({
        kind: 'position',
        action: 'sl_missing',
        status: 'stored',
        symbol: p.tradeSymbol || p.symbol,
        detail: `SL 缺失 — 持倉無停損保護（全倉清盤風險）${sessionChanged ? ` · 疑似時段轉換（${prevPhase} → ${session}）流失` : ''}`,
        payload: { from: 'guard', session },
      })
      st0.addLog('warn', `⚠ ${p.tradeSymbol || p.symbol} SL 缺失 — 無停損保護（每輪提醒直至修復）`)
    }

    // 3) build the DATA block (everything the model may cite)
    const lines: string[] = []
    lines.push('市場狀態:')
    for (const m of ['SPY', 'QQQ', 'VIX']) {
      const q = qOf(m)
      lines.push(q ? `- ${m} ${fmtPrice(q.price)}${m === 'VIX' ? '' : ` 日變動 ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`}` : `- ${m} 無報價`)
    }
    lines.push('')
    lines.push(`交易時段: ${sessionLabel}`)
    if (session === 'pre' || session === 'post') {
      lines.push('- ⚠ 延長交易時段：Alpaca 不接受市價單（會被靜默擱置至下次 regular session）— exit 建議仍可提出，終端會自動轉為限價執行。')
    }
    if (sessionChanged) {
      lines.push(`- ⚠ 時段剛轉換（${prevPhase} → ${session}）— 這類轉換常令 TP/SL 保護單消失，必須逐倉複查下面每個持倉的 SL/TP 是否仍在。`)
    }
    if (slMissingRows.length > 0) {
      lines.push('')
      lines.push('⚠ 保護缺失（最高優先級 — 必須處理）:')
      for (const p of slMissingRows) {
        lines.push(`- ${p.tradeSymbol || p.symbol}（${p.side.toUpperCase()} ${p.qty}股，現價 ${fmtPrice(p.current)}）：SL 無 — 全倉清盤風險。請以 action=reattach + new_stop 重新掛上停損。`)
      }
    }
    lines.push('')
    lines.push(`持倉（${positions.length}）:`)
    positions.forEach((p, i) => {
      const ex = exits[p.symbol] ?? exits[p.tradeSymbol] ?? {}
      const sl = ex.sl ? (ex.sl.stopPrice ?? ex.sl.limitPrice) : null
      const tp = ex.tp?.limitPrice ?? null
      const openAge = ago(p.openedAt)
      lines.push(`${i + 1}. ${p.tradeSymbol || p.symbol} ${p.side.toUpperCase()} ${p.qty}股 · 現價 ${fmtPrice(p.current)} · 進場 ${fmtPrice(p.avgEntry)} · 浮動損益 ${p.uplPct >= 0 ? '+' : ''}${p.uplPct.toFixed(2)}% · SL ${sl != null ? fmtPrice(sl) : '無'} · TP ${tp != null ? fmtPrice(tp) : '無'}${openAge ? ` · 持有 ${openAge}` : ''} · 來源 ${p.source ?? 'manual'}`)
    })
    if (positions.length === 0) lines.push('（無）')
    lines.push('')
    lines.push(`待成交訂單（${pending.length}）:`)
    pending.forEach((o, i) => {
      const q = qOf(o.symbol)
      const dist = o.limitPrice != null && q ? ((q.price - o.limitPrice) / o.limitPrice) * 100 : null
      const age = ago(o.createdAt)
      lines.push(`${i + 1}. id=${o.orderId} ${o.symbol} ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.qty} @ ${o.limitPrice != null ? fmtPrice(o.limitPrice) : '?'} · TP ${o.tpPrice != null ? fmtPrice(o.tpPrice) : '無'} · SL ${o.slPrice != null ? fmtPrice(o.slPrice) : '無'}${q ? ` · 現價 ${fmtPrice(q.price)}（偏離 ${dist != null ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '?'}）` : ''}${age ? ` · 掛單 ${age}` : ''} · 來源 ${o.source ?? 'manual'}`)
    })
    if (pending.length === 0) lines.push('（無）')
    lines.push('')
    lines.push(`今日已平倉（${histJ?.configured === false ? '未設定 broker keys' : `${trades.length} 筆，最多列 12`}）:`)
    trades.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.symbol} ${t.side === 'long' ? 'LONG' : 'SHORT'} ${t.qty}股 ${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)} · 損益 ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%（$${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}） · 持有 ${fmtDur(t.durationMs)} · 來源 ${t.source ?? 'manual'}`)
    })
    if (trades.length === 0) lines.push('（今日尚無平倉）')
    if (lessons.length > 0) {
      lines.push('')
      lines.push('記憶（過去歸納的教訓，請遵守並避免重複）:')
      for (const l of lessons) lines.push(`- ${l}`)
    }
    const dataBlock = lines.join('\n')

    st0.addLog('info', `送審：持倉 ${positions.length} · 待成交 ${pending.length} · 今日平倉 ${trades.length}${lessons.length ? ` · 記憶 ${lessons.length} 條` : ''}${slMissingRows.length ? ` · ⚠ SL缺失 ${slMissingRows.length}` : ''} · 時段 ${session}`)

    // 4) one batched model call
    const res = await fetch('/api/ai-trade/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: stewardInstruction() }] as AiChatMsg[],
        context: dataBlock,
        maxTokens: 1400,
      }),
      signal: sig,
    })
    const j = await res.json().catch(() => null) as { ok?: boolean; content?: string; error?: string } | null
    if (!res.ok || !j?.ok || typeof j.content !== 'string') throw new Error(j?.error || `HTTP ${res.status}`)
    const verdict = parseJsonObject(j.content)
    if (!verdict) throw new Error('模型回覆無法解析為 JSON 物件')
    const pvArrAll = Array.isArray(verdict.positions) ? (verdict.positions as unknown[]) : []
    const ovArrAll = Array.isArray(verdict.orders) ? (verdict.orders as unknown[]) : []
    const lessonArrAll = Array.isArray(verdict.lessons) ? (verdict.lessons as unknown[]) : []
    st0.addLog('info', `模型回覆：持倉建議 ${pvArrAll.length} · 掛單建議 ${ovArrAll.length} · 教訓 ${lessonArrAll.length}`)

    // 5) execute validated actions — the terminal re-checks everything
    const actionsLeft = () => cfg.maxActionsPerCycle - executed - failed
    interface PosVerdict { symbol?: unknown; action?: unknown; new_stop?: unknown; new_target?: unknown; confidence?: unknown; reason?: unknown }
    interface OrdVerdict { id?: unknown; action?: unknown; new_entry?: unknown; new_tp?: unknown; new_sl?: unknown; confidence?: unknown; reason?: unknown }

    // ---- positions ----
    const pvArr = Array.isArray(verdict.positions) ? (verdict.positions as PosVerdict[]) : []
    for (const pv of pvArr) {
      const sym = String(pv.symbol ?? '').replace(/[^A-Za-z0-9/]/g, '').toUpperCase()
      const row = positions.find((p) => (p.tradeSymbol || p.symbol).replace(/[^A-Za-z0-9/]/g, '').toUpperCase() === sym)
      const action = String(pv.action ?? 'hold')
      const reason = String(pv.reason ?? '').slice(0, 80)
      const conf = clampN(Math.round(num(pv.confidence, 0)), 0, 100)
      if (!row) continue // model named a symbol we don't hold — ignore silently
      if (action === 'hold') continue // no DB row — holds are the default
      const kindBase = { kind: 'position' as const, symbol: row.tradeSymbol || row.symbol, detail: reason, payload: { from: 'model', confidence: conf, action } }
      // v2.12.30 — slice-aware refusal: exit/close kills the whole position
      // (needs EVERY slice engine-free), protection edits only ADD safety
      // (any unmanaged slice is enough)
      const manageable = action === 'exit' ? fullyManageable(row) : protectionManageable(row)
      if (!manageable) {
        skipped++
        drafts.push({ ...kindBase, action: 'hold', status: 'skipped', detail: `${reason || '模型建議'} — 拒絕：${row.source} 引擎管理中，護倉不碰` })
        continue
      }
      if (action === 'exit') {
        if (!cfg.closePositions) {
          skipped++
          drafts.push({ ...kindBase, action: 'close', status: 'skipped', detail: `${reason} — 已停用「允許平倉」開關` })
          continue
        }
        if (conf < cfg.minConfidence) {
          skipped++
          drafts.push({ ...kindBase, action: 'close', status: 'skipped', detail: `${reason} — 信心 ${conf}% 低於門檻 ${cfg.minConfidence}%` })
          continue
        }
        if (actionsLeft() <= 0) {
          skipped++
          drafts.push({ ...kindBase, action: 'close', status: 'skipped', detail: `${reason} — 本輪動作數已達上限` })
          continue
        }
        if (cfg.dryRun) {
          drafts.push({ ...kindBase, action: 'close', status: 'dry_run', detail: `試運行：市價平倉 ${row.qty}股 — ${reason}` })
          continue
        }
        try {
          const r = await fetchJson(`/api/trading/positions/${encodeURIComponent(row.tradeSymbol || row.symbol)}?mode=${cfg.mode}`, { method: 'DELETE', signal: sig })
          if (r.status === 200) {
            executed++
            // v2.12.29 — during pre/post the route converts the market close
            // into a marketable limit (extended-hours discipline); surface
            // that honestly in the event + log
            const extNote = String((r.j as { extendedNote?: string } | null)?.extendedNote || '')
            drafts.push({ ...kindBase, action: 'close', status: 'executed', detail: `已平倉 ${row.qty}股 — ${reason}${extNote ? `（${extNote}）` : ''}`, payload: { confidence: conf, uplPct: row.uplPct } })
            st0.addLog('success', `${row.tradeSymbol} 已平倉 — ${reason}${extNote ? `（${extNote}）` : ''}`)
          } else {
            failed++
            drafts.push({ ...kindBase, action: 'close', status: 'failed', detail: `平倉失敗（HTTP ${r.status}）— ${reason}` })
            st0.addLog('error', `${row.tradeSymbol} 平倉失敗 HTTP ${r.status}`)
          }
        } catch {
          failed++
          drafts.push({ ...kindBase, action: 'close', status: 'failed', detail: `平倉連線失敗 — ${reason}` })
        }
        continue
      }
      // tighten|widen|reattach → amend/attach SL and/or TP exit legs
      // (v2.12.29 — reattach flows the SAME validated path; the attach blocks
      // below key on the leg being MISSING, not on the verb)
      if (action !== 'tighten' && action !== 'widen' && action !== 'reattach') continue
      if (!cfg.amendPositions) {
        skipped++
        drafts.push({ ...kindBase, action: 'amend', status: 'skipped', detail: `${reason} — 已停用「調整持倉 TP/SL」開關` })
        continue
      }
      if (conf < cfg.minConfidence) {
        skipped++
        drafts.push({ ...kindBase, action: 'amend', status: 'skipped', detail: `${reason} — 信心 ${conf}% 低於門檻 ${cfg.minConfidence}%` })
        continue
      }
      const ex = exits[row.symbol] ?? exits[row.tradeSymbol] ?? {}
      const long = row.side !== 'short'
      const cur = row.current
      const newStop = num(pv.new_stop, 0)
      const newTarget = num(pv.new_target, 0)
      // v2.12.29 — set when a missing TP rides the SL attach call (single OCO)
      let tpAttached = false

      // SL leg
      if (newStop > 0 && ex.sl) {
        const oldSl = ex.sl.stopPrice ?? ex.sl.limitPrice
        if (oldSl == null) {
          skipped++
          drafts.push({ ...kindBase, action: 'amend_sl', status: 'skipped', detail: `該 SL 單無可比較價格（trail 型）— 不盲改` })
        } else {
          const geoOk = long ? newStop < cur : newStop > cur
          const moved = Math.abs(newStop - oldSl) / oldSl >= 0.0015
          if (!geoOk) {
            skipped++
            drafts.push({ ...kindBase, action: 'amend_sl', status: 'skipped', detail: `SL ${fmtPrice(newStop)} 方位不合法（${long ? '須低於' : '須高於'}現價 ${fmtPrice(cur)}）— ${reason}` })
          } else if (!moved) {
            skipped++
            drafts.push({ ...kindBase, action: 'amend_sl', status: 'skipped', detail: `SL 變動 <0.15% — 不折騰（${fmtPrice(oldSl)} → ${fmtPrice(newStop)}）` })
          } else if (actionsLeft() <= 0) {
            skipped++
            drafts.push({ ...kindBase, action: 'amend_sl', status: 'skipped', detail: `本輪動作數已達上限 — ${reason}` })
          } else {
            const body: Record<string, unknown> = { mode: cfg.mode, crypto: row.assetClass === 'crypto' }
            if (ex.sl.stopPrice != null) body.stop_price = newStop
            else body.limit_price = newStop
            if (cfg.dryRun) {
              drafts.push({ ...kindBase, action: 'amend_sl', status: 'dry_run', detail: `試運行：SL ${fmtPrice(oldSl)} → ${fmtPrice(newStop)} — ${reason}`, payload: { from: oldSl, to: newStop, confidence: conf } })
            } else {
              try {
                const r = await fetchJson(`/api/trading/orders/${ex.sl.orderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig })
                if (r.status === 200) {
                  executed++
                  drafts.push({ ...kindBase, action: 'amend_sl', status: 'executed', detail: `SL ${fmtPrice(oldSl)} → ${fmtPrice(newStop)} — ${reason}`, payload: { from: oldSl, to: newStop, confidence: conf, orderId: ex.sl.orderId } })
                  st0.addLog('success', `${row.tradeSymbol} SL ${fmtPrice(oldSl)} → ${fmtPrice(newStop)} — ${reason}`)
                } else {
                  failed++
                  const err = String((r.j as { error?: string } | null)?.error || `HTTP ${r.status}`)
                  drafts.push({ ...kindBase, action: 'amend_sl', status: 'failed', detail: `SL 修改失敗 — ${err}` })
                  st0.addLog('error', `${row.tradeSymbol} SL 修改失敗 — ${err}`)
                }
              } catch {
                failed++
                drafts.push({ ...kindBase, action: 'amend_sl', status: 'failed', detail: `SL 修改連線失敗 — ${reason}` })
              }
            }
          }
        }
      }

      // v2.12.29 — ATTACH path: the SL leg is GONE (the guard case). Same
      // geometry gate as an amend, no old-price comparison — protection must
      // not depend on which verb the model chose (tighten/widen/reattach all
      // restore a missing leg). Both legs missing → ONE attach call (the
      // exits route rebuilds them as a single OCO).
      if (newStop > 0 && !ex.sl && (long ? newStop < cur : newStop > cur)) {
        const sym = row.tradeSymbol || row.symbol
        const tpAlsoMissing = newTarget > 0 && !ex.tp && (long ? newTarget > cur : newTarget < cur)
        const kindAttach = { kind: 'position' as const, symbol: sym, detail: reason, payload: { from: 'model', confidence: conf, action: 'reattach_sl' } }
        if (!cfg.amendPositions) {
          skipped++
          drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'skipped', detail: `SL 缺失，需重新掛上 ${fmtPrice(newStop)} — 已停用「調整持倉 TP/SL」開關` })
        } else if (conf < cfg.minConfidence) {
          skipped++
          drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'skipped', detail: `SL 缺失，需重新掛上 ${fmtPrice(newStop)} — 信心 ${conf}% 低於門檻 ${cfg.minConfidence}%` })
        } else if (actionsLeft() <= 0) {
          skipped++
          drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'skipped', detail: `SL 缺失，需重新掛上 — 本輪動作數已達上限` })
        } else if (cfg.dryRun) {
          drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'dry_run', detail: `試運行：重新掛上缺失的 SL ${fmtPrice(newStop)}${tpAlsoMissing ? ` + TP ${fmtPrice(newTarget)}` : ''} — ${reason}` })
        } else {
          try {
            const attachBody: Record<string, unknown> = { mode: cfg.mode, sl: newStop }
            if (tpAlsoMissing) attachBody.tp = newTarget
            const r = await fetchJson(`/api/trading/positions/${encodeURIComponent(sym)}/exits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attachBody), signal: sig })
            if (r.status === 200) {
              executed++
              if (tpAlsoMissing) tpAttached = true
              slFixed.add(sym.toUpperCase())
              drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'executed', detail: `已重新掛上缺失的 SL ${fmtPrice(newStop)}${tpAlsoMissing ? ` 與 TP ${fmtPrice(newTarget)}` : ''} — ${reason}` })
              st0.addLog('success', `${sym} SL 重新掛上 ${fmtPrice(newStop)}${tpAlsoMissing ? ` · TP ${fmtPrice(newTarget)}` : ''} — ${reason}`)
            } else {
              failed++
              const err = String((r.j as { error?: string } | null)?.error || `HTTP ${r.status}`)
              drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'failed', detail: `SL 重新掛上失敗 — ${err}` })
              st0.addLog('error', `${sym} SL 重新掛上失敗 — ${err}`)
            }
          } catch {
            failed++
            drafts.push({ ...kindAttach, action: 'reattach_sl', status: 'failed', detail: `SL 重新掛上連線失敗 — ${reason}` })
          }
        }
      }

      // TP leg
      if (newTarget > 0 && ex.tp) {
        const oldTp = ex.tp.limitPrice ?? ex.tp.stopPrice
        if (oldTp == null) {
          skipped++
          drafts.push({ ...kindBase, action: 'amend_tp', status: 'skipped', detail: `該 TP 單無可比較價格 — 不盲改` })
        } else {
          const geoOk = long ? newTarget > cur : newTarget < cur
          const moved = Math.abs(newTarget - oldTp) / oldTp >= 0.0015
          if (!geoOk) {
            skipped++
            drafts.push({ ...kindBase, action: 'amend_tp', status: 'skipped', detail: `TP ${fmtPrice(newTarget)} 方位不合法（${long ? '須高於' : '須低於'}現價 ${fmtPrice(cur)}）— ${reason}` })
          } else if (!moved) {
            skipped++
            drafts.push({ ...kindBase, action: 'amend_tp', status: 'skipped', detail: `TP 變動 <0.15% — 不折騰（${fmtPrice(oldTp)} → ${fmtPrice(newTarget)}）` })
          } else if (actionsLeft() <= 0) {
            skipped++
            drafts.push({ ...kindBase, action: 'amend_tp', status: 'skipped', detail: `本輪動作數已達上限 — ${reason}` })
          } else {
            const body = { mode: cfg.mode, limit_price: newTarget, crypto: row.assetClass === 'crypto' }
            if (cfg.dryRun) {
              drafts.push({ ...kindBase, action: 'amend_tp', status: 'dry_run', detail: `試運行：TP ${fmtPrice(oldTp)} → ${fmtPrice(newTarget)} — ${reason}`, payload: { from: oldTp, to: newTarget, confidence: conf } })
            } else {
              try {
                const r = await fetchJson(`/api/trading/orders/${ex.tp.orderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig })
                if (r.status === 200) {
                  executed++
                  drafts.push({ ...kindBase, action: 'amend_tp', status: 'executed', detail: `TP ${fmtPrice(oldTp)} → ${fmtPrice(newTarget)} — ${reason}`, payload: { from: oldTp, to: newTarget, confidence: conf, orderId: ex.tp.orderId } })
                  st0.addLog('success', `${row.tradeSymbol} TP ${fmtPrice(oldTp)} → ${fmtPrice(newTarget)} — ${reason}`)
                } else {
                  failed++
                  const err = String((r.j as { error?: string } | null)?.error || `HTTP ${r.status}`)
                  drafts.push({ ...kindBase, action: 'amend_tp', status: 'failed', detail: `TP 修改失敗 — ${err}` })
                  st0.addLog('error', `${row.tradeSymbol} TP 修改失敗 — ${err}`)
                }
              } catch {
                failed++
                drafts.push({ ...kindBase, action: 'amend_tp', status: 'failed', detail: `TP 修改連線失敗 — ${reason}` })
              }
            }
          }
        }
      }

      // v2.12.29 — ATTACH path for a MISSING TP leg (tp-only; when both legs
      // were missing the SL attach above already placed them together in one
      // OCO). The exits route preserves the SL sibling by rebuilding the pair
      // from the canceled snapshot.
      if (!tpAttached && newTarget > 0 && !ex.tp && (long ? newTarget > cur : newTarget < cur)) {
        const sym = row.tradeSymbol || row.symbol
        const kindAttach = { kind: 'position' as const, symbol: sym, detail: reason, payload: { from: 'model', confidence: conf, action: 'reattach_tp' } }
        if (!cfg.amendPositions) {
          skipped++
          drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'skipped', detail: `TP 缺失，需重新掛上 ${fmtPrice(newTarget)} — 已停用「調整持倉 TP/SL」開關` })
        } else if (conf < cfg.minConfidence) {
          skipped++
          drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'skipped', detail: `TP 缺失，需重新掛上 ${fmtPrice(newTarget)} — 信心 ${conf}% 低於門檻 ${cfg.minConfidence}%` })
        } else if (actionsLeft() <= 0) {
          skipped++
          drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'skipped', detail: `TP 缺失，需重新掛上 — 本輪動作數已達上限` })
        } else if (cfg.dryRun) {
          drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'dry_run', detail: `試運行：重新掛上缺失的 TP ${fmtPrice(newTarget)} — ${reason}` })
        } else {
          try {
            const r = await fetchJson(`/api/trading/positions/${encodeURIComponent(sym)}/exits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: cfg.mode, tp: newTarget }), signal: sig })
            if (r.status === 200) {
              executed++
              drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'executed', detail: `已重新掛上缺失的 TP ${fmtPrice(newTarget)} — ${reason}` })
              st0.addLog('success', `${sym} TP 重新掛上 ${fmtPrice(newTarget)} — ${reason}`)
            } else {
              failed++
              const err = String((r.j as { error?: string } | null)?.error || `HTTP ${r.status}`)
              drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'failed', detail: `TP 重新掛上失敗 — ${err}` })
              st0.addLog('error', `${sym} TP 重新掛上失敗 — ${err}`)
            }
          } catch {
            failed++
            drafts.push({ ...kindAttach, action: 'reattach_tp', status: 'failed', detail: `TP 重新掛上連線失敗 — ${reason}` })
          }
        }
      }
    }

    // ---- pending orders ----
    const ovArr = Array.isArray(verdict.orders) ? (verdict.orders as OrdVerdict[]) : []
    for (const ov of ovArr) {
      const oid = String(ov.id ?? '')
      const row = pending.find((o) => o.orderId === oid)
      const action = String(ov.action ?? 'keep')
      const reason = String(ov.reason ?? '').slice(0, 80)
      const conf = clampN(Math.round(num(ov.confidence, 0)), 0, 100)
      if (!row) continue
      if (action === 'keep') continue
      const kindBase = { kind: 'order' as const, symbol: row.symbol, detail: reason, payload: { from: 'model', confidence: conf, action } }
      if (!isManual(row.source)) {
        skipped++
        drafts.push({ ...kindBase, action, status: 'skipped', detail: `${reason || '模型建議'} — 拒絕：${row.source ?? '其他'} 引擎的掛單，護倉不碰` })
        continue
      }
      if (action === 'cancel') {
        if (!cfg.cancelOrders) {
          skipped++
          drafts.push({ ...kindBase, action: 'cancel', status: 'skipped', detail: `${reason} — 已停用「允許取消掛單」開關` })
          continue
        }
        if (conf < cfg.minConfidence) {
          skipped++
          drafts.push({ ...kindBase, action: 'cancel', status: 'skipped', detail: `${reason} — 信心 ${conf}% 低於門檻` })
          continue
        }
        if (actionsLeft() <= 0) {
          skipped++
          drafts.push({ ...kindBase, action: 'cancel', status: 'skipped', detail: `${reason} — 本輪動作數已達上限` })
          continue
        }
        if (cfg.dryRun) {
          drafts.push({ ...kindBase, action: 'cancel', status: 'dry_run', detail: `試運行：取消掛單 ${row.symbol} ${row.side} ${row.qty} — ${reason}` })
          continue
        }
        try {
          const r = await fetchJson(`/api/trading/orders/${row.orderId}?mode=${cfg.mode}`, { method: 'DELETE', signal: sig })
          if (r.status === 200) {
            executed++
            drafts.push({ ...kindBase, action: 'cancel', status: 'executed', detail: `已取消掛單 ${row.symbol} ${row.side} ${row.qty} @ ${row.limitPrice != null ? fmtPrice(row.limitPrice) : '?'} — ${reason}` })
            st0.addLog('success', `${row.symbol} 掛單已取消 — ${reason}`)
          } else {
            failed++
            const err = String((r.j as { error?: string } | null)?.error || `HTTP ${r.status}`)
            drafts.push({ ...kindBase, action: 'cancel', status: 'failed', detail: `取消失敗 — ${err}` })
            st0.addLog('error', `${row.symbol} 取消掛單失敗 — ${err}`)
          }
        } catch {
          failed++
          drafts.push({ ...kindBase, action: 'cancel', status: 'failed', detail: `取消連線失敗 — ${reason}` })
        }
        continue
      }
      if (action !== 'amend') continue
      if (!cfg.amendOrders) {
        skipped++
        drafts.push({ ...kindBase, action: 'amend', status: 'skipped', detail: `${reason} — 已停用「調整掛單」開關` })
        continue
      }
      if (conf < cfg.minConfidence) {
        skipped++
        drafts.push({ ...kindBase, action: 'amend', status: 'skipped', detail: `${reason} — 信心 ${conf}% 低於門檻` })
        continue
      }
      const buy = row.side !== 'sell'
      const newEntry = num(ov.new_entry, 0)
      const newTp = num(ov.new_tp, 0)
      const newSl = num(ov.new_sl, 0)
      const entry = newEntry > 0 ? newEntry : (row.limitPrice ?? 0)
      const body: Record<string, unknown> = { mode: cfg.mode, crypto: isCryptoSym(row.symbol) }
      let changed = false
      let changedDesc = ''
      if (newEntry > 0 && row.limitPrice != null && Math.abs(newEntry - row.limitPrice) / row.limitPrice >= 0.0015) {
        body.entry_limit = newEntry
        changed = true
        changedDesc += `entry ${fmtPrice(row.limitPrice)} → ${fmtPrice(newEntry)}`
      }
      if (newTp > 0 && entry > 0 && (buy ? newTp > entry : newTp < entry) && (!row.tpPrice || Math.abs(newTp - row.tpPrice) / row.tpPrice >= 0.0015)) {
        body.tp_price = newTp
        changed = true
        changedDesc += `${changedDesc ? ' · ' : ''}TP ${row.tpPrice ? `${fmtPrice(row.tpPrice)} → ` : ''}${fmtPrice(newTp)}`
      }
      if (newSl > 0 && entry > 0 && (buy ? newSl < entry : newSl > entry) && (!row.slPrice || Math.abs(newSl - row.slPrice) / row.slPrice >= 0.0015)) {
        body.sl_price = newSl
        changed = true
        changedDesc += `${changedDesc ? ' · ' : ''}SL ${row.slPrice ? `${fmtPrice(row.slPrice)} → ` : ''}${fmtPrice(newSl)}`
      }
      if (!changed) {
        skipped++
        drafts.push({ ...kindBase, action: 'amend', status: 'skipped', detail: `無有效修改（幅度 <0.15% 或方位不合法）— ${reason}` })
        continue
      }
      if (actionsLeft() <= 0) {
        skipped++
        drafts.push({ ...kindBase, action: 'amend', status: 'skipped', detail: `本輪動作數已達上限 — ${reason}` })
        continue
      }
      if (cfg.dryRun) {
        drafts.push({ ...kindBase, action: 'amend', status: 'dry_run', detail: `試運行：${changedDesc} — ${reason}`, payload: { body } })
        continue
      }
      try {
        const r = await fetchJson(`/api/trading/orders/${row.orderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig })
        if (r.status === 200) {
          executed++
          drafts.push({ ...kindBase, action: 'amend', status: 'executed', detail: `掛單已改：${changedDesc} — ${reason}`, payload: { body } })
          st0.addLog('success', `${row.symbol} 掛單已改：${changedDesc} — ${reason}`)
        } else {
          failed++
          const err = String((r.j as { error?: string } | null)?.error || `HTTP ${r.status}`)
          drafts.push({ ...kindBase, action: 'amend', status: 'failed', detail: `掛單修改失敗 — ${err}` })
          st0.addLog('error', `${row.symbol} 掛單修改失敗 — ${err}`)
        }
      } catch {
        failed++
        drafts.push({ ...kindBase, action: 'amend', status: 'failed', detail: `掛單修改連線失敗 — ${reason}` })
      }
    }

    // ---- lessons (remember) ----
    const lessonArr = Array.isArray(verdict.lessons) ? verdict.lessons : []
    for (const raw of lessonArr.slice(0, 3)) {
      const text = String(raw ?? '').trim().slice(0, 160)
      if (!text) continue
      lessonCount++
      drafts.push({ kind: 'lesson', action: 'lesson', status: 'stored', detail: text })
    }

    // v2.12.29 — drop the guard events for legs this cycle re-attached (the
    // feed shows the FIX, not a stale complaint that was already handled)
    if (slFixed.size > 0) {
      for (let i = drafts.length - 1; i >= 0; i--) {
        const d = drafts[i]
        if (d.action === 'sl_missing' && d.symbol && slFixed.has(d.symbol.toUpperCase())) drafts.splice(i, 1)
      }
    }

    // 6) store everything (+ server-side prune) — one POST
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const summary = `持倉 ${positions.length} · 待成交 ${pending.length} · 今日平倉 ${trades.length} → 執行 ${executed}${cfg.dryRun ? '（試運行）' : ''} · 失敗 ${failed} · 跳過 ${skipped} · 教訓 ${lessonCount} · ${secs}s`
    drafts.push({
      kind: 'cycle',
      action: 'summary',
      status: cfg.dryRun ? 'dry_run' : 'executed',
      detail: summary,
      payload: { executed, failed, skipped, lessonCount, positions: positions.length, pending: pending.length, trades: trades.length },
    })
    if (drafts.length > 0) {
      const post = await fetchJson('/api/ai-steward/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: drafts, purgeDays: cfg.purgeDays }),
        signal: sig,
      })
      const pj = post.j as { ok?: boolean; events?: StewardEvent[]; pruned?: number; error?: string } | null
      if (post.status === 200 && pj?.ok) {
        useAiStewardStore.setState({ events: Array.isArray(pj.events) ? pj.events : [] })
        if ((pj.pruned ?? 0) > 0) st0.addLog('info', `已清理 ${pj!.pruned} 條過期護倉記錄（保留 ${cfg.purgeDays} 天）`)
        // v2.12.26 — the POST mirrored lesson rows into the permanent memory
        // table; refresh the store's copy so the panel + next cycle see them
        try {
          const lr = await fetchJson('/api/ai-steward/lessons', { signal: sig })
          const lj = lr.j as { lessons?: StewardLesson[] } | null
          if (lr.status === 200 && Array.isArray(lj?.lessons)) {
            useAiStewardStore.setState({ lessons: lj!.lessons })
          }
        } catch { /* non-fatal — next cycle refetches */ }
      } else {
        st0.addLog('warn', `護倉記錄寫入失敗 — ${pj?.error || `HTTP ${post.status}`}（動作已執行，僅審計未存）`)
      }
    }
    useAiStewardStore.setState({ lastSummary: summary })
    st0.addLog(executed + failed > 0 ? 'success' : 'info', `護倉完成 — ${summary}`)
  } catch (e) {
    const msg = e instanceof DOMException && e.name === 'AbortError' ? '護倉已取消' : `護倉異常 — ${e instanceof Error ? e.message : String(e)}`
    st0.addLog(e instanceof DOMException && e.name === 'AbortError' ? 'warn' : 'error', msg)
    // store the failure honestly (best-effort)
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      drafts.push({ kind: 'error', action: 'cycle', status: 'failed', detail: msg.slice(0, 300) })
      void fetchJson('/api/ai-steward/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: drafts, purgeDays: cfg.purgeDays }),
      }).catch(() => {})
    }
  } finally {
    running = false
    runAbort = null
    useAiStewardStore.setState({ running: false, lastRunAt: Date.now() })
    const cur = useAiStewardStore.getState().config
    const ri = useAiStewardStore.getState().runnerInfo
    // v2.12.24 — re-arm only when the engine is supposed to run HERE: a
    // manual 立即檢視 on a follower device must never start a second
    // periodic loop behind the elected runner's back.
    if (cur.enabled && (!ri || ri.isMe)) armTimer(cur.intervalSec)
  }
}
