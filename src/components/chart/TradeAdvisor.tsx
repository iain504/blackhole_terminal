'use client'

// Trade Advisor (Task 82, revamped Task 83) — a one-click technical trade plan
// on the chart with TWO modes:
//
//   DAY (Task 83 — built on what the day-trading community actually uses):
//     session VWAP · opening range (5/15/30m, ORB) · prior-day high/low ·
//     relative volume · ATR(5m)-sized stops (0.5–2.5 ATR) · R:R ≥ 1.5 targets.
//     Setups: breakout-retest (resting limit at the OR edge after the break),
//     breakout (resting at the edge from inside the range), VWAP pullback,
//     reversion (countertrend, flagged). Logic: src/lib/dayplan.ts.
//
//   SWING (the original Task 82 flow):
//   1. Reuses the Auto S/R detector (src/lib/sr.ts) on a HIGHER timeframe
//      (default 1D) and picks the highest-score level (most pivot touches).
//   2. Anchors a fib retracement on the level's most recent REAL leg (Task
//      82c): the departure after its last touch episode → the subsequent
//      extreme (bounded by the level's next revisit). That keeps the standard
//      retracement convention honest — 1.000 = the leg ORIGIN (here: the S/R
//      level the move started from), 0.000 = the leg END (the swing extreme),
//      0.5–0.618 measured back from the extreme = the "golden pocket"
//      (meta.golden — the canvas renderer fills the band). The two fib points
//      sit at their real bars, so the drawn leg is a true diagonal like a
//      hand-drawn TradingView fib. If NO candidate level has a real leg, the
//      whole-lookback extreme is used as a fallback and flagged ⚠ synthetic
//      in the panel.
//   3. Populates the advice panel with the optimal entry (golden-pocket
//      midpoint), TP (nearest opposite S/R level, fallback swing extreme)
//      and SL (beyond the anchor by half the pocket height) — every value
//      editable before submitting.
//
//   BOTH modes: GTC LIMIT order with bracket TP/SL (stocks) or OCO-managed
//   legs (crypto) — a resting limit works ANY time, market hours not
//   required. The advisor TRACKS the order it submitted (Task 83): a status
//   row polls the broker every 4s (OPEN / FILLED @ px / closed) and offers a
//   CANCEL button while the order is still working. While armed it monitors
//   the live price (waiting / at-zone / invalidated). "Clean up" removes
//   every advisor-made line (meta.auto === 'advisor*') — user drawings
//   untouched.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X, Sparkles, Eraser, RefreshCw, Lightbulb, Radar, GripVertical, Ban, CheckCircle2, Clock3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { useTerminal, DrawingKind, DrawingPoint } from '@/store/terminal'
import { detectSrLevels, SrBar } from '@/lib/sr'
import { analyzeDay, DayAnalysis, DayPlan } from '@/lib/dayplan'
import { isCryptoSymbol, fmtPrice } from '@/lib/market-types'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'
type SideSel = 'auto' | 'long' | 'short'
/** Task 83: DAY = OR/VWAP/PDH-PDL intraday plan · SWING = HTF S/R + fib pocket (classic) */
type PlanMode = 'day' | 'swing'

/** tracked advisor-submitted order (cancel button + status row, both modes) */
interface OrderTrack {
  mode: Mode
  ids: string[]
  side: 'buy' | 'sell'
  qty: number
  entry: number
}

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
  /** fib leg: 'leg' = real (level's last departure → extreme, both bars
   *  real); 'lookback' = synthetic fallback (whole-lookback extreme — the
   *  level origin is NOT verified, panel shows ⚠) */
  legStartTime: number
  legSource: 'leg' | 'lookback'
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

type OrderStatus = 'checking' | 'open' | 'filled' | 'closed'

const OPEN_ORDER_STATUSES = new Set(['new', 'accepted', 'pending_new', 'pending_replace', 'pending_cancel', 'held', 'partially_filled'])

/** price at retracement fraction f of the leg (f=0 → swing extreme, f=1 → level) */
function priceAt(a: Pick<Advice, 'level' | 'swing'>, f: number): number {
  return a.swing + (a.level - a.swing) * f
}

/** short UTC-s date for the panel/toast (client-rendered only) */
const fmtDay = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Bars whose range comes within tolPct of `level` (or straddles it) are "at
 *  the level"; consecutive ones (gaps ≤3 bars = one shelf/test) merge into a
 *  touch EPISODE. Chronological order. */
