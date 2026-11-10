'use client'

// AI 護倉 control panel (v2.12.26) — rendered in the AI Trade tab sidebar,
// under the auto-trade scanner. Pure UI: state + the periodic review engine
// live in @/store/ai-steward (module scope), so the steward keeps patrolling
// when this tab is unmounted. It periodically reviews (1) open positions —
// TP/SL maintenance against performance/US market/VIX, (2) pending orders —
// re-price or cancel when the market moved away, (3) today's closed trades —
// distils reusable lessons. Every action is stored in the DB via
// /api/ai-steward/events and pruned by retention (purgeDays); the distilled
// lessons (記取的教訓) live in the PERMANENT AiStewardLesson memory table
// (v2.12.26 — never retention-purged, fed back into every review cycle,
// curated per-lesson via /api/ai-steward/lessons).
import { useEffect, useState } from 'react'
import {
  ShieldCheck, Play, Square, Trash2, TriangleAlert, CircleCheck, CircleX,
  Minus, BookOpen, RefreshCw, X, Plus,
} from 'lucide-react'
import { useAiStewardStore, type StewardEvent, type StewardLesson } from '@/store/ai-steward'
import { CORE_DISCIPLINES } from '@/lib/ai-steward-disciplines'
import { TaijiSpinner } from '@/components/theme/TaoistLoader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const INTERVAL_OPTIONS = [
  { v: 120, label: '2 分鐘' },
  { v: 300, label: '5 分鐘' },
  { v: 600, label: '10 分鐘' },
  { v: 900, label: '15 分鐘' },
  { v: 1800, label: '30 分鐘' },
  { v: 3600, label: '1 小時' },
]

