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
// Honesty contract: demo-flagged bars are allowed for evaluation (clearly
// marked) but only fireable in paper mode; every skip/reject is logged with
// its reason; a failed model call kills the round — nothing is invented.
//
// The engine lives at module scope (setTimeout chain), so the scan keeps
// running when the AI Trade tab is unmounted. Config persists in localStorage;
// an enabled scanner auto-resumes after reload via resumeAiAutoIfNeeded()
// (called from TerminalRoot once the user session is known).
import { create } from 'zustand'
import {
  AI_TRADE_DEFAULT_MODEL, buildChartSnapshot, snapshotToText,
  isAiTradeModel, type AiTradeModel, type AiChatMsg,
} from '@/lib/ai-trade'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import { useTerminal, watchlistSymbols } from '@/store/terminal'

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

function loadConfig(): AiAutoConfig {
  if (typeof window === 'undefined') return { ...AI_AUTO_DEFAULT_CONFIG }
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return { ...AI_AUTO_DEFAULT_CONFIG }
    const j = JSON.parse(raw) as Partial<AiAutoConfig>
    return {
      enabled: Boolean(j.enabled),
      intervalSec: clampN(num(j.intervalSec, AI_AUTO_DEFAULT_CONFIG.intervalSec), 60, 7200),
      timeframe: (typeof j.timeframe === 'string' && TIMEFRAMES[j.timeframe as Timeframe])
        ? j.timeframe as Timeframe : AI_AUTO_DEFAULT_CONFIG.timeframe,
      model: isAiTradeModel(j.model) ? j.model : AI_AUTO_DEFAULT_CONFIG.model,
      minConfidence: clampN(num(j.minConfidence, AI_AUTO_DEFAULT_CONFIG.minConfidence), 0, 100),
      minRR: clampN(num(j.minRR, AI_AUTO_DEFAULT_CONFIG.minRR), 0.1, 100),
      riskPct: clampN(num(j.riskPct, AI_AUTO_DEFAULT_CONFIG.riskPct), 0.01, 10),
      maxOpenAuto: Math.round(clampN(num(j.maxOpenAuto, AI_AUTO_DEFAULT_CONFIG.maxOpenAuto), 1, 20)),
      maxSymbols: Math.round(clampN(num(j.maxSymbols, AI_AUTO_DEFAULT_CONFIG.maxSymbols), 1, 50)),
      mode: j.mode === 'live' ? 'live' : 'paper',
      dryRun: Boolean(j.dryRun),
      watchlistId: typeof j.watchlistId === 'string' && j.watchlistId ? j.watchlistId : null,
      excludedSymbols: Array.isArray(j.excludedSymbols)
        ? j.excludedSymbols.filter((s): s is string => typeof s === 'string' && /^[A-Z0-9./:-]{1,15}$/.test(s)).slice(0, 100)
        : [],
    }
  } catch {
    return { ...AI_AUTO_DEFAULT_CONFIG }
  }
}

function persistConfig(cfg: AiAutoConfig) {
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch { /* private mode */ }
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
  addLog: (level: AiAutoLogEntry['level'], text: string) => void
  updateConfig: (patch: Partial<AiAutoConfig>) => void
  setEnabled: (on: boolean) => void
  start: (immediate?: boolean) => void
  stop: () => void
  scanOnce: () => Promise<void>
  cancelScan: () => void
  clearLog: () => void
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
  addLog: (level, text) => set((s) => ({ log: [...s.log, { id: ++logSeq, at: Date.now(), level, text }].slice(-250) })),
  updateConfig: (patch) => {
    const next = { ...get().config, ...patch }
    persistConfig(next)
    set({ config: next })
    // a period change while running reschedules the pending tick from now
    if (patch.intervalSec !== undefined && timer && next.enabled && !scanning) {
      if (timer) { clearTimeout(timer); timer = null }
      armTimer(next.intervalSec)
    }
  },
  setEnabled: (on) => { if (on) startScanner(true); else stopScanner() },
  start: (immediate = true) => startScanner(immediate),
  stop: () => stopScanner(),
  scanOnce: () => runScan(),
  cancelScan: () => scanAbort?.abort(),
  clearLog: () => set({ log: [] }),
}))

function armTimer(intervalSec: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void runScan() }, intervalSec * 1000)
  useAiAutoStore.setState({ nextScanAt: Date.now() + intervalSec * 1000 })
}

function startScanner(immediate: boolean) {
  const st = useAiAutoStore.getState()
  if (st.config.enabled && timer) return // already running
  const next = { ...st.config, enabled: true }
  persistConfig(next)
  useAiAutoStore.setState({ config: next })
  st.addLog('info', `自動交易掃描器啟動 — 每 ${fmtInterval(next.intervalSec)} 掃描關注清單一次（門檻：信心 ≥ ${next.minConfidence}% · R:R ≥ 1:${next.minRR}）`)
  if (immediate) {
    void runScan()
  } else {
    armTimer(Math.min(next.intervalSec, 30)) // auto-resume: first look after ≤30s, then the real cadence
  }
}

function stopScanner() {
  if (timer) { clearTimeout(timer); timer = null }
  if (scanning) scanAbort?.abort() // honest stop mid-flight too
  const st = useAiAutoStore.getState()
  const next = { ...st.config, enabled: false }
  persistConfig(next)
  useAiAutoStore.setState({ config: next, nextScanAt: null })
  st.addLog('info', '自動交易掃描器已停止')
}

/** Called from TerminalRoot once the user session is known: re-arm an enabled scanner left on by a previous session. */
export function resumeAiAutoIfNeeded() {
  if (resumed) return
  resumed = true
  const st = useAiAutoStore.getState()
  if (!st.config.enabled || timer || scanning) return
  st.addLog('info', '偵測到上次啟用的自動交易 — 自動恢復掃描')
  startScanner(false)
}

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
    for (const p of posJ?.positions ?? []) { const s = String(p.symbol ?? '').toUpperCase(); if (s) openSyms.add(s) }
    if (equity == null) st0.addLog('warn', '取得帳戶權益失敗 — 候選即使達標也無法計算倉位')

    // 3) bars → snapshots (concurrency 3, demo-flagged kept but marked)
    interface Snap { symbol: string; text: string; demo: boolean; lastClose: number }
    const snaps: Snap[] = []
    const skipped: string[] = []
    for (const group of chunk(symbols, 3)) {
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
      if (openSyms.has(snap.symbol)) { v.rejectReason = '已有該標的持倉'; return v }
      const openAuto = st0.fired.length + fireCount
      if (openAuto >= cfg.maxOpenAuto) { v.rejectReason = `達自動倉上限（${cfg.maxOpenAuto}）`; return v }
      v.passed = true
      passCount++
      return v
    })

    useAiAutoStore.setState({ verdicts })

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
        }
      } catch (e) {
        v.passed = false
        v.rejectReason = e instanceof DOMException && e.name === 'AbortError' ? '掃描被取消' : '下單連線失敗'
        st0.addLog('error', `${v.symbol} ${v.rejectReason}`)
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
    useAiAutoStore.setState({ lastScanAt: Date.now() })
    if (cur.enabled) armTimer(cur.intervalSec)
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
