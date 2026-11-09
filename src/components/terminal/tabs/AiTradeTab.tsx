'use client'

// AI Trade tab (v2.12.17) — EdgeZero adviser workspace.
// A chat with the terminal's own OpenAI-compatible edge model, grounded in
// live terminal data: account snapshot, open positions, watchlist quotes.
// All upstream calls are proxied by /api/ai-trade/chat (the API key never
// reaches the browser). Honesty contract: the model is told to say when the
// data is insufficient — the tab never fakes a reply either.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Sparkles, SendHorizontal, Square, RefreshCw, CircleAlert, ShieldAlert } from 'lucide-react'
import { useTerminal, watchlistSymbols } from '@/store/terminal'
import { useAiAutoStore } from '@/store/ai-auto-trade'
import { AI_TRADE_MODELS, AI_TRADE_DEFAULT_MODEL, type AiTradeModel, type AiChatMsg } from '@/lib/ai-trade'
import { visibleAwareInterval } from '@/lib/visible-poll'
import AiAutoTradePanel from './AiAutoTradePanel'
import AiStewardPanel from './AiStewardPanel'
import { TaijiSpinner } from '@/components/theme/TaoistLoader'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

interface CtxState {
  accountLine: string | null
  positions: { symbol: string; side: string; qty: number; avgEntry: number; current: number; upl: number; uplPct: number }[]
  quotes: { symbol: string; price: number; changePct: number; sim?: boolean }[]
  fetchedAt: number | null
  note: string | null // honest degradations (no keys, watchlist empty, …)
}

const SUGGESTIONS = [
  '我的持倉目前有什麼風險？',
  '摘要我的帳戶現況',
  '幫我擬一份 BTC/USD 的短線計劃',
  '根據我的關注清單，現在哪個標的最值得看？',
]

const EMPTY_CTX: CtxState = { accountLine: null, positions: [], quotes: [], fetchedAt: null, note: null }

// v2.12.20 — same event SettingsDialog dispatches after an AI Agent endpoint
// save; kept as a literal so this tab doesn't pull the whole dialog module in.
const SETTINGS_CHANGED_EVENT = 'tt:settings-changed'

// v2.12.26 — the right AI bar (自動交易 + 護倉 + context cards) is RESIZABLE:
// drag the separator between the chat and the bar, use ←/→ keys (Shift = big
// step), or double-click to reset. Width persists per browser
// (bh-aitrade-barw-v1); mobile stacks vertically so the handle hides below lg.
const BAR_W_LS_KEY = 'bh-aitrade-barw-v1'
const BAR_W_MIN = 260
const BAR_W_MAX = 560
const BAR_W_DEFAULT = 320
function loadBarWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(BAR_W_LS_KEY))
    return Number.isFinite(n) && n > 0 ? Math.min(BAR_W_MAX, Math.max(BAR_W_MIN, Math.round(n))) : BAR_W_DEFAULT
  } catch {
    return BAR_W_DEFAULT
  }
}

