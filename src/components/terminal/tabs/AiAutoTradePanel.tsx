'use client'

// AI 自動交易 control panel (v2.12.18) — rendered at the top of the AI Trade
// tab sidebar. Pure UI: all state and the periodic scan engine live in
// @/store/ai-auto-trade (module scope), so the scan keeps running when this
// tab is unmounted. Honesty contract: every candidate shows WHY it passed or
// was rejected; the log never hides a failed order.
import { useEffect, useMemo, useState } from 'react'
import { Bot, Play, Square, Trash2, TriangleAlert, CircleCheck, CircleX, Minus, ListChecks, Radar, RefreshCw, Crosshair, TrendingUp, TrendingDown } from 'lucide-react'
import { useAiAutoStore, AI_EVAL_FAIL_REASON } from '@/store/ai-auto-trade'
import { useTerminal, watchlistSymbols } from '@/store/terminal'
import { AI_TRADE_MODELS } from '@/lib/ai-trade'
import { TIMEFRAMES } from '@/lib/market-types'
import type { ScreenerResult } from '@/lib/screener'
import { TaijiSpinner } from '@/components/theme/TaoistLoader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const INTERVAL_OPTIONS = [
  { v: 60, label: '1 分鐘' },
  { v: 120, label: '2 分鐘' },
  { v: 300, label: '5 分鐘' },
  { v: 600, label: '10 分鐘' },
  { v: 1800, label: '30 分鐘' },
  { v: 3600, label: '1 小時' },
]

const TF_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1D'] as const

// v2.12.20 — same event SettingsDialog dispatches after an AI Agent endpoint
// save; kept as a literal so this panel doesn't pull the dialog module in.
const SETTINGS_CHANGED_EVENT = 'tt:settings-changed'

const fmtPx = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4))

