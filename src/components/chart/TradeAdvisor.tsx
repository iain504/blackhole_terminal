'use client'

// Trade Advisor (Task 82) — a one-click technical trade plan on the chart:
//   1. Reuses the Auto S/R detector (src/lib/sr.ts) on a HIGHER timeframe
//      (default 1D) and picks the highest-score level (most pivot touches).
//   2. Anchors a fib retracement between that level and the recent swing
//      extreme, draws it on the chart, and highlights the 0.5–0.618
//      "golden pocket" (meta.golden — the canvas renderer fills the band).
//   3. Populates the advice panel with the optimal entry (golden-pocket
//      midpoint), TP (nearest opposite S/R level, fallback swing extreme)
//      and SL (beyond the anchor by half the pocket height) — every value
//      editable before submitting.
//   4. Confirm → GTC LIMIT order with bracket TP/SL (stocks) or OCO-managed
//      legs (crypto). A resting limit works ANY time — market hours not
//      required (that is the whole point of limit-only advice).
//   5. While armed it actively monitors the live price: waiting / IN GOLDEN
//      ZONE / overshot / invalidated states update on every tick.
//   6. "Clean up" removes every advisor-made line (meta.auto === 'advisor*')
//      — the anchor S/R hline + the fib — leaving user drawings untouched.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X, Sparkles, Eraser, RefreshCw, Lightbulb, Radar, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { useTerminal, DrawingKind, DrawingPoint } from '@/store/terminal'
import { detectSrLevels, SrBar } from '@/lib/sr'
import { isCryptoSymbol, fmtPrice } from '@/lib/market-types'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'
type SideSel = 'auto' | 'long' | 'short'

/** golden-pocket retracement band (user spec: 0.5–0.618) */
const GOLD_LO = 0.5
const GOLD_HI = 0.618
/** optimal entry = midpoint of the golden pocket (0.5+0.618)/2 */
const GOLD_MID = (GOLD_LO + GOLD_HI) / 2

/** Alpaca price increments — mirrors lib/trading fmtPx (server-only module):
 *  crypto 6dp (>=1) / 8dp (<1) · stocks penny 2dp (>=1) / 4dp (<1).
 *  Raw JS floats get 422'd ("sub-penny increment does not fulfill minimum
 *  pricing criteria"). */
function pxOut(v: number, crypto: boolean): number {
  if (!Number.isFinite(v) || v <= 0) return v
  const dp = crypto ? (v >= 1 ? 6 : 8) : v >= 1 ? 2 : 4
  return +v.toFixed(dp)
}

interface Advice {
  side: 'long' | 'short'
  /** the anchor S/R level (leg start) */
  level: number
  levelSide: 'support' | 'resistance'
  touches: number
  tf: string
  /** swing extreme (leg end) */
  swing: number
  swingTime: number
  /** golden pocket in PRICE space: lo < hi always */
  zoneLo: number
  zoneHi: number
  entry: number
  tp: number
  sl: number
  rr: number
  tpSource: 'level' | 'swing' | 'measured'
}

type MonitorState = 'idle' | 'waiting' | 'zone' | 'stale' | 'invalidated'

/** price at retracement fraction f of the leg (f=0 → swing extreme, f=1 → level) */
function priceAt(a: Pick<Advice, 'level' | 'swing'>, f: number): number {
  return a.swing + (a.level - a.swing) * f
}

function monitorState(a: Advice, p: number | null): MonitorState {
  if (p == null || !Number.isFinite(p)) return 'waiting'
  if (a.side === 'long') {
    if (p <= a.sl) return 'invalidated'
    if (p >= a.zoneLo && p <= a.zoneHi) return 'zone'
    if (p < a.zoneLo) return 'stale' // retracement overshot the pocket
    return 'waiting'
  }
  if (p >= a.sl) return 'invalidated'
  if (p >= a.zoneLo && p <= a.zoneHi) return 'zone'
  if (p > a.zoneHi) return 'stale'
  return 'waiting'
}

const MON_LABEL: Record<MonitorState, string> = {
  idle: '—',
  waiting: 'waiting for the pullback',
  zone: 'PRICE IN GOLDEN ZONE',
  stale: 'price overshot the zone',
  invalidated: 'invalidated (beyond SL)',
}

