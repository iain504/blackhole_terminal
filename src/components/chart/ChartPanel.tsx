'use client'

// Interactive chart: lightweight-charts + transparent overlay canvas for
// drawings (hline/vline/trend/fib) and alert lines. Lines stay draggable &
// resizable after drawing, with right-click context menus (Task 14 #1/#4,
// Task 16 #4/#5/#6). Earnings [E] (yfinance) + news ⚡ icons on the TIME
// AXIS (x-axis), TradingView-style.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle, UTCTimestamp, Time,
  IChartApi, ISeriesApi, MouseEventParams, CandlestickData, LineData,
} from 'lightweight-charts'
import { useTerminal, Drawing, DrawingKind, DrawingPoint, DRAW_COLORS } from '@/store/terminal'
import { useShallow } from 'zustand/react/shallow'
import { TIMEFRAMES, fmtPrice, isCryptoSymbol, Bar, Timeframe } from '@/lib/market-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import {
  MousePointer2, Minus, ArrowUpDown, TrendingUp, Ruler, Eye, EyeOff, Trash2,
  ChevronDown, CandlestickChart as CandleIcon, LineChart as LineIcon, Loader2, BellPlus,
  Briefcase,
} from 'lucide-react'
import { SymbolSearchDialog } from './SymbolSearchDialog'
import { TradeTicket, TicketPrefill } from './TradeTicket'
import { useSymbolPositions } from './usePositions'
import { ExitInfo, PendingOrderInfo, normSym } from './trading-types'
import { ttLog } from '@/lib/console-log'

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

/** Suggested price for a not-yet-created TP/SL (ghost chip default). */
function ghostDefaultPrice(kind: 'tp' | 'sl', entry: number, long: boolean): number {
  return kind === 'tp' ? entry * (long ? 1.05 : 0.95) : entry * (long ? 0.95 : 1.05)
}

type Hit =
  | { type: 'drawing'; id: string; part: 'whole' | 'point'; index?: number }
  | { type: 'alert'; id: string; part: 'whole' }
  | { type: 'exit'; id: string; part: 'sl' | 'tp'; origPrice: number; exit: ExitInfo }
  | { type: 'position'; id: string; part: 'whole'; origPrice: number }
  | { type: 'pending'; id: string; part: 'whole' | 'tp' | 'sl'; pending: PendingOrderInfo; origPrice: number }
  | { type: 'ghost'; id: string; part: 'sl' | 'tp' }
  | { type: 'chart'; part: 'whole' }

/** Hits that exist on the canvas (everything except the synthetic chart-menu hit). */
type SceneHit = Exclude<Hit, { type: 'chart' }>

interface MenuState {
  x: number
  y: number
  hit: Hit
  price?: number | null
}

interface DragState {
  hit: SceneHit
  x0: number
  y0: number
  orig: { time: number | null; price: number }[]
  origPixels: ({ x: number; y: number } | null)[]
  moved: boolean
}

const KIND_LABEL: Record<DrawingKind, string> = {
  hline: 'Horizontal line',
  vline: 'Vertical line',
  trend: 'Trend line',
  fib: 'Fib retracement',
}

const EMPTY_DRAWINGS: Drawing[] = []

export interface ChartPanelProps {
  symbol: string
  timeframe: Timeframe
  onSymbolChange: (s: string) => void
  onTimeframeChange: (tf: Timeframe) => void
  /** grid mode: click to focus this pane (drives Quote/News sidebar) */
  onFocus?: () => void
  /** grid mode: visual focus ring */
  focused?: boolean
  /** pane key for crosshair sync (must be unique within the group) */
  syncKey?: string
  /** crosshair sync group id (tab id) or null to disable */
  syncGroup?: string | null
  /** smaller chrome for grid panes */
  compact?: boolean
}

