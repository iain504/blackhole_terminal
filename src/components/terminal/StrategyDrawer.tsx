'use client'

// Strategy drawer — conditional ("complex") orders: IF an indicator condition
// fires THEN place a market BUY/SELL with optional TP/SL (bracket).
// Complements the Alerts drawer: alarms notify, strategies TRADE.
import { useEffect, useRef, useState } from 'react'
import { useTerminal, Strategy } from '@/store/terminal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Bot, Loader2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ttLog } from '@/lib/console-log'

const TFS = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'] as const
const TF_LABEL: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1D': '1D', '1W': '1W', '1M': '1M' }

/** One-line human summary of a rule's condition half. */
function condSummary(r: Strategy): string {
  const tf = TF_LABEL[r.timeframe] ?? r.timeframe
  if (r.kind === 'rsi') {
    return `RSI(${r.params?.period ?? 14}) crosses ${r.condition === 'cross_below' ? 'below' : 'above'} ${r.level} · ${tf}`
  }
  const p = r.params ?? {}
  const base = `MACD(${p.fast ?? 12},${p.slow ?? 26},${p.signal ?? 9})`
  const cond =
    r.condition === 'bull_cross' ? 'bullish crossover'
    : r.condition === 'bear_cross' ? 'bearish crossover'
    : r.condition === 'cross_above' ? `crosses above ${r.level}`
    : `crosses below ${r.level}`
  return `${base} ${cond} · ${tf}`
}

/** Short TP/SL chip text (no unit suffix — the row renders it). */
function exitChip(mode: string, value: number | null): string | null {
  if (mode === 'pct' && value != null) return `${value >= 10 ? Math.round(value) : value}`
  if (mode === 'price' && value != null) return `${value}`
  return null
}

function statusBadgeCls(status: string): string {
  if (status === 'triggered') return 'border-emerald-500/40 text-emerald-400'
  if (status === 'failed') return 'border-rose-500/40 text-rose-400'
  if (status === 'placing') return 'border-sky-500/40 text-sky-400'
  if (status === 'paused') return 'border-zinc-600 text-zinc-400'
  return 'border-violet-500/40 text-violet-400'
}

