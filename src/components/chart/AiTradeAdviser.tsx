'use client'

// AI Trade Adviser (v2.12.17) — per-chart floating panel.
// One-click chart reading by the EdgeZero model: the panel computes a
// technical snapshot from the bars ALREADY loaded in this chart (no extra
// market fetches) and asks the model for a structured read: bias → levels →
// risks → plan. Follow-up questions keep the same grounding. Honesty
// contract: if bars aren't loaded, the panel says so instead of guessing.
// v2.12.18 — the panel is MOVE-ABLE: drag the header anywhere inside the
// chart container (pointer events, clamped so it can't be lost off-panel),
// double-click or 「還原」 snaps back to the default dock; arrow keys move it
// for keyboard users.
// v2.12.21 — the panel follows the user's AI Agent lane (Settings → AI Agent
// API): when a custom OpenAI-compatible endpoint is saved the hardcoded
// EdgeZero model Select is REPLACED by a 「自訂 · model」 badge — the chat
// route uses the saved model anyway, so offering edge0 choices there was
// misleading. Re-probes on the tt:settings-changed event.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, SendHorizontal, Square, X, LineChart, GripVertical, Bot } from 'lucide-react'
import {
  AI_TRADE_MODELS, AI_TRADE_DEFAULT_MODEL,
  buildChartSnapshot, snapshotToText,
  type AiTradeModel, type AiChatMsg,
} from '@/lib/ai-trade'
import type { Bar } from '@/lib/market-types'
import { TaijiSpinner } from '@/components/theme/TaoistLoader'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const CHART_PROMPT =
  `請根據 DATA 區的技術快照分析此圖表，用繁體中文，依序給：\n` +
  `1) 方向觀點（偏多/偏空/中性 + 一句理由）\n` +
  `2) 關鍵支撐與阻力（用快照裡的實際價位）\n` +
  `3) 風險與失效條件\n` +
  `4) 若要進場的計劃（進場區 / 止損 / 目標，以 ATR 概念給距離）\n` +
  `若快照不足以支撐結論，請誠實說明缺少什麼。`

type Turn = AiChatMsg

/** null = docked at the default spot (right-2 top-12); numbers = free position inside the chart container. */
type PanelPos = { left: number; top: number } | null

interface DragState {
  grabDX: number // pointer → panel-left offset (viewport px)
  grabDY: number
  prLeft: number // chart container origin (viewport px)
  prTop: number
  pW: number // container size
  pH: number
  w: number // panel size
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
/** keep at least the header strip visible at the bottom edge */
const MIN_VISIBLE = 36

const SETTINGS_CHANGED_EVENT = 'tt:settings-changed'

export function AiTradeAdviser({
  symbol,
  timeframe,
  livePrice,
  getBars,
  onClose,
}: {
  symbol: string
  timeframe: string
  livePrice: number | null
  getBars: () => Bar[]
  onClose: () => void
}) {
  const [model, setModel] = useState<AiTradeModel>(AI_TRADE_DEFAULT_MODEL)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [barError, setBarError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pos, setPos] = useState<PanelPos>(null)
  // v2.12.21 — the saved AI Agent config (Settings → AI Agent API) owns the
  // model lane: non-null = show 「自訂 · model」 instead of the EdgeZero Select.
  const [aiCustom, setAiCustom] = useState<{ model: string; host: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, busy])

  // follow the user's AI Agent lane; re-probe when Settings saves/removes it
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

  // ---- move-able panel (v2.12.18) -----------------------------------------