export function TradeAdvisor({
  symbol,
  livePrice,
  onClose,
  createDrawing,
  deleteDrawing,
}: {
  symbol: string
  livePrice: number | null
  onClose: () => void
  createDrawing: (kind: DrawingKind, points: DrawingPoint[], opts?: { meta?: Record<string, unknown> | null; color?: string }) => Promise<void>
  deleteDrawing: (id: string) => Promise<void>
}) {
  const { toast } = useToast()
  const isCrypto = isCryptoSymbol(symbol)

  // ---- movable panel (Task 82b): drag by the header, same pattern as the
  // trade ticket (Task 54.3) — left/top px inside the chart container,
  // persisted in the terminal layout (rides export/import + autosave) ----
  const advisorPos = useTerminal((s) => s.advisorPos)
  const setAdvisorPos = useTerminal((s) => s.setAdvisorPos)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const lastPos = useRef<{ x: number; y: number } | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const pos = dragPos ?? advisorPos

  const clampPos = useCallback((x: number, y: number): { x: number; y: number } => {
    const el = rootRef.current
    const parent = el?.parentElement
    if (!el || !parent) return { x, y }
    const pw = parent.clientWidth
    const ph = parent.clientHeight
    if (!(pw > 0) || !(ph > 0)) return { x, y }
    const maxX = Math.max(4, pw - el.offsetWidth - 4)
    const maxY = Math.max(4, ph - el.offsetHeight - 4)
    return { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) }
  }, [])

  // a saved position may fall outside after a chart resize — clamp VISUALLY
  // on mount (the stored value stays until the next drag commit)
  useEffect(() => {
    if (advisorPos) setDragPos(clampPos(advisorPos.x, advisorPos.y))
  }, [advisorPos, clampPos])

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return // close button
    const el = rootRef.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const er = el.getBoundingClientRect()
    const pr = parent.getBoundingClientRect()
    const origX = er.left - pr.left
    const origY = er.top - pr.top
    dragState.current = { startX: e.clientX, startY: e.clientY, origX, origY }
    lastPos.current = { x: origX, y: origY }
    setDragPos({ x: origX, y: origY })
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current
    if (!st) return
    const next = clampPos(st.origX + (e.clientX - st.startX), st.origY + (e.clientY - st.startY))
    lastPos.current = next
    setDragPos(next)
  }
  const endHeaderDrag = () => {
    if (!dragState.current) return
    dragState.current = null
    const final = lastPos.current
    setDragPos(null)
    if (final) setAdvisorPos(final)
  }

  // ---- setup (the "confirm the details" step) ----
  const [mode, setMode] = useState<Mode>('paper')
  const [sideSel, setSideSel] = useState<SideSel>('auto')
  const [scanTf, setScanTf] = useState<'1D' | '4h'>('1D')
  const [minTouches, setMinTouches] = useState('4')
  const [days, setDays] = useState('365')
  const [qty, setQty] = useState('1')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [entryEdits, setEntryEdits] = useState<{ entry: string; tp: string; sl: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // symbol switch invalidates any advice computed for the previous symbol
  useEffect(() => {
    setAdvice(null)
    setEntryEdits(null)
    setErr(null)
  }, [symbol])

  const setEdit = (k: 'entry' | 'tp' | 'sl', v: string) =>
    setEntryEdits((e) => ({ entry: e?.entry ?? String(advice?.entry ?? ''), tp: e?.tp ?? String(advice?.tp ?? ''), sl: e?.sl ?? String(advice?.sl ?? ''), [k]: v }))

  // effective (possibly hand-edited) order prices
  const entryVal = Number(entryEdits?.entry ?? advice?.entry ?? NaN)
  const tpVal = Number(entryEdits?.tp ?? advice?.tp ?? NaN)
  const slVal = Number(entryEdits?.sl ?? advice?.sl ?? NaN)
  const rrLive = useMemo(() => {
    if (!advice || !Number.isFinite(entryVal) || !Number.isFinite(tpVal) || !Number.isFinite(slVal)) return null
    const risk = Math.abs(entryVal - slVal)
    return risk > 0 ? Math.abs(tpVal - entryVal) / risk : null
  }, [advice, entryVal, tpVal, slVal])

  const mon: MonitorState = advice ? monitorState(advice, livePrice) : 'idle'

  /** a limit on the far side of the live price would fill immediately
   *  instead of RESTING in the golden pocket — surface that honestly */
  const marketable =
    advice != null && livePrice != null && Number.isFinite(entryVal) && entryVal > 0 &&
    (advice.side === 'long' ? entryVal >= livePrice : entryVal <= livePrice)

  // ---------- analyze ----------
  const analyze = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      const minT = Math.max(2, Math.round(Number(minTouches) || 4))
      const d = Math.min(3000, Math.max(30, Math.round(Number(days) || 365)))
      const res = await fetch(`/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=${scanTf}&days=${d}`)
        .then((r) => r.json()).catch(() => null)
      const bars: SrBar[] = ((res?.bars ?? []) as { time: number; high: number; low: number; close: number }[])
        .map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }))
      if (bars.length < 30) {
        setErr(`Not enough ${scanTf} history for ${symbol} (${bars.length} bars). Try more days.`)
        return
      }
      const ref = livePrice ?? bars[bars.length - 1].close
      const levels = detectSrLevels(bars, { minTouches: minT, maxLevels: 8, tolPct: scanTf === '1D' ? 0.012 : 0.009, refPrice: ref })
      if (levels.length === 0) {
        setErr(`No S/R level with ≥${minT} touches in the last ${d}d (${scanTf}). Lower min touches or extend the lookback.`)
        return
      }
      const best = (arr: typeof levels) =>
        [...arr].sort((x, y) => y.touches - x.touches || Math.abs(x.price - ref) - Math.abs(y.price - ref))[0] ?? null
      const supports = levels.filter((l) => l.price < ref)
      const resistances = levels.filter((l) => l.price > ref)
      const longLv = best(supports)
      const shortLv = best(resistances)
      const side: 'long' | 'short' =
        sideSel === 'auto'
          ? longLv && shortLv
            ? (longLv.touches >= shortLv.touches ? 'long' : 'short')
            : longLv ? 'long' : 'short'
          : sideSel
      const lv = side === 'long' ? longLv : shortLv
      if (!lv) {
        setErr(`No ${side === 'long' ? 'support below' : 'resistance above'} the current price with ≥${minT} touches (${scanTf}).`)
        return
      }
      // swing extreme across the whole lookback window (leg end)
      let swing = side === 'long' ? bars[0].high : bars[0].low
      let swingTime = bars[0].time
      for (const b of bars) {
        if (side === 'long' ? b.high > swing : b.low < swing) {
          swing = side === 'long' ? b.high : b.low
          swingTime = b.time
        }
      }
      if (side === 'long' ? swing <= lv.price : swing >= lv.price) {
        setErr(`${side === 'long' ? 'Swing high is not above the support' : 'Swing low is not below the resistance'} — try another timeframe.`)
        return
      }
      const a0 = { side, level: lv.price, levelSide: lv.side, touches: lv.touches, tf: scanTf, swing, swingTime }
      const p5 = priceAt(a0, GOLD_LO)
      const p618 = priceAt(a0, GOLD_HI)
      const zoneLo = Math.min(p5, p618)
      const zoneHi = Math.max(p5, p618)
      const entry = priceAt(a0, GOLD_MID)
      const zoneH = zoneHi - zoneLo
      const sl = side === 'long' ? lv.price - zoneH / 2 : lv.price + zoneH / 2
      // TP: nearest OPPOSITE level beyond the pocket; fallback = swing extreme
      let tp = side === 'long' ? swing : swing
      let tpSource: Advice['tpSource'] = 'swing'
      const beyond = levels
        .filter((l) => (side === 'long' ? l.price > zoneHi : l.price < zoneLo))
        .sort((x, y) => (side === 'long' ? x.price - y.price : y.price - x.price))
      if (beyond.length > 0) {
        tp = beyond[0].price
        tpSource = 'level'
      }
      const risk = Math.abs(entry - sl)
      if (!(risk > 0) || !Number.isFinite(risk)) {
        setErr('Could not build a sane risk band for this level — try another timeframe.')
        return
      }
      if (!(tp > entry) && side === 'long') { tp = entry + 2 * risk; tpSource = 'measured' }
      if (!(tp < entry) && side === 'short') { tp = entry - 2 * risk; tpSource = 'measured' }
      const advice: Advice = { ...a0, zoneLo, zoneHi, entry, tp, sl, rr: Math.abs(tp - entry) / risk, tpSource }
      if (!aliveRef.current) return
      // replace the advisor's OWN previous lines first — re-analyze never
      // stacks duplicate anchors/fibs (user drawings are untouched)
      const prev = (useTerminal.getState().drawingsBySymbol[symbol] || []).filter(
        (d) => String((d.meta as { auto?: unknown } | null)?.auto ?? '').startsWith('advisor'),
      )
      await Promise.all(prev.map((d) => deleteDrawing(d.id)))
      // 1) anchor S/R hline (advisor-tagged so cleanup finds it — distinct
      //    cyan/pink vs the S/R tool's red/yellow/green TF colors)
      await createDrawing('hline', [{ time: null, price: lv.price, pane: 'price' }], {
        color: side === 'long' ? '#22d3ee' : '#f472b6',
        meta: { auto: 'advisor', role: 'anchor', side: lv.side, touches: lv.touches, tf: scanTf },
      })
      // 2) fib retracement level→swing with the golden pocket band
      //    (renderer: level 0 = swing extreme, level 1 = the S/R anchor)
      await createDrawing('fib', [
        { time: swingTime, price: lv.price, pane: 'price' },
        { time: swingTime, price: swing, pane: 'price' },
      ], {
        color: '#a78bfa',
        meta: { auto: 'advisor', role: 'fib', golden: true, side, tf: scanTf },
      })
      setAdvice(advice)
      setEntryEdits({ entry: String(+entry.toFixed(6)), tp: String(+tp.toFixed(6)), sl: String(+sl.toFixed(6)) })
      toast({
        title: `Advisor: ${side === 'long' ? 'LONG' : 'SHORT'} plan on ${symbol}`,
        description: `${lv.side} ${fmtPrice(lv.price)} · ${lv.touches} touches ${scanTf} · golden pocket ${fmtPrice(zoneLo)}–${fmtPrice(zoneHi)} · drawn on chart`,
      })
    } catch {
      setErr('Analysis failed — could not load history.')
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [symbol, scanTf, minTouches, days, sideSel, livePrice, createDrawing, deleteDrawing, toast])

  // ---------- cleanup: remove every advisor-made line ----------
  const cleanup = useCallback(async (): Promise<number> => {
    const mine = (useTerminal.getState().drawingsBySymbol[symbol] || []).filter(
      (d) => String((d.meta as { auto?: unknown } | null)?.auto ?? '').startsWith('advisor'),
    )
    await Promise.all(mine.map((d) => deleteDrawing(d.id)))
    setAdvice(null)
    setEntryEdits(null)
    return mine.length
  }, [symbol, deleteDrawing])

  // ---------- submit the GTC LIMIT order ----------
  const submit = useCallback(async () => {
    if (!advice) return
    const q = isCrypto ? parseFloat(qty) : Math.floor(parseFloat(qty))
    if (!(q > 0)) {
      toast({ title: 'Enter a quantity', variant: 'destructive' })
      return
    }
    if (!(entryVal > 0) || !(tpVal > 0) || !(slVal > 0)) {
      toast({ title: 'Entry, TP and SL are all required', variant: 'destructive' })
      return
    }
    const wrongSide = advice.side === 'long' ? !(slVal < entryVal && entryVal < tpVal) : !(tpVal < entryVal && entryVal < slVal)
    if (wrongSide) {
      toast({
        title: 'Check the plan geometry',
        description: advice.side === 'long' ? 'Long needs SL < entry < TP.' : 'Short needs TP < entry < SL.',
        variant: 'destructive',
      })
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/trading/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          symbol,
          side: advice.side === 'long' ? 'buy' : 'sell',
          qty: q,
          type: 'limit',
          limit_price: pxOut(entryVal, isCrypto),
          take_profit: pxOut(tpVal, isCrypto),
          stop_loss: pxOut(slVal, isCrypto),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || `Order failed (${res.status})`)
      const errs: string[] = json.errors || []
      const oid = json.orders?.[0]?.id
      toast({
        title: `📋 Advisor limit ${advice.side === 'long' ? 'buy' : 'sell'} submitted (${json.mode || mode})`,
        description: [
          `${q} ${symbol} @ ${fmtPrice(entryVal)} GTC`,
          `TP ${fmtPrice(tpVal)} · SL ${fmtPrice(slVal)}`,
          json.splitNote,
          ...errs,
          oid ? `#${String(oid).slice(0, 8)}` : '',
        ].filter(Boolean).join(' · '),
        variant: errs.length ? 'destructive' : 'default',
      })
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
    } catch (e) {
      toast({
        title: 'Order failed',
        description: e instanceof Error ? e.message : 'Something went wrong.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [advice, qty, entryVal, tpVal, slVal, mode, symbol, isCrypto, toast])

  const advisorLineCount = useTerminal(
    (s) => (s.drawingsBySymbol[symbol] || []).filter((d) => String((d.meta as { auto?: unknown } | null)?.auto ?? '').startsWith('advisor')).length,
  )

  const monColor =
    mon === 'zone' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
      : mon === 'invalidated' ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
        : mon === 'stale' ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
          : 'border-zinc-800 bg-zinc-900 text-zinc-400'

  return (
    <div
      ref={rootRef}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
      className={cn(
        'terminal-scroll absolute z-40 max-h-[calc(100%-3.5rem)] w-64 overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur',
        !pos && 'right-2 top-12',
      )}
      role="dialog"
      aria-label={`Trade advisor ${symbol}`}
    >
      <div
        className="mb-2 flex cursor-move touch-none select-none items-center justify-between"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
        title="Drag to move the trade advisor"
        aria-label="Drag to move the trade advisor"
      >
        <span className="flex items-center gap-1.5 font-semibold text-zinc-100">
          <GripVertical className="h-3.5 w-3.5 text-zinc-600" />
          <Lightbulb className="h-3.5 w-3.5 text-amber-400" />
          Advisor <span className="text-amber-400">{symbol}</span>
        </span>
        <button data-no-drag onClick={onClose} aria-label="Close trade advisor" className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* paper / live */}
      <div className="mb-2 flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
        {(['paper', 'live'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={cn(
              'flex-1 rounded px-2 py-1 font-medium capitalize transition-colors',
              mode === m ? (m === 'live' ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400') : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === 'live' && (
        <p className="mb-2 rounded bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-400">
          LIVE mode — real money orders.
        </p>
      )}

      {/* plan setup — confirm the details */}
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">Plan setup</div>
      <div className="mb-1 flex items-center gap-1">
        {(['auto', 'long', 'short'] as SideSel[]).map((s) => (
          <button
            key={s}
            onClick={() => setSideSel(s)}
            aria-pressed={sideSel === s}
            className={cn(
              'flex-1 rounded-md py-1 text-[11px] font-semibold capitalize transition-colors',
              sideSel === s
                ? s === 'long' ? 'bg-emerald-600 text-white' : s === 'short' ? 'bg-rose-600 text-white' : 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="ta-tf" className="text-[10px] text-zinc-400">S/R timeframe</Label>
          <select
            id="ta-tf"
            value={scanTf}
            onChange={(e) => setScanTf(e.target.value as '1D' | '4h')}
            className="mt-0.5 h-7 w-full rounded-md border border-zinc-800 bg-zinc-950 px-1.5 text-xs text-zinc-200"
          >
            <option value="1D">1D (higher)</option>
            <option value="4h">4H</option>
          </select>
        </div>
        <div>
          <Label htmlFor="ta-touch" className="text-[10px] text-zinc-400">Min score (touches)</Label>
          <Input
            id="ta-touch"
            type="number"
            min="2"
            max="10"
            step="1"
            value={minTouches}
            onChange={(e) => setMinTouches(e.target.value)}
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
          />
        </div>
        <div>
          <Label htmlFor="ta-days" className="text-[10px] text-zinc-400">Lookback (days)</Label>
          <Input
            id="ta-days"
            type="number"
            min="30"
            max="3000"
            step="1"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
          />
        </div>
        <div>
          <Label htmlFor="ta-qty" className="text-[10px] text-zinc-400">
            Quantity{!isCrypto && <span title="Stocks require whole-number quantity" className="ml-1 cursor-help text-zinc-600">(whole)</span>}
          </Label>
          <Input
            id="ta-qty"
            type="number"
            min="0"
            step={isCrypto ? 'any' : '1'}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
          />
        </div>
      </div>

      <Button
        size="sm"
        disabled={busy}
        onClick={() => void analyze()}
        className="mt-2 h-7 w-full gap-1 bg-amber-500 px-2 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : advice ? <RefreshCw className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        {busy ? 'Analyzing…' : advice ? 'Re-analyze' : 'Analyze & arm monitor'}
      </Button>
      {err && (
        <p className="mt-1.5 rounded bg-rose-500/10 px-2 py-1 text-[10px] leading-snug text-rose-400">{err}</p>
      )}

      {/* advice */}
      {advice && (
        <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Trade plan</span>
            <Badge variant="outline" className={cn('h-auto gap-1 px-1.5 py-0 text-[9px] font-semibold', advice.side === 'long' ? 'border-emerald-500/40 text-emerald-400' : 'border-rose-500/40 text-rose-400')}>
              {advice.side.toUpperCase()}
            </Badge>
          </div>
          <div className="space-y-0.5 text-[10px] leading-4 text-zinc-400">
            <div className="flex justify-between gap-2">
              <span>Anchor {advice.tf} S/R</span>
              <span className="tabular-nums text-zinc-200">
                {fmtPrice(advice.level)} · {advice.levelSide} · score {advice.touches}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>Swing extreme</span>
              <span className="tabular-nums text-zinc-200">{fmtPrice(advice.swing)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>Golden pocket 0.5–0.618</span>
              <span className="tabular-nums text-violet-300">{fmtPrice(advice.zoneLo)} – {fmtPrice(advice.zoneHi)}</span>
            </div>
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {([
              { k: 'entry' as const, label: 'Entry (limit)', v: entryEdits?.entry, def: advice.entry, cls: 'text-amber-400' },
              { k: 'tp' as const, label: advice.tpSource === 'level' ? 'TP (next level)' : advice.tpSource === 'swing' ? 'TP (swing)' : 'TP (2R)', v: entryEdits?.tp, def: advice.tp, cls: 'text-emerald-400' },
              { k: 'sl' as const, label: advice.side === 'long' ? 'SL (below anchor)' : 'SL (above anchor)', v: entryEdits?.sl, def: advice.sl, cls: 'text-rose-400' },
            ]).map(({ k, label, v, def, cls }) => (
              <div key={k}>
                <Label htmlFor={`ta-${k}`} className="text-[9px] leading-3 text-zinc-500">{label}</Label>
                <Input
                  id={`ta-${k}`}
                  type="number"
                  min="0"
                  step="any"
                  value={v ?? ''}
                  onChange={(e) => setEdit(k, e.target.value)}
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-1 text-right text-[10px] tabular-nums"
                  aria-label={label}
                />
                <div className={cn('mt-0.5 text-right text-[9px] tabular-nums', cls)}>{fmtPrice(def)}</div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
            <span>
              R:R <span className={cn('tabular-nums font-semibold', (rrLive ?? advice.rr) >= 1.5 ? 'text-emerald-400' : (rrLive ?? advice.rr) >= 1 ? 'text-amber-400' : 'text-rose-400')}>
                {(rrLive ?? advice.rr).toFixed(2)}
              </span>
            </span>
            <span title="Live price (streaming)">now {livePrice != null ? fmtPrice(livePrice) : '—'}</span>
          </div>
          {/* active monitor */}
          <div className={cn('mt-1.5 flex items-center gap-1.5 rounded border px-1.5 py-1 text-[10px] font-semibold', monColor)} role="status" aria-live="polite">
            <Radar className={cn('h-3 w-3', mon === 'zone' && 'animate-pulse')} />
            {MON_LABEL[mon]}
          </div>
          {mon === 'zone' && (
            <p className="mt-1 text-[10px] leading-snug text-emerald-400/90">
              Price is testing the golden pocket — review entry/TP/SL and submit the resting limit when ready.
            </p>
          )}
          {marketable && (
            <p className="mt-1 text-[10px] leading-snug text-amber-400">
              ⚠ Entry is beyond the live price — this limit would fill immediately, not rest in the pocket. Wait for the pullback or edit the entry.
            </p>
          )}
          {isCrypto && advice.side === 'short' && (
            <p className="mt-1 text-[10px] leading-snug text-amber-400/90">
              Shorting crypto requires available holdings — the sell limit will fail without them.
            </p>
          )}
          <Button
            onClick={() => void submit()}
            disabled={submitting}
            className={cn(
              'mt-2 h-auto min-h-8 w-full whitespace-normal px-2 py-1 font-semibold leading-snug',
              advice.side === 'long' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-rose-600 text-white hover:bg-rose-500',
            )}
          >
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Submit LIMIT {advice.side === 'long' ? 'buy' : 'sell'} {qty || '—'} {symbol} · GTC
          </Button>
        </div>
      )}

      {/* cleanup */}
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 border-zinc-800 px-2 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          disabled={advisorLineCount === 0}
          onClick={() => {
            void cleanup().then((n) =>
              toast({ title: n > 0 ? `Removed ${n} advisor line${n === 1 ? '' : 's'}` : 'No advisor lines on this chart' }),
            )
          }}
        >
          <Eraser className="h-3 w-3" />
          Clean up lines{advisorLineCount > 0 ? ` (${advisorLineCount})` : ''}
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">
        Limit-only advice (GTC) — rests until filled, works any time even outside market hours.
        TP/SL ride along as a bracket (stocks) or OCO-managed legs (crypto).
      </p>
    </div>
  )
}