const PURGE_OPTIONS = [
  { v: 3, label: '3 天' },
  { v: 7, label: '7 天' },
  { v: 14, label: '14 天' },
  { v: 30, label: '30 天' },
  { v: 60, label: '60 天' },
]

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const KIND_META: Record<StewardEvent['kind'], { label: string; cls: string }> = {
  position: { label: '持倉', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
  order: { label: '掛單', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  lesson: { label: '教訓', cls: 'border-violet-500/40 bg-violet-500/10 text-violet-300' },
  cycle: { label: '巡檢', cls: 'border-zinc-600 bg-zinc-800 text-zinc-300' },
  error: { label: '錯誤', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
}

function StatusDot({ status }: { status: StewardEvent['status'] }) {
  return status === 'executed' ? (
    <CircleCheck className="h-3 w-3 shrink-0 text-emerald-400" aria-label="已執行" />
  ) : status === 'failed' ? (
    <CircleX className="h-3 w-3 shrink-0 text-rose-400" aria-label="失敗" />
  ) : status === 'dry_run' ? (
    <TriangleAlert className="h-3 w-3 shrink-0 text-amber-400" aria-label="試運行" />
  ) : status === 'skipped' ? (
    <Minus className="h-3 w-3 shrink-0 text-zinc-500" aria-label="跳過" />
  ) : (
    <BookOpen className="h-3 w-3 shrink-0 text-violet-400" aria-label="記錄" />
  )
}

export default function AiStewardPanel() {
  const cfg = useAiStewardStore((s) => s.config)
  const running = useAiStewardStore((s) => s.running)
  const lastRunAt = useAiStewardStore((s) => s.lastRunAt)
  const nextRunAt = useAiStewardStore((s) => s.nextRunAt)
  const lastSummary = useAiStewardStore((s) => s.lastSummary)
  const events = useAiStewardStore((s) => s.events)
  const log = useAiStewardStore((s) => s.log)
  const addLog = useAiStewardStore((s) => s.addLog)
  const updateConfig = useAiStewardStore((s) => s.updateConfig)
  const setEnabled = useAiStewardStore((s) => s.setEnabled)
  const runOnce = useAiStewardStore((s) => s.runOnce)
  const clearLog = useAiStewardStore((s) => s.clearLog)
  const setEvents = useAiStewardStore((s) => s.setEvents)
  // v2.12.24 — cross-device sync: who is the elected runner (null = off/unknown)
  const runnerInfo = useAiStewardStore((s) => s.runnerInfo)
  // v2.12.26 — PERMANENT lesson memory + its store hooks
  const lessons = useAiStewardStore((s) => s.lessons)
  const setLessons = useAiStewardStore((s) => s.setLessons)
  const deleteLesson = useAiStewardStore((s) => s.deleteLesson)
  const addLesson = useAiStewardStore((s) => s.addLesson)
  // manual lesson input (v2.12.26 — the user's own rules live in the same memory)
  const [lessonDraft, setLessonDraft] = useState('')
  const [addingLesson, setAddingLesson] = useState(false)
  const submitLesson = async () => {
    const text = lessonDraft.trim()
    if (!text || addingLesson) return
    setAddingLesson(true)
    const ok = await addLesson(text)
    setAddingLesson(false)
    if (ok) setLessonDraft('')
  }

  // pull the DB trail on mount (also feeds the engine's 記憶 before the first cycle)
  useEffect(() => {
    let alive = true
    fetch('/api/ai-steward/events')
      .then((r) => r.json())
      .then((j: { events?: StewardEvent[] }) => { if (alive && Array.isArray(j.events)) setEvents(j.events) })
      .catch(() => {})
    // v2.12.26 — the PERMANENT lesson memory (never retention-purged)
    fetch('/api/ai-steward/lessons')
      .then((r) => r.json())
      .then((j: { lessons?: StewardLesson[] }) => { if (alive && Array.isArray(j.lessons)) setLessons(j.lessons) })
      .catch(() => {})
    return () => { alive = false }
  }, [setEvents, setLessons])

  // 1s ticker for the next-run countdown (only while armed)
  const [, tickTock] = useState(0)
  useEffect(() => {
    if (!cfg.enabled || !nextRunAt) return
    const t = setInterval(() => tickTock((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [cfg.enabled, nextRunAt])

  const shownEvents = events.filter((e) => e.kind !== 'lesson').slice(0, 40)
  // v2.12.24 — enabled on the account but the elected runner is ANOTHER
  // device: honest amber pill (the steward is NOT running in this browser).
  const remoteRunner = Boolean(cfg.enabled && runnerInfo && !runnerInfo.isMe)

  const toggleEventWatch = async () => {
    if (events.length === 0) return
    try {
      const r = await fetch('/api/ai-steward/events', { method: 'DELETE' })
      const j = await r.json() as { ok?: boolean; deleted?: number }
      if (j.ok) {
        setEvents([])
        addLog('info', `已清除 ${j.deleted ?? 0} 條護倉記錄（教訓永久保留）`)
      }
    } catch { /* offline — leave as-is */ }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" data-testid="ai-steward-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-100">
          <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
          AI 護倉
          {cfg.dryRun && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-400">試運行</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
              running
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : remoteRunner
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                  : cfg.enabled
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-500',
            )}
            title={remoteRunner ? `由 ${runnerInfo?.name ?? '其他裝置'} 執行 — 本機待命` : undefined}
          >
            {running && <TaijiSpinner className="h-2.5 w-2.5" aria-hidden />}
            {running ? '檢視中' : remoteRunner ? '其他裝置運行中' : cfg.enabled ? '運行中' : '已停止'}
          </span>
          <Switch checked={cfg.enabled} onCheckedChange={setEnabled} aria-label="啟用 AI 護倉" />
        </span>
      </div>

      <p className="mt-1 text-[10px] leading-4 text-zinc-500">
        定期審視持倉 TP/SL、待成交掛單與今日平倉，依市況（SPY/QQQ/VIX）維護倉位並記取教訓。
      </p>

      {/* status line */}
      <p className="mt-1.5 font-mono text-[10px] leading-4 text-zinc-500">
        {remoteRunner
          ? `由 ${runnerInfo?.name ?? '其他裝置'} 執行 — 本機待命（裝置離線自動接管）`
          : nextRunAt && cfg.enabled
            ? `下次檢視 ${fmtCountdown(nextRunAt - Date.now())}`
            : cfg.enabled
              ? '排程中…'
              : '護倉未運行'}
        {!remoteRunner && lastRunAt ? ` · 上次 ${new Date(lastRunAt).toLocaleTimeString()}` : ''}
      </p>
      {lastSummary && (
        <p className="mt-1 rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-1 font-mono text-[10px] leading-4 text-zinc-400">
          {lastSummary}
        </p>
      )}

      {/* config grid */}
      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">檢視間隔</Label>
          <Select value={String(cfg.intervalSec)} onValueChange={(v) => updateConfig({ intervalSec: Number(v) })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="檢視間隔"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {INTERVAL_OPTIONS.map((o) => (
                <SelectItem key={o.v} value={String(o.v)} className="text-[11px]">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">交易模式</Label>
          <Select value={cfg.mode} onValueChange={(v) => updateConfig({ mode: v as typeof cfg.mode })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="交易模式"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              <SelectItem value="paper" className="text-[11px]">Paper 模擬</SelectItem>
              <SelectItem value="live" className="text-[11px]">Live 實盤</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">信心門檻 %</Label>
          <Input
            value={String(cfg.minConfidence)}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) updateConfig({ minConfidence: Math.min(Math.max(Math.round(n), 0), 100) }) }}
            inputMode="numeric"
            className="h-7 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-200"
            aria-label="信心門檻百分比"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">每輪動作上限</Label>
          <Input
            value={String(cfg.maxActionsPerCycle)}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) updateConfig({ maxActionsPerCycle: Math.min(Math.max(Math.round(n), 1), 10) }) }}
            inputMode="numeric"
            className="h-7 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-200"
            aria-label="每輪動作上限"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">記錄保留</Label>
          <Select value={String(cfg.purgeDays)} onValueChange={(v) => updateConfig({ purgeDays: Number(v) })}>
            <SelectTrigger className="h-7 border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="記錄保留天數"><SelectValue /></SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {PURGE_OPTIONS.map((o) => (
                <SelectItem key={o.v} value={String(o.v)} className="text-[11px]">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[9px] uppercase tracking-wider text-zinc-500">權限</Label>
          <div className="flex flex-col gap-1 pt-0.5 text-[10px] text-zinc-400">
            <label className="flex items-center gap-1.5">
              <Switch checked={cfg.amendPositions} onCheckedChange={(v) => updateConfig({ amendPositions: v })} aria-label="允許調整持倉 TP/SL" className="scale-90" />
              調整持倉 TP/SL
            </label>
          </div>
        </div>
      </div>

      {/* remaining permission switches */}
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-zinc-400">
        <label className="flex items-center gap-1.5">
          <Switch checked={cfg.amendOrders} onCheckedChange={(v) => updateConfig({ amendOrders: v })} aria-label="允許修改掛單" className="scale-90" />
          修改掛單 entry/TP/SL
        </label>
        <label className="flex items-center gap-1.5">
          <Switch checked={cfg.cancelOrders} onCheckedChange={(v) => updateConfig({ cancelOrders: v })} aria-label="允許取消掛單" className="scale-90" />
          取消不利掛單
        </label>
        <label className="flex items-center gap-1.5">
          <Switch checked={cfg.closePositions} onCheckedChange={(v) => updateConfig({ closePositions: v })} aria-label="允許市價平倉" className="scale-90" />
          市價平倉（高風險）
        </label>
        <label className="flex items-center gap-1.5">
          <Switch checked={cfg.dryRun} onCheckedChange={(v) => updateConfig({ dryRun: v })} aria-label="試運行模式" className="scale-90" />
          試運行（只建議不動單）
        </label>
      </div>

      {/* actions */}
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 flex-1 gap-1 bg-emerald-600 text-[10px] text-white hover:bg-emerald-500"
          onClick={() => void runOnce()}
          disabled={running}
        >
          <RefreshCw className="h-3 w-3" /> 立即檢視
        </Button>
        {cfg.enabled ? (
          <Button size="sm" variant="outline" className="h-7 gap-1 border-zinc-700 text-[10px] text-zinc-300 hover:bg-zinc-800" onClick={() => setEnabled(false)}>
            <Square className="h-3 w-3" /> 停止
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 gap-1 border-zinc-700 text-[10px] text-zinc-300 hover:bg-zinc-800" onClick={() => setEnabled(true)}>
            <Play className="h-3 w-3" /> 啟動
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[10px] text-zinc-500 hover:text-zinc-300" onClick={() => void toggleEventWatch()} disabled={events.length === 0} aria-label="清除護倉記錄">
          <Trash2 className="h-3 w-3" /> 記錄
        </Button>
      </div>

      {/* activity log (in-memory, this session) */}
      {log.length > 0 && (
        <div className="mt-2 max-h-36 overflow-y-auto terminal-scroll rounded border border-zinc-800 bg-zinc-950/60 p-1.5" aria-label="護倉活動日誌">
          {log.slice(-30).map((l) => (
            <p key={l.id} className="flex gap-1.5 font-mono text-[10px] leading-4">
              <span className="shrink-0 text-zinc-600">{new Date(l.at).toLocaleTimeString()}</span>
              <span className={cn(
                'min-w-0',
                l.level === 'success' ? 'text-emerald-400' : l.level === 'warn' ? 'text-amber-400' : l.level === 'error' ? 'text-rose-400' : 'text-zinc-400',
              )}>{l.text}</span>
            </p>
          ))}
        </div>
      )}

      {/* DB trail: actions */}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">護倉記錄（DB · 保留 {cfg.purgeDays} 天）</span>
          <span className="text-[9px] text-zinc-600">{events.length} 條</span>
        </div>
        {shownEvents.length === 0 ? (
          <p className="text-[10px] leading-4 text-zinc-600">尚無記錄 — 啟動或「立即檢視」後，每個動作與理由都會存入資料庫並定期清理。</p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto terminal-scroll pr-1">
            {shownEvents.map((e) => (
              <li key={e.id} className="flex items-start gap-1.5 rounded border border-zinc-800/70 bg-zinc-950/50 px-1.5 py-1">
                <StatusDot status={e.status} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className={cn('rounded border px-1 text-[8px] font-medium', KIND_META[e.kind].cls)}>{KIND_META[e.kind].label}</span>
                    {e.symbol && <span className="font-mono text-[9px] font-semibold text-zinc-300">{e.symbol}</span>}
                    <span className="text-[8px] text-zinc-600">{new Date(e.createdAt).toLocaleString()}</span>
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-zinc-400">{e.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* v2.12.29 — core disciplines: code-level standing orders, always fed
          to every review cycle; unlike user lessons these can never be
          deleted, trimmed, or forgotten */}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">核心紀律（系統內建 · 永遠遵守）</span>
          <ShieldCheck className="h-3 w-3 text-emerald-500" aria-hidden />
        </div>
        <ul className="space-y-1">
          {CORE_DISCIPLINES.map((d, i) => (
            <li key={i} className="flex items-start gap-1.5 rounded border border-emerald-900/40 bg-emerald-500/5 px-1.5 py-1" data-testid="core-discipline">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
              <span className="min-w-0 flex-1 text-[10px] leading-4 text-zinc-300">{d}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* PERMANENT memory: lessons (v2.12.26 — never retention-purged) */}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">記取的教訓（永久記憶 · 餵回每輪檢視）</span>
          <span className="text-[9px] text-zinc-600">{lessons.length} 條</span>
        </div>
        {/* manual add — the user's own rules join the AI's distilled memory */}
        <div className="mb-1.5 flex items-center gap-1">
          <Input
            value={lessonDraft}
            onChange={(e) => setLessonDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitLesson() }}
            placeholder="手動加入教訓…（Enter 或＋）"
            maxLength={200}
            className="h-7 min-w-0 flex-1 border-zinc-800 bg-zinc-900/80 px-2 text-[10px] text-zinc-200 placeholder:text-zinc-600"
            aria-label="手動加入教訓"
            data-testid="lesson-input"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-0.5 border-violet-800/60 px-1.5 text-[10px] text-violet-300 hover:bg-violet-500/10"
            onClick={() => void submitLesson()}
            disabled={!lessonDraft.trim() || addingLesson}
            aria-label="加入教訓"
            data-testid="lesson-add"
          >
            <Plus className="h-3 w-3" aria-hidden /> 加入
          </Button>
        </div>
        {lessons.length === 0 ? (
          <p className="text-[10px] leading-4 text-zinc-600">尚無教訓 — 檢視今日平倉後歸納的改善會永久保存（不隨記錄清理刪除），並於每輪檢視時回饋給 AI。</p>
        ) : (
          <ul className="max-h-44 space-y-1 overflow-y-auto terminal-scroll pr-1">
            {lessons.map((l) => (
              <li key={l.id} className="flex items-start gap-1.5 rounded border border-violet-900/40 bg-violet-500/5 px-1.5 py-1">
                <BookOpen className="mt-0.5 h-3 w-3 shrink-0 text-violet-400" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] leading-4 text-zinc-300">{l.text}</span>
                  <span className="mt-0.5 block text-[8px] text-zinc-600" title={`首次學於 ${new Date(l.createdAt).toLocaleString()}`}>
                    學於 {new Date(l.createdAt).toLocaleDateString()}{l.lastSeenAt !== l.createdAt ? ` · 最近強化 ${new Date(l.lastSeenAt).toLocaleDateString()}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void deleteLesson(l.id)}
                  className="mt-0.5 rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                  aria-label={`刪除教訓：${l.text}`}
                  title="刪除此教訓（其餘永久保留）"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-2 text-[9px] leading-4 text-zinc-600">
        安全：只動手動來源的倉/單（algo/grid 引擎管理中的不碰）；每個動作須過信心門檻與方位/幅度檢查；每輪有動作上限。AI 建議僅供參考，不構成投資建議。
      </p>
    </div>
  )
}