export function StrategyDrawer({ onClose }: { onClose: () => void }) {
  const strategies = useTerminal((s) => s.strategies)
  const addStrategyLocal = useTerminal((s) => s.addStrategyLocal)
  const patchStrategyLocal = useTerminal((s) => s.patchStrategyLocal)
  const removeStrategyLocal = useTerminal((s) => s.removeStrategyLocal)
  const activeTab = useTerminal((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0])

  // ---- creation form state ----
  const [kind, setKind] = useState<'rsi' | 'macd'>('rsi')
  const [symbol, setSymbol] = useState('')
  const [tf, setTf] = useState('1D')
  // rsi condition fields
  const [rsiPeriod, setRsiPeriod] = useState('14')
  const [rsiLevel, setRsiLevel] = useState('30')
  // macd condition fields
  const [fast, setFast] = useState('12')
  const [slow, setSlow] = useState('26')
  const [signal, setSignal] = useState('9')
  const [cond, setCond] = useState<'bull_cross' | 'bear_cross' | 'cross_above' | 'cross_below'>('bull_cross')
  const [macdLevel, setMacdLevel] = useState('0')
  // action fields
  const [action, setAction] = useState<'buy' | 'sell'>('buy')
  const [qty, setQty] = useState('1')
  const [tpMode, setTpMode] = useState<'none' | 'price' | 'pct'>('pct')
  const [tpValue, setTpValue] = useState('2')
  const [slMode, setSlMode] = useState<'none' | 'price' | 'pct'>('pct')
  const [slValue, setSlValue] = useState('1')
  const [repeat, setRepeat] = useState(false)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const symTouched = useRef(false)

  // prefill symbol/timeframe from the active chart tab (once)
  useEffect(() => {
    if (symTouched.current) return
    if (activeTab?.symbol) {
      setSymbol(activeTab.symbol)
      if (activeTab.timeframe) setTf(activeTab.timeframe)
    }
  }, [activeTab?.symbol, activeTab?.timeframe])

  const rsiLevelN = parseFloat(rsiLevel)
  const macdLevelN = parseFloat(macdLevel)
  const qtyN = parseFloat(qty)
  const tpN = parseFloat(tpValue)
  const slN = parseFloat(slValue)
  // RSI direction is level-driven (≥50 = overbought trigger, <50 = oversold),
  // mirroring the alarms drawer's level↔direction auto-flip
  const rsiCondition: 'cross_above' | 'cross_below' = rsiLevelN >= 50 ? 'cross_above' : 'cross_below'

  const formValid =
    symbol.trim().length > 0 &&
    Number.isFinite(qtyN) && qtyN > 0 &&
    (kind === 'rsi'
      ? Number.isFinite(rsiLevelN) && rsiLevelN > 0 && rsiLevelN < 100
      : (cond === 'cross_above' || cond === 'cross_below' ? Number.isFinite(macdLevelN) : true)) &&
    (tpMode === 'none' || (Number.isFinite(tpN) && tpN > 0)) &&
    (slMode === 'none' || (Number.isFinite(slN) && slN > 0))

  const summary = `IF ${kind === 'rsi'
    ? `RSI(${parseInt(rsiPeriod, 10) || 14}) crosses ${rsiCondition === 'cross_below' ? 'below' : 'above'} ${rsiLevel || '—'}`
    : `MACD(${parseInt(fast, 10) || 12},${parseInt(slow, 10) || 26},${parseInt(signal, 10) || 9}) ${cond === 'bull_cross' ? 'bullish crossover' : cond === 'bear_cross' ? 'bearish crossover' : cond === 'cross_above' ? `crosses above ${macdLevel || '—'}` : `crosses below ${macdLevel || '—'}`}`
  } · ${TF_LABEL[tf] ?? tf} → THEN ${action.toUpperCase()} ${qty || '—'} ${symbol.toUpperCase() || ''}`

  const create = async () => {
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    setCreating(true)
    setErr(null)
    try {
      const body = {
        symbol: sym,
        kind,
        condition: kind === 'rsi' ? rsiCondition : cond,
        level: kind === 'rsi' ? rsiLevelN : (cond === 'cross_above' || cond === 'cross_below' ? macdLevelN : 0),
        timeframe: tf,
        params:
          kind === 'rsi'
            ? { period: parseInt(rsiPeriod, 10) }
            : { fast: parseInt(fast, 10), slow: parseInt(slow, 10), signal: parseInt(signal, 10) },
        action,
        qty: qtyN,
        tpMode,
        tpValue: tpMode === 'none' ? null : tpN,
        slMode,
        slValue: slMode === 'none' ? null : slN,
        repeat,
      }
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.strategy) {
        addStrategyLocal(json.strategy as Strategy)
        ttLog('strategy', `🤖 Armed: ${condSummary(json.strategy as Strategy)} → ${action.toUpperCase()} ${qtyN} ${sym}`, 'ok')
      } else {
        setErr(json?.error || `HTTP ${res.status}`)
        ttLog('strategy', `Create strategy failed: ${json?.error || res.status}`, 'warn')
      }
    } catch {
      setErr('Network error')
    } finally {
      setCreating(false)
    }
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/strategies/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (res.ok && json?.strategy) patchStrategyLocal(id, json.strategy as Strategy)
  }

  const remove = async (id: string) => {
    removeStrategyLocal(id)
    await fetch(`/api/strategies/${id}`, { method: 'DELETE' })
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Strategy orders">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close strategies" />
      <div className="absolute right-3 top-12 w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5 text-sm font-medium">
          <span className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-violet-400" /> Strategy Orders
          </span>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-xs">
            Close
          </Button>
        </div>

        {/* ---- new strategy form ---- */}
        <div className="border-b border-zinc-800 p-2.5">
          {/* IF row: indicator + symbol */}
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-violet-400">IF</span>
            {(['rsi', 'macd'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                  kind === k
                    ? k === 'rsi' ? 'bg-pink-500/15 text-pink-300' : 'bg-amber-500/15 text-amber-300'
                    : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
                )}
              >
                {k}
              </button>
            ))}
            <Input
              value={symbol}
              onChange={(e) => { symTouched.current = true; setSymbol(e.target.value.toUpperCase()) }}
              placeholder="SYMBOL"
              aria-label="Strategy symbol"
              className="ml-auto h-7 w-[110px] border-zinc-700 bg-zinc-950 text-xs uppercase"
            />
          </div>

          {/* condition fields */}
          {kind === 'rsi' ? (
            <div className="mb-2 flex items-center gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">Len</label>
              <Input
                type="number" value={rsiPeriod} min={2} max={200}
                onChange={(e) => setRsiPeriod(e.target.value)}
                aria-label="RSI period"
                className="h-7 w-14 border-zinc-700 bg-zinc-950 text-xs"
              />
              <select
                value={rsiCondition}
                onChange={(e) => {
                  const below = e.target.value === 'cross_below'
                  setRsiLevel(below ? '30' : '70')
                }}
                aria-label="RSI condition"
                className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-200"
              >
                <option value="cross_above">crosses above</option>
                <option value="cross_below">crosses below</option>
              </select>
              <Input
                type="number" step="any" value={rsiLevel} min={1} max={99}
                onChange={(e) => setRsiLevel(e.target.value)}
                aria-label="RSI level"
                className="h-7 w-16 border-zinc-700 bg-zinc-950 text-xs"
              />
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">F/S/G</span>
              <Input type="number" value={fast} min={1} onChange={(e) => setFast(e.target.value)} aria-label="MACD fast" className="h-7 w-11 border-zinc-700 bg-zinc-950 text-xs" />
              <Input type="number" value={slow} min={2} onChange={(e) => setSlow(e.target.value)} aria-label="MACD slow" className="h-7 w-11 border-zinc-700 bg-zinc-950 text-xs" />
              <Input type="number" value={signal} min={1} onChange={(e) => setSignal(e.target.value)} aria-label="MACD signal" className="h-7 w-11 border-zinc-700 bg-zinc-950 text-xs" />
              <select
                value={cond}
                onChange={(e) => setCond(e.target.value as typeof cond)}
                aria-label="MACD condition"
                className="h-7 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-200"
              >
                <option value="bull_cross">bull crossover</option>
                <option value="bear_cross">bear crossover</option>
                <option value="cross_above">crosses above</option>
                <option value="cross_below">crosses below</option>
              </select>
              {(cond === 'cross_above' || cond === 'cross_below') && (
                <Input
                  type="number" step="any" value={macdLevel}
                  onChange={(e) => setMacdLevel(e.target.value)}
                  aria-label="MACD level"
                  className="h-7 w-16 border-zinc-700 bg-zinc-950 text-xs"
                />
              )}
            </div>
          )}

          {/* timeframe row */}
          <div className="mb-2 flex items-center gap-1">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">TF</label>
            <div className="flex overflow-hidden rounded border border-zinc-700" role="radiogroup" aria-label="Timeframe">
              {TFS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTf(t)}
                  aria-pressed={tf === t}
                  className={cn(
                    'px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                    tf === t ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300',
                  )}
                >
                  {TF_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {/* THEN row: action + qty */}
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">THEN</span>
            <div className="flex overflow-hidden rounded border border-zinc-700" role="radiogroup" aria-label="Order side">
              <button
                onClick={() => setAction('buy')}
                aria-pressed={action === 'buy'}
                className={cn('px-2 py-1 text-[11px] font-bold transition-colors', action === 'buy' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300')}
              >
                BUY
              </button>
              <button
                onClick={() => setAction('sell')}
                aria-pressed={action === 'sell'}
                className={cn('px-2 py-1 text-[11px] font-bold transition-colors', action === 'sell' ? 'bg-rose-500/20 text-rose-300' : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300')}
              >
                SELL
              </button>
            </div>
            <Input
              type="number" step="any" min={0} value={qty}
              onChange={(e) => setQty(e.target.value)}
              aria-label="Order quantity"
              className="h-7 w-20 border-zinc-700 bg-zinc-950 text-xs"
            />
            <span className="text-[10px] text-zinc-500">qty @ market</span>
          </div>

          {/* TP / SL rows */}
          <div className="space-y-1.5">
            {([['tp', 'Take profit'] as const, ['sl', 'Stop loss'] as const]).map(([k, label]) => {
              const mode = k === 'tp' ? tpMode : slMode
              const setMode = k === 'tp' ? setTpMode : setSlMode
              const value = k === 'tp' ? tpValue : slValue
              const setValue = k === 'tp' ? setTpValue : setSlValue
              return (
                <div key={k} className="flex items-center gap-1.5">
                  <label className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-zinc-500">{label}</label>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'none' | 'price' | 'pct')}
                    aria-label={`${label} mode`}
                    className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-200"
                  >
                    <option value="none">— none</option>
                    <option value="pct">% offset</option>
                    <option value="price">price</option>
                  </select>
                  <Input
                    type="number" step="any" min={0} value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && formValid && void create()}
                    disabled={mode === 'none'}
                    aria-label={`${label} value`}
                    className="h-7 flex-1 border-zinc-700 bg-zinc-950 text-xs disabled:opacity-40"
                  />
                  {mode === 'pct' && <span className="text-xs text-zinc-500">%</span>}
                  {mode === 'pct' && (
                    <span className="hidden text-[9px] leading-tight text-zinc-600 sm:block">
                      {action === 'buy' ? (k === 'tp' ? 'above' : 'below') : k === 'tp' ? 'below' : 'above'}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* repeat toggle */}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setRepeat(!repeat)}
              aria-pressed={repeat}
              className={cn(
                'flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors',
                repeat ? 'border-violet-500/40 bg-violet-500/10 text-violet-300' : 'border-zinc-700 bg-zinc-950 text-zinc-500 hover:text-zinc-300',
              )}
              title={repeat ? 'Re-arms after every fire (fresh crossing memory)' : 'One-shot: disarms after the first fire'}
            >
              <Zap className="h-3 w-3" /> {repeat ? 'Repeat' : 'One-shot'}
            </button>
            <span className="truncate text-[10px] text-zinc-600">
              {repeat ? 're-arms after every fire' : 'disarms after the first fire'}
            </span>
          </div>

          {/* live summary */}
          <p className="mt-2 rounded bg-zinc-950/80 px-2 py-1.5 text-[11px] leading-snug text-zinc-400">
            {summary}
          </p>
          {err && <p className="mt-1 text-[11px] text-rose-400">{err}</p>}

          <Button
            size="sm" disabled={!formValid || creating} onClick={() => void create()}
            className="mt-2 h-7 w-full bg-violet-600 text-xs text-white hover:bg-violet-500"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : '🤖 Arm strategy'}
          </Button>
        </div>

        {/* ---- strategy list ---- */}
        <div className="max-h-[42vh] overflow-y-auto p-2">
          {strategies.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-zinc-500">
              No strategies yet — build one above. When the condition fires, the order is placed automatically with its TP/SL.
            </p>
          )}
          {strategies.map((r) => {
            const tp = exitChip(r.tpMode, r.tpValue)
            const sl = exitChip(r.slMode, r.slValue)
            return (
              <div key={r.id} className="rounded-md px-2 py-1.5 text-xs hover:bg-zinc-800/60">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', r.action === 'sell' ? 'bg-rose-500' : 'bg-emerald-500')}
                    />
                    <span className="font-medium text-zinc-200">{r.symbol}</span>
                    <span className="truncate text-zinc-400">{condSummary(r)}</span>
                  </div>
                  <Badge variant="outline" className={cn('shrink-0 text-[10px]', statusBadgeCls(r.status))}>
                    {r.status === 'placing' ? 'placing…' : r.status}
                  </Badge>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 pl-4">
                  <span className="truncate text-[11px] text-zinc-500" title={r.fireNote ?? undefined}>
                    <span className={r.action === 'sell' ? 'text-rose-400' : 'text-emerald-400'}>
                      {r.action.toUpperCase()} {r.qty}
                    </span>
                    {tp && <span className="ml-1.5 text-emerald-500/80">TP {tp}{r.tpMode === 'pct' ? '%' : ''}</span>}
                    {sl && <span className="ml-1.5 text-rose-500/80">SL {sl}{r.slMode === 'pct' ? '%' : ''}</span>}
                    {r.repeat && <span className="ml-1.5 text-violet-400/80">∞</span>}
                    {r.fireNote && <span className="ml-1.5 text-zinc-600">— {r.fireNote}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost" size="sm" className="h-6 px-1.5 text-[10px] text-zinc-400"
                      title={r.repeat ? 'Switch to one-shot' : 'Switch to repeat'}
                      onClick={() => void patch(r.id, { repeat: !r.repeat })}
                    >
                      {r.repeat ? '∞' : '1×'}
                    </Button>
                    {(r.status === 'triggered' || r.status === 'failed' || r.status === 'paused') && (
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => void patch(r.id, { status: 'armed' })}>
                        Re-arm
                      </Button>
                    )}
                    {r.status !== 'triggered' && r.status !== 'failed' && (
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => void patch(r.id, { status: r.status === 'paused' ? 'armed' : 'paused' })}>
                        {r.status === 'paused' ? 'Resume' : 'Pause'}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-rose-400 hover:text-rose-300" onClick={() => void remove(r.id)}>
                      ✕
                    </Button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          Checked every 20s (also server-side) · fires only on a genuine crossing of the chosen timeframe · order placed as market with bracket TP/SL · % legs resolve from the live quote at fire time
        </div>
      </div>
    </div>
  )
}