function touchEpisodes(bars: SrBar[], level: number, tolPct: number) {
  const tol = Math.abs(level) * tolPct
  const at = (b: SrBar) => b.low - tol <= level && level <= b.high + tol
  const eps: { start: number; end: number }[] = []
  let cur: { start: number; end: number } | null = null
  for (let i = 0; i < bars.length; i++) {
    if (!at(bars[i])) continue
    if (cur && i - cur.end <= 3) cur.end = i
    else {
      cur = { start: i, end: i }
      eps.push(cur)
    }
  }
  return eps
}

/** The most recent REAL fib leg from `level` (Task 82c): after a touch
 *  episode price DEPARTS and travels to an extreme — bounded by the level's
 *  next revisit (a completed leg) or by now (the ongoing leg). Scanned
 *  newest-first; a leg needs ≥3 bars away from the level and an extreme
 *  clearing the zone by 2×tol on the trade side. null = this level never
 *  originated a real leg in the lookback → caller falls back. */
function legFromLevel(
  bars: SrBar[],
  level: number,
  tolPct: number,
  side: 'long' | 'short',
): { swing: number; swingTime: number; legStartTime: number } | null {
  const eps = touchEpisodes(bars, level, tolPct)
  const minClear = Math.abs(level) * tolPct * 2
  for (let i = eps.length - 1; i >= 0; i--) {
    const from = eps[i].end + 1
    const to = i + 1 < eps.length ? eps[i + 1].start - 1 : bars.length - 1
    if (to - from + 1 < 3) continue
    let swing = side === 'long' ? bars[from].high : bars[from].low
    let swingTime = bars[from].time
    for (let j = from + 1; j <= to; j++) {
      const b = bars[j]
      if (side === 'long' ? b.high > swing : b.low < swing) {
        swing = side === 'long' ? b.high : b.low
        swingTime = b.time
      }
    }
    if (side === 'long' ? swing >= level + minClear : swing <= level - minClear) {
      return { swing, swingTime, legStartTime: bars[eps[i].end].time }
    }
  }
  return null
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

const MON_LABEL_DAY: Record<MonitorState, string> = {
  idle: '—',
  waiting: 'waiting for the entry zone',
  zone: 'PRICE AT ENTRY ZONE',
  stale: '—',
  invalidated: 'invalidated (beyond SL)',
}

/** day-plan TP provenance → input label */
const TP_DAY: Record<DayPlan['tpSource'], string> = {
  measured: 'TP (measured)',
  prevday: 'TP (prev-day)',
  vwap: 'TP (VWAP)',
  '2R': 'TP (2R)',
  'or-edge': 'TP (OR edge)',
}

/** day-mode monitor: within ±0.25×ATR(5m) of the entry counts as "at the
 *  zone"; beyond the SL the plan is dead. No 'stale' concept — a resting
 *  breakout limit is SUPPOSED to wait. */
function monitorDay(a: DayAnalysis, p: number | null): MonitorState {
  const g = a.plan
  if (!g || p == null || !Number.isFinite(p) || a.atr == null) return 'waiting'
  if (g.side === 'long') {
    if (p <= g.sl) return 'invalidated'
    return Math.abs(p - g.entry) <= 0.25 * a.atr ? 'zone' : 'waiting'
  }
  if (p >= g.sl) return 'invalidated'
  return Math.abs(p - g.entry) <= 0.25 * a.atr ? 'zone' : 'waiting'
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
  const [planMode, setPlanMode] = useState<PlanMode>('day')
  const [sideSel, setSideSel] = useState<SideSel>('auto')
  const [scanTf, setScanTf] = useState<'1D' | '4h'>('1D')
  const [minTouches, setMinTouches] = useState('4')
  const [days, setDays] = useState('365')
  const [orMin, setOrMin] = useState('15')
  const [qty, setQty] = useState('1')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [day, setDay] = useState<DayAnalysis | null>(null)
  const [entryEdits, setEntryEdits] = useState<{ entry: string; tp: string; sl: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // ---- advisor-submitted order tracking (Task 83): status row + cancel ----
  const [orderTrack, setOrderTrack] = useState<OrderTrack | null>(null)
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('checking')
  const [orderFillPx, setOrderFillPx] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // symbol switch invalidates any advice computed for the previous symbol
  useEffect(() => {
    setAdvice(null)
    setDay(null)
    setEntryEdits(null)
    setErr(null)
  }, [symbol])

  // mode switch swaps the setup + clears the other mode's plan (the tracked
  // order row survives — it reflects a LIVE broker order, not the plan)
  const switchMode = (m: PlanMode) => {
    if (m === planMode) return
    setPlanMode(m)
    setAdvice(null)
    setDay(null)
    setEntryEdits(null)
    setErr(null)
  }

  const setEdit = (k: 'entry' | 'tp' | 'sl', v: string) =>
    setEntryEdits((e) => ({
      entry: e?.entry ?? String((planMode === 'day' ? day?.plan?.entry : advice?.entry) ?? ''),
      tp: e?.tp ?? String((planMode === 'day' ? day?.plan?.tp : advice?.tp) ?? ''),
      sl: e?.sl ?? String((planMode === 'day' ? day?.plan?.sl : advice?.sl) ?? ''),
      [k]: v,
    }))

  // effective (possibly hand-edited) order prices — DAY plan or SWING advice
  const activeSide: 'long' | 'short' | null = planMode === 'day' ? (day?.plan?.side ?? null) : (advice?.side ?? null)
  const entryVal = Number(entryEdits?.entry ?? (planMode === 'day' ? day?.plan?.entry : advice?.entry) ?? NaN)
  const tpVal = Number(entryEdits?.tp ?? (planMode === 'day' ? day?.plan?.tp : advice?.tp) ?? NaN)
  const slVal = Number(entryEdits?.sl ?? (planMode === 'day' ? day?.plan?.sl : advice?.sl) ?? NaN)
  const rrLive = useMemo(() => {
    if (activeSide == null || !Number.isFinite(entryVal) || !Number.isFinite(tpVal) || !Number.isFinite(slVal)) return null
    const risk = Math.abs(entryVal - slVal)
    return risk > 0 ? Math.abs(tpVal - entryVal) / risk : null
  }, [activeSide, entryVal, tpVal, slVal])

  const mon: MonitorState = planMode === 'day'
    ? (day ? monitorDay(day, livePrice) : 'idle')
    : advice ? monitorState(advice, livePrice) : 'idle'

  /** a limit on the far side of the live price would fill immediately
   *  instead of RESTING at the planned level — surface that honestly */
  const marketable =
    activeSide != null && livePrice != null && Number.isFinite(entryVal) && entryVal > 0 &&
    (activeSide === 'long' ? entryVal >= livePrice : entryVal <= livePrice)

  // ---------- analyze ----------
  const analyze = useCallback(async () => {
    setBusy(true)
    setErr(null)
    // replace the advisor's OWN previous lines first — re-analyze never
    // stacks duplicate anchors/fibs/level lines (user drawings untouched)
    const prev = (useTerminal.getState().drawingsBySymbol[symbol] || []).filter(
      (d) => String((d.meta as { auto?: unknown } | null)?.auto ?? '').startsWith('advisor'),
    )
    await Promise.all(prev.map((d) => deleteDrawing(d.id)))
    try {
      if (planMode === 'day') {
        // ---- DAY mode (Task 83): community-standard intraday tools ----
        // session VWAP · opening range (ORB) · prior-day H/L · relative volume
        // · ATR(5m)-sized stops · R:R ≥ 1.5 targets — see src/lib/dayplan.ts
        const orMinutes = Math.min(60, Math.max(1, Math.round(Number(orMin) || 15)))
        const res = await fetch(`/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=5m&days=10`)
          .then((r) => r.json()).catch(() => null)
        const bars = ((res?.bars ?? []) as { time: number; open: number; high: number; low: number; close: number; volume: number }[])
        if (bars.length < 30) {
          setErr(`Not enough 5m history for ${symbol} (${bars.length} bars).`)
          return
        }
        const p = livePrice ?? bars[bars.length - 1].close
        const analysis = analyzeDay({ price: p, side: sideSel, orMinutes, tfSec: 300, bars })
        if (!aliveRef.current) return
        setAdvice(null)
        setDay(analysis)
        if (analysis.err || !analysis.plan) {
          setEntryEdits(null)
          setErr(analysis.err ?? 'No day-trade setup right now.')
          return
        }
        setErr(null)
        const g = analysis.plan
        // day drawings: OR edges (amber) + prior-day H/L (zinc) — advisor-tagged
        // so "Clean up lines" removes exactly these
        if (analysis.or && Number.isFinite(analysis.or.high) && Number.isFinite(analysis.or.low)) {
          await createDrawing('hline', [{ time: null, price: analysis.or.high, pane: 'price' }], {
            color: '#f59e0b', meta: { auto: 'advisor', role: 'or-high', tf: '5m', orMinutes },
          })
          await createDrawing('hline', [{ time: null, price: analysis.or.low, pane: 'price' }], {
            color: '#f59e0b', meta: { auto: 'advisor', role: 'or-low', tf: '5m', orMinutes },
          })
        }
        if (analysis.pdh != null) {
          await createDrawing('hline', [{ time: null, price: analysis.pdh, pane: 'price' }], {
            color: '#e4e4e7', meta: { auto: 'advisor', role: 'pdh', tf: '1D' },
          })
        }
        if (analysis.pdl != null) {
          await createDrawing('hline', [{ time: null, price: analysis.pdl, pane: 'price' }], {
            color: '#e4e4e7', meta: { auto: 'advisor', role: 'pdl', tf: '1D' },
          })
        }
        setEntryEdits({ entry: String(g.entry), tp: String(g.tp), sl: String(g.sl) })
        toast({
          title: `Advisor: ${g.side === 'long' ? 'LONG' : 'SHORT'} day plan on ${symbol}`,
          description: [
            g.setup,
            analysis.or ? `OR ${fmtPrice(analysis.or.low)}–${fmtPrice(analysis.or.high)}` : '',
            analysis.vwap != null ? `VWAP ${fmtPrice(analysis.vwap)}` : '',
            analysis.rvol != null ? `RVOL ${analysis.rvol.toFixed(1)}×` : '',
            `entry ${fmtPrice(g.entry)} · R:R ${g.rr.toFixed(2)}`,
          ].filter(Boolean).join(' · '),
        })
        return
      }
      setDay(null)
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
      const tolPct = scanTf === '1D' ? 0.012 : 0.009
      const levels = detectSrLevels(bars, { minTouches: minT, maxLevels: 8, tolPct, refPrice: ref })
      if (levels.length === 0) {
        setErr(`No S/R level with ≥${minT} touches in the last ${d}d (${scanTf}). Lower min touches or extend the lookback.`)
        return
      }
      const order = (arr: typeof levels) =>
        [...arr].sort((x, y) => y.touches - x.touches || Math.abs(x.price - ref) - Math.abs(y.price - ref))
      const supports = levels.filter((l) => l.price < ref)
      const resistances = levels.filter((l) => l.price > ref)

      // Fib leg construction (Task 82c): the retracement is only meaningful
      // when its 1.000 origin REALLY is where the move started. Walk each
      // candidate level (strongest first) and take its most recent REAL leg
      // (departure → subsequent extreme). Only when NO candidate has one,
      // fall back to the whole-lookback extreme — flagged ⚠ synthetic.
      type LegPick = {
        side: 'long' | 'short'
        lv: (typeof levels)[number]
        swing: number
        swingTime: number
        legStartTime: number
        legSource: 'leg' | 'lookback'
      }
      const buildForSide = (side: 'long' | 'short', arr: typeof levels): LegPick | null => {
        for (const lv of order(arr)) {
          const leg = legFromLevel(bars, lv.price, tolPct, side)
          if (leg) return { side, lv, ...leg, legSource: 'leg' }
        }
        const lv = order(arr)[0]
        if (!lv) return null
        let swing = side === 'long' ? bars[0].high : bars[0].low
        let swingTime = bars[0].time
        for (const b of bars) {
          if (side === 'long' ? b.high > swing : b.low < swing) {
            swing = side === 'long' ? b.high : b.low
            swingTime = b.time
          }
        }
        if (side === 'long' ? swing <= lv.price : swing >= lv.price) return null
        return { side, lv, swing, swingTime, legStartTime: swingTime, legSource: 'lookback' }
      }
      const longPick = sideSel === 'short' ? null : buildForSide('long', supports)
      const shortPick = sideSel === 'long' ? null : buildForSide('short', resistances)
      // auto: prefer the side with a REAL leg, then score, then proximity
      const prefer = (a: LegPick | null, b: LegPick | null): LegPick | null => {
        if (!a) return b
        if (!b) return a
        const realA = a.legSource === 'leg' ? 1 : 0
        const realB = b.legSource === 'leg' ? 1 : 0
        if (realA !== realB) return realA > realB ? a : b
        if (a.lv.touches !== b.lv.touches) return a.lv.touches > b.lv.touches ? a : b
        return Math.abs(a.lv.price - ref) <= Math.abs(b.lv.price - ref) ? a : b
      }
      if (sideSel !== 'auto') {
        const arr = sideSel === 'long' ? supports : resistances
        if (arr.length === 0) {
          setErr(`No ${sideSel === 'long' ? 'support below' : 'resistance above'} the current price with ≥${minT} touches (${scanTf}).`)
          return
        }
      }
      const pick = sideSel === 'auto' ? prefer(longPick, shortPick) : sideSel === 'long' ? longPick : shortPick
      if (!pick) {
        setErr(`${sideSel === 'long' ? 'Swing high is not above the support' : 'Swing low is not below the resistance'} — try another timeframe.`)
        return
      }
      const { side, lv, swing, swingTime, legStartTime, legSource } = pick
      const a0 = { side, level: lv.price, levelSide: lv.side, touches: lv.touches, tf: scanTf, swing, swingTime, legStartTime, legSource }
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
      // 1) anchor S/R hline (advisor-tagged so cleanup finds it — distinct
      //    cyan/pink vs the S/R tool's red/yellow/green TF colors)
      await createDrawing('hline', [{ time: null, price: lv.price, pane: 'price' }], {
        color: side === 'long' ? '#22d3ee' : '#f472b6',
        meta: { auto: 'advisor', role: 'anchor', side: lv.side, touches: lv.touches, tf: scanTf },
      })
      // 2) fib retracement on the REAL leg: 1.000 (origin) at the level's
      //    departure bar, 0.000 (extreme) at the swing bar — a true diagonal
      //    like a hand-drawn TradingView fib; fallback anchors both ends at
      //    the swing bar (synthetic leg ⚠)
      await createDrawing('fib', [
        { time: legStartTime, price: lv.price, pane: 'price' },
        { time: swingTime, price: swing, pane: 'price' },
      ], {
        color: '#a78bfa',
        meta: { auto: 'advisor', role: 'fib', golden: true, side, tf: scanTf, legSource },
      })
      setAdvice(advice)
      setEntryEdits({ entry: String(+entry.toFixed(6)), tp: String(+tp.toFixed(6)), sl: String(+sl.toFixed(6)) })
      toast({
        title: `Advisor: ${side === 'long' ? 'LONG' : 'SHORT'} plan on ${symbol}`,
        description: `${lv.side} ${fmtPrice(lv.price)} · ${lv.touches} touches ${scanTf} · leg ${legSource === 'leg' ? `${fmtDay(legStartTime)}→${fmtDay(swingTime)}` : 'synthetic ⚠'} · pocket ${fmtPrice(zoneLo)}–${fmtPrice(zoneHi)}`,
      })
    } catch {
      setErr('Analysis failed — could not load history.')
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [symbol, planMode, scanTf, minTouches, days, orMin, sideSel, livePrice, createDrawing, deleteDrawing, toast])

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

  // ---------- submit the GTC LIMIT order (both modes) ----------
  const submit = useCallback(async () => {
    if (!activeSide) return
    const q = isCrypto ? parseFloat(qty) : Math.floor(parseFloat(qty))
    if (!(q > 0)) {
      toast({ title: 'Enter a quantity', variant: 'destructive' })
      return
    }
    if (!(entryVal > 0) || !(tpVal > 0) || !(slVal > 0)) {
      toast({ title: 'Entry, TP and SL are all required', variant: 'destructive' })
      return
    }
    const wrongSide = activeSide === 'long' ? !(slVal < entryVal && entryVal < tpVal) : !(tpVal < entryVal && entryVal < slVal)
    if (wrongSide) {
      toast({
        title: 'Check the plan geometry',
        description: activeSide === 'long' ? 'Long needs SL < entry < TP.' : 'Short needs TP < entry < SL.',
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
          side: activeSide === 'long' ? 'buy' : 'sell',
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
      const ids: string[] = ((json.orders ?? []) as { id?: string }[])
        .map((o) => o?.id)
        .filter((x): x is string => Boolean(x))
      const oid = ids[0]
      // track the submission → status row + Cancel button (Task 83)
      setOrderTrack({ mode: (json.mode || mode) as Mode, ids, side: activeSide === 'long' ? 'buy' : 'sell', qty: q, entry: entryVal })
      setOrderStatus('checking')
      setOrderFillPx(null)
      toast({
        title: `📋 Advisor limit ${activeSide === 'long' ? 'buy' : 'sell'} submitted (${json.mode || mode})`,
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
  }, [activeSide, qty, entryVal, tpVal, slVal, mode, symbol, isCrypto, toast])

  // ---------- order-status polling (Task 83) ----------
  // While a submitted order is checking/open, poll every 4s: any id FILLED →
  // filled row (with fill px); any id still working → open (Cancel active);
  // all ids resolved → closed. Stops once terminal.
  useEffect(() => {
    if (!orderTrack || orderTrack.ids.length === 0) return
    if (orderStatus === 'filled' || orderStatus === 'closed') return
    let stop = false
    const tick = async () => {
      try {
        const rs = await Promise.all(orderTrack.ids.map((id) =>
          fetch(`/api/trading/orders/${encodeURIComponent(id)}?mode=${orderTrack.mode}`, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ))
        if (stop) return
        const orders = rs.map((j) => j?.order).filter(Boolean) as { status?: string; filled_avg_price?: string | null }[]
        const sts = orders.map((o) => String(o.status ?? ''))
        const fillPx = orders.find((o) => o.filled_avg_price)?.filled_avg_price ?? null
        if (fillPx) setOrderFillPx(String(fillPx))
        if (sts.includes('filled')) {
          setOrderStatus('filled')
          window.dispatchEvent(new CustomEvent('tt:positions-changed'))
        } else if (sts.some((s) => OPEN_ORDER_STATUSES.has(s))) {
          setOrderStatus('open')
        } else if (orders.length > 0) {
          setOrderStatus('closed') // every id resolved to a terminal state (canceled/expired/rejected…)
        } // else: fetch hiccup — keep last status, keep polling
      } catch { /* keep polling */ }
    }
    void tick()
    const h = setInterval(() => void tick(), 4000)
    return () => { stop = true; clearInterval(h) }
  }, [orderTrack, orderStatus])

  // ---------- cancel the advisor-submitted order (Task 83) ----------
  const cancelSubmitted = useCallback(async () => {
    const t = orderTrack
    if (!t) return
    setCancelling(true)
    try {
      // only ids the broker still reports open are cancelable — anything else
      // (already filled/canceled) fails the DELETE with a confusing error
      const open = await fetch(`/api/trading/orders?mode=${t.mode}&symbol=${encodeURIComponent(symbol)}`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      const openIds = new Set((((open?.orders ?? []) as { id?: string }[]).map((o) => String(o?.id))))
      const targets = t.ids.filter((id) => openIds.has(id))
      if (targets.length === 0) {
        toast({ title: 'Order is no longer open', description: 'It already filled or canceled — see the Positions tab.' })
        setOrderStatus('closed')
        return
      }
      const results = await Promise.all(targets.map((id) =>
        fetch(`/api/trading/orders/${encodeURIComponent(id)}?mode=${t.mode}`, { method: 'DELETE' })
          .then(async (r) => ({ ok: r.ok, err: ((await r.json().catch(() => null))?.error as string | undefined) }))
          .catch(() => ({ ok: false, err: 'network error' })),
      ))
      const failed = results.filter((r) => !r.ok).map((r) => r.err || 'cancel failed')
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      toast({
        title: failed.length > 0 ? `Cancel failed on ${failed.length} order${failed.length === 1 ? '' : 's'}` : `Advisor order canceled`,
        description: failed.length > 0
          ? failed.join(' · ')
          : `${t.qty} ${symbol} ${t.side.toUpperCase()} limit @ ${fmtPrice(t.entry)} — canceled.`,
        variant: failed.length > 0 ? 'destructive' : 'default',
      })
      setOrderStatus('checking') // re-poll to confirm the broker state
    } finally {
      setCancelling(false)
    }
  }, [orderTrack, symbol, toast])

  const advisorLineCount = useTerminal(
    (s) => (s.drawingsBySymbol[symbol] || []).filter((d) => String((d.meta as { auto?: unknown } | null)?.auto ?? '').startsWith('advisor')).length,
  )

  const monColor =
    mon === 'zone' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
      : mon === 'invalidated' ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
        : mon === 'stale' ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
          : 'border-zinc-800 bg-zinc-900 text-zinc-400'

  // unified plan view for the panel — whatever mode is active
  const planView = planMode === 'day'
    ? day?.plan
      ? {
          side: day.plan.side,
          entry: day.plan.entry,
          tp: day.plan.tp,
          sl: day.plan.sl,
          rr: day.plan.rr,
          tpLabel: TP_DAY[day.plan.tpSource],
          slLabel: 'SL (ATR)',
          setup: day.plan.setup as string | null,
        }
      : null
    : advice
      ? {
          side: advice.side,
          entry: advice.entry,
          tp: advice.tp,
          sl: advice.sl,
          rr: advice.rr,
          tpLabel: advice.tpSource === 'level' ? 'TP (next level)' : advice.tpSource === 'swing' ? 'TP (swing)' : 'TP (2R)',
          slLabel: advice.side === 'long' ? 'SL (below anchor)' : 'SL (above anchor)',
          setup: null,
        }
      : null

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

      {/* plan mode (Task 83): Day = OR/VWAP/PDH-PDL intraday · Swing = HTF S/R + fib pocket */}
      <div className="mb-2 flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
        {([
          { k: 'day' as PlanMode, label: 'Day trade' },
          { k: 'swing' as PlanMode, label: 'Swing (S/R + fib)' },
        ]).map((m) => (
          <button
            key={m.k}
            onClick={() => switchMode(m.k)}
            aria-pressed={planMode === m.k}
            className={cn(
              'flex-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors',
              planMode === m.k ? 'bg-amber-500/20 text-amber-400' : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

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
      {planMode === 'day' ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="ta-or" className="text-[10px] text-zinc-400">Opening range</Label>
            <select
              id="ta-or"
              value={orMin}
              onChange={(e) => setOrMin(e.target.value)}
              className="mt-0.5 h-7 w-full rounded-md border border-zinc-800 bg-zinc-950 px-1.5 text-xs text-zinc-200"
            >
              <option value="5">first 5 min</option>
              <option value="15">first 15 min</option>
              <option value="30">first 30 min</option>
            </select>
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
      ) : (
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
      )}

      <Button
        size="sm"
        disabled={busy}
        onClick={() => void analyze()}
        className="mt-2 h-7 w-full gap-1 bg-amber-500 px-2 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : planView ? <RefreshCw className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        {busy ? 'Analyzing…' : planView ? 'Re-analyze' : planMode === 'day' ? 'Analyze day plan' : 'Analyze & arm monitor'}
      </Button>
      {err && (
        <p className="mt-1.5 rounded bg-rose-500/10 px-2 py-1 text-[10px] leading-snug text-rose-400">{err}</p>
      )}

      {/* trade plan (day OR swing — mutually exclusive) */}
      {planView && (
        <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{planMode === 'day' ? 'Day plan' : 'Trade plan'}</span>
            <div className="flex items-center gap-1">
              {planView.setup && (
                <Badge variant="outline" className="h-auto border-zinc-700 px-1.5 py-0 text-[9px] font-semibold uppercase text-zinc-300">
                  {planView.setup.replace('-', ' ')}
                </Badge>
              )}
              <Badge variant="outline" className={cn('h-auto gap-1 px-1.5 py-0 text-[9px] font-semibold', planView.side === 'long' ? 'border-emerald-500/40 text-emerald-400' : 'border-rose-500/40 text-rose-400')}>
                {planView.side.toUpperCase()}
              </Badge>
            </div>
          </div>

          {planMode === 'swing' && advice && (
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
                <span>Fib leg</span>
                <span
                  className="tabular-nums text-zinc-200"
                  title={advice.legSource === 'leg' ? 'Real leg: the level’s last departure bar → the swing extreme (standard retracement: 1.000 origin = level, 0.000 = extreme)' : 'Synthetic leg: whole-lookback extreme — the level origin is not verified, treat the pocket as indicative'}
                >
                  {advice.legSource === 'leg' ? `${fmtDay(advice.legStartTime)} → ${fmtDay(advice.swingTime)}` : 'lookback ⚠'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Golden pocket 0.5–0.618</span>
                <span className="tabular-nums text-violet-300">{fmtPrice(advice.zoneLo)} – {fmtPrice(advice.zoneHi)}</span>
              </div>
            </div>
          )}
          {planMode === 'swing' && advice?.legSource === 'lookback' && (
            <p className="mt-1 text-[10px] leading-snug text-amber-400/90">
              ⚠ Synthetic leg — price never left this level and made the swing in one move; the pocket is indicative only.
            </p>
          )}

          {planMode === 'day' && day && (
            <>
              {day.plan?.rationale && (
                <p className="pb-1 text-[10px] leading-snug text-zinc-300">{day.plan.rationale}</p>
              )}
              {/* community checklist (Task 83): VWAP · OR · PDH/PDL · RVOL */}
              <div className="space-y-0.5 text-[10px] leading-4">
                {day.checks.map((c) => (
                  <div key={c.key} className="flex items-baseline justify-between gap-2" title={c.detail}>
                    <span className="shrink-0 text-zinc-500">{c.label}</span>
                    <span
                      className={cn(
                        'text-right text-[10px] font-medium',
                        c.tone === 'long' ? 'text-emerald-400'
                          : c.tone === 'short' ? 'text-rose-400'
                            : c.tone === 'warn' ? 'text-amber-400'
                              : 'text-zinc-400',
                      )}
                    >
                      {c.state}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {([
              { k: 'entry' as const, label: 'Entry (limit)', v: entryEdits?.entry, def: planView.entry, cls: 'text-amber-400' },
              { k: 'tp' as const, label: planView.tpLabel, v: entryEdits?.tp, def: planView.tp, cls: 'text-emerald-400' },
              { k: 'sl' as const, label: planView.slLabel, v: entryEdits?.sl, def: planView.sl, cls: 'text-rose-400' },
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
              R:R <span className={cn('tabular-nums font-semibold', (rrLive ?? planView.rr) >= 1.5 ? 'text-emerald-400' : (rrLive ?? planView.rr) >= 1 ? 'text-amber-400' : 'text-rose-400')}>
                {(rrLive ?? planView.rr).toFixed(2)}
              </span>
            </span>
            <span title="Live price (streaming)">now {livePrice != null ? fmtPrice(livePrice) : '—'}</span>
          </div>
          {/* active monitor */}
          <div className={cn('mt-1.5 flex items-center gap-1.5 rounded border px-1.5 py-1 text-[10px] font-semibold', monColor)} role="status" aria-live="polite">
            <Radar className={cn('h-3 w-3', mon === 'zone' && 'animate-pulse')} />
            {planMode === 'day' ? MON_LABEL_DAY[mon] : MON_LABEL[mon]}
          </div>
          {mon === 'zone' && (
            <p className="mt-1 text-[10px] leading-snug text-emerald-400/90">
              {planMode === 'day'
                ? 'Price is at the entry zone — review entry/TP/SL and submit the resting limit when ready.'
                : 'Price is testing the golden pocket — review entry/TP/SL and submit the resting limit when ready.'}
            </p>
          )}
          {marketable && (
            <p className="mt-1 text-[10px] leading-snug text-amber-400">
              ⚠ Entry is beyond the live price — this limit would fill immediately instead of resting at the planned level. Wait for the move or edit the entry.
            </p>
          )}
          {isCrypto && planView.side === 'short' && (
            <p className="mt-1 text-[10px] leading-snug text-amber-400/90">
              Shorting crypto requires available holdings — the sell limit will fail without them.
            </p>
          )}
          <Button
            onClick={() => void submit()}
            disabled={submitting}
            className={cn(
              'mt-2 h-auto min-h-8 w-full whitespace-normal px-2 py-1 font-semibold leading-snug',
              planView.side === 'long' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-rose-600 text-white hover:bg-rose-500',
            )}
          >
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Submit LIMIT {planView.side === 'long' ? 'buy' : 'sell'} {qty || '—'} {symbol} · GTC
          </Button>
        </div>
      )}

      {/* submitted-order status + cancel (Task 83) */}
      {orderTrack && (
        <div
          className={cn(
            'mt-1.5 rounded border px-1.5 py-1 text-[10px]',
            orderStatus === 'filled' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
              : orderStatus === 'closed' ? 'border-zinc-800 bg-zinc-900 text-zinc-500'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-400',
          )}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 font-semibold">
              {orderStatus === 'filled' ? <CheckCircle2 className="h-3 w-3" />
                : orderStatus === 'closed' ? <Ban className="h-3 w-3" />
                  : <Clock3 className={cn('h-3 w-3', orderStatus === 'checking' && 'animate-pulse')} />}
              Order{orderTrack.ids[0] ? ` #${orderTrack.ids[0].slice(0, 8)}` : ''}{' '}
              {orderStatus === 'checking' ? 'checking…' : orderStatus.toUpperCase()}
            </span>
            {(orderStatus === 'open' || orderStatus === 'checking') && (
              <button
                data-no-drag
                onClick={() => void cancelSubmitted()}
                disabled={cancelling}
                className="rounded border border-rose-500/40 px-1.5 py-0.5 text-[9px] font-semibold text-rose-400 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
                aria-label="Cancel the advisor order"
              >
                {cancelling && <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" />}
                Cancel order
              </button>
            )}
          </div>
          <div className="mt-0.5 text-[9px] text-zinc-500">
            {orderTrack.qty} {symbol} {orderTrack.side.toUpperCase()} limit @ {fmtPrice(orderTrack.entry)}
            {orderFillPx ? ` · fill ${fmtPrice(Number(orderFillPx))}` : ''}
            {orderStatus === 'filled' ? ' — manage the position from the Positions tab'
              : orderStatus === 'closed' ? ' — canceled / expired'
                : orderStatus === 'open' ? ' — resting at the broker' : ''}
          </div>
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
        {planMode === 'day'
          ? 'Day setups: opening-range break/retest, VWAP pullback, prior-day levels — limit-only (GTC) so the entry rests until price comes to it.'
          : 'Limit-only advice (GTC) — rests until filled, works any time even outside market hours. TP/SL ride along as a bracket (stocks) or OCO-managed legs (crypto).'}
      </p>
    </div>
  )
}
