'use client'

// AI 自動交易 control panel (v2.12.18) — rendered at the top of the AI Trade
// tab sidebar. Pure UI: all state and the periodic scan engine live in
// @/store/ai-auto-trade (module scope), so the scan keeps running when this
// tab is unmounted. Honesty contract: every candidate shows WHY it passed or
// was rejected; the log never hides a failed order.
import { useEffect, useState } from 'react'
import { Bot, Play, Square, Trash2, TriangleAlert, CircleCheck, CircleX, Minus } from 'lucide-react'
import { useAiAutoStore } from '@/store/ai-auto-trade'
import { AI_TRADE_MODELS } from '@/lib/ai-trade'
import { TIMEFRAMES } from '@/lib/market-types'
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

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function AiAutoTradePanel() {
  const cfg = useAiAutoStore((s) => s.config)
  const scanning = useAiAutoStore((s) => s.scanning)
  const lastScanAt = useAiAutoStore((s) => s.lastScanAt)
  const nextScanAt = useAiAutoStore((s) => s.nextScanAt)
  const verdicts = useAiAutoStore((s) => s.verdicts)
  const fired = useAiAutoStore((s) => s.fired)
  const log = useAiAutoStore((s) => s.log)
  const updateConfig = useAiAutoStore((s) => s.updateConfig)
  const setEnabled = useAiAutoStore((s) => s.setEnabled)
  const scanOnce = useAiAutoStore((s) => s.scanOnce)
  const cancelScan = useAiAutoStore((s) => s.cancelScan)
  const clearLog = useAiAutoStore((s) => s.clearLog)

  // 1s ticker for the next-scan countdown (only while armed)
  const [, tickTock] = useState(0)
  useEffect(() => {
    if (!cfg.enabled || !nextScanAt) return
    const t = setInterval(() => tickTock((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [cfg.enabled, nextScanAt])

  // number fields kept as strings so partial typing doesn't fight the clamps
  const [minConf, setMinConf] = useState(String(cfg.minConfidence))
  const [minRR, setMinRR] = useState(String(cfg.minRR))
  const [riskPct, setRiskPct] = useState(String(cfg.riskPct))
  const [maxOpen, setMaxOpen] = useState(String(cfg.maxOpenAuto))
  useEffect(() => {
    setMinConf(String(cfg.minConfidence))
    setMinRR(String(cfg.minRR))
    setRiskPct(String(cfg.riskPct))
    setMaxOpen(String(cfg.maxOpenAuto))
  }, [cfg])

  const commitNum = (raw: string, apply: (n: number) => void) => {
    const n = Number(raw)
    if (Number.isFinite(n)) apply(n)
  }

  const liveDanger = cfg.mode === 'live' && !cfg.dryRun

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
                : cfg.enabled
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-zinc-700 bg-zinc-800/60 text-zinc-500',
            )}
          >
            {scanning && <TaijiSpinner className="h-2.5 w-2.5" aria-hidden />}
            {scanning ? '掃描中' : cfg.enabled ? '運行中' : '已停止'}
          </span>
          <Switch checked={cfg.enabled} onCheckedChange={setEnabled} aria-label="啟用 AI 自動交易" />
        </span>
      </div>

      {/* status line */}
      <p className="mt-1.5 font-mono text-[10px] leading-4 text-zinc-500">
        {nextScanAt && cfg.enabled
          ? `下次掃描 ${fmtCountdown(nextScanAt - Date.now())}`
          : cfg.enabled
            ? '排程中…'
            : '掃描器未運行'}
        {lastScanAt ? ` · 上次 ${new Date(lastScanAt).toLocaleTimeString()}` : ''}
        {fired.length > 0 ? ` · 已觸發 ${fired.length} 筆` : ''}
      </p>

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
          <Select value={cfg.model} onValueChange={(v) => updateConfig({ model: v as typeof cfg.model })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="模型"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {AI_TRADE_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-[11px]">{m.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                {[3, 6, 10, 15].map((n) => (
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
      </div>

      {/* sizing explainer + gate reminder */}
      <p className="mt-2 text-[9px] leading-3.5 text-zinc-600">
        門檻：信心 ≥ {cfg.minConfidence}% 且 R:R ≥ 1:{cfg.minRR}（R:R 由終端以停損/目標重算，不信任模型算術）。
        倉位：風險金額 = 權益 × {cfg.riskPct}% × 信心/100，數量 = 風險金額 ÷ |現價−停損|，名目上限 50% 權益；市價單附 TL/SL。
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
      {verdicts.length > 0 && (
        <div className="mt-2">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-widest text-zinc-500">上輪評估（{verdicts.length}）</span>
          <ul className="terminal-scroll max-h-44 space-y-1 overflow-y-auto pr-1">
            {verdicts.map((v) => (
              <li key={v.symbol} className="flex items-center justify-between gap-2 rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-1">
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-zinc-200">
                  {v.passed ? (
                    <CircleCheck className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden />
                  ) : v.direction === 'flat' ? (
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
                  <span className="text-zinc-400">信心 {v.confidence}%</span>
                  {v.rr != null ? <span className="ml-1 text-zinc-400">R:R 1:{v.rr.toFixed(1)}</span> : null}
                  {v.passed ? (
                    <span className="ml-1 text-emerald-400">{v.dryRunNote ? '試運行' : '已觸發'}</span>
                  ) : (
                    <span className="ml-1 text-zinc-600">{v.rejectReason}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