// v2.12.37 — plan lifecycle counts from the ledger (polled every 60s)
interface PlanStats {
  waiting: number
  executed: number
  invalidated: number
  expired: number
  gated: number
  superseded: number
  goodWait: number
  missedRun: number
  neutral: number
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// v2.12.34 — compact formatters for the auto-watchlist table
const fmtUsdVol = (n: number | null | undefined): string =>
  n == null ? '—' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : `$${Math.round(n / 1e3)}K`
const fmtPct1 = (v: number | null | undefined, sign = false): string =>
  v == null ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%`

export default function AiAutoTradePanel() {
  const cfg = useAiAutoStore((s) => s.config)
  const scanning = useAiAutoStore((s) => s.scanning)
  const lastScanAt = useAiAutoStore((s) => s.lastScanAt)
  const nextScanAt = useAiAutoStore((s) => s.nextScanAt)
  const verdicts = useAiAutoStore((s) => s.verdicts)
  const fired = useAiAutoStore((s) => s.fired)
  const plans = useAiAutoStore((s) => s.plans)
  const log = useAiAutoStore((s) => s.log)
  const updateConfig = useAiAutoStore((s) => s.updateConfig)
  const setEnabled = useAiAutoStore((s) => s.setEnabled)
  const scanOnce = useAiAutoStore((s) => s.scanOnce)
  const cancelScan = useAiAutoStore((s) => s.cancelScan)
  const clearLog = useAiAutoStore((s) => s.clearLog)
  // v2.12.24 — cross-device sync: who is the elected runner (null = off/unknown)
  const runnerInfo = useAiAutoStore((s) => s.runnerInfo)
  const watchlists = useTerminal((s) => s.watchlists)

  // v2.12.20 — the AI Agent endpoint (Settings → AI Agent API) overrides the
  // model lane for scans too: badge it honestly, refetch on settings saves
  const [aiCustom, setAiCustom] = useState<{ model: string; host: string } | null>(null)
  useEffect(() => {
    let alive = true
    const probe = () =>
      fetch('/api/settings/ai-agent')
        .then((r) => r.json())
        .then((j: { configured?: boolean; model?: string; endpointHost?: string }) => {
          if (alive) setAiCustom(j.configured && j.model ? { model: j.model, host: j.endpointHost ?? '' } : null)
        })
        .catch(() => {})
    probe()
    window.addEventListener(SETTINGS_CHANGED_EVENT, probe)
    return () => {
      alive = false
      window.removeEventListener(SETTINGS_CHANGED_EVENT, probe)
    }
  }, [])

  // 1s ticker for the next-scan countdown (only while armed)
  const [, tickTock] = useState(0)
  useEffect(() => {
    if (!cfg.enabled || !nextScanAt) return
    const t = setInterval(() => tickTock((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [cfg.enabled, nextScanAt])

  // v2.12.37 — plan review stats (60s poll; resolve=1 also drives the 24h
  // review pass server-side, same pattern as the verdict reconciliation)
  const [planStats, setPlanStats] = useState<PlanStats | null>(null)
  useEffect(() => {
    if (cfg.entryMode !== 'react') { setPlanStats(null); return }
    let alive = true
    const pull = () =>
      fetch('/api/ai-trade/plans?resolve=1&history=1')
        .then((r) => r.json())
        .then((j: { stats?: PlanStats }) => { if (alive && j?.stats) setPlanStats(j.stats) })
        .catch(() => {})
    pull()
    const t = setInterval(pull, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [cfg.entryMode])

  // number fields kept as strings so partial typing doesn't fight the clamps
  const [minConf, setMinConf] = useState(String(cfg.minConfidence))
  const [minRR, setMinRR] = useState(String(cfg.minRR))
  const [riskPct, setRiskPct] = useState(String(cfg.riskPct))
  const [maxOpen, setMaxOpen] = useState(String(cfg.maxOpenAuto))
  const [maxCorr, setMaxCorr] = useState(String(cfg.maxCorrelated))
  useEffect(() => {
    setMinConf(String(cfg.minConfidence))
    setMinRR(String(cfg.minRR))
    setRiskPct(String(cfg.riskPct))
    setMaxOpen(String(cfg.maxOpenAuto))
    setMaxCorr(String(cfg.maxCorrelated))
  }, [cfg])

  const commitNum = (raw: string, apply: (n: number) => void) => {
    const n = Number(raw)
    if (Number.isFinite(n)) apply(n)
  }

  const liveDanger = cfg.mode === 'live' && !cfg.dryRun
  // v2.12.24 — enabled on the account but the elected runner is ANOTHER
  // device: honest amber pill (the engine is NOT running in this browser).
  const remoteRunner = Boolean(cfg.enabled && runnerInfo && !runnerInfo.isMe)

  // selected watchlist + its symbol items (separators become group labels)
  const selectedList = watchlists.find((l) => l.id === cfg.watchlistId) ?? watchlists[0] ?? null
  const watchSyms = useMemo(() => watchlistSymbols(selectedList?.items ?? []), [selectedList])

  // v2.12.34 — AUTO WATCHLIST (US-universe screener Top-50) fetch state.
  // Loaded lazily when the pool source needs it; 「立即篩選」 forces a fresh
  // server-side screen (?sync=1 — the first real run can take 10–30 s).
  // One busy flag + guarded effect: no in-flight dedup key means a deps churn
  // can never strand a response (the alive-flag cleanup race never fires a
  // state set that already belonged to this mount).
  const [screener, setScreener] = useState<ScreenerResult | null>(null)
  const [scrBusy, setScrBusy] = useState<'idle' | 'loading' | 'syncing'>('idle')
  const [scrError, setScrError] = useState<string | null>(null)

  const applyScreener = (p: Promise<Response>, kind: 'loading' | 'syncing') => {
    setScrBusy(kind)
    setScrError(null)
    p.then(async (r) => {
      const j = await r.json().catch(() => null) as ScreenerResult | { error?: string } | null
      if (!r.ok) throw new Error((j as { error?: string } | null)?.error ?? `HTTP ${r.status}`)
      setScreener(j as ScreenerResult)
    })
      .catch((e) => setScrError(e instanceof Error ? e.message : String(e)))
      .finally(() => setScrBusy('idle'))
  }

  const syncScreener = () => {
    if (scrBusy !== 'idle') return
    applyScreener(fetch('/api/market/screener?sync=1'), 'syncing')
  }

  useEffect(() => {
    if (cfg.poolSource === 'watchlist' || screener || scrBusy !== 'idle') return
    applyScreener(fetch('/api/market/screener'), 'loading')
  }, [cfg.poolSource, screener, scrBusy])

  // pool-aware scan list: auto = screener Top-50; union = the watchlist
  // first with the picks filling the remainder; watchlist = as before
  const pickSyms = useMemo(() => (screener?.picks ?? []).map((p) => p.symbol), [screener])
  const scanSymbols = useMemo(
    () =>
      cfg.poolSource === 'auto' ? pickSyms
        : cfg.poolSource === 'union' ? [...watchSyms, ...pickSyms.filter((s) => !watchSyms.includes(s))]
        : watchSyms,
    [cfg.poolSource, pickSyms, watchSyms],
  )
  const scanItems = selectedList?.items ?? []
  const excluded = cfg.excludedSymbols
  const toggleSymbol = (sym: string) => {
    const next = excluded.includes(sym) ? excluded.filter((s) => s !== sym) : [...excluded, sym]
    updateConfig({ excludedSymbols: next })
  }
  const setAllExcluded = (all: boolean) => {
    updateConfig({ excludedSymbols: all ? [...scanSymbols] : [] })
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" aria-label="AI 自動交易">
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-100">
          <Bot className="h-4 w-4 text-violet-400" aria-hidden />
          AI 自動交易
          {cfg.dryRun && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-400">試運行</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
              scanning
                ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                : remoteRunner
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                  : cfg.enabled
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-500',
            )}
            title={remoteRunner ? `由 ${runnerInfo?.name ?? '其他裝置'} 執行 — 本機待命` : undefined}
          >
            {scanning && <TaijiSpinner className="h-2.5 w-2.5" aria-hidden />}
            {scanning ? '掃描中' : remoteRunner ? '其他裝置運行中' : cfg.enabled ? '運行中' : '已停止'}
          </span>
          <Switch checked={cfg.enabled} onCheckedChange={setEnabled} aria-label="啟用 AI 自動交易" />
        </span>
      </div>

      {/* status line */}
      <p className="mt-1.5 font-mono text-[10px] leading-4 text-zinc-500">
        {remoteRunner
          ? `由 ${runnerInfo?.name ?? '其他裝置'} 執行 — 本機待命（裝置離線自動接管）`
          : nextScanAt && cfg.enabled
            ? `下次掃描 ${fmtCountdown(nextScanAt - Date.now())}`
            : cfg.enabled
              ? '排程中…'
              : '掃描器未運行'}
        {!remoteRunner && lastScanAt ? ` · 上次 ${new Date(lastScanAt).toLocaleTimeString()}` : ''}
        {!remoteRunner && fired.length > 0 ? ` · 已觸發 ${fired.length} 筆` : ''}
      </p>

      {/* v2.12.37 — the entry discipline, stated where the user is looking */}
      {cfg.entryMode === 'react' && (
        <p className="mt-1 font-mono text-[9px] leading-3.5 text-violet-400/80">
          React &gt; Respond &gt; Review — 分析建計劃 · 市場確認才跟進 · 事後覆盤
        </p>
      )}

      {/* config grid */}
      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">掃描間隔</Label>
          <Select value={String(cfg.intervalSec)} onValueChange={(v) => updateConfig({ intervalSec: Number(v) })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="掃描間隔"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {INTERVAL_OPTIONS.map((o) => (
                <SelectItem key={o.v} value={String(o.v)} className="text-[11px]">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">關注清單</Label>
          <Select
            value={selectedList?.id ?? ''}
            onValueChange={(v) => updateConfig({ watchlistId: v, excludedSymbols: [] })}
            disabled={watchlists.length === 0}
          >
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="掃描用關注清單">
              <SelectValue placeholder={watchlists.length ? '—' : '無清單'} />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {watchlists.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-[11px]">
                  {l.name}（{watchlistSymbols(l.items).length}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* v2.12.34 — pool source: hand-picked watchlist / auto screener Top-50 / merged */}
        <div className="col-span-2 space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">掃描池來源</Label>
          <div className="flex gap-1" role="radiogroup" aria-label="掃描池來源">
            {([['watchlist', '關注清單'], ['auto', '自動選股'], ['union', '合併']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={cfg.poolSource === v}
                onClick={() => updateConfig({ poolSource: v })}
                className={cn(
                  'h-6 flex-1 rounded border px-1.5 text-[10px] transition-colors',
                  cfg.poolSource === v
                    ? 'border-violet-500/60 bg-violet-500/15 text-violet-200'
                    : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:text-zinc-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[9px] leading-3.5 text-zinc-600">
            {cfg.poolSource === 'watchlist' && '以你選的關注清單作為候選池。'}
            {cfg.poolSource === 'auto' && '候選池 = 全美股自動篩選 Top 50（波動+流動性），不看關注清單。'}
            {cfg.poolSource === 'union' && '關注清單優先，剩餘名額由自動選股 Top 50 補滿。'}
          </p>
        </div>
        {/* v2.12.37 — entry protocol: React plan-wait vs legacy instant fire */}
        <div className="col-span-2 space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">進場模式（React &gt; Respond &gt; Review）</Label>
          <div className="flex gap-1" role="radiogroup" aria-label="進場模式">
            {([['react', 'React 計劃'], ['instant', '即時下單']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={cfg.entryMode === v}
                onClick={() => updateConfig({ entryMode: v })}
                className={cn(
                  'h-6 flex-1 rounded border px-1.5 text-[10px] transition-colors',
                  cfg.entryMode === v
                    ? 'border-violet-500/60 bg-violet-500/15 text-violet-200'
                    : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:text-zinc-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[9px] leading-3.5 text-zinc-600">
            {cfg.entryMode === 'react' && '模型先出買/賣觸發計劃（觸發價 + TP/SL）→ 終端監控市場，價格觸及才跟進；反向否定或 48h 逾期作廢並覆盤。'}
            {cfg.entryMode === 'instant' && '達標候選立即以市價單進場（舊制 — 不等市場確認）。'}
          </p>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">K線時間框架</Label>
          <Select value={cfg.timeframe} onValueChange={(v) => updateConfig({ timeframe: v as typeof cfg.timeframe })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="K線時間框架"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {TF_OPTIONS.map((tf) => (
                <SelectItem key={tf} value={tf} className="text-[11px]">{TIMEFRAMES[tf].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">模型</Label>
          {aiCustom ? (
            <span
              className="flex h-7 items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 text-[10px] font-medium text-violet-300"
              title={`自訂 AI 端點 · ${aiCustom.host}（於 Settings → AI Agent 管理）`}
            >
              <Bot className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">自訂 · {aiCustom.model}</span>
            </span>
          ) : (
            <Select value={cfg.model} onValueChange={(v) => updateConfig({ model: v as typeof cfg.model })}>
              <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="模型"><SelectValue /></SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
                {AI_TRADE_MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-[11px]">{m.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">帳戶模式</Label>
          <Select value={cfg.mode} onValueChange={(v) => updateConfig({ mode: v as typeof cfg.mode })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="帳戶模式"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              <SelectItem value="paper" className="text-[11px]">模擬 paper</SelectItem>
              <SelectItem value="live" className="text-[11px] text-rose-400">真實 live</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">最低信心 %</Label>
          <Input
            inputMode="decimal" value={minConf} onChange={(e) => setMinConf(e.target.value)}
            onBlur={() => commitNum(minConf, (n) => updateConfig({ minConfidence: Math.min(Math.max(n, 0), 100) }))}
            className="h-7 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-100" aria-label="最低信心百分比"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">最低 R:R（1:x）</Label>
          <Input
            inputMode="decimal" value={minRR} onChange={(e) => setMinRR(e.target.value)}
            onBlur={() => commitNum(minRR, (n) => updateConfig({ minRR: Math.min(Math.max(n, 0.1), 100) }))}
            className="h-7 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-100" aria-label="最低風險回報比"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">單筆風險 % 權益</Label>
          <Input
            inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)}
            onBlur={() => commitNum(riskPct, (n) => updateConfig({ riskPct: Math.min(Math.max(n, 0.01), 10) }))}
            className="h-7 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-100" aria-label="單筆風險百分比"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">自動倉上限</Label>
          <Input
            inputMode="numeric" value={maxOpen} onChange={(e) => setMaxOpen(e.target.value)}
            onBlur={() => commitNum(maxOpen, (n) => updateConfig({ maxOpenAuto: Math.round(Math.min(Math.max(n, 1), 20)) }))}
            className="h-7 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-100" aria-label="自動倉位上限"
          />
        </div>
        <div className="col-span-2 flex items-center justify-between gap-2">
          <div className="space-y-1">
            <Label className="text-[9px] uppercase tracking-wider text-zinc-500">每輪掃描標數上限</Label>
            <Select value={String(cfg.maxSymbols)} onValueChange={(v) => updateConfig({ maxSymbols: Number(v) })}>
              <SelectTrigger className="h-7 w-full border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="每輪掃描標數上限"><SelectValue /></SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
                {[3, 6, 10, 15, 20, 30, 50].map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-[11px]">{n} 個</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="mt-4 flex cursor-pointer items-center gap-1.5 text-[10px] text-zinc-400">
            <Switch checked={cfg.dryRun} onCheckedChange={(v) => updateConfig({ dryRun: v })} aria-label="試運行模式" />
            試運行（不下單）
          </label>
        </div>
        {/* v2.12.32 — earnings gap-risk hard gate */}
        <div className="col-span-2 flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-zinc-400">
            <Switch checked={cfg.blockEarnings} onCheckedChange={(v) => updateConfig({ blockEarnings: v })} aria-label="避開財報窗口" />
            避開財報窗口
          </label>
          <span className="text-[9px] text-zinc-600">發布前 2 天至發布後禁止開新倉（跳空風險 · 日期未知時放行）</span>
        </div>
        {/* v2.12.33 — regime-dynamic thresholds + concentration gate */}
        <div className="col-span-2 flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-zinc-400">
            <Switch checked={cfg.dynamicThresholds} onCheckedChange={(v) => updateConfig({ dynamicThresholds: v })} aria-label="動態門檻" />
            動態門檻（依 regime）
          </label>
          <span className="text-[9px] text-zinc-600">RISK_OFF 做多 / RISK_ON 做空：信心 +10 · R:R ×1.25</span>
        </div>
        <div className="col-span-2 flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-zinc-400">
            <Switch checked={cfg.blockConcentration} onCheckedChange={(v) => updateConfig({ blockConcentration: v })} aria-label="避開集中風險" />
            避開集中風險
          </label>
          <span className="flex items-center gap-1 text-[9px] text-zinc-600">
            與同向持倉相關 ≥ 0.85 拒單 · 同向上限
            <Input
              inputMode="numeric" value={maxCorr} onChange={(e) => setMaxCorr(e.target.value)}
              onBlur={() => commitNum(maxCorr, (n) => updateConfig({ maxCorrelated: Math.round(Math.min(Math.max(n, 1), 10)) }))}
              className="h-5 w-9 border-zinc-800 bg-zinc-900/80 px-1 text-center text-[10px] text-zinc-100" aria-label="同向持倉上限"
            />
          </span>
        </div>
      </div>

      {/* custom AI Agent endpoint note (overrides the built-in model lane) */}
      {aiCustom && (
        <p className="mt-1.5 text-[9px] leading-3.5 text-violet-400/90">
          推論端點：自訂 {aiCustom.host}（{aiCustom.model}）— 於 Settings → AI Agent 管理
        </p>
      )}

      {/* scan list — which symbols from the selected watchlist participate */}
      <div className="mt-2 rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-500">
            <ListChecks className="h-3 w-3" aria-hidden />
            掃描標的（{scanSymbols.length - excluded.length}/{scanSymbols.length}）
          </span>
          <span className="flex items-center gap-1">
            <button
              onClick={() => setAllExcluded(false)}
              className="rounded px-1 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
              disabled={scanSymbols.length === 0 || excluded.length === 0}
              aria-label="全部加入掃描"
            >全選</button>
            <button
              onClick={() => setAllExcluded(true)}
              className="rounded px-1 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
              disabled={excluded.length >= scanSymbols.length}
              aria-label="全部排除"
            >全不選</button>
          </span>
        </div>
        {scanSymbols.length === 0 ? (
          <p className="mt-1 text-[10px] text-zinc-600">
            {cfg.poolSource !== 'watchlist'
              ? scrBusy === 'loading'
                ? '自動選股載入中…首次篩選約需 10–30 秒'
                : '自動選股清單為空 — 按下方「立即篩選」生成'
              : selectedList
                ? `「${selectedList.name}」沒有可掃描的符號`
                : '尚未選擇關注清單'}
          </p>
        ) : (
          <ul className="terminal-scroll mt-1 max-h-36 space-y-0.5 overflow-y-auto pr-1">
            {(cfg.poolSource === 'watchlist' ? scanItems : scanSymbols).map((item) => {
              if (item.startsWith('#')) {
                return (
                  <li key={item} className="pt-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-600">
                    {item.slice(1)}
                  </li>
                )
              }
              const on = !excluded.includes(item)
              return (
                <li key={item}>
                  <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-zinc-900/70">
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-300">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleSymbol(item)}
                        className="h-3 w-3 accent-violet-500"
                        aria-label={`掃描 ${item}`}
                      />
                      {item}
                    </span>
                    <span className={cn('text-[8.5px]', on ? 'text-emerald-500/80' : 'text-zinc-600')}>
                      {on ? '掃描' : '排除'}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* v2.12.34 — auto watchlist card: the screener Top-50 with the metrics
          that earned each row its rank; [立即篩選] forces a fresh server-side
          screen (rate-limited 2/min — one run costs ~110 snapshot calls) */}
      {cfg.poolSource !== 'watchlist' && (
        <div className="mt-2 rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-500">
              <Radar className="h-3 w-3" aria-hidden />
              自動選股 Top 50
              {screener && (
                <span
                  className={cn(
                    'rounded px-1 py-px text-[8px] font-normal',
                    screener.source === 'real' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400',
                  )}
                >
                  {screener.source === 'real' ? '即時篩選' : '模擬宇宙'}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={syncScreener}
              disabled={scrBusy !== 'idle'}
              className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              aria-label="立即重新篩選美股宇宙"
            >
              <RefreshCw className={cn('h-2.5 w-2.5', scrBusy === 'syncing' && 'animate-spin')} aria-hidden />
              {scrBusy === 'syncing' ? '篩選中…' : '立即篩選'}
            </button>
          </div>
          {screener && (
            <p className="mt-1 text-[9px] leading-3.5 text-zinc-600">
              宇宙 {screener.universeSize.toLocaleString()} 檔 · 通過 {screener.filteredSize.toLocaleString()} · 深篩 {screener.stage2Size}
              {screener.feed ? ` · feed ${screener.feed}` : ''}
              {' · '}{new Date(screener.computedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 更新
              {screener.note ? ` · ${screener.note}` : ''}
            </p>
          )}
          {scrError && (
            <p className="mt-1 text-[9px] leading-3.5 text-rose-400">篩選失敗：{scrError}（掃描會退回關注清單）</p>
          )}
          {scrBusy === 'loading' && !screener && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
              <TaijiSpinner className="h-3 w-3" aria-hidden /> 首次篩選整個美股宇宙，約需 10–30 秒…
            </p>
          )}
          {screener && screener.picks.length > 0 && (
            <>
              <div className="terminal-scroll mt-1 max-h-56 overflow-y-auto pr-1">
                <table className="w-full border-collapse font-mono text-[9.5px] leading-4">
                  <thead>
                    <tr className="text-zinc-600">
                      <th className="w-6 py-0.5 text-left font-normal">#</th>
                      <th className="py-0.5 text-left font-normal">Symbol</th>
                      <th className="py-0.5 text-right font-normal" title="ATR14 佔價百分比（波動因子，權重 40%）">ATR14%</th>
                      <th className="py-0.5 text-right font-normal" title="前一日成交量 ÷ 20 日均量（權重 15%）">量比</th>
                      <th className="py-0.5 text-right font-normal" title="前一日成交金額（流動性因子，權重 30%）">成交額</th>
                      <th className="py-0.5 text-right font-normal">日漲跌</th>
                    </tr>
                  </thead>
                  <tbody>
                    {screener.picks.map((p) => (
                      <tr key={p.symbol} className="border-t border-zinc-900 text-zinc-300">
                        <td className="text-zinc-600">{p.rank}</td>
                        <td>
                          {p.symbol}
                          {p.kind === 'etf' && <span className="ml-1 rounded bg-zinc-800 px-0.5 text-[8px] text-zinc-400">ETF</span>}
                        </td>
                        <td className="text-right">{fmtPct1(p.atrPct)}</td>
                        <td className="text-right">{p.relVol != null ? `${p.relVol.toFixed(1)}×` : '—'}</td>
                        <td className="text-right">{fmtUsdVol(p.dollarVol)}</td>
                        <td className={cn('text-right', p.chgPct != null ? (p.chgPct >= 0 ? 'text-emerald-400/90' : 'text-rose-400/90') : 'text-zinc-600')}>
                          {fmtPct1(p.chgPct, true)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[9px] leading-3.5 text-zinc-600">
                評分 = ATR波動40% + 成交額30% + 量比15% + 日內振幅15%（橫斷面百分位）· 伺服器快取 15 分鐘 · 每輪掃描自動帶入，排除清單同樣生效。
              </p>
            </>
          )}
        </div>
      )}

      {/* sizing explainer + gate reminder */}
      <p className="mt-2 text-[9px] leading-3.5 text-zinc-600">
        門檻：信心 ≥ {cfg.minConfidence}% 且 R:R ≥ 1:{cfg.minRR}（R:R 由終端以{cfg.entryMode === 'react' ? '觸發價' : '停損/目標'}重算，不信任模型算術）。
        {cfg.entryMode === 'react'
          ? `計劃：風險金額 = 權益 × ${cfg.riskPct}% × 信心/100，數量 = 風險金額 ÷ |觸發−停損|，名目上限 50% 權益；市場確認觸發時以市價單跟進並附 TL/SL。`
          : `倉位：風險金額 = 權益 × ${cfg.riskPct}% × 信心/100，數量 = 風險金額 ÷ |現價−停損|，名目上限 50% 權益；市價單附 TL/SL。`}
      </p>

      {liveDanger && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[10px] leading-4 text-rose-300">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          真實帳戶模式 — 達標候選將以真實資金自動下單。請確認風險預算與停損距離。
        </div>
      )}

      {/* actions */}
      <div className="mt-2 flex items-center gap-2">
        {scanning ? (
          <Button size="sm" variant="outline" className="h-7 flex-1 gap-1.5 border-zinc-700 text-[11px] text-zinc-300 hover:bg-zinc-800" onClick={cancelScan}>
            <Square className="h-3 w-3" /> 停止掃描
          </Button>
        ) : (
          <Button size="sm" className="h-7 flex-1 gap-1.5 bg-violet-600 text-[11px] text-white hover:bg-violet-500" onClick={() => void scanOnce()}>
            <Play className="h-3 w-3" /> 立即掃描
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px] text-zinc-500 hover:text-zinc-300" onClick={clearLog} aria-label="清除日誌">
          <Trash2 className="h-3 w-3" /> 清除
        </Button>
      </div>

      {/* last scan verdicts */}
      {verdicts.length > 0 && (() => {
        // v2.12.35 — distribution header: a wall of neutrals is the engine
        // working as designed (win-rate first); make that readable at a
        // glance instead of a list of scary 0% rows.
        const flatN = verdicts.filter((v) => v.direction === 'flat' && v.rejectReason !== AI_EVAL_FAIL_REASON).length
        const longN = verdicts.filter((v) => v.direction === 'long').length
        const shortN = verdicts.filter((v) => v.direction === 'short').length
        const failN = verdicts.filter((v) => v.rejectReason === AI_EVAL_FAIL_REASON).length
        return (
        <div className="mt-2">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">上輪評估（{verdicts.length}）</span>
            <span className="font-mono text-[9px] leading-3 text-zinc-500" aria-label="評估分佈">
              <span className="text-zinc-400">中性 {flatN}</span>
              <span className="mx-1 text-zinc-700">·</span>
              <span className={longN > 0 ? 'text-emerald-400' : 'text-zinc-600'}>偏多 {longN}</span>
              <span className="mx-1 text-zinc-700">·</span>
              <span className={shortN > 0 ? 'text-rose-400' : 'text-zinc-600'}>偏空 {shortN}</span>
              {failN > 0 ? (<>
                <span className="mx-1 text-zinc-700">·</span>
                <span className="text-amber-400">失敗 {failN}</span>
              </>) : null}
            </span>
          </div>
          <ul className="terminal-scroll max-h-44 space-y-1 overflow-y-auto pr-1">
            {verdicts.map((v) => {
              const evalFailed = v.rejectReason === AI_EVAL_FAIL_REASON
              return (
              <li key={v.symbol} className="flex items-center justify-between gap-2 rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-1">
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-zinc-200">
                  {v.passed ? (
                    <CircleCheck className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden />
                  ) : v.direction === 'flat' && !evalFailed ? (
                    <Minus className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
                  ) : (
                    <CircleX className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
                  )}
                  {v.symbol}
                  <span className={cn(
                    'shrink-0 text-[9px]',
                    v.direction === 'long' ? 'text-emerald-400' : v.direction === 'short' ? 'text-rose-400' : 'text-zinc-500',
                  )}>
                    {v.direction === 'long' ? '▲偏多' : v.direction === 'short' ? '▼偏空' : '—中性'}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[9px] leading-3">
                  {/* v2.12.35 — confidence is a TRADE-conviction number: it only
                      means something on a directional call. A flat row now shows
                      the model's own reason (why no trade) instead of a misleading
                      「信心 0%」，and a failed row shows only the failure. */}
                  {v.direction !== 'flat' ? <span className="text-zinc-400">信心 {v.confidence}%</span> : null}
                  {v.rr != null ? <span className="ml-1 text-zinc-400">R:R 1:{v.rr.toFixed(1)}</span> : null}
                  {/* v2.12.37 — react mode: the conditional plans this verdict
                      produced; rejected sides show strikethrough + reason */}
                  {v.plans && v.plans.length > 0 && (
                    <span className="ml-1 inline-flex gap-1 align-baseline">
                      {v.plans.map((p) => (
                        <span
                          key={p.side}
                          title={p.note ?? `${p.side} 觸發 ${p.trigger} · TP ${p.tp} / SL ${p.sl}`}
                          className={p.status === 'created'
                            ? (p.side === 'buy' ? 'text-emerald-400' : 'text-rose-400')
                            : 'text-zinc-600 line-through'}
                        >
                          {p.side === 'buy' ? '▲' : '▼'}{p.status === 'created' ? fmtPx(p.trigger) : '拒'}
                        </span>
                      ))}
                    </span>
                  )}
                  {v.passed ? (
                    <span className="ml-1 text-emerald-400">{v.dryRunNote ? '試運行' : cfg.entryMode === 'react' ? '計劃已建' : '已觸發'}</span>
                  ) : v.direction === 'flat' && !evalFailed ? (
                    <span className="ml-1 text-zinc-500" title={v.reason || v.rejectReason || ''}>{v.reason || v.rejectReason}</span>
                  ) : (
                    <span className={cn('ml-1', evalFailed ? 'text-amber-500' : 'text-zinc-600')}>{v.rejectReason}</span>
                  )}
                </span>
              </li>
              )
            })}
          </ul>
        </div>
        )
      })()}

      {/* v2.12.37 — REACT: the plan waiting room + lifecycle + review stats */}
      {cfg.entryMode === 'react' && (() => {
        const waitingPlans = plans.filter((p) => p.status === 'WAITING')
        const closedPlans = plans.filter((p) => p.status !== 'WAITING').slice(0, 10)
        return (
        <div className="mt-2">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-500">
              <Crosshair className="h-3 w-3" aria-hidden />
              計劃等候區（{waitingPlans.length}）
            </span>
            {planStats && (
              <span className="font-mono text-[9px] leading-3 text-zinc-500" aria-label="計劃覆盤統計">
                <span className="text-emerald-400">執行 {planStats.executed}</span>
                <span className="mx-1 text-zinc-700">·</span>
                <span className="text-zinc-400">等待正確 {planStats.goodWait}</span>
                <span className="mx-1 text-zinc-700">·</span>
                <span className={planStats.missedRun > 0 ? 'text-amber-400' : 'text-zinc-600'}>錯過 {planStats.missedRun}</span>
              </span>
            )}
          </div>
          {waitingPlans.length === 0 && closedPlans.length === 0 ? (
            <p className="text-[10px] text-zinc-600">尚無計劃 — 掃描後模型會在這裡留下買/賣觸發計劃，市場確認才跟進。</p>
          ) : (
            <ul className="terminal-scroll max-h-44 space-y-1 overflow-y-auto pr-1">
              {waitingPlans.map((p) => {
                const dist = p.refPrice > 0 ? ((p.trigger - p.refPrice) / p.refPrice) * 100 : null
                const age = Date.now() - p.createdAt
                const ageLabel = age >= 3600_000 ? `${Math.floor(age / 3600_000)}h` : `${Math.max(1, Math.floor(age / 60_000))}m`
                return (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-1">
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-zinc-200">
                      {p.side === 'buy'
                        ? <TrendingUp className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden />
                        : <TrendingDown className="h-3 w-3 shrink-0 text-rose-400" aria-hidden />}
                      {p.symbol}
                      <span className={cn('shrink-0 text-[9px]', p.side === 'buy' ? 'text-emerald-400' : 'text-rose-400')}>
                        {p.side === 'buy' ? '▲等上攻' : '▼等跌破'}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[9px] leading-3 text-zinc-400">
                      觸發 {fmtPx(p.trigger)}
                      <span className="ml-1 text-zinc-500">TL {fmtPx(p.tp)}/SL {fmtPx(p.sl)}</span>
                      {p.rr > 0 && <span className="ml-1 text-zinc-500">R:R 1:{p.rr.toFixed(1)}</span>}
                      {dist != null && <span className="ml-1 text-violet-300" title="計劃時現價距觸發價的百分比">距 {dist >= 0 ? '+' : ''}{dist.toFixed(1)}%</span>}
                      <span className="ml-1 text-zinc-600">{ageLabel}</span>
                    </span>
                  </li>
                )
              })}
              {closedPlans.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-zinc-900 bg-zinc-950/40 px-2 py-0.5">
                  <span className="flex min-w-0 shrink-0 items-center gap-1.5 font-mono text-[9.5px] text-zinc-400">
                    {p.symbol}
                    <span className={cn(
                      'shrink-0 text-[9px]',
                      p.status === 'EXECUTED' ? 'text-emerald-400'
                        : p.status === 'GATED' ? 'text-amber-400'
                        : 'text-zinc-500',
                    )}>
                      {p.status === 'EXECUTED' ? '已執行'
                        : p.status === 'INVALIDATED' ? '反向作廢'
                        : p.status === 'EXPIRED' ? '逾期'
                        : p.status === 'GATED' ? '閘門擋下'
                        : p.status === 'SUPERSEDED' ? '已更新' : p.status}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-right font-mono text-[9px] text-zinc-600" title={p.statusNote ?? ''}>
                    {p.statusNote ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[9px] leading-3.5 text-zinc-600">
            React &gt; Respond &gt; Review — 價格觸及觸發價才跟進（附計劃 TL/SL）；先碰停損區則反向作廢；48h 逾期作廢。作廢/逾期計劃 24h 後覆盤「等待正確 / 錯過」並寫入永久教訓。
          </p>
        </div>
        )
      })()}

      {/* activity log */}
      <div className="mt-2">
        <span className="mb-1 block text-[9px] font-semibold uppercase tracking-widest text-zinc-500">活動日誌</span>
        {log.length === 0 ? (
          <p className="text-[10px] text-zinc-600">尚無紀錄 — 開啟開關或按「立即掃描」開始。</p>
        ) : (
          <ul className="terminal-scroll max-h-40 space-y-0.5 overflow-y-auto pr-1" aria-live="polite">
            {log.map((e) => (
              <li key={e.id} className="flex items-start gap-1.5 font-mono text-[9.5px] leading-4">
                <span className="shrink-0 text-zinc-600">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={cn(
                  'min-w-0 break-words',
                  e.level === 'success' ? 'text-emerald-400'
                    : e.level === 'warn' ? 'text-amber-400'
                    : e.level === 'error' ? 'text-rose-400'
                    : 'text-zinc-400',
                )}>{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