export function ChartPanel({ symbol, timeframe: tf, onSymbolChange, onTimeframeChange, onFocus, focused, syncKey, syncGroup, compact }: ChartPanelProps) {
  // store
  const drawingTool = useTerminal((s) => s.drawingTool)
  const setDrawingTool = useTerminal((s) => s.setDrawingTool)
  const addDrawingLocal = useTerminal((s) => s.addDrawingLocal)
  const patchDrawingLocal = useTerminal((s) => s.patchDrawingLocal)
  const removeDrawingLocal = useTerminal((s) => s.removeDrawingLocal)
  const patchAlertLocal = useTerminal((s) => s.patchAlertLocal)
  const removeAlertLocal = useTerminal((s) => s.removeAlertLocal)
  const addAlertLocal = useTerminal((s) => s.addAlertLocal)
  const loadDrawings = useTerminal((s) => s.loadDrawings)

  // refs
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null)
  const barsRef = useRef<Bar[]>([])
  const hoverRef = useRef<string | null>(null)
  const feedStateRef = useRef('')
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<{ kind: DrawingKind; p1: DrawingPoint; p2: DrawingPoint } | null>(null)
  const rafRef = useRef(0)

  // ui state
  const [loading, setLoading] = useState(true)
  const [demo, setDemo] = useState(false)
  const [demoReason, setDemoReason] = useState<string | undefined>(undefined)
  const [settingsVer, setSettingsVer] = useState(0)
  const [chartType, setChartType] = useState<'candles' | 'line'>('candles')
  const [quote, setQuote] = useState<{ price: number; changePct: number; change: number } | null>(null)
  const [showDrawings, setShowDrawings] = useState(true)
  const [activeColor, setActiveColor] = useState(DRAW_COLORS[4])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editValue, setEditValue] = useState<{
    type: 'drawing' | 'alert' | 'exit' | 'ghost' | 'pending'; id?: string; part?: 'sl' | 'tp' | 'entry'; price: number; pctMode?: boolean; exit?: { info: ExitInfo; kind: 'sl' | 'tp' }; pending?: PendingOrderInfo
  } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [tradeOpen, setTradeOpen] = useState(false)
  const [ticketPrefill, setTicketPrefill] = useState<TicketPrefill | null>(null)
  const { toast } = useToast()

  // trading positions + SL/TP exits for this symbol (polls every 15s)
  const posData = useSymbolPositions(symbol)
  const posRefresh = posData.refresh
  const posRef = useRef(posData.data)
  posRef.current = posData.data
  const exitDragRef = useRef<{ kind: 'sl' | 'tp'; price: number | null } | null>(null)
  // pending-order drag (entry / planned TP / planned SL of an unfilled order)
  const pendingDragRef = useRef<{ part: 'entry' | 'tp' | 'sl'; price: number | null } | null>(null)
  // ghost [+TP]/[+SL] chip rects (rebuilt each overlay pass, hit-tested to
  // let the user DRAG a new exit out of the position line)
  const ghostChipRectsRef = useRef<{ part: 'sl' | 'tp'; x: number; y: number; w: number; h: number }[]>([])

  // crosshair sync (multi-chart grid): refs so the chart lifecycle effect
  // always reads fresh values without re-creating the chart
  const syncGroupRef = useRef(syncGroup)
  syncGroupRef.current = syncGroup
  const syncKeyRef = useRef(syncKey)
  syncKeyRef.current = syncKey
  const suppressSyncUntilRef = useRef(0)
  const syncRafRef = useRef(0)
  const pendingSyncRef = useRef<{ group: string; from: string; time: Time | null; price: number | null } | null>(null)

  // OHLC legend: written directly to these DOM nodes from the crosshair handler
  // (no React state — see note in the chart lifecycle effect)
  const legendRef = useRef<HTMLDivElement>(null)

  // x-axis event markers: earnings [E] (yfinance) + news ⚡ (Alpaca) — TradingView
  // style icons on the time axis at the event dates (one icon per event day)
  const markersRef = useRef<{
    earnings: { ts: number; epsActual?: number | null; epsEstimate?: number | null; upcoming?: boolean }[]
    news: { ts: number; title?: string }[]
  }>({ earnings: [], news: [] })
  // icon hit rects (rebuilt each renderOverlay pass, used for hover tooltips)
  const axisIconsRef = useRef<{ kind: 'e' | 'n'; x: number; y: number; w: number; h: number; tip: string }[]>([])
  const symEsc = symbol.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tfLabelEsc = TIMEFRAMES[tf].label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const drawings = useTerminal(useShallow((s) => s.drawingsBySymbol[symbol] ?? EMPTY_DRAWINGS))
  const symbolAlerts = useTerminal(useShallow((s) => s.alerts.filter((a) => a.symbol === symbol)))

  // Refetch market data when credentials change in Settings (save/test keys)
  useEffect(() => {
    const onChanged = () => setSettingsVer((v) => v + 1)
    window.addEventListener('tt:settings-changed', onChanged)
    return () => window.removeEventListener('tt:settings-changed', onChanged)
  }, [])

  // ---------- coordinate helpers ----------
  // Time → x. timeToCoordinate() only resolves EXACT bar times, so drawings
  // captured between bars / in the left-right margins previously vanished or
  // snapped to the wrong bar. Robust version: exact hit → interpolate between
  // the bracketing bars (handles weekend/overnight gaps) → extrapolate into
  // the margins using the per-bar pixel spacing.
  const xOf = useCallback((t: number | null): number | null => {
    if (t == null || !chartRef.current) return null
    const ts = chartRef.current.timeScale()
    const bars = barsRef.current
    const exact = ts.timeToCoordinate(t as UTCTimestamp)
    if (exact != null) return Number(exact)
    if (bars.length === 0) return null
    const last = bars.length - 1
    const barX = (i: number): number | null => {
      const x = ts.timeToCoordinate(bars[i].time as UTCTimestamp)
      return x == null ? null : Number(x)
    }
    // pixels per bar from two reference bars (index→x is globally linear)
    const pxPerBar = (): number | null => {
      const vr = ts.getVisibleLogicalRange()
      let a = vr ? Math.ceil(Number(vr.from)) : 0
      let b = vr ? Math.floor(Number(vr.to)) : last
      a = Math.max(0, Math.min(a, last))
      b = Math.max(0, Math.min(b, last))
      if (b === a) {
        a = Math.max(0, a - 1)
        b = Math.min(last, b + 1)
      }
      if (b === a) return null
      const xa = barX(a)
      const xb = barX(b)
      if (xa == null || xb == null || xb === xa) return null
      return (xb - xa) / (b - a)
    }
    if (t > bars[last].time) {
      const x1 = barX(last)
      if (x1 == null) return null
      const ppb = pxPerBar()
      if (ppb == null) return x1
      return x1 + ((t - bars[last].time) / TIMEFRAMES[tf].seconds) * ppb
    }
    if (t < bars[0].time) {
      const x0 = barX(0)
      if (x0 == null) return null
      const ppb = pxPerBar()
      if (ppb == null) return x0
      return x0 + ((t - bars[0].time) / TIMEFRAMES[tf].seconds) * ppb
    }
    // bracket: first bar with time >= t, interpolate to the previous bar
    let lo = 0
    let hi = last
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bars[mid].time < t) lo = mid + 1
      else hi = mid
    }
    const j = lo
    const i = Math.max(0, j - 1)
    const xa = barX(i)
    const xb = barX(j)
    if (xa == null || xb == null) return null
    const dt = bars[j].time - bars[i].time
    if (dt <= 0) return xa
    return xa + ((t - bars[i].time) / dt) * (xb - xa)
  }, [tf])

  const yOf = useCallback((p: number): number | null => {
    if (!seriesRef.current) return null
    const y = seriesRef.current.priceToCoordinate(p)
    return y == null ? null : Number(y)
  }, [])

  const priceAt = useCallback((y: number): number | null => {
    if (!seriesRef.current) return null
    const p = seriesRef.current.coordinateToPrice(y)
    return p == null ? null : Number(p)
  }, [])

  // Time under the cursor, CONTINUOUS (no snapping). lightweight-charts'
  // coordinateToTime() ceils to the NEXT bar, which used to place drawn lines
  // up to a full bar-width right of the arrow. We derive the exact fractional
  // bar index from two reference bars (public API only) and map it to a
  // continuous time: between bars → interpolate across their actual time gap,
  // beyond the data → extend by the timeframe seconds. Round-trips exactly
  // through xOf() above, so the committed line lands precisely under the
  // cursor — matching TradingView (magnet off).
  const timeAt = useCallback((x: number): number | null => {
    const chart = chartRef.current
    const bars = barsRef.current
    if (!chart || bars.length === 0) return null
    const ts = chart.timeScale()
    const last = bars.length - 1
    const vr = ts.getVisibleLogicalRange()
    let a = vr ? Math.ceil(Number(vr.from)) : 0
    let b = vr ? Math.floor(Number(vr.to)) : last
    a = Math.max(0, Math.min(a, last))
    b = Math.max(0, Math.min(b, last))
    if (b === a) {
      a = Math.max(0, a - 1)
      b = Math.min(last, b + 1)
    }
    if (b === a) return null
    const xa = ts.timeToCoordinate(bars[a].time as UTCTimestamp)
    const xb = ts.timeToCoordinate(bars[b].time as UTCTimestamp)
    if (xa == null || xb == null || Number(xb) === Number(xa)) return null
    const fi = a + ((x - Number(xa)) / (Number(xb) - Number(xa))) * (b - a)
    const tfSec = TIMEFRAMES[tf].seconds
    if (fi >= last) return bars[last].time + (fi - last) * tfSec
    if (fi <= 0) return bars[0].time + fi * tfSec
    const i = Math.floor(fi)
    const f = fi - i
    const t0 = bars[i].time
    const t1 = bars[i + 1].time
    return t1 > t0 ? t0 + f * (t1 - t0) : t0
  }, [tf])

  // scheduleRedraw must invoke the LATEST renderOverlay: a rAF closure over
  // renderOverlay directly would capture the FIRST render's copy (useCallback
  // deps []), whose `symbol`/`showDrawings`/`activeColor` are frozen — after a
  // symbol switch every redraw rendered the OLD symbol's drawings, so a newly
  // drawn line never appeared until a full page reload. The ref always points
  // at the current render's overlay renderer (assigned right after its
  // definition below).
  const renderOverlayRef = useRef<() => void>(() => {})
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      renderOverlayRef.current()
    })
  }, [])

  // ---------- overlay rendering ----------
  const renderOverlay = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const w = container.clientWidth
    const h = container.clientHeight
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const st = useTerminal.getState()
    const ds = st.drawingsBySymbol[symbol] || []
    const als = st.alerts.filter((a) => a.symbol === symbol && a.status !== 'triggered')

    if (st.drawingTool !== 'cursor' || draftRef.current) {
      // drawing hint strip
      ctx.fillStyle = 'rgba(161,161,170,0.75)'
      ctx.font = '11px ui-sans-serif, system-ui'
      const label =
        draftRef.current
          ? `${KIND_LABEL[draftRef.current.kind]}: click to set end point · Esc to cancel`
          : `${KIND_LABEL[st.drawingTool as DrawingKind]}: click on the chart${st.drawingTool === 'trend' || st.drawingTool === 'fib' ? ' (2 clicks)' : ''}`
      ctx.fillText(label, 46, 84)
    }

    if (st.drawingTool === 'cursor') {
      if (showDrawings) for (const d of ds) drawDrawing(ctx, d, w, h, hoverRef.current === d.id || (dragRef.current?.hit.type === 'drawing' && dragRef.current.hit.id === d.id))
      for (const a of als) drawAlert(ctx, a, w)
    } else if (showDrawings) {
      for (const d of ds) drawDrawing(ctx, d, w, h, false)
    }

    // ---- trade zones + position / pending-order lines (trade assistance) ----
    // Zones (entry↔TP green / entry↔SL red, 50% translucent) paint FIRST so
    // every line and chip renders on top of them.
    const posBundle = posRef.current
    const myPos = posBundle?.positions.find((p) => normSym(p.symbol) === normSym(symbol))
    const myExits = posBundle?.exits[normSym(symbol)]
    const pendings = (posBundle?.pending || []).filter((p) => normSym(p.symbol) === normSym(symbol) && p.limitPrice != null)
    const TP_ZONE = 'rgba(34,197,94,0.5)' // transparent green 50% (user spec)
    const SL_ZONE = 'rgba(244,63,94,0.5)' // transparent red 50% (user spec)
    const drawZone = (priceA: number, priceB: number, color: string) => {
      const yA = yOf(priceA)
      const yB = yOf(priceB)
      if (yA == null || yB == null || Math.abs(yA - yB) < 1) return
      ctx.save()
      ctx.fillStyle = color
      ctx.fillRect(0, Math.min(yA, yB), w, Math.abs(yB - yA))
      ctx.restore()
    }
    // filled-position zones
    if (myPos && myPos.avgEntry > 0) {
      if (myExits?.tp?.limitPrice != null) drawZone(myPos.avgEntry, myExits.tp.limitPrice, TP_ZONE)
      if (myExits?.sl && (myExits.sl.stopPrice != null || myExits.sl.limitPrice != null)) {
        drawZone(myPos.avgEntry, myExits.sl.stopPrice ?? myExits.sl.limitPrice!, SL_ZONE)
      }
    }
    // pending-order zones (planned TP/SL from the bracket legs / ttb- plan)
    for (const p of pendings) {
      if (p.tpPrice != null) drawZone(p.limitPrice!, p.tpPrice, TP_ZONE)
      if (p.slPrice != null) drawZone(p.limitPrice!, p.slPrice, SL_ZONE)
    }

    // position entry line
    let posChipRect: { x: number; y: number; w: number; h: number } | null = null
    ghostChipRectsRef.current = []
    if (myPos) {
      const yEntry = yOf(myPos.avgEntry)
      if (yEntry != null) {
        ctx.save()
        ctx.strokeStyle = '#e4e4e7'
        ctx.lineWidth = 1.5
        ctx.setLineDash([10, 4])
        ctx.globalAlpha = 0.85
        hlinePath(ctx, yEntry, w)
        ctx.setLineDash([])
        ctx.restore()
        posChipRect = drawChip(ctx, w - 150, yEntry, `POS ${myPos.side === 'long' ? '+' : '-'}${myPos.qty} @ ${fmtPrice(myPos.avgEntry)}`, '#a1a1aa', false)
        // ghost [+TP]/[+SL] chips LEFT of the POS chip for every missing exit —
        // drag one to a target price to create the exit, click to type a price
        const long = myPos.side === 'long'
        let rightEdge = posChipRect.x - 6
        if (!myExits?.tp) {
          const hr = drawGhostChip(ctx, rightEdge, yEntry, '[+TP]', '#22c55e', hoverRef.current === 'ghost:tp')
          ghostChipRectsRef.current.push({ part: 'tp', ...hr })
          rightEdge = hr.x - 6
        }
        if (!myExits?.sl) {
          const hr = drawGhostChip(ctx, rightEdge, yEntry, '[+SL]', '#f43f5e', hoverRef.current === 'ghost:sl')
          ghostChipRectsRef.current.push({ part: 'sl', ...hr })
        }
      }
    }
    // pending entry line (dashed; right-click → cancel)
    for (const p of pendings) {
      const yEntry = yOf(p.limitPrice!)
      if (yEntry == null) continue
      ctx.save()
      ctx.strokeStyle = p.side === 'buy' ? '#34d399' : '#fb7185'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.globalAlpha = 0.95
      hlinePath(ctx, yEntry, w)
      ctx.setLineDash([])
      ctx.restore()
      drawChip(
        ctx,
        w - 210,
        yEntry,
        `${p.side === 'buy' ? 'BUY' : 'SELL'} ${p.type.toUpperCase()} ${p.qty} @ ${fmtPrice(p.limitPrice!)}${p.managed ? ' · TP/SL' : ''}`,
        p.side === 'buy' ? '#34d399' : '#fb7185',
        hoverRef.current?.startsWith('pending') ?? false,
      )
    }
    if (myExits?.sl && (myExits.sl.stopPrice != null || myExits.sl.limitPrice != null)) {
      const slPrice = myExits.sl.stopPrice ?? myExits.sl.limitPrice!
      const ySl = yOf(slPrice)
      if (ySl != null) {
        // trailing stops ratchet — label the percent, not the (stale) stop
        const isTrail = myExits.sl.type === 'trailing_stop'
        ctx.save()
        ctx.strokeStyle = '#f43f5e'
        ctx.lineWidth = 1.5
        ctx.setLineDash(isTrail ? [2, 4] : [7, 5])
        ctx.globalAlpha = 0.95
        hlinePath(ctx, ySl, w)
        ctx.setLineDash([])
        ctx.restore()
        drawChip(
          ctx,
          w - 92,
          ySl,
          isTrail ? `SL trail ${myExits.sl.trailPercent ?? '?'}%` : `SL ${fmtPrice(slPrice)}`,
          '#f43f5e',
          hoverRef.current?.startsWith('exit') ?? false,
        )
      }
    }
    if (myExits?.tp && myExits.tp.limitPrice != null) {
      const yTp = yOf(myExits.tp.limitPrice)
      if (yTp != null) {
        ctx.save()
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 1.5
        ctx.setLineDash([7, 5])
        ctx.globalAlpha = 0.95
        hlinePath(ctx, yTp, w)
        ctx.setLineDash([])
        ctx.restore()
        drawChip(ctx, w - 92, yTp, `TP ${fmtPrice(myExits.tp.limitPrice)}`, '#22c55e', hoverRef.current?.startsWith('exit') ?? false)
      }
    }
    // pending TP/SL lines (green/red dashed per spec)
    for (const p of pendings) {
      if (p.tpPrice != null) {
        const yTp = yOf(p.tpPrice)
        if (yTp != null) {
          ctx.save()
          ctx.strokeStyle = '#22c55e'
          ctx.lineWidth = 1.5
          ctx.setLineDash([7, 5])
          ctx.globalAlpha = 0.95
          hlinePath(ctx, yTp, w)
          ctx.setLineDash([])
          ctx.restore()
          drawChip(ctx, w - 118, yTp, `TP ${fmtPrice(p.tpPrice)} (pend)`, '#22c55e', hoverRef.current?.startsWith('pending') ?? false)
        }
      }
      if (p.slPrice != null) {
        const ySl = yOf(p.slPrice)
        if (ySl != null) {
          ctx.save()
          ctx.strokeStyle = '#f43f5e'
          ctx.lineWidth = 1.5
          ctx.setLineDash([7, 5])
          ctx.globalAlpha = 0.95
          hlinePath(ctx, ySl, w)
          ctx.setLineDash([])
          ctx.restore()
          drawChip(ctx, w - 118, ySl, `SL ${fmtPrice(p.slPrice)} (pend)`, '#f43f5e', hoverRef.current?.startsWith('pending') ?? false)
        }
      }
    }
    // preview of the NEW sl/tp value while dragging (user asked explicitly)
    const exDrag = exitDragRef.current
    if (exDrag && exDrag.price != null) {
      const yD = yOf(exDrag.price)
      if (yD != null) {
        ctx.save()
        ctx.strokeStyle = exDrag.kind === 'sl' ? '#fb7185' : '#4ade80'
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 4])
        ctx.globalAlpha = 1
        hlinePath(ctx, yD, w)
        ctx.setLineDash([])
        ctx.restore()
        drawChip(ctx, w - 122, yD, `new ${exDrag.kind.toUpperCase()} ${fmtPrice(exDrag.price)}`, exDrag.kind === 'sl' ? '#fb7185' : '#4ade80', true)
      }
    }
    // preview of the NEW pending entry/TP/SL while dragging (drops → PATCH)
    const pDrag = pendingDragRef.current
    if (pDrag && pDrag.price != null) {
      const yD = yOf(pDrag.price)
      if (yD != null) {
        const color = pDrag.part === 'tp' ? '#4ade80' : pDrag.part === 'sl' ? '#fb7185' : '#e4e4e7'
        ctx.save()
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 4])
        ctx.globalAlpha = 1
        hlinePath(ctx, yD, w)
        ctx.setLineDash([])
        ctx.restore()
        const label = pDrag.part === 'entry' ? 'ENTRY' : pDrag.part.toUpperCase()
        drawChip(ctx, w - 122, yD, `new ${label} ${fmtPrice(pDrag.price)}`, color, true)
      }
    }

    // ---- x-axis event icons: earnings [E] (yfinance) + news ⚡ (TradingView-style) ----
    // Icons sit ON the time axis (bottom of the pane), aligned with the event's
    // bar; upcoming earnings extrapolate into the right margin at their real
    // date. Events are deduped per (kind, day) — one icon per event day — and
    // crowded icons spread HORIZONTALLY along the axis (never stacked into a
    // vertical column).
    const chartApi = chartRef.current
    const mk = markersRef.current
    axisIconsRef.current = []
    if (chartApi && (mk.earnings.length > 0 || mk.news.length > 0) && barsRef.current.length > 0) {
      const psW = chartApi.priceScale('right').width()
      const tAxisH = chartApi.timeScale().height()
      const bars = barsRef.current
      const lastBarTime = bars[bars.length - 1].time
      const xMin = 8
      const xMax = w - psW - 6
      const yBase = h - tAxisH - 11 // first-row icon center, just above the time axis
      const halfW = 15 // generic icon half-width used for off-canvas culling

      // bar in effect at the event moment (past events snap to their bar)
      const barAt = (ts: number): Bar | null => {
        if (ts < bars[0].time) return null
        if (ts >= bars[bars.length - 1].time) return bars[bars.length - 1]
        let lo = 0
        let hi = bars.length - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (bars[mid].time <= ts) lo = mid
          else hi = mid - 1
        }
        return bars[lo]
      }
      const fmtDay = (ts: number) =>
        new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

      type AxisIcon = { kind: 'e' | 'n'; x: number; y: number; tip: string }
      // dedupe per (kind, resolved target time): one icon per event day, with
      // the individual headlines/details merged into its tooltip
      const grouped = new Map<string, { kind: 'e' | 'n'; t: number; tips: string[] }>()
      const collect = (kind: 'e' | 'n', ts: number, tip: string) => {
        // past events snap to the bar in effect; future events (upcoming
        // earnings) extrapolate into the right margin at their real date
        const t = ts > lastBarTime ? ts : (barAt(ts)?.time ?? null)
        if (t == null) return
        const key = `${kind}:${t}`
        const g = grouped.get(key)
        if (g) g.tips.push(tip)
        else grouped.set(key, { kind, t, tips: [tip] })
      }
      for (const e of mk.earnings) {
        const epsBits =
          e.epsActual != null
            ? ` · EPS ${e.epsActual}${e.epsEstimate != null ? ` (est ${e.epsEstimate})` : ''}`
            : ''
        collect('e', e.ts, `Earnings · ${fmtDay(e.ts)}${e.upcoming ? ' · upcoming' : ''}${epsBits}`)
      }
      for (const n of mk.news) {
        collect('n', n.ts, `News · ${fmtDay(n.ts)}${n.title ? ` — ${n.title}` : ''}`)
      }

      const icons: AxisIcon[] = []
      for (const g of grouped.values()) {
        const rawX = xOf(g.t)
        if (rawX == null || rawX < xMin - halfW * 2 || rawX > w + halfW * 2) continue
        const extra = g.tips.length > 1 ? ` (+${g.tips.length - 1} more)` : ''
        icons.push({ kind: g.kind, x: rawX, y: yBase, tip: `${g.tips[0]}${extra}` })
      }

      // spread crowded icons HORIZONTALLY along the axis: forward pass pushes
      // each icon right of the previous one, backward pass clamps the tail to
      // the right edge — the result is a readable row on the time axis
      icons.sort((a, b) => a.x - b.x)
      const gapBetween = (a: AxisIcon, b: AxisIcon) =>
        (a.kind === 'e' ? 14 : 8) + (b.kind === 'e' ? 14 : 8) + 3
      if (icons.length > 0) {
        icons[0].x = Math.max(icons[0].x, xMin)
        for (let i = 1; i < icons.length; i++) {
          icons[i].x = Math.max(icons[i].x, icons[i - 1].x + gapBetween(icons[i - 1], icons[i]))
        }
        icons[icons.length - 1].x = Math.min(icons[icons.length - 1].x, xMax)
        for (let i = icons.length - 2; i >= 0; i--) {
          icons[i].x = Math.min(icons[i].x, icons[i + 1].x - gapBetween(icons[i], icons[i + 1]))
        }
        icons[0].x = Math.max(icons[0].x, xMin)
      }
      const placed = icons
      const hoverIdx = hoverRef.current?.startsWith('axis:') ? parseInt(hoverRef.current.slice(5), 10) : -1

      placed.forEach((ic, i) => {
        const highlighted = i === hoverIdx
        ctx.save()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        if (ic.kind === 'e') {
          const bw = 27
          const bh = 15
          ctx.fillStyle = 'rgba(24,24,27,0.92)'
          ctx.strokeStyle = highlighted ? '#fde047' : '#f59e0b'
          ctx.lineWidth = highlighted ? 1.6 : 1
          ctx.beginPath()
          ctx.roundRect(ic.x - bw / 2, ic.y - bh / 2, bw, bh, 4)
          ctx.fill()
          ctx.stroke()
          ctx.fillStyle = highlighted ? '#fde047' : '#fbbf24'
          ctx.font = `${highlighted ? '600 ' : ''}9px ui-monospace, monospace`
          ctx.fillText('[E]', ic.x, ic.y + 0.5)
        } else {
          ctx.fillStyle = 'rgba(24,24,27,0.92)'
          ctx.strokeStyle = highlighted ? '#f0abfc' : 'rgba(232,121,249,0.55)'
          ctx.lineWidth = highlighted ? 1.6 : 1
          ctx.beginPath()
          ctx.arc(ic.x, ic.y, 7.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          ctx.font = '10px sans-serif'
          ctx.fillText('⚡', ic.x, ic.y + 0.5)
        }
        ctx.restore()
        axisIconsRef.current.push({ kind: ic.kind, x: ic.x - 15, y: ic.y - 9, w: 30, h: 18, tip: ic.tip })
      })

      // tooltip for the hovered axis icon (above the icon, clamped to the pane)
      if (hoverIdx >= 0 && hoverIdx < axisIconsRef.current.length) {
        const hit = axisIconsRef.current[hoverIdx]
        ctx.save()
        ctx.font = '10px ui-sans-serif, system-ui'
        const maxW = 240
        const words = hit.tip.split(' ')
        const lines: string[] = []
        let line = ''
        for (const wd of words) {
          const cand = line ? `${line} ${wd}` : wd
          if (ctx.measureText(cand).width > maxW && line) {
            lines.push(line)
            line = wd
          } else line = cand
        }
        if (line) lines.push(line)
        const tw = Math.min(maxW, ...lines.map((l) => ctx.measureText(l).width)) + 14
        const th = lines.length * 14 + 9
        const tx = Math.min(Math.max(hit.x + hit.w / 2 - tw / 2, 6), w - psW - tw - 6)
        const ty = Math.max(6, hit.y - th - 6)
        ctx.fillStyle = 'rgba(9,9,11,0.96)'
        ctx.strokeStyle = 'rgba(113,113,122,0.6)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(tx, ty, tw, th, 5)
        ctx.fill()
        ctx.stroke()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        lines.forEach((l, li) => {
          ctx.fillStyle = li === 0 && hit.kind === 'e' ? '#fbbf24' : li === 0 && hit.kind === 'n' ? '#e879f9' : '#d4d4d8'
          ctx.font = `${li === 0 ? '600 ' : ''}10px ui-sans-serif, system-ui`
          ctx.fillText(l, tx + 7, ty + 5 + li * 14)
        })
        ctx.restore()
      }
    }

    // draft preview
    const draft = draftRef.current
    if (draft) {
      const p1 = pixelPoint(draft.p1)
      const p2 = pixelPoint(draft.p2)
      ctx.save()
      ctx.strokeStyle = activeColor
      ctx.globalAlpha = 0.75
      ctx.setLineDash([5, 4])
      ctx.lineWidth = 1.5
      if (draft.kind === 'hline' && p1) hlinePath(ctx, p1.y, w)
      else if (draft.kind === 'vline' && p1) vlinePath(ctx, p1.x, h)
      else if (p1 && p2) segPath(ctx, p1, p2, w, draft.kind === 'fib')
      ctx.restore()
    }
     
  }, [symbol, showDrawings, activeColor, xOf, yOf, priceAt, timeAt])
  // keep the redraw scheduler pointed at the freshest overlay renderer
  // (see the stale-closure note above scheduleRedraw)
  renderOverlayRef.current = renderOverlay

  function pixelPoint(pt: DrawingPoint): { x: number; y: number } | null {
    const x = pt.time == null ? null : xOf(pt.time)
    const y = yOf(pt.price)
    if (x == null || y == null) return null
    return { x, y }
  }

  function hlinePath(ctx: CanvasRenderingContext2D, y: number, w: number) {
    ctx.beginPath()
    ctx.moveTo(0, Math.round(y) + 0.5)
    ctx.lineTo(w, Math.round(y) + 0.5)
    ctx.stroke()
  }
  function vlinePath(ctx: CanvasRenderingContext2D, x: number, h: number) {
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, h)
    ctx.stroke()
  }
  function segPath(ctx: CanvasRenderingContext2D, p1: { x: number; y: number }, p2: { x: number; y: number }, w: number, extendRight: boolean) {
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    if (extendRight) {
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const farX = dx !== 0 ? (w - p1.x) / dx : Infinity
      const ex = farX >= 0 ? w : p1.x - dx * 100
      const ey = p1.y + dy * (farX >= 0 ? farX : -100)
      ctx.lineTo(ex, ey)
    } else {
      ctx.lineTo(p2.x, p2.y)
    }
    ctx.stroke()
  }

  function drawDrawing(ctx: CanvasRenderingContext2D, d: Drawing, w: number, h: number, highlighted: boolean) {
    ctx.save()
    ctx.strokeStyle = d.color
    ctx.lineWidth = d.width + (highlighted ? 1 : 0)
    ctx.globalAlpha = 1

    if (d.kind === 'hline') {
      const y = yOf(d.points[0]?.price ?? 0)
      if (y != null) {
        hlinePath(ctx, y, w)
        drawChip(ctx, w - 74, y, fmtPrice(d.points[0].price), d.color, highlighted)
        // move grip dots at center
        dot(ctx, w / 2, y, d.color, highlighted)
      }
    } else if (d.kind === 'vline') {
      const x = xOf(d.points[0]?.time ?? null)
      if (x != null) {
        vlinePath(ctx, x, h)
        dot(ctx, x, h / 2, d.color, highlighted)
      }
    } else if (d.kind === 'trend' || d.kind === 'fib') {
      const p1 = pixelPoint(d.points[0])
      const p2 = pixelPoint(d.points[1])
      if (p1 && p2) {
        if (d.kind === 'trend') {
          segPath(ctx, p1, p2, w, false)
        } else {
          // fib: levels between p1..p2 extended to right edge
          const xLeft = Math.min(p1.x, p2.x)
          const price1 = d.points[0].price
          const price2 = d.points[1].price
          ctx.font = '10px ui-monospace, monospace'
          for (const lv of FIB_LEVELS) {
            const priceLv = price2 + (price1 - price2) * lv
            const y = yOf(priceLv)
            if (y == null) continue
            ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : 0.6
            ctx.setLineDash(lv === 0.5 ? [6, 3] : [])
            ctx.beginPath()
            ctx.moveTo(xLeft, Math.round(y) + 0.5)
            ctx.lineTo(w, Math.round(y) + 0.5)
            ctx.stroke()
            ctx.globalAlpha = 0.95
            ctx.fillStyle = d.color
            const label = `${lv.toFixed(3)}  ${fmtPrice(priceLv)}`
            ctx.fillText(label, xLeft + 4, y - 3)
          }
        }
        dot(ctx, p1.x, p1.y, d.color, highlighted)
        dot(ctx, p2.x, p2.y, d.color, highlighted)
      }
    }
    ctx.restore()
  }

  function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, highlighted: boolean): { x: number; y: number; w: number; h: number } {
    ctx.save()
    ctx.font = '10px ui-monospace, monospace' // set BEFORE measureText (was measured with a stale font)
    const wTxt = ctx.measureText(text).width
    const bw = Math.max(46, wTxt + 12)
    const bh = 16
    const by = Math.round(y) - bh / 2
    ctx.fillStyle = color
    ctx.globalAlpha = highlighted ? 1 : 0.9
    ctx.beginPath()
    ctx.roundRect(x, by, bw, bh, 3)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = '#09090b'
    ctx.fillText(text, x + 6, by + 11.5)
    ctx.restore()
    return { x, y: by, w: bw, h: bh }
  }

  /** Outline-style chip for a MISSING exit ("[+TP]"/"[+SL]"); its RIGHT edge
   * sits at rightEdge. Returns the rect for hit-testing. */
  function drawGhostChip(ctx: CanvasRenderingContext2D, rightEdge: number, y: number, text: string, color: string, highlighted: boolean): { x: number; y: number; w: number; h: number } {
    ctx.save()
    ctx.font = '10px ui-monospace, monospace'
    const wTxt = ctx.measureText(text).width
    const bw = Math.max(34, wTxt + 12)
    const bh = 16
    const x = Math.round(rightEdge) - bw
    const by = Math.round(y) - bh / 2
    ctx.globalAlpha = highlighted ? 1 : 0.9
    ctx.fillStyle = 'rgba(9,9,11,0.85)'
    ctx.beginPath()
    ctx.roundRect(x, by, bw, bh, 3)
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = highlighted ? 1.6 : 1
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.fillText(text, x + 6, by + 11.5)
    ctx.restore()
    return { x, y: by, w: bw, h: bh }
  }

  function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, highlighted: boolean) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, highlighted ? 4.5 : 3.5, 0, Math.PI * 2)
    ctx.fillStyle = '#09090b'
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  function drawAlert(ctx: CanvasRenderingContext2D, a: { id: string; price: number; color: string; status: string }, w: number) {
    const y = yOf(a.price)
    if (y == null) return
    ctx.save()
    ctx.strokeStyle = a.color
    ctx.lineWidth = 1.5
    ctx.setLineDash(a.status === 'paused' ? [2, 5] : [7, 5])
    ctx.globalAlpha = a.status === 'paused' ? 0.6 : 0.95
    hlinePath(ctx, y, w)
    ctx.setLineDash([])
    // bell chip on the right axis
    const label = `${a.status === 'paused' ? '⏸' : '🔔'} ${fmtPrice(a.price)}`
    ctx.font = '10px ui-monospace, monospace'
    const bw = ctx.measureText(label).width + 14
    const by = Math.round(y) - 8
    ctx.globalAlpha = 1
    ctx.fillStyle = a.color
    ctx.beginPath()
    ctx.roundRect(w - bw - 4, by, bw, 16, 3)
    ctx.fill()
    ctx.fillStyle = '#09090b'
    ctx.fillText(label, w - bw + 2, by + 11.5)
    ctx.restore()
  }

  // redraw when relevant state changes
  useEffect(() => {
    scheduleRedraw()
  }, [drawings, symbolAlerts, showDrawings, drawingTool, activeColor, posData.data, scheduleRedraw])

  // CRITICAL: redraw the overlay whenever the container resizes. Panel splits,
  // window resizes and sidebar changes alter the pane height -> lightweight-charts
  // remaps price->pixel (scale margins are relative to height), but NOTHING else
  // fires a redraw, leaving drawings/painted lines at stale pixel positions
  // ("drawing not at right position"). The ResizeObserver closes that gap.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => scheduleRedraw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [scheduleRedraw])

  // ---------- hit testing ----------
  const distToSeg = (px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) return Math.hypot(px - a.x, py - a.y)
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
  }

  const hitTest = useCallback((x: number, y: number): SceneHit | null => {
    const st = useTerminal.getState()
    const ds = st.drawingsBySymbol[symbol] || []
    const als = st.alerts.filter((a) => a.symbol === symbol && a.status !== 'triggered')

    // trade lines take priority (pending orders / position entry / SL / TP)
    const posBundle = posRef.current
    const myPos = posBundle?.positions.find((p) => normSym(p.symbol) === normSym(symbol))
    const myExits = posBundle?.exits[normSym(symbol)]
    const pendings = (posBundle?.pending || []).filter((pp) => normSym(pp.symbol) === normSym(symbol) && pp.limitPrice != null)
    for (const p of pendings) {
      const yE = yOf(p.limitPrice!)
      if (yE != null && Math.abs(y - yE) < 7) {
        return { type: 'pending', id: p.orderId, part: 'whole', pending: p, origPrice: p.limitPrice! }
      }
      if (p.tpPrice != null) {
        const yT = yOf(p.tpPrice)
        if (yT != null && Math.abs(y - yT) < 7) {
          return { type: 'pending', id: p.orderId, part: 'tp', pending: p, origPrice: p.tpPrice }
        }
      }
      if (p.slPrice != null) {
        const yS = yOf(p.slPrice)
        if (yS != null && Math.abs(y - yS) < 7) {
          return { type: 'pending', id: p.orderId, part: 'sl', pending: p, origPrice: p.slPrice }
        }
      }
    }
    if (myExits?.sl && (myExits.sl.stopPrice != null || myExits.sl.limitPrice != null)) {
      const slPrice = myExits.sl.stopPrice ?? myExits.sl.limitPrice!
      const yl = yOf(slPrice)
      if (yl != null && Math.abs(y - yl) < 7) {
        // trailing stops are hittable too (menu / double-click → trail %);
        // their drag is a no-op (no fixed price)
        return { type: 'exit', id: myExits.sl.orderId, part: 'sl', origPrice: slPrice, exit: myExits.sl }
      }
    }
    if (myExits?.tp && myExits.tp.limitPrice != null) {
      const yl = yOf(myExits.tp.limitPrice)
      if (yl != null && Math.abs(y - yl) < 7) {
        return { type: 'exit', id: myExits.tp.orderId, part: 'tp', origPrice: myExits.tp.limitPrice, exit: myExits.tp }
      }
    }
    // ghost [+TP]/[+SL] chips — rect hit, tested BEFORE the position line
    // (the chips sit ON the entry line at the right edge)
    for (const r of ghostChipRectsRef.current) {
      if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2) {
        return { type: 'ghost', id: r.part, part: r.part }
      }
    }
    if (myPos && myPos.avgEntry > 0) {
      const yl = yOf(myPos.avgEntry)
      if (yl != null && Math.abs(y - yl) < 6) {
        return { type: 'position', id: myPos.tradeSymbol, part: 'whole', origPrice: myPos.avgEntry }
      }
    }

    if (showDrawings) {
      for (let i = ds.length - 1; i >= 0; i--) {
        const d = ds[i]
        if (d.kind === 'hline') {
          const yl = yOf(d.points[0]?.price ?? 0)
          if (yl != null && Math.abs(y - yl) < 7) return { type: 'drawing', id: d.id, part: 'whole' }
        } else if (d.kind === 'vline') {
          const xl = xOf(d.points[0]?.time ?? null)
          if (xl != null && Math.abs(x - xl) < 7) return { type: 'drawing', id: d.id, part: 'whole' }
        } else {
          const p1 = pixelPoint(d.points[0])
          const p2 = pixelPoint(d.points[1])
          if (p1 && Math.hypot(x - p1.x, y - p1.y) < 8) return { type: 'drawing', id: d.id, part: 'point', index: 0 }
          if (p2 && Math.hypot(x - p2.x, y - p2.y) < 8) return { type: 'drawing', id: d.id, part: 'point', index: 1 }
          if (d.kind === 'trend' && p1 && p2 && distToSeg(x, y, p1, p2) < 7) {
            return { type: 'drawing', id: d.id, part: 'whole' }
          }
          if (d.kind === 'fib' && p1 && p2) {
            const xLeft = Math.min(p1.x, p2.x)
            if (x >= xLeft - 4) {
              const price1 = d.points[0].price
              const price2 = d.points[1].price
              for (const lv of FIB_LEVELS) {
                const yl = yOf(price2 + (price1 - price2) * lv)
                if (yl != null && Math.abs(y - yl) < 6) return { type: 'drawing', id: d.id, part: 'whole' }
              }
            }
          }
        }
      }
    }
    for (let i = als.length - 1; i >= 0; i--) {
      const yl = yOf(als[i].price)
      if (yl != null && Math.abs(y - yl) < 7) return { type: 'alert', id: als[i].id, part: 'whole' }
    }
    return null
     
  }, [symbol, showDrawings, xOf, yOf])

  // ---------- drawing persistence ----------
  const createDrawing = useCallback(async (kind: DrawingKind, points: DrawingPoint[]) => {
    const optimistic: Drawing = {
      id: `tmp-${Date.now()}`,
      symbol,
      kind,
      points,
      color: activeColor,
      width: 2,
      meta: null,
    }
    addDrawingLocal(optimistic)
    try {
      const res = await fetch('/api/drawings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, kind, points, color: activeColor, width: 2 }),
      })
      if (res.ok) {
        const json = await res.json()
        removeDrawingLocal(optimistic.id, symbol)
        addDrawingLocal(json.drawing)
      }
    } catch { /* offline — optimistic stays */ }
  }, [symbol, activeColor, addDrawingLocal, removeDrawingLocal])

  const patchDrawing = useCallback(async (id: string, patch: { points?: DrawingPoint[]; color?: string }) => {
    patchDrawingLocal(id, symbol, patch)
    await fetch(`/api/drawings/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => { /* offline */ })
  }, [symbol, patchDrawingLocal])

  const deleteDrawing = useCallback(async (id: string) => {
    removeDrawingLocal(id, symbol)
    await fetch(`/api/drawings/${id}`, { method: 'DELETE' }).catch(() => { /* offline */ })
  }, [symbol, removeDrawingLocal])

  const patchAlert = useCallback(async (id: string, patch: Record<string, unknown>) => {
    patchAlertLocal(id, patch)
    await fetch(`/api/alerts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => { /* offline */ })
  }, [patchAlertLocal])

  const deleteAlert = useCallback(async (id: string) => {
    removeAlertLocal(id)
    await fetch(`/api/alerts/${id}`, { method: 'DELETE' }).catch(() => { /* offline */ })
  }, [removeAlertLocal])

  const addAlertAtPrice = useCallback(async (price: number) => {
    const cur = quote?.price ?? price
    // 'above' fires when price rises into the level (current price below it);
    // 'below' fires when price falls into it (current price above it).
    const direction = cur > price ? 'below' : 'above'
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, price, direction, color: DRAW_COLORS[2] }),
      })
      if (res.ok) {
        const json = await res.json()
        addAlertLocal(json.alert)
      }
    } catch { /* offline */ }
  }, [symbol, quote, addAlertLocal])

  // ---------- trade assistance actions ----------
  const patchExitPrice = useCallback(async (
    info: ExitInfo, kind: 'sl' | 'tp', price: number, attempt = 0,
  ) => {
    if (info.type === 'trailing_stop') {
      // a trailing stop has no fixed price — Alpaca ratchets stop_price itself;
      // only the trail % is editable (patchExitTrailPct)
      toast({ title: 'Trailing stop has no fixed price', description: 'Change the trail % instead (right-click → Change trail %).', variant: 'destructive' })
      void posRefresh()
      return
    }
    const body: Record<string, unknown> = {
      // the mode the position was loaded from — without it the route falls
      // back to the stored preference and can PATCH the WRONG host (paper vs
      // live have separate order-id spaces), which silently never updated
      // the order on Alpaca
      mode: posData.data?.mode,
      // crypto prices allow 9dp; stocks reject sub-penny — the server picks
      // the right rounding from this flag
      crypto: symbol.includes('/'),
    }
    if (kind === 'tp') {
      body.limit_price = price
    } else {
      body.stop_price = price
      if (info.type === 'stop_limit' && info.stopPrice != null && info.limitPrice != null) {
        // preserve the stop→limit offset of the original stop-limit order
        const off = info.stopPrice - info.limitPrice
        body.limit_price = Math.max(1e-9, price - off)
      }
    }
    try {
      const res = await fetch(`/api/trading/orders/${info.orderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({
          title: `${kind.toUpperCase()} updated to ${fmtPrice(price)}`,
          description: json?.method === 'cancel-replace'
            ? 'Order re-created on Alpaca (replace rejected)'
            : json?.note || undefined,
        })
      } else if (attempt === 0 && (res.status === 404 || res.status === 409)) {
        // STALE-ID HEAL: the exit was JUST re-created (a previous drag or a
        // concurrent edit replaced the order id) — retry once against the
        // CURRENT id so the user's drag still lands instead of erroring
        const fresh = await fetch(`/api/trading/positions?symbol=${encodeURIComponent(symbol)}`)
          .then((r) => r.json()).catch(() => null)
        const cur = fresh?.exits?.[normSym(symbol)]?.[kind]
        if (cur?.orderId && cur.orderId !== info.orderId) {
          await patchExitPrice(cur, kind, price, 1)
          return
        }
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      } else {
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Update failed', description: 'Network error', variant: 'destructive' })
    } finally {
      void posRefresh()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      // a cancel+re-place replace churns server-side for ~2s — a second
      // refresh heals any gap state the first refresh raced (lines must never
      // stay missing after a move)
      window.setTimeout(() => {
        void posRefresh()
        window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      }, 2500)
    }
  }, [posData.data?.mode, posRefresh, toast, symbol])

  // change the trail % of a trailing-stop exit — the line's stop_price ratchets
  // with the price (Alpaca recomputes it), so the percent is the editable knob
  const patchExitTrailPct = useCallback(async (info: ExitInfo, pct: number, attempt = 0) => {
    try {
      const res = await fetch(`/api/trading/orders/${info.orderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: posData.data?.mode, crypto: symbol.includes('/'), trail_percent: pct }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: `Trail % updated to ${pct}%` })
      } else if (attempt === 0 && (res.status === 404 || res.status === 409)) {
        // STALE-ID HEAL (same as patchExitPrice): retry once on the current id
        const fresh = await fetch(`/api/trading/positions?symbol=${encodeURIComponent(symbol)}`)
          .then((r) => r.json()).catch(() => null)
        const cur = fresh?.exits?.[normSym(symbol)]?.sl
        if (cur?.orderId && cur.orderId !== info.orderId) {
          await patchExitTrailPct(cur, pct, 1)
          return
        }
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      } else {
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Update failed', description: 'Network error', variant: 'destructive' })
    } finally {
      void posRefresh()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      window.setTimeout(() => {
        void posRefresh()
        window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      }, 2500)
    }
  }, [posData.data?.mode, posRefresh, toast, symbol])

  // attach a NEW TP/SL to the open position (ghost chip drag / typed price /
  // right-click "add here")
  const addExitToPosition = useCallback(async (kind: 'sl' | 'tp', price: number) => {
    const pos = posRef.current?.positions.find((p) => normSym(p.symbol) === normSym(symbol))
    if (!pos) {
      toast({ title: `No open ${symbol} position`, variant: 'destructive' })
      return
    }
    try {
      const res = await fetch(`/api/trading/positions/${encodeURIComponent(pos.tradeSymbol)}/exits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: posData.data?.mode, [kind === 'tp' ? 'tp' : 'sl']: price }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({
          title: `${kind.toUpperCase()} added at ${fmtPrice(price)}`,
          description: json?.oco ? 'OCO exit created on Alpaca' : json?.warnings?.join('; ') || undefined,
        })
      } else {
        toast({ title: `${kind.toUpperCase()} failed`, description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: `${kind.toUpperCase()} failed`, description: 'Network error', variant: 'destructive' })
    } finally {
      void posRefresh()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
    }
  }, [symbol, posData.data?.mode, posRefresh, toast])

  const cancelExitOrder = useCallback(async (orderId: string) => {
    const q = posData.data?.mode ? `?mode=${posData.data.mode}` : ''
    await fetch(`/api/trading/orders/${orderId}${q}`, { method: 'DELETE' }).catch(() => { /* offline */ })
    toast({ title: 'Exit order cancelled' })
    void posRefresh()
  }, [posData.data?.mode, posRefresh, toast])

  // cancel a pending (unfilled) ENTRY order from the chart context menu
  const cancelPendingOrder = useCallback(async (orderId: string) => {
    const q = posData.data?.mode ? `?mode=${posData.data.mode}` : ''
    await fetch(`/api/trading/orders/${orderId}${q}`, { method: 'DELETE' }).catch(() => { /* offline */ })
    toast({ title: 'Pending order cancelled' })
    void posRefresh()
    window.dispatchEvent(new CustomEvent('tt:positions-changed'))
  }, [posData.data?.mode, posRefresh, toast])

  // change a PENDING order's entry limit price or planned TP/SL — the drop of
  // a dragged entry/(pend) TP/SL line (crypto plan orders re-place with a new
  // id; stock brackets PATCH their parent — both handled server-side)
  const patchPendingOrder = useCallback(async (
    pending: PendingOrderInfo, part: 'entry' | 'tp' | 'sl', price: number, attempt = 0,
  ) => {
    const body: Record<string, unknown> = {
      mode: posData.data?.mode,
      crypto: symbol.includes('/'),
    }
    if (part === 'entry') body.entry_limit = price
    else if (part === 'tp') body.tp_price = price
    else body.sl_price = price
    try {
      const res = await fetch(`/api/trading/orders/${pending.orderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({
          title: `${part === 'entry' ? 'Entry' : part.toUpperCase()} updated to ${fmtPrice(price)}`,
          description: json?.method === 'cancel-replace'
            ? 'Order re-created on Alpaca (new id)'
            : json?.note || undefined,
        })
      } else if (attempt === 0 && (res.status === 404 || res.status === 409)) {
        // STALE-ID HEAL: a previous drag in the same burst already canceled
        // and re-created this order (crypto plan orders get a NEW id on every
        // replace) — re-sync once and apply the drop to the CURRENT order
        const fresh = await fetch(`/api/trading/positions?symbol=${encodeURIComponent(symbol)}`)
          .then((r) => r.json()).catch(() => null)
        const list = (fresh?.pending || []).filter((pp: PendingOrderInfo) => normSym(pp.symbol) === normSym(symbol) && pp.orderId !== pending.orderId)
        const cur = list.find((pp: PendingOrderInfo) => part === 'entry' || (part === 'tp' ? pp.tpPrice != null : pp.slPrice != null)) || list[0]
        if (cur?.orderId) {
          await patchPendingOrder(cur, part, price, 1)
          return
        }
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      } else {
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Update failed', description: 'Network error', variant: 'destructive' })
    } finally {
      void posRefresh()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      // crypto plan orders re-place via cancel → wait → POST (~2s) — the
      // second refresh heals any gap state the first refresh raced
      window.setTimeout(() => {
        void posRefresh()
        window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      }, 2500)
    }
  }, [posData.data?.mode, posRefresh, toast, symbol])

  const closePositionBySymbol = useCallback(async (tradeSymbol: string) => {
    try {
      const res = await fetch(`/api/trading/positions/${encodeURIComponent(tradeSymbol)}`, { method: 'DELETE' })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: `Closing ${tradeSymbol}`, description: 'Market close submitted' })
      } else {
        toast({ title: 'Close failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Close failed', description: 'Network error', variant: 'destructive' })
    } finally {
      void posRefresh()
    }
  }, [posRefresh, toast])

  // ---------- pointer interaction ----------
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const rel = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const { x, y } = rel(e)
      const tool = useTerminal.getState().drawingTool

      if (tool !== 'cursor') {
        e.stopPropagation()
        e.preventDefault()
        const t = timeAt(x)
        const p = priceAt(y)
        if (p == null) return
        const pt: DrawingPoint = { time: t, price: p }
        if (tool === 'hline' || tool === 'vline') {
          void createDrawing(tool, [pt])
          setDrawingTool('cursor')
        } else if (!draftRef.current) {
          draftRef.current = { kind: tool, p1: pt, p2: { ...pt } }
          scheduleRedraw()
        } else {
          const d = draftRef.current
          draftRef.current = null
          void createDrawing(d.kind, [d.p1, pt])
          setDrawingTool('cursor')
        }
        return
      }

      const hit = hitTest(x, y)
      if (hit && (hit.type === 'drawing' || hit.type === 'alert' || hit.type === 'exit' || hit.type === 'ghost' || hit.type === 'pending')) {
        e.stopPropagation()
        e.preventDefault()
        setMenu(null)
        const st = useTerminal.getState()
        let orig: { time: number | null; price: number }[] = []
        let origPixels: ({ x: number; y: number } | null)[] = []
        if (hit.type === 'drawing') {
          const d = (st.drawingsBySymbol[symbol] || []).find((dd) => dd.id === hit.id)
          if (!d) return
          orig = d.points.map((p) => ({ ...p }))
          // hlines created from the RIGHT-CLICK menu carry time:null and
          // pixelPoint() returns null for them (x == null) — a null origPixel
          // made the drag a no-op ("right-click horizontal line cannot move").
          // hline dragging only needs the Y pixel, so fall back to it.
          origPixels = orig.map((p) =>
            pixelPoint(p) ?? (d.kind === 'hline' ? { x: 0, y: yOf(p.price) ?? y } : null),
          )
        } else if (hit.type === 'alert') {
          const a = st.alerts.find((aa) => aa.id === hit.id)
          if (!a) return
          orig = [{ time: null, price: a.price }]
          origPixels = [{ x: 0, y: yOf(a.price) ?? y }]
        } else if (hit.type === 'exit') {
          if (hit.exit.type === 'trailing_stop') {
            return // no fixed price — dragging a trailing stop is meaningless
          }
          // exit line drag (SL/TP) — preview handled in onMove via exitDragRef
          orig = [{ time: null, price: hit.origPrice }]
          origPixels = [{ x: 0, y: yOf(hit.origPrice) ?? y }]
          exitDragRef.current = { kind: hit.part, price: hit.origPrice }
        } else if (hit.type === 'pending') {
          // pending entry / planned TP/SL line drag — relative move like exits
          orig = [{ time: null, price: hit.origPrice }]
          origPixels = [{ x: 0, y: yOf(hit.origPrice) ?? y }]
          pendingDragRef.current = { part: hit.part === 'whole' ? 'entry' : hit.part, price: hit.origPrice }
        } else {
          // ghost [+TP]/[+SL] chip — dragging it CREATES the exit at the drop
          // price (starts from the suggested ±5% level, follows the cursor)
          const pos = posRef.current?.positions.find((pp) => normSym(pp.symbol) === normSym(symbol))
          const def = pos
            ? ghostDefaultPrice(hit.part, pos.avgEntry, pos.side === 'long')
            : (priceAt(y) ?? 0)
          orig = [{ time: null, price: def }]
          origPixels = [{ x: 0, y: yOf(def) ?? y }]
          exitDragRef.current = { kind: hit.part, price: def }
        }
        dragRef.current = { hit, x0: x, y0: y, orig, origPixels, moved: false }

        const onMove = (ev: PointerEvent) => {
          const drag = dragRef.current
          if (!drag) return
          const { x: cx, y: cy } = rel(ev)
          const dx = cx - drag.x0
          const dy = cy - drag.y0
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
          const store = useTerminal.getState()
          if (drag.hit.type === 'exit') {
            const oy = drag.origPixels[0]?.y
            if (oy != null) {
              const np = priceAt(oy + dy)
              exitDragRef.current = { kind: drag.hit.part, price: np }
              scheduleRedraw()
            }
            return
          }
          if (drag.hit.type === 'pending') {
            const oy = drag.origPixels[0]?.y
            if (oy != null) {
              const np = priceAt(oy + dy)
              pendingDragRef.current = { part: drag.hit.part === 'whole' ? 'entry' : drag.hit.part, price: np }
              scheduleRedraw()
            }
            return
          }
          if (drag.hit.type === 'ghost') {
            // ABSOLUTE: the new exit line follows the cursor so it lands
            // exactly at the drop price ("drag and drop to target price")
            const np = priceAt(cy)
            exitDragRef.current = { kind: drag.hit.part, price: np }
            scheduleRedraw()
            return
          }
          if (drag.hit.type === 'alert') {
            const oy = drag.origPixels[0]?.y
            if (oy != null) {
              const np = priceAt(oy + dy)
              if (np != null) store.patchAlertLocal(drag.hit.id, { price: np })
            }
            return
          }
          const ds = store.drawingsBySymbol[symbol] || []
          const d = ds.find((dd) => dd.id === drag.hit.id)
          if (!d) return
          const points = d.points.map((p, i) => {
            if (drag.hit.part === 'point' && drag.hit.index !== i) return { ...p }
            const op = drag.origPixels[i]
            const oo = drag.orig[i]
            let time = oo.time
            let price = oo.price
            if (d.kind !== 'hline') {
              // time needs the original x pixel (hlines never move in time and
              // may carry time:null — no origPixel — which is fine for them)
              if (op) {
                const nt = timeAt(op.x + dx)
                if (nt != null) time = nt
              }
            }
            if (d.kind !== 'vline') {
              const oy = yOf(oo.price)
              if (oy != null) {
                const np = priceAt(oy + dy)
                if (np != null) price = np
              }
            }
            return { time, price }
          })
          store.patchDrawingLocal(drag.hit.id, symbol, { points })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          const drag = dragRef.current
          dragRef.current = null
          el.style.cursor = ''
          if (drag?.hit.type === 'exit') {
            const d = exitDragRef.current
            exitDragRef.current = null
            scheduleRedraw()
            if (drag.moved && d?.price != null) {
              void patchExitPrice(drag.hit.exit, drag.hit.part, d.price)
            }
            return
          }
          if (drag?.hit.type === 'pending') {
            const d = pendingDragRef.current
            pendingDragRef.current = null
            scheduleRedraw()
            if (drag.moved && d?.price != null) {
              void patchPendingOrder(drag.hit.pending, d.part, d.price)
            }
            return
          }
          if (drag?.hit.type === 'ghost') {
            const d = exitDragRef.current
            exitDragRef.current = null
            scheduleRedraw()
            if (drag.moved && d?.price != null) {
              void addExitToPosition(drag.hit.part, d.price)
            } else if (!drag.moved) {
              // plain click: type the price instead of dragging
              const pos = posRef.current?.positions.find((pp) => normSym(pp.symbol) === normSym(symbol))
              setEditValue({
                type: 'ghost',
                part: drag.hit.part,
                price: pos ? ghostDefaultPrice(drag.hit.part, pos.avgEntry, pos.side === 'long') : (priceAt(y) ?? 0),
              })
            }
            return
          }
          if (!drag || !drag.moved) {
            scheduleRedraw()
            return
          }
          const store = useTerminal.getState()
          if (drag.hit.type === 'alert') {
            const a = store.alerts.find((aa) => aa.id === drag.hit.id)
            if (a) void patchAlert(a.id, { price: a.price })
          } else if (drag.hit.type === 'drawing') {
            const d = (store.drawingsBySymbol[symbol] || []).find((dd) => dd.id === drag.hit.id)
            if (d) void patchDrawing(d.id, { points: d.points })
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp, { once: true })
        el.style.cursor = 'grabbing'
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (dragRef.current) return
      const { x, y } = rel(e)
      const tool = useTerminal.getState().drawingTool
      if (tool !== 'cursor') {
        el.style.cursor = 'crosshair'
        const t = timeAt(x)
        const p = priceAt(y)
        if (draftRef.current && p != null) {
          draftRef.current.p2 = { time: t, price: p }
          scheduleRedraw()
        }
        return
      }
      const hit = hitTest(x, y)
      // x-axis event icons ([E]/⚡) hover — hit rects come from the last overlay pass
      let axisIdx = -1
      if (!hit && chartRef.current) {
        const ch = containerRef.current?.clientHeight ?? 0
        const tH = chartRef.current.timeScale().height()
        if (ch > 0 && y >= ch - tH - 90) {
          axisIdx = axisIconsRef.current.findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
        }
      }
      const newHover = hit ? `${hit.type}:${hit.id}` : axisIdx >= 0 ? `axis:${axisIdx}` : null
      if (newHover !== hoverRef.current) {
        hoverRef.current = newHover
        scheduleRedraw()
      }
      el.style.cursor = hit ? (hit.part === 'point' ? 'nwse-resize' : 'grab') : axisIdx >= 0 ? 'pointer' : ''
    }

    const onPointerLeave = () => {
      if (hoverRef.current) {
        hoverRef.current = null
        scheduleRedraw()
      }
    }

    const onContextMenu = (e: MouseEvent) => {
      const { x, y } = rel(e)
      const hit = hitTest(x, y)
      e.preventDefault()
      e.stopPropagation()
      // cursor price — used by "add TP/SL here" and the trade menu actions
      const price = priceAt(y)
      if (hit) {
        setMenu({ x, y, hit, price })
        return
      }
      // empty chart: custom menu with price-aware actions (alert / trade / hline)
      setMenu({ x, y, hit: { type: 'chart', part: 'whole' }, price })
    }

    const onDoubleClick = (e: MouseEvent) => {
      // double-click near a line edits its value quickly
      const { x, y } = rel(e)
      const hit = hitTest(x, y)
      if (!hit) return
      const st = useTerminal.getState()
      if (hit.type === 'alert') {
        const a = st.alerts.find((aa) => aa.id === hit.id)
        if (a) setEditValue({ type: 'alert', id: a.id, price: a.price })
      } else if (hit.type === 'exit') {
        if (hit.exit.type === 'trailing_stop') {
          // trailing stop: edit the trail PERCENT, not a fixed price
          setEditValue({ type: 'exit', id: hit.id, price: hit.exit.trailPercent ?? 5, pctMode: true, exit: { info: hit.exit, kind: hit.part } })
        } else {
          setEditValue({ type: 'exit', id: hit.id, price: hit.origPrice, exit: { info: hit.exit, kind: hit.part } })
        }
      } else if (hit.type === 'pending') {
        setEditValue({
          type: 'pending',
          id: hit.id,
          part: hit.part === 'whole' ? 'entry' : hit.part,
          price: hit.origPrice,
          pending: hit.pending,
        })
      } else if (hit.type === 'ghost') {
        const pos = posRef.current?.positions.find((pp) => normSym(pp.symbol) === normSym(symbol))
        setEditValue({
          type: 'ghost',
          part: hit.part,
          price: pos ? ghostDefaultPrice(hit.part, pos.avgEntry, pos.side === 'long') : (priceAt(y) ?? 0),
        })
      } else if (hit.type === 'drawing') {
        const d = (st.drawingsBySymbol[symbol] || []).find((dd) => dd.id === hit.id)
        if (d && d.kind === 'hline') setEditValue({ type: 'drawing', id: d.id, price: d.points[0].price })
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (draftRef.current) {
          draftRef.current = null
          scheduleRedraw()
        }
        if (useTerminal.getState().drawingTool !== 'cursor') setDrawingTool('cursor')
        setMenu(null)
      }
    }

    el.addEventListener('pointerdown', onPointerDown, true)
    el.addEventListener('pointermove', onPointerMove, true)
    el.addEventListener('pointerleave', onPointerLeave)
    el.addEventListener('contextmenu', onContextMenu, true)
    el.addEventListener('dblclick', onDoubleClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true)
      el.removeEventListener('pointermove', onPointerMove, true)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('contextmenu', onContextMenu, true)
      el.removeEventListener('dblclick', onDoubleClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [hitTest, createDrawing, patchDrawing, patchAlert, patchExitPrice, addExitToPosition, patchPendingOrder, symbol, timeAt, priceAt, yOf, scheduleRedraw, setDrawingTool])

  // ---------- chart lifecycle ----------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setLoading(true)
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#09090b' },
        textColor: '#a1a1aa',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#18181b' }, horzLines: { color: '#18181b' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#52525b', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#27272a' },
        horzLine: { color: '#52525b', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#27272a' },
      },
      rightPriceScale: { borderColor: '#27272a', scaleMargins: { top: 0.1, bottom: 0.24 } },
      timeScale: {
        borderColor: '#27272a',
        timeVisible: TIMEFRAMES[tf].seconds < 86400,
        secondsVisible: false,
        rightOffset: 6,
      },
    })
    chartRef.current = chart

    const seriesOptions = {
      // keep position/SL/TP lines inside the visible price range
      autoscaleInfoProvider: (base: () => { priceRange?: { minValue: number; maxValue: number }; margins?: unknown } | null) => {
        const res = base()
        const bundle = posRef.current
        const ex = bundle?.exits[normSym(symbol)]
        const vals: number[] = []
        const p = bundle?.positions.find((pp) => normSym(pp.symbol) === normSym(symbol))
        if (p && p.avgEntry > 0) {
          vals.push(p.avgEntry)
          // keep the ghost [+TP]/[+SL] suggested levels (±5%) inside the view
          // so a freshly started ghost drag is visible
          if (!ex?.tp) vals.push(ghostDefaultPrice('tp', p.avgEntry, p.side === 'long'))
          if (!ex?.sl) vals.push(ghostDefaultPrice('sl', p.avgEntry, p.side === 'long'))
        }
        if (ex?.sl && ex.sl.stopPrice != null) vals.push(ex.sl.stopPrice)
        if (ex?.tp && ex.tp.limitPrice != null) vals.push(ex.tp.limitPrice)
        // pending orders too — a dragged (pend) entry/TP/SL must never land
        // outside the visible price range (an out-of-pane line renders clipped
        // and looks like it "disappeared" after the move)
        for (const pp of bundle?.pending || []) {
          if (normSym(pp.symbol) !== normSym(symbol)) continue
          if (pp.limitPrice != null) vals.push(pp.limitPrice)
          if (pp.tpPrice != null) vals.push(pp.tpPrice)
          if (pp.slPrice != null) vals.push(pp.slPrice)
        }
        if (vals.length === 0) return res
        let min = res?.priceRange?.minValue ?? Math.min(...vals)
        let max = res?.priceRange?.maxValue ?? Math.max(...vals)
        for (const v of vals) {
          min = Math.min(min, v)
          max = Math.max(max, v)
        }
        return { priceRange: { minValue: min, maxValue: max } }
      },
    }
    let series: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>
    if (chartType === 'candles') {
      series = chart.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
        ...seriesOptions,
      })
    } else {
      series = chart.addLineSeries({ color: '#22c55e', lineWidth: 2, ...seriesOptions })
    }
    seriesRef.current = series

    const vol = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      const bar = param.seriesData.get(series) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined
      const volBar = param.seriesData.get(vol) as { value?: number } | undefined
      // update the OHLC legend by writing the DOM directly — a setState here
      // re-rendered the whole ChartPanel on EVERY mouse move (visibly janky,
      // multiplied by every pane in multi-chart grids)
      const leg = legendRef.current
      if (leg) {
        if (bar && bar.close != null) {
          const o = bar.open ?? bar.close
          const c = bar.close
          const upBar = c >= o
          const col = upBar ? 'text-emerald-400' : 'text-rose-400'
          const volTxt = volBar?.value != null ? `Vol ${(volBar.value / 1e6).toFixed(2)}M` : ''
          leg.innerHTML =
            `<div><span class="font-semibold text-zinc-100">${symEsc}</span>` +
            `<span class="text-zinc-500"> · ${tfLabelEsc} · </span>` +
            `<span class="text-zinc-500">O</span><span class="${col}"> ${fmtPrice(o)}</span>` +
            `<span class="text-zinc-500"> H</span><span class="${col}"> ${fmtPrice(bar.high ?? c)}</span>` +
            `<span class="text-zinc-500"> L</span><span class="${col}"> ${fmtPrice(bar.low ?? c)}</span>` +
            `<span class="text-zinc-500"> C</span><span class="${col}"> ${fmtPrice(c)}</span></div>` +
            (volTxt ? `<div class="text-zinc-500">${volTxt}</div>` : '')
          leg.classList.remove('hidden')
        }
      }
      // publish crosshair position to sibling panes (multi-chart sync), rAF-throttled
      const group = syncGroupRef.current
      const key = syncKeyRef.current
      if (group && key && Date.now() >= suppressSyncUntilRef.current) {
        const bar2 = param.time != null ? (param.seriesData.get(series) as CandlestickData | undefined) : undefined
        const px = bar2 ? Number((bar2 as CandlestickData).close ?? NaN) : NaN
        pendingSyncRef.current = { group, from: key, time: param.time ?? null, price: Number.isFinite(px) ? px : null }
        if (!syncRafRef.current) {
          syncRafRef.current = requestAnimationFrame(() => {
            syncRafRef.current = 0
            const d = pendingSyncRef.current
            pendingSyncRef.current = null
            if (d) window.dispatchEvent(new CustomEvent('tt:xsync', { detail: d }))
          })
        }
      }
    })

    // apply crosshair positions published by sibling panes (multi-chart sync)
    const onExternalSync = (e: Event) => {
      const d = (e as CustomEvent<{ group: string; from: string; time: Time | null; price: number | null }>).detail
      const group = syncGroupRef.current
      const key = syncKeyRef.current
      if (!d || !group || !key || d.group !== group || d.from === key) return
      suppressSyncUntilRef.current = Date.now() + 60
      try {
        if (d.time != null && d.price != null && Number.isFinite(d.price)) {
          chart.setCrosshairPosition(d.price, d.time, series)
        } else {
          chart.clearCrosshairPosition()
        }
      } catch { /* chart tearing down */ }
    }
    window.addEventListener('tt:xsync', onExternalSync)

    let cancelled = false

    // ---- scroll-back pagination (Task 28 #1) ----
    // When the user scrolls/zooms near the LEFT edge of the loaded history,
    // fetch the preceding chunk (~barCount bars) from the API and prepend it.
    // Closure flags reset automatically on symbol/timeframe change.
    let loadingOlder = false
    let olderExhausted = false
    const seriesDataFor = (clean: Bar[]) =>
      clean.map((b) =>
        chartType === 'candles'
          ? { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close }
          : { time: b.time as UTCTimestamp, value: b.close },
      )
    const applyBars = (clean: Bar[]) => {
      series.setData(seriesDataFor(clean))
      vol.setData(
        clean.map((b) => ({
          time: b.time as UTCTimestamp,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
        })),
      )
    }
    const loadOlder = async () => {
      const bars = barsRef.current
      if (loadingOlder || olderExhausted || cancelled || bars.length === 0) return
      const oldest = bars[0].time
      loadingOlder = true
      try {
        const res = await fetch(
          `/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}&before=${oldest}`,
        )
        if (!res.ok) throw new Error('older bars fetch failed')
        const json = await res.json()
        if (cancelled) return
        const incoming: Bar[] = (json.bars as Bar[]) || []
        // only bars STRICTLY older than what is loaded (server windows can overlap)
        const fresh = incoming.filter((b) => b.time < oldest)
        if (fresh.length === 0) {
          // nothing older exists — stop asking (until symbol/tf changes)
          olderExhausted = true
          return
        }
        const map = new Map<number, Bar>()
        for (const b of bars) map.set(b.time, b)
        for (const b of fresh) map.set(b.time, b)
        const merged = [...map.values()].sort((a, b) => a.time - b.time)
        barsRef.current = merged
        // prepending N bars shifts every logical index by N — restore the exact
        // visible window so the view doesn't jump while the user is scrolling
        const prev = chart.timeScale().getVisibleLogicalRange()
        applyBars(merged)
        const added = merged.length - bars.length
        if (prev) {
          chart.timeScale().setVisibleLogicalRange({ from: prev.from + added, to: prev.to + added })
        }
        scheduleRedraw()
        // extend the [E]/⚡ event-marker window back over the new history
        void (async () => {
          try {
            const mres = await fetch(
              `/api/market/markers?symbol=${encodeURIComponent(symbol)}&from=${merged[0].time}&to=${oldest}`,
            )
            if (!mres.ok || cancelled) return
            const mj = await mres.json()
            const olderEarnings = ((mj.earningsInfo as { ts: number }[]) || []).filter((e) => e.ts < oldest)
            const rawNews = ((mj.newsItems as { ts: number }[]) || [])
              .filter((n) => n.ts < oldest)
              .sort((a, b) => a.ts - b.ts)
            const step = Math.max(1, Math.ceil(rawNews.length / 16))
            const spacedNews = rawNews.filter((_, i) => i % step === 0)
            if (cancelled) return
            const prevM = markersRef.current
            markersRef.current = {
              earnings: [...olderEarnings, ...prevM.earnings],
              news: [...spacedNews, ...prevM.news],
            }
            scheduleRedraw()
          } catch { /* markers optional */ }
        })()
      } catch {
        // transient failure — the next scroll tick retries
      } finally {
        loadingOlder = false
      }
    }

    ;(async () => {
      try {
        const res = await fetch(`/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`)
        if (!res.ok) throw new Error('bars fetch failed')
        const json = await res.json()
        if (cancelled) return
        setDemo(Boolean(json.meta?.demo))
        setDemoReason(json.meta?.reason as string | undefined)
        // feed status → bottom console (log once per state change)
        const demoNow = Boolean(json.meta?.demo)
        const reasonNow = String(json.meta?.reason ?? '')
        const feedKey = `${symbol}|${demoNow}|${reasonNow}`
        if (feedStateRef.current !== feedKey) {
          feedStateRef.current = feedKey
          const src = String(json.meta?.source ?? '')
          ttLog(
            'data',
            demoNow
              ? `${symbol} → demo data${reasonNow ? ` (${reasonNow})` : ''}`
              : src === 'binance'
                ? `${symbol} → live Binance data (free feed)`
                : `${symbol} → live data${src ? ` (${src})` : ''}`,
            demoNow ? 'warn' : 'ok',
          )
        }
        const bars: Bar[] = (json.bars as Bar[]) || []
        // dedupe + sort by time
        const map = new Map<number, Bar>()
        for (const b of bars) map.set(b.time, b)
        const clean = [...map.values()].sort((a, b) => a.time - b.time)
        barsRef.current = clean

        applyBars(clean)
        // TradingView-like: show recent window, not the whole history
        if (clean.length > 0) {
          const from = Math.max(0, clean.length - 150)
          chart.timeScale().setVisibleLogicalRange({ from, to: clean.length + 6 })
        }

        // x-axis event markers: earnings [E] (yfinance) + news ⚡ (Task 20)
        if (clean.length > 0) {
          try {
            const from = clean[0].time
            const lastT = clean[clean.length - 1].time
            const mres = await fetch(`/api/market/markers?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${lastT}`)
            if (mres.ok && !cancelled) {
              const mj = await mres.json()
              const earnings = ((mj.earningsInfo as { ts: number; epsActual?: number | null; epsEstimate?: number | null; upcoming?: boolean }[]) || [])
                .filter((e) => e.ts <= lastT || e.upcoming)
              // cap news markers evenly across the fetched window so the axis
              // stays readable regardless of news frequency (icons are deduped
              // per event day at render time)
              const rawNews = ((mj.newsItems as { ts: number; title?: string }[]) || [])
                .filter((n) => n.ts <= lastT)
                .sort((a, b) => a.ts - b.ts)
              const step = Math.max(1, Math.ceil(rawNews.length / 16))
              const spacedNews = rawNews.filter((_, i) => i % step === 0)
              markersRef.current = { earnings, news: spacedNews.slice(0, 16) }
            }
          } catch { /* markers optional */ }
        }
        setLoading(false)
        scheduleRedraw()
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()

    const onRangeChange = () => {
      scheduleRedraw()
      // near the left edge of the loaded history → pull the preceding chunk
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r && r.from < 12) void loadOlder()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)
    // also redraw when the visible TIME range shifts (zoom/scroll can change the
    // price autoscale without changing the logical bar range)
    const onTimeRangeChange = () => scheduleRedraw()
    chart.timeScale().subscribeVisibleTimeRangeChange(onTimeRangeChange)

    // debug handle (harmless): lets DevTools / E2E verify coordinate round-trips
    ;(window as unknown as Record<string, unknown>).__ttDbg = {
      rect: () => container.getBoundingClientRect(),
      priceAt,
      timeAt,
      xOf,
      yOf,
      // scroll-back pagination probes (Task 28 #1)
      bars: () => barsRef.current.length,
      oldestBarTime: () => barsRef.current[0]?.time ?? null,
      firstVisibleTime: () => {
        try {
          const r = chart.timeScale().getVisibleRange()
          return r ? Math.floor((r.from as UTCTimestamp as unknown as number) as number) : null
        } catch {
          return null
        }
      },
    }

    return () => {
      cancelled = true
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onTimeRangeChange)
      window.removeEventListener('tt:xsync', onExternalSync)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      barsRef.current = []
      markersRef.current = { earnings: [], news: [] }
      axisIconsRef.current = []
    }
  }, [symbol, tf, chartType, settingsVer, scheduleRedraw])

  // load drawings for this symbol
  useEffect(() => {
    void loadDrawings(symbol)
  }, [symbol, loadDrawings])

  // quote polling (10s) — also feeds the live price into the last bar so the
  // chart tracks the market between bar closes and re-autoscales (which keeps
  // position/SL/TP lines in view)
  useEffect(() => {
    let alive = true
    const fetchQ = async () => {
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: [symbol] }),
        })
        if (!res.ok || !alive) return
        const json = await res.json()
        const q = json.quotes?.[0]
        if (q && alive) {
          setQuote({ price: q.price, changePct: q.changePct, change: q.change })
          const bars = barsRef.current
          const s = seriesRef.current
          if (bars.length > 0 && s && json.meta?.demo !== true) {
            const lastB = bars[bars.length - 1]
            const close = q.price as number
            const high = Math.max(lastB.high, close)
            const low = Math.min(lastB.low, close)
            const bar = (
              chartType === 'candles'
                ? { time: lastB.time as UTCTimestamp, open: lastB.open, high, low, close }
                : { time: lastB.time as UTCTimestamp, value: close }
            ) as CandlestickData<Time> | LineData<Time>
            s.update(bar)
            barsRef.current = [...bars.slice(0, -1), { ...lastB, close, high, low }]
            scheduleRedraw()
          }
        }
      } catch { /* offline */ }
    }
    fetchQ()
    const timer = setInterval(fetchQ, 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [symbol, chartType, scheduleRedraw])

  const up = (quote?.changePct ?? 0) >= 0

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative h-full w-full select-none overflow-hidden',
        focused != null && (focused ? 'ring-1 ring-inset ring-emerald-500/60' : 'ring-0 ring-inset ring-transparent'),
      )}
      style={{ background: '#09090b' }}
      onPointerDownCapture={() => onFocus?.()}
    >
      {/* chart canvas is injected here by lightweight-charts */}
      {/* h-full/w-full is CRITICAL: a canvas with only inset-0 renders at its
          intrinsic (backing-store) CSS size, so on devicePixelRatio > 1 screens
          (retina / 125-150% Windows scaling) every overlay drawing appeared at
          dpr× its intended position — exactly the "line is not where I clicked"
          bug. Explicit CSS size + dpr-scaled backing store = 1:1 coordinates. */}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden />

      {/* header overlay */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/85 px-2 backdrop-blur-sm', compact ? 'h-8' : 'h-10')}>
        <div className="pointer-events-auto flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-7 gap-1 px-2 font-semibold text-zinc-100', compact ? 'text-xs' : 'text-sm')}
            onClick={() => setSearchOpen(true)}
          >
            {symbol}
            {!compact && <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />}
            {isCryptoSymbol(symbol) && <Badge variant="outline" className="ml-1 border-amber-500/40 text-[9px] text-amber-400">7×24</Badge>}
          </Button>
        </div>
        <div className="pointer-events-auto flex items-center gap-0.5 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5">
          {(Object.keys(TIMEFRAMES) as (keyof typeof TIMEFRAMES)[]).map((k) => (
            <button
              key={k}
              onClick={() => onTimeframeChange(k)}
              className={cn(
                'rounded font-medium transition-colors',
                compact ? 'px-1 py-0.5 text-[10px]' : 'px-1.5 py-0.5 text-[11px]',
                k === tf ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
              )}
            >
              {TIMEFRAMES[k].label}
            </button>
          ))}
        </div>
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5">
          <button
            className={cn('rounded px-1.5 py-1', chartType === 'candles' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300')}
            onClick={() => setChartType('candles')}
            aria-label="Candlesticks"
          >
            <CandleIcon className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn('rounded px-1.5 py-1', chartType === 'line' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300')}
            onClick={() => setChartType('line')}
            aria-label="Line"
          >
            <LineIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2 pr-1">
          {demo && (
            <Badge
              variant="outline"
              title={
                !demoReason || demoReason === 'no-keys'
                  ? 'Demo data — add your Alpaca API keys in Settings → Test keys'
                  : demoReason === 'alpaca-http-401' || demoReason === 'alpaca-http-403'
                    ? 'Alpaca rejected the saved keys — check them in Settings'
                    : `Alpaca request failed (${demoReason}) — will retry`
              }
              className={
                demoReason === 'alpaca-http-401' || demoReason === 'alpaca-http-403'
                  ? 'border-rose-500/40 text-[10px] text-rose-400'
                  : 'border-amber-500/40 text-[10px] text-amber-400'
              }
            >
              {!demoReason || demoReason === 'no-keys'
                ? 'demo'
                : demoReason === 'alpaca-http-401' || demoReason === 'alpaca-http-403'
                  ? 'keys rejected'
                  : demoReason === 'alpaca-http-429'
                    ? 'rate limited'
                    : 'data error'}
            </Badge>
          )}
          {quote && !compact && (
            <div className="text-right">
              <span className="text-sm font-semibold tabular-nums text-zinc-100">{fmtPrice(quote.price)}</span>
              <span className={cn('ml-2 text-[11px] tabular-nums', up ? 'text-emerald-400' : 'text-rose-400')}>
                {up ? '+' : ''}{quote.changePct.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* drawing toolbar — semi-transparent so values behind stay visible (Task 14 #4) */}
      <div className="absolute left-2 top-12 z-30 flex flex-col gap-0.5 rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-1 opacity-40 backdrop-blur-sm transition-opacity hover:opacity-100 focus-within:opacity-100">
        <button
          title="Trade ticket — buy/sell with SL/TP/trailing (paper or live)"
          aria-label="Open trade ticket"
          aria-pressed={tradeOpen}
          onClick={() => {
            setTicketPrefill(null)
            setTradeOpen((v) => !v)
          }}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            tradeOpen ? 'bg-emerald-500/25 text-emerald-400' : 'text-zinc-300 hover:bg-emerald-500/15 hover:text-emerald-400',
          )}
        >
          <Briefcase className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 my-0.5 h-px bg-zinc-800" />
        {(
          [
            { tool: 'cursor' as const, icon: MousePointer2, label: 'Cursor (pan/zoom)' },
            { tool: 'hline' as const, icon: Minus, label: 'Horizontal line' },
            { tool: 'vline' as const, icon: ArrowUpDown, label: 'Vertical line' },
            { tool: 'trend' as const, icon: TrendingUp, label: 'Trend line (2 clicks)' },
            { tool: 'fib' as const, icon: Ruler, label: 'Fib retracement (2 clicks)' },
          ]
        ).map(({ tool, icon: Icon, label }) => (
          <button
            key={tool}
            title={label}
            aria-label={label}
            aria-pressed={drawingTool === tool}
            onClick={() => setDrawingTool(tool)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              drawingTool === tool ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <div className="mx-1 my-0.5 h-px bg-zinc-800" />
        <div className="flex flex-col items-center gap-1 py-0.5">
          {DRAW_COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Drawing color ${c}`}
              onClick={() => setActiveColor(c)}
              className={cn('h-3 w-3 rounded-full transition-transform', activeColor === c ? 'scale-125 ring-1 ring-white/70' : 'opacity-70 hover:opacity-100')}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="mx-1 my-0.5 h-px bg-zinc-800" />
        <button
          title={showDrawings ? 'Hide drawings' : 'Show drawings'}
          aria-label={showDrawings ? 'Hide drawings' : 'Show drawings'}
          onClick={() => setShowDrawings((v) => !v)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {showDrawings ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <button
          title="Delete all drawings"
          aria-label="Delete all drawings"
          onClick={() => {
            for (const d of drawings) void deleteDrawing(d.id)
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-rose-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* OHLC legend — content written directly by the crosshair handler (perf) */}
      <div
        ref={legendRef}
        className="pointer-events-none absolute left-12 top-12 z-20 hidden rounded bg-zinc-950/50 px-2 py-1 font-mono text-[11px] leading-4 text-zinc-300 backdrop-blur-sm"
        aria-hidden
      />

      {/* loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/40">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
        </div>
      )}

      {/* context menu */}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} container={containerRef.current} symbol={symbol}
        posData={posData.data}
        onAddAlert={(price) => void addAlertAtPrice(price)}
        onAddHline={(price) => {
          void createDrawing('hline', [{ time: null, price }])
        }}
        onTrade={(side, price) => {
          // right-click price => limit order AT that price
          setTicketPrefill({ side, price, type: 'limit' })
          setTradeOpen(true)
        }}
        onOpenTicket={() => {
          setTicketPrefill(null)
          setTradeOpen(true)
        }}
        onEditValue={(hit) => {
          const st = useTerminal.getState()
          if (hit.type === 'alert') {
            const a = st.alerts.find((aa) => aa.id === hit.id)
            if (a) setEditValue({ type: 'alert', id: a.id, price: a.price })
          } else if (hit.type === 'exit') {
            if (hit.exit.type === 'trailing_stop') {
              // trailing stop: edit the trail PERCENT, not a fixed price
              setEditValue({ type: 'exit', id: hit.id, price: hit.exit.trailPercent ?? 5, pctMode: true, exit: { info: hit.exit, kind: hit.part } })
            } else {
              setEditValue({ type: 'exit', id: hit.id, price: hit.origPrice, exit: { info: hit.exit, kind: hit.part } })
            }
          } else if (hit.type === 'pending') {
            setEditValue({
              type: 'pending',
              id: hit.id,
              part: hit.part === 'whole' ? 'entry' : hit.part,
              price: hit.origPrice,
              pending: hit.pending,
            })
          } else if (hit.type === 'ghost') {
            const pos = posRef.current?.positions.find((pp) => normSym(pp.symbol) === normSym(symbol))
            setEditValue({
              type: 'ghost',
              part: hit.part,
              price: pos ? ghostDefaultPrice(hit.part, pos.avgEntry, pos.side === 'long') : (quote?.price ?? 0),
            })
          } else if (hit.type === 'drawing') {
            const d = (st.drawingsBySymbol[symbol] || []).find((dd) => dd.id === hit.id)
            if (d?.kind === 'hline') setEditValue({ type: 'drawing', id: d.id, price: d.points[0].price })
          }
        }}
        onPatchDrawing={patchDrawing}
        onDeleteDrawing={deleteDrawing}
        onPatchAlert={patchAlert}
        onDeleteAlert={deleteAlert}
        onPatchExit={(info, kind, price) => void patchExitPrice(info, kind, price)}
        onAddExit={(kind, price) => void addExitToPosition(kind, price)}
        onCancelExit={(orderId) => void cancelExitOrder(orderId)}
        onCancelPending={(orderId) => void cancelPendingOrder(orderId)}
        onClosePosition={(tradeSymbol) => void closePositionBySymbol(tradeSymbol)}
      />}

      {/* edit value popover */}
      {editValue && (
        <EditValuePopover
          value={editValue.price}
          label={editValue.pctMode ? 'Set trail % (stop distance from price)' : undefined}
          onCancel={() => setEditValue(null)}
          onSave={(price) => {
            if (editValue.type === 'alert') void patchAlert(editValue.id!, { price })
            else if (editValue.type === 'exit' && editValue.exit) {
              if (editValue.pctMode) void patchExitTrailPct(editValue.exit.info, price)
              else void patchExitPrice(editValue.exit.info, editValue.exit.kind, price)
            } else if (editValue.type === 'pending' && editValue.pending) {
              void patchPendingOrder(editValue.pending, editValue.part === 'tp' ? 'tp' : editValue.part === 'sl' ? 'sl' : 'entry', price)
            } else if (editValue.type === 'ghost' && (editValue.part === 'tp' || editValue.part === 'sl')) {
              void addExitToPosition(editValue.part, price)
            } else {
              const d = (useTerminal.getState().drawingsBySymbol[symbol] || []).find((dd) => dd.id === editValue.id)
              if (d) void patchDrawing(d.id, { points: d.points.map((p, i) => (i === 0 ? { ...p, price } : p)) })
            }
            setEditValue(null)
          }}
        />
      )}

      {/* trade ticket (paper / live via Alpaca Trading API) */}
      {tradeOpen && (
        <TradeTicket
          symbol={symbol}
          livePrice={quote?.price ?? null}
          prefill={ticketPrefill}
          onClose={() => setTradeOpen(false)}
          onPlaced={() => void posData.refresh()}
        />
      )}

      <SymbolSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={onSymbolChange}
      />
    </div>
  )
}

// ---------- context menu ----------
function ContextMenu({
  menu, onClose, container, symbol, posData,
  onAddAlert, onAddHline, onTrade, onOpenTicket,
  onEditValue, onPatchDrawing, onDeleteDrawing, onPatchAlert, onDeleteAlert,
  onPatchExit, onAddExit, onCancelExit, onCancelPending, onClosePosition,
}: {
  menu: MenuState
  onClose: () => void
  container: HTMLElement | null
  symbol: string
  posData: { positions: { symbol: string; tradeSymbol: string; qty: number; side: string; avgEntry: number }[]; exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }> } | null
  onAddAlert: (price: number) => void
  onAddHline: (price: number) => void
  onTrade: (side: 'buy' | 'sell', price?: number) => void
  onOpenTicket: () => void
  onEditValue: (hit: SceneHit) => void
  onPatchDrawing: (id: string, patch: { color?: string }) => Promise<void>
  onDeleteDrawing: (id: string) => Promise<void>
  onPatchAlert: (id: string, patch: Record<string, unknown>) => Promise<void>
  onDeleteAlert: (id: string) => Promise<void>
  onPatchExit: (info: ExitInfo, kind: 'sl' | 'tp', price: number) => void
  onAddExit: (kind: 'sl' | 'tp', price: number) => void
  onCancelExit: (orderId: string) => void
  onCancelPending: (orderId: string) => void
  onClosePosition: (tradeSymbol: string) => void
}) {
  const symDrawing = menu.hit.type === 'drawing' ? menu.hit : null
  const alertHit = menu.hit.type === 'alert' ? menu.hit : null
  const alert = alertHit ? useTerminal.getState().alerts.find((a) => a.id === alertHit.id) : null
  const symDrawingData = symDrawing ? (useTerminal.getState().drawingsBySymbol[symbol] || []).find((d) => d.id === symDrawing.id) : null

  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('pointerdown', close, { once: true })
    window.addEventListener('wheel', close, { once: true })
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  if (!container) return null
  const w = container.clientWidth
  const h = container.clientHeight
  const left = Math.min(menu.x + 4, w - 230)
  const top = Math.min(menu.y + 4, h - 320)
  const price = menu.price ?? null

  if (menu.hit.type === 'alert' && alert && alertHit) {
    return (
      <div
        className="absolute z-40 w-56 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Alert · {alert.symbol} @ {fmtPrice(alert.price)}
        </div>
        <MenuItem
          label={alert.status === 'paused' ? '▶ Resume alert' : '⏸ Pause alert'}
          onClick={() => {
            void onPatchAlert(alert.id, { status: alert.status === 'paused' ? 'active' : 'paused' })
            onClose()
          }}
        />
        <MenuItem label="✏️ Edit value…" onClick={() => { onEditValue(alertHit); onClose() }} />
        <MenuItem
          label={alert.direction === 'above' ? '▲ Trigger when rising above' : '▼ Trigger when falling below'}
          onClick={() => {
            void onPatchAlert(alert.id, { direction: alert.direction === 'above' ? 'below' : 'above' })
            onClose()
          }}
        />
        <ColorRow
          active={alert.color}
          onPick={(c) => { void onPatchAlert(alert.id, { color: c }); onClose() }}
        />
        <div className="my-1 h-px bg-zinc-800" />
        <MenuItem label="🗑 Delete alert" danger onClick={() => { void onDeleteAlert(alert.id); onClose() }} />
      </div>
    )
  }

  if (menu.hit.type === 'drawing' && symDrawing && symDrawingData) {
    const d = symDrawingData
    const drawingHit = symDrawing
    return (
      <div
        className="absolute z-40 w-56 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {KIND_LABEL[d.kind]}
        </div>
        {d.kind !== 'vline' && (
          <MenuItem
            label={<span className="flex items-center gap-1.5"><BellPlus className="h-3.5 w-3.5 text-amber-400" /> Add alert at {fmtPrice(d.kind === 'hline' ? d.points[0].price : d.points[d.points.length - 1].price)}</span>}
            onClick={() => {
              onAddAlert(d.kind === 'hline' ? d.points[0].price : d.points[d.points.length - 1].price)
              onClose()
            }}
          />
        )}
        {d.kind === 'hline' && (
          <MenuItem label="✏️ Change value…" onClick={() => { onEditValue(drawingHit); onClose() }} />
        )}
        <ColorRow
          active={d.color}
          onPick={(c) => { void onPatchDrawing(d.id, { color: c }); onClose() }}
        />
        <div className="my-1 h-px bg-zinc-800" />
        <MenuItem label="🗑 Delete drawing" danger onClick={() => { void onDeleteDrawing(d.id); onClose() }} />
      </div>
    )
  }

  if (menu.hit.type === 'pending') {
    const hit = menu.hit
    const p = hit.pending
    const sideLabel = p.side === 'buy' ? 'Buy' : 'Sell'
    return (
      <div
        className="absolute z-40 w-60 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Pending {sideLabel} {p.type} · {fmtPrice(hit.origPrice)}
          {hit.part !== 'whole' ? ` · ${hit.part.toUpperCase()} line` : ''}
        </div>
        <div className="px-3 pb-1 text-[10px] text-zinc-500">
          {p.qty} {p.symbol}
          {p.tpPrice != null ? ` · TP ${fmtPrice(p.tpPrice)}` : ''}
          {p.slPrice != null ? ` · SL ${fmtPrice(p.slPrice)}` : ''}
          {p.managed ? ' · OCO-managed' : ''}
        </div>
        <MenuItem label="✏️ Change entry price…" onClick={() => { onEditValue({ ...hit, part: 'whole' }); onClose() }} />
        {p.tpPrice != null && (
          <MenuItem
            label={<span className="text-emerald-400">✏️ Change TP to…</span>}
            onClick={() => { onEditValue({ ...hit, part: 'tp', origPrice: p.tpPrice! }); onClose() }}
          />
        )}
        {p.slPrice != null && (
          <MenuItem
            label={<span className="text-rose-400">✏️ Change SL to…</span>}
            onClick={() => { onEditValue({ ...hit, part: 'sl', origPrice: p.slPrice! }); onClose() }}
          />
        )}
        <MenuItem label="🧾 Trade ticket…" onClick={() => { onOpenTicket(); onClose() }} />
        <div className="my-1 h-px bg-zinc-800" />
        <MenuItem
          label="🗑 Cancel pending order"
          danger
          onClick={() => { onCancelPending(p.orderId); onClose() }}
        />
      </div>
    )
  }

  if (menu.hit.type === 'exit') {
    const hit = menu.hit
    const label = hit.part === 'sl' ? 'Stop loss' : 'Take profit'
    const isTrail = hit.exit.type === 'trailing_stop'
    return (
      <div
        className="absolute z-40 w-56 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {isTrail ? `${label} · trail ${hit.exit.trailPercent ?? '?'}%` : `${label} · ${fmtPrice(hit.origPrice)}`}
          {!isTrail && <span className="text-zinc-600"> ({hit.exit.type})</span>}
        </div>
        {isTrail ? (
          <MenuItem label="✏️ Change trail %…" onClick={() => { onEditValue(hit); onClose() }} />
        ) : (
          <MenuItem label="✏️ Change value…" onClick={() => { onEditValue(hit); onClose() }} />
        )}
        <MenuItem
          label="🧾 Trade ticket…"
          onClick={() => { onOpenTicket(); onClose() }}
        />
        <div className="my-1 h-px bg-zinc-800" />
        <MenuItem label={`🗑 Cancel ${hit.part.toUpperCase()} order`} danger onClick={() => { onCancelExit(hit.exit.orderId); onClose() }} />
      </div>
    )
  }

  if (menu.hit.type === 'ghost') {
    const hit = menu.hit
    const label = hit.part === 'sl' ? 'SL' : 'TP'
    return (
      <div
        className="absolute z-40 w-60 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Add {label} to position
        </div>
        <div className="px-3 pb-1 text-[10px] text-zinc-500">Drag the chip to the target price, or:</div>
        {price != null && (
          <MenuItem
            label={`${hit.part === 'tp' ? '🟢' : '🔴'} Set ${label} at ${fmtPrice(price)}`}
            onClick={() => { onAddExit(hit.part, price); onClose() }}
          />
        )}
        <MenuItem label="✏️ Enter price…" onClick={() => { onEditValue(hit); onClose() }} />
      </div>
    )
  }

  if (menu.hit.type === 'position') {
    const hit = menu.hit
    const pos = posData?.positions.find((p) => p.tradeSymbol === hit.id)
    const exits = posData?.exits[normSym(hit.id)]
    const long = pos?.side === 'long'
    const tpOk = price != null && long != null && (long ? price > pos!.avgEntry : price < pos!.avgEntry)
    const slOk = price != null && long != null && (long ? price < pos!.avgEntry : price > pos!.avgEntry)
    return (
      <div
        className="absolute z-40 w-56 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Position {pos ? `${pos.side === 'long' ? '+' : '-'}${pos.qty} @ ${fmtPrice(pos.avgEntry)}` : hit.id}
        </div>
        {!exits?.tp && (
          <MenuItem
            label={<span className="text-emerald-400">🟢 Add TP{tpOk ? ` at ${fmtPrice(price!)}` : '…'}</span>}
            onClick={() => {
              if (tpOk && price != null) onAddExit('tp', price)
              else onEditValue({ type: 'ghost', id: 'tp', part: 'tp' })
              onClose()
            }}
          />
        )}
        {!exits?.sl && (
          <MenuItem
            label={<span className="text-rose-400">🔴 Add SL{slOk ? ` at ${fmtPrice(price!)}` : '…'}</span>}
            onClick={() => {
              if (slOk && price != null) onAddExit('sl', price)
              else onEditValue({ type: 'ghost', id: 'sl', part: 'sl' })
              onClose()
            }}
          />
        )}
        <MenuItem label="🧾 Trade ticket…" onClick={() => { onOpenTicket(); onClose() }} />
        <MenuItem
          label={pos?.side === 'long' ? '🔴 Sell to close (market)' : '🟢 Buy to close (market)'}
          danger
          onClick={() => { onClosePosition(hit.id); onClose() }}
        />
      </div>
    )
  }

  if (menu.hit.type === 'chart') {
    return (
      <div
        className="absolute z-40 w-60 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {symbol}{price != null ? ` · ${fmtPrice(price)}` : ''}
        </div>
        {price != null && (
          <MenuItem
            label={<span className="flex items-center gap-1.5"><BellPlus className="h-3.5 w-3.5 text-amber-400" /> Add price alert at {fmtPrice(price)}</span>}
            onClick={() => { onAddAlert(price); onClose() }}
          />
        )}
        {price != null && (
          <MenuItem label="─ Horizontal line here" onClick={() => { onAddHline(price); onClose() }} />
        )}
        <div className="my-1 h-px bg-zinc-800" />
        {price != null && (
          <MenuItem
            label={<span className="text-emerald-400">🟢 Buy limit @ {fmtPrice(price)}</span>}
            onClick={() => { onTrade('buy', price); onClose() }}
          />
        )}
        {price != null && (
          <MenuItem
            label={<span className="text-rose-400">🔴 Sell limit @ {fmtPrice(price)}</span>}
            onClick={() => { onTrade('sell', price); onClose() }}
          />
        )}
        <MenuItem label="🧾 Trade ticket…" onClick={() => { onOpenTicket(); onClose() }} />
      </div>
    )
  }
  return null
}

function MenuItem({ label, onClick, danger }: { label: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={cn(
        'flex w-full items-center px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800',
        danger && 'text-rose-400 hover:text-rose-300',
      )}
      onClick={onClick}
      role="menuitem"
    >
      {label}
    </button>
  )
}

function ColorRow({ active, onPick }: { active: string; onPick: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5">
      <span className="mr-1 text-[10px] text-zinc-500">Color</span>
      {DRAW_COLORS.map((c) => (
        <button
          key={c}
          aria-label={`color ${c}`}
          className={cn('h-4 w-4 rounded-full', active === c && 'ring-2 ring-white/70')}
          style={{ backgroundColor: c }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  )
}

function EditValuePopover({ value, onSave, onCancel, label }: { value: number; onSave: (v: number) => void; onCancel: () => void; label?: string }) {
  const [v, setV] = useState(String(value))
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <button className="absolute inset-0 bg-black/40" onClick={onCancel} aria-label="Cancel" />
      <div className="relative w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <p className="mb-2 text-xs font-medium text-zinc-300">{label || 'Set value'}</p>
        <Input
          autoFocus
          type="number"
          step="any"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(parseFloat(v))
            if (e.key === 'Escape') onCancel()
          }}
          className="border-zinc-700 bg-zinc-950 text-sm"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
          <Button size="sm" className="h-7 bg-emerald-500 text-xs text-zinc-950 hover:bg-emerald-400" onClick={() => onSave(parseFloat(v))}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  )
}