  /** Convert the currently-rendered (docked or free) position into explicit container-relative left/top. */
  const materializePos = useCallback((): PanelPos => {
    const panel = panelRef.current
    const parent = panel?.offsetParent as HTMLElement | null
    if (!panel || !parent) return null
    const r = panel.getBoundingClientRect()
    const pr = parent.getBoundingClientRect()
    return { left: r.left - pr.left, top: r.top - pr.top }
  }, [])

  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // the close button lives in the header — clicking it must not start a drag
    if ((e.target as HTMLElement).closest('button')) return
    const panel = panelRef.current
    const parent = panel?.offsetParent as HTMLElement | null
    if (!panel || !parent) return
    const m = materializePos()
    if (!m) return
    const pr = parent.getBoundingClientRect()
    dragRef.current = {
      grabDX: e.clientX - (pr.left + m.left),
      grabDY: e.clientY - (pr.top + m.top),
      prLeft: pr.left,
      prTop: pr.top,
      pW: parent.clientWidth,
      pH: parent.clientHeight,
      w: panel.offsetWidth,
    }
    setPos(m) // switch from docked (right-anchored) to explicit left/top anchoring
    setDragging(true)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* older engines */ }
  }, [materializePos])

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const left = clamp(e.clientX - d.grabDX - d.prLeft, 0, Math.max(0, d.pW - d.w))
    const top = clamp(e.clientY - d.grabDY - d.prTop, 0, Math.max(0, d.pH - MIN_VISIBLE))
    setPos({ left, top })
  }, [])

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }, [])

  const resetPos = useCallback(() => setPos(null), [])

  // keyboard: arrows nudge 12px (Shift = 32px) — first press materializes the docked spot
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 12
    const dv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!dv) return
    e.preventDefault()
    const panel = panelRef.current
    const parent = panel?.offsetParent as HTMLElement | null
    if (!panel || !parent) return
    setPos((cur) => {
      const base = cur ?? materializePos()
      if (!base) return cur
      return {
        left: clamp(base.left + dv[0], 0, Math.max(0, parent.clientWidth - panel.offsetWidth)),
        top: clamp(base.top + dv[1], 0, Math.max(0, parent.clientHeight - MIN_VISIBLE)),
      }
    })
  }, [materializePos])

  const ask = useCallback(async (content: string) => {
    if (busy || !content.trim()) return
    const bars = getBars()
    if (bars.length < 5) {
      setBarError('圖表資料尚未載入 — 等K線出現後再問。')
      return
    }
    setBarError(null)
    const snapshot = buildChartSnapshot(bars, symbol, timeframe, livePrice)
    const next: Turn[] = [...turns, { role: 'user', content }]
    setTurns(next)
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/ai-trade/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: next.slice(-8),
          context: `Chart technical snapshot (computed from the ${snapshot.barCount} bars currently loaded in this chart):\n${snapshotToText(snapshot)}`,
          maxTokens: 700,
        }),
        signal: ctrl.signal,
      })
      const j = await res.json().catch(() => null)
      if (res.ok && j?.ok && j.content) {
        setTurns((t) => [...t, { role: 'assistant', content: String(j.content) }])
      } else {
        setTurns((t) => [...t, { role: 'assistant', content: `⚠️ ${j?.error || `請求失敗（${res.status}）`}` }])
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setTurns((t) => [...t, { role: 'assistant', content: '⚠️ 連線失敗 — 請稍後再試' }])
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, getBars, symbol, timeframe, livePrice, model, turns])

  return (
    <div
      ref={panelRef}
      className="absolute right-2 top-12 z-40 flex max-h-[calc(100%-3.5rem)] w-[300px] max-w-[calc(100%-1rem)] flex-col rounded-lg border border-zinc-700/80 bg-zinc-900/95 text-xs text-zinc-200 shadow-2xl backdrop-blur"
      style={pos ? { left: pos.left, top: pos.top, right: 'auto' } : undefined}
      role="dialog"
      aria-label={`AI Trade adviser ${symbol}`}
    >
      {/* header = drag handle */}
      <div
        className={cn(
          'flex touch-none select-none items-center justify-between gap-2 border-b border-zinc-800 px-2 py-2',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={startDrag}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetPos}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="heading"
        aria-level={2}
        aria-label={`AI 顧問 ${symbol} — 拖曳移動面板；方向鍵微調；雙擊還原`}
        title="拖曳移動 · 雙擊還原"
      >
        <span className="flex min-w-0 items-center gap-1.5 font-semibold text-zinc-100">
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-400" aria-hidden />
          <span className="truncate">
            AI 顧問 <span className="text-violet-400">{symbol}</span>
            <span className="ml-1 text-[10px] font-normal text-zinc-500">{timeframe}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {pos && (
            <button
              onClick={resetPos}
              aria-label="還原面板位置"
              title="還原位置"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <LineChart className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={onClose} aria-label="Close AI adviser" className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {/* model row + one-shot analyse — the Select only exists on the built-in
          EdgeZero lane; with a saved AI Agent config the saved model is used
          server-side, so the panel badges it instead of offering edge0 picks */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        {aiCustom ? (
          <span
            className="flex h-6 min-w-0 items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 text-[10px] font-medium text-violet-300"
            title={`自訂 AI 端點 · ${aiCustom.host}（於 Settings → AI Agent 管理）`}
          >
            <Bot className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">自訂 · {aiCustom.model}</span>
          </span>
        ) : (
          <Select value={model} onValueChange={(v) => setModel(v as AiTradeModel)}>
            <SelectTrigger className="h-6 w-[150px] border-zinc-800 bg-zinc-900/80 px-2 text-[10px] text-zinc-300" aria-label="AI model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
              {AI_TRADE_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-[10px]">{m.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          size="sm"
          className="ml-auto h-6 gap-1 bg-violet-600 px-2 text-[10px] text-white hover:bg-violet-500"
          onClick={() => void ask(CHART_PROMPT)}
          disabled={busy}
          aria-label="分析此圖表"
        >
          <LineChart className="h-3 w-3" /> 分析此圖表
        </Button>
      </div>

      {/* thread */}
      <div ref={scrollRef} className="terminal-scroll min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {turns.length === 0 && !busy && (
          <div className="space-y-2 pt-1 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 lp-kai text-sm text-[#c2452d]" aria-hidden>道</div>
            <p className="text-[11px] leading-4 text-zinc-500">
              以此圖已載入的K線計算技術快照，交給{aiCustom ? `自訂模型（${aiCustom.model}）` : 'EdgeZero'}推演。<br />不外乎資料、不承諾行情。
            </p>
          </div>
        )}
        {turns.map((t, i) => (
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[92%] whitespace-pre-wrap rounded-md rounded-br-sm bg-zinc-800/80 px-2 py-1.5 text-[11px] leading-4 text-zinc-100">
                {t.content === CHART_PROMPT ? '（請求：分析此圖表）' : t.content}
              </div>
            </div>
          ) : (
            <div key={i} className="whitespace-pre-wrap rounded-md rounded-bl-sm border border-zinc-800 bg-zinc-950/70 px-2 py-1.5 text-[11px] leading-4 text-zinc-200">
              {t.content}
            </div>
          )
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500" role="status" aria-live="polite">
            <TaijiSpinner className="h-3.5 w-3.5 text-zinc-400" /> 推演中…
          </div>
        )}
        {barError && <p className="text-[10px] leading-4 text-amber-400">{barError}</p>}
      </div>

      {/* follow-up composer */}
      <div className="flex items-center gap-1.5 border-t border-zinc-800 p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); setInput('') } }}
          placeholder="追問…"
          disabled={busy}
          aria-label="追問"
          className={cn(
            'h-7 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900/80 px-2 text-[11px] text-zinc-100',
            'placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none',
          )}
        />
        {busy ? (
          <button onClick={() => abortRef.current?.abort()} aria-label="停止" className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:bg-zinc-800">
            <Square className="h-3 w-3" />
          </button>
        ) : (
          <button
            onClick={() => { const v = input; setInput(''); void ask(v) }}
            disabled={!input.trim()}
            aria-label="送出追問"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            <SendHorizontal className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}