export default function AiTradeTab() {
  const watchlists = useTerminal((s) => s.watchlists)
  // v2.12.19 — which watchlist feeds the quotes card AND the auto-trade scan
  // (one shared choice, stored in the auto-trade config); '#Group' separators
  // never leak into quotes again.
  const autoWatchlistId = useAiAutoStore((s) => s.config.watchlistId)
  const updateAutoConfig = useAiAutoStore((s) => s.updateConfig)
  const selectedList = watchlists.find((l) => l.id === autoWatchlistId) ?? watchlists[0] ?? null

  const [model, setModel] = useState<AiTradeModel>(AI_TRADE_DEFAULT_MODEL)
  const [messages, setMessages] = useState<AiChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState<{
    ok: boolean
    error?: string
    custom?: boolean
    endpointHost?: string
    model?: string
  } | null>(null)
  const [includeCtx, setIncludeCtx] = useState(true)
  const [ctx, setCtx] = useState<CtxState>(EMPTY_CTX)
  const [ctxBusy, setCtxBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // v2.12.26 — resizable right AI bar: width state + pointer-drag handling
  const [barW, setBarW] = useState<number>(loadBarWidth)
  const barDrag = useRef<{ startX: number; startW: number } | null>(null)
  const persistBarW = useCallback((w: number) => {
    try { window.localStorage.setItem(BAR_W_LS_KEY, String(w)) } catch { /* private mode */ }
  }, [])
  const onBarSepDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    barDrag.current = { startX: e.clientX, startW: barW }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  const onBarSepMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = barDrag.current
    if (!d) return
    // sidebar sits on the RIGHT: dragging left grows it, dragging right shrinks
    setBarW(Math.min(BAR_W_MAX, Math.max(BAR_W_MIN, Math.round(d.startW - (e.clientX - d.startX)))))
  }
  const onBarSepEnd = () => {
    if (!barDrag.current) return
    barDrag.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    setBarW((w) => { persistBarW(w); return w })
  }
  const onBarSepKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = barW + step // ← widens the right-side bar
    if (e.key === 'ArrowRight') next = barW - step
    if (next !== null) {
      e.preventDefault()
      const clamped = Math.min(BAR_W_MAX, Math.max(BAR_W_MIN, next))
      setBarW(clamped)
      persistBarW(clamped)
    }
  }

  // health probe on mount (re-probed when Settings saves an AI Agent change) —
  // honest 在線/離線 pill + which lane is live (custom endpoint vs EdgeZero)
  useEffect(() => {
    let alive = true
    const probe = () =>
      fetch('/api/ai-trade/health')
        .then((r) => r.json())
        .then((j) => {
          if (alive)
            setHealth({
              ok: Boolean(j.ok),
              error: j.error,
              custom: Boolean(j.custom),
              endpointHost: j.endpointHost,
              model: j.model,
            })
        })
        .catch(() => {
          if (alive) setHealth({ ok: false, error: '無法查詢' })
        })
    probe()
    window.addEventListener(SETTINGS_CHANGED_EVENT, probe)
    return () => {
      alive = false
      window.removeEventListener(SETTINGS_CHANGED_EVENT, probe)
    }
  }, [])

  // ---- live terminal context (account + positions + watchlist quotes) ----
  // v2.12.25 — fetchCtx is the pure data pass; refreshCtx = fetch + render.
  // send() awaits fetchCtx DIRECTLY so every AI judgment is grounded in
  // data fetched at send time (the mount-time snapshot used to go stale for
  // hours — stale buying power/positions fed the model wrong sizing and
  // repeated-buy advice).
  const fetchCtx = useCallback(async (): Promise<CtxState> => {
    const out: CtxState = { ...EMPTY_CTX, fetchedAt: Date.now() }
    try {
      const [accRes, posRes] = await Promise.all([fetch('/api/trading/account'), fetch('/api/trading/positions')])
      if (accRes.ok) {
        const j = await accRes.json().catch(() => null)
        const a = j?.account
        if (a) {
          const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null }
          const bits: string[] = []
          const eq = n(a.equity); if (eq != null) bits.push(`equity ${eq.toFixed(2)}`)
          const bp = n(a.buyingPower ?? a.buying_power); if (bp != null) bits.push(`buying power ${bp.toFixed(2)}`)
          const cash = n(a.cash); if (cash != null) bits.push(`cash ${cash.toFixed(2)}`)
          if (j.mode) bits.push(`mode ${j.mode}`)
          out.accountLine = bits.length ? bits.join(' · ') : null
        } else if (j?.authError?.message || j?.error) {
          out.note = j.authError?.message || j.error
        }
      }
      if (posRes.ok) {
        const j = await posRes.json().catch(() => null)
        out.positions = (Array.isArray(j?.positions) ? j.positions : [])
          .map((p: Record<string, unknown>) => ({
            symbol: String(p.symbol ?? p.tradeSymbol ?? ''),
            side: String(p.side ?? ''),
            qty: Number(p.qty) || 0,
            avgEntry: Number(p.avgEntry ?? p.avg_entry_price) || 0,
            current: Number(p.current ?? p.current_price) || 0,
            upl: Number(p.upl ?? p.unrealized_pl) || 0,
            uplPct: Number(p.uplPct ?? p.unrealized_plpc) || 0,
          }))
          .filter((p: { symbol: string }) => p.symbol)
      }
      // watchlist quotes — selected list (shared with auto-trade), separators
      // filtered out, capped at 30 symbols
      const items = watchlistSymbols(selectedList?.items ?? [])
      if (items.length > 0) {
        const qRes = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: items.slice(0, 30) }),
        })
        if (qRes.ok) {
          const j = await qRes.json().catch(() => null)
          out.quotes = (Array.isArray(j?.quotes) ? j.quotes : [])
            .map((q: { symbol?: string; price?: number; changePct?: number; sim?: boolean }) => ({
              symbol: String(q.symbol ?? ''),
              price: Number(q.price) || 0,
              changePct: Number(q.changePct) || 0,
              sim: Boolean(q.sim),
            }))
            .filter((q: { symbol: string }) => q.symbol)
          // honest degradation: rows the real feed couldn't answer were
          // silently sim-filled — surface it instead of feeding fake prices
          const simRows = out.quotes.filter((q) => q.sim).length
          if (simRows > 0) out.note = out.note ?? `${simRows} 個標的沒有真實行情 — 顯示模擬價（標記「模擬」）`
        }
      } else {
        out.note = out.note ?? (selectedList ? `清單「${selectedList.name}」沒有可顯示的符號` : '關注清單為空 — 無報價上下文')
      }
    } catch {
      out.note = out.note ?? '部分上下文取得失敗（離線？）'
    }
    return out
  }, [watchlists, selectedList])

  const refreshCtx = useCallback(async () => {
    setCtxBusy(true)
    const out = await fetchCtx()
    setCtx(out)
    setCtxBusy(false)
  }, [fetchCtx])

  // v2.12.25 — the context cards (帳戶/持倉/關注清單報價) used to fetch ONCE
  // on mount and only on the manual 重新整理 button, so the sidebar showed
  // stale buying power/positions for hours. 15s visible-aware polling keeps
  // them current (paused while the tab is hidden, one catch-up on return).
  useEffect(() => {
    const stop = visibleAwareInterval(() => void refreshCtx(), 15_000)
    const onChanged = () => void refreshCtx()
    window.addEventListener('tt:positions-changed', onChanged)
    window.addEventListener('tt:settings-changed', onChanged)
    return () => {
      stop()
      window.removeEventListener('tt:positions-changed', onChanged)
      window.removeEventListener('tt:settings-changed', onChanged)
    }
  }, [refreshCtx])

  // keep the thread pinned to the latest bubble
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  const buildContext = useCallback((state?: CtxState) => {
    const c = state ?? ctx
    const parts: string[] = []
    if (c.accountLine) parts.push(`ACCOUNT: ${c.accountLine}`)
    if (c.positions.length > 0) {
      parts.push(
        'OPEN POSITIONS:\n' +
          c.positions
            .map((p) => `- ${p.symbol} ${p.side} ${p.qty} @ ${p.avgEntry}, now ${p.current}, uP/L ${p.upl.toFixed(2)} (${p.uplPct.toFixed(2)}%)`)
            .join('\n'),
      )
    } else {
      parts.push('OPEN POSITIONS: none')
    }
    if (c.quotes.length > 0) {
      parts.push(
        'WATCHLIST QUOTES:\n' +
          c.quotes
            // v2.12.25 — simulated rows are labeled IN the prompt so the model
            // never treats a synthetic price as market data
            .map((q) => `- ${q.symbol}: ${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today)${q.sim ? ' [SIMULATED — not real market data]' : ''}`)
            .join('\n'),
      )
    }
    return parts.join('\n\n')
  }, [ctx])

  const send = useCallback(async (text?: string) => {
    const content = (text ?? input).trim()
    if (!content || busy) return
    setInput('')
    const next: AiChatMsg[] = [...messages, { role: 'user', content }]
    setMessages(next)
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      // v2.12.25 — judge on FRESH data: re-fetch the context at send time
      // (account/positions/quotes), render it, and build the prompt from it.
      // The mount-time snapshot could be hours old — stale buying power and
      // positions used to drive repeated-buy / wrong-sizing advice.
      let ctxForPrompt = ctx
      if (includeCtx) {
        setCtxBusy(true)
        ctxForPrompt = await fetchCtx()
        setCtx(ctxForPrompt)
        setCtxBusy(false)
      }
      const res = await fetch('/api/ai-trade/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: next.slice(-24),
          context: includeCtx ? buildContext(ctxForPrompt) : undefined,
        }),
        signal: ctrl.signal,
      })
      const j = await res.json().catch(() => null)
      if (res.ok && j?.ok && j.content) {
        setMessages((m) => [...m, { role: 'assistant', content: String(j.content) }])
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${j?.error || `請求失敗（${res.status}）`}` }])
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setMessages((m) => [...m, { role: 'assistant', content: '⚠️ 連線失敗 — 請稍後再試' }])
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [input, busy, messages, model, includeCtx, ctx, fetchCtx, buildContext])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setBusy(false)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-400" aria-hidden />
          <h1 className="text-sm font-semibold text-zinc-100">AI Trade 交易顧問</h1>
        </div>
        <span className="hidden text-[11px] text-zinc-500 sm:inline">
          {health?.custom ? `自訂端點 · ${health.endpointHost || 'AI Agent'}` : 'EdgeZero · 本地推理邊緣'}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* health pill */}
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
              health == null
                ? 'border-zinc-800 text-zinc-500'
                : health.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-400',
            )}
            title={health?.error}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', health == null ? 'bg-zinc-600' : health.ok ? 'bg-emerald-400' : 'bg-rose-400')} aria-hidden />
            {health == null ? '檢測中…' : health.ok ? '在線' : '離線'}
          </span>
          {/* model picker — replaced by a custom-endpoint badge when the user's
              own AI Agent API is active (the chat route uses its model anyway) */}
          {health?.custom ? (
            <span
              className="flex h-7 items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 text-[11px] font-medium text-violet-300"
              title={`自訂 AI 端點 · ${health.endpointHost ?? ''}（於 Settings → AI Agent 管理）`}
            >
              <Bot className="h-3 w-3" aria-hidden />
              自訂 · {health.model || 'model'}
            </span>
          ) : (
            <Select value={model} onValueChange={(v) => setModel(v as AiTradeModel)}>
              <SelectTrigger className="h-7 w-[170px] border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-200" aria-label="AI model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
                {AI_TRADE_MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-[11px]">
                    {m.title}
                    <span className="ml-1.5 text-[9px] text-zinc-500">{m.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* context toggle */}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
            <Switch checked={includeCtx} onCheckedChange={setIncludeCtx} aria-label="附帶帳戶與持倉上下文" />
            附帶上下文
          </label>
          <Button
            variant="ghost" size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => void refreshCtx()}
            disabled={ctxBusy}
            aria-label="重新整理上下文"
          >
            {ctxBusy ? <TaijiSpinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重新整理
          </Button>
        </div>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden"
        style={{ '--bar-w': `${barW}px` } as React.CSSProperties}
      >
        {/* chat column */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40" aria-label="AI 對話">
          <div ref={scrollRef} className="terminal-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && !busy && (
              <div className="flex h-full flex-col items-center justify-center gap-4 py-10 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 lp-kai text-xl text-[#c2452d]" aria-hidden>道</div>
                <div>
                  <p className="lp-kai text-base text-zinc-300">「執古之道，以御今之有」</p>
                  <p className="mt-1 text-[11px] text-zinc-600">問市、問倉、問心 —— 資料取自你的終端，模型僅推演，不下單。</p>
                </div>
                <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left text-[11px] text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800/70"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-zinc-800 bg-zinc-800/80 px-3 py-2 text-xs leading-5 text-zinc-100">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex items-start gap-2">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#c2452d]/40 bg-zinc-900 lp-kai text-[11px] text-[#c2452d]" aria-hidden>道</div>
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-bl-sm border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs leading-5 text-zinc-200">
                    {m.content}
                  </div>
                </div>
              )
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-[11px] text-zinc-500" role="status" aria-live="polite">
                <TaijiSpinner className="h-4 w-4 text-zinc-400" />
                推演中…
              </div>
            )}
          </div>
          {/* composer */}
          <div className="border-t border-zinc-800 p-2.5">
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={includeCtx ? '問點什麼…（附帶帳戶/持倉/關注清單上下文）' : '問點什麼…（無上下文模式）'}
                rows={2}
                disabled={busy}
                className="min-h-0 flex-1 resize-none border-zinc-800 bg-zinc-900/80 text-xs text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-zinc-700"
                aria-label="訊息"
              />
              {busy ? (
                <Button variant="outline" size="sm" className="h-9 gap-1.5 border-zinc-700 text-zinc-300 hover:bg-zinc-800" onClick={cancel}>
                  <Square className="h-3.5 w-3.5" /> 停止
                </Button>
              ) : (
                <Button size="sm" className="h-9 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => void send()} disabled={!input.trim()}>
                  <SendHorizontal className="h-3.5 w-3.5" /> 送出
                </Button>
              )}
            </div>
            <p className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-600">
              <ShieldAlert className="h-3 w-3" aria-hidden />
              AI 分析僅供參考，不構成投資建議；實際下單請用交易票 / 演算法 / 網格工具。
            </p>
          </div>
        </section>

        {/* v2.12.26 — drag handle: resize the right AI bar (desktop only) */}
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="調整右側 AI 欄寬度 — 拖曳、左右方向鍵（Shift 大步進）、雙擊重設"
          aria-valuemin={BAR_W_MIN}
          aria-valuemax={BAR_W_MAX}
          aria-valuenow={barW}
          className="hidden w-2 shrink-0 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-violet-500/25 focus-visible:bg-violet-500/40 focus-visible:outline-none active:bg-violet-500/30 relative lg:block"
          data-testid="ai-bar-resizer"
          onPointerDown={onBarSepDown}
          onPointerMove={onBarSepMove}
          onPointerUp={onBarSepEnd}
          onPointerCancel={onBarSepEnd}
          onDoubleClick={() => { setBarW(BAR_W_DEFAULT); persistBarW(BAR_W_DEFAULT) }}
          onKeyDown={onBarSepKey}
          title="拖曳調整 AI 欄寬度 · 雙擊重設"
        >
          <span className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-700" aria-hidden />
        </div>

        {/* context sidebar */}
        <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-[var(--bar-w)] lg:overflow-y-auto terminal-scroll" aria-label="上下文資料">
          {/* v2.12.18 — AI 自動交易：定期掃描關注清單，達門檻自動下單（TL/SL） */}
          <AiAutoTradePanel />
          {/* v2.12.22 — AI 護倉：定期維護持倉 TP/SL、掛單與今日平倉檢討（DB 記錄+定期清理） */}
          <AiStewardPanel />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">帳戶</span>
              {ctx.fetchedAt && <span className="text-[9px] text-zinc-600">{new Date(ctx.fetchedAt).toLocaleTimeString()}</span>}
            </div>
            {ctx.accountLine ? (
              <p className="font-mono text-[11px] leading-5 text-zinc-300">{ctx.accountLine}</p>
            ) : (
              <p className="text-[11px] text-zinc-600">{ctx.note ?? '無帳戶資料'}</p>
            )}
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <span className="mb-2 block text-[10px] font-semibold uppercase tracking-widest text-zinc-500">持倉（{ctx.positions.length}）</span>
            {ctx.positions.length === 0 ? (
              <p className="text-[11px] text-zinc-600">目前無持倉</p>
            ) : (
              <ul className="space-y-1.5">
                {ctx.positions.map((p) => (
                  <li key={p.symbol} className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-zinc-300">{p.symbol}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-zinc-500">{p.side} {p.qty}</span>
                      <span className={cn(p.upl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {p.upl >= 0 ? '+' : ''}{p.upl.toFixed(2)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">關注清單報價（{ctx.quotes.length}）</span>
              {watchlists.length > 0 && (
                <Select
                  value={selectedList?.id ?? ''}
                  onValueChange={(v) => updateAutoConfig({ watchlistId: v, excludedSymbols: [] })}
                >
                  <SelectTrigger className="h-5 w-[130px] border-zinc-800 bg-zinc-900/80 px-1.5 text-[9px] text-zinc-300" aria-label="報價關注清單">
                    <SelectValue placeholder="— 選清單 —" />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-200">
                    {watchlists.map((l) => (
                      <SelectItem key={l.id} value={l.id} className="text-[10px]">
                        {l.name}（{watchlistSymbols(l.items).length}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {ctx.quotes.length === 0 ? (
              <p className="text-[11px] text-zinc-600">{ctx.quotes.length === 0 && ctx.note ? ctx.note : '無資料'}</p>
            ) : (
              <ul className="space-y-1">
                {ctx.quotes.map((q) => (
                  <li key={q.symbol} className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-zinc-300">{q.symbol}</span>
                    <span className="flex items-center gap-2">
                      {q.sim && (
                        <span
                          className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-400"
                          title="模擬價 — 真實行情來源沒有此標的，數值由模擬器生成，不可作為交易依據"
                        >
                          模擬
                        </span>
                      )}
                      <span className="text-zinc-500">{q.price}</span>
                      <span className={cn(q.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {q.changePct >= 0 ? '+' : ''}{q.changePct.toFixed(2)}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {health && !health.ok && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-[11px] leading-5 text-rose-300">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {health.custom ? '自訂 AI 端點' : 'EdgeZero'} 離線（{health.error}）— 對話將無法取得回覆
              {health.custom ? '；可於 Settings → AI Agent 檢查設定或改回內建。' : '。'}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
