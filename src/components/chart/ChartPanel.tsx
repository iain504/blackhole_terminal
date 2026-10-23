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
import { useTerminal, Drawing, DrawingKind, DrawingPoint, DrawingPane, DRAW_COLORS, Alert } from '@/store/terminal'
import { detectSrLevels, SrBar } from '@/lib/sr'
import { sessionOf } from '@/lib/sessions'
import { useShallow } from 'zustand/react/shallow'
import { TIMEFRAMES, fmtPrice, isCryptoSymbol, Bar, Timeframe } from '@/lib/market-types'
import {
  computeOverlays, computeRsi, computeMacd, stripMargins, indicatorsActive,
  loadIndicators, saveIndicators, normalizeIndicators, DEFAULT_INDICATORS,
  type IndicatorSettings, type LinePoint,
} from '@/lib/indicators'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import {
  MousePointer2, Minus, ArrowUpDown, TrendingUp, Ruler, Eye, EyeOff, Trash2,
  ChevronDown, CandlestickChart as CandleIcon, LineChart as LineIcon, Loader2, BellPlus,
  Briefcase, Sigma, Square, Type, Sparkles, AlignHorizontalJustifyCenter, Lightbulb,
} from 'lucide-react'
import { SymbolSearchDialog } from './SymbolSearchDialog'
import { TradeTicket, TicketPrefill } from './TradeTicket'
import { TradeAdvisor } from './TradeAdvisor'
import { useSymbolPositions } from './usePositions'
import { ExitInfo, PendingOrderInfo, normSym } from './trading-types'
import { ttLog } from '@/lib/console-log'
import { subscribeStream, StreamTick } from '@/lib/stream-client'

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

/** Suggested price for a not-yet-created TP/SL (ghost chip default). */
function ghostDefaultPrice(kind: 'tp' | 'sl', entry: number, long: boolean): number {
  return kind === 'tp' ? entry * (long ? 1.05 : 0.95) : entry * (long ? 0.95 : 1.05)
}

/** Alpaca-legal trailing-stop range (probed live 2026-10: 0.05 → 422 "trail_percent
 * must be greater than or equal to 0.1"; 0.1 / 10 / 15 / 20 all accepted). The drag
 * converts a stop level into a %, so it must land inside this band. */
const TRAIL_PCT_MIN = 0.1
const TRAIL_PCT_MAX = 20

/** Dragged stop level → trail % of the reference (live) price, clamped to the
 * Alpaca-legal band and rounded to the 0.1 step the ghost chip displays. */
function trailPctFromDrag(level: number, refPx: number): number | null {
  if (!(refPx > 0) || !Number.isFinite(level)) return null
  const pct = (Math.abs(level - refPx) / refPx) * 100
  return Math.round(Math.min(TRAIL_PCT_MAX, Math.max(TRAIL_PCT_MIN, pct)) * 10) / 10
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
  /** strip under the cursor when the menu was opened ('price' = main pane) */
  pane?: DrawingPane
  /** value in THAT pane's scale at the cursor (RSI level / volume / macd) */
  paneValue?: number | null
}

interface DragState {
  hit: SceneHit
  x0: number
  y0: number
  orig: DrawingPoint[]
  origPixels: ({ x: number; y: number } | null)[]
  moved: boolean
  /** trailing-stop drag: the exit being re-trailed + the LIVE price frozen at
   * drag start (the trail % is the dragged level's distance from that price) */
  trail?: { exit: ExitInfo; refPx: number }
}

const KIND_LABEL: Record<DrawingKind, string> = {
  hline: 'Horizontal line',
  vline: 'Vertical line',
  trend: 'Trend line',
  fib: 'Fib retracement',
  rect: 'Rectangle',
  text: 'Text',
}

/** font-size presets for the text annotation editor */
const TEXT_SIZES = [10, 12, 14, 16, 18, 22, 28]

/** read `meta.text` / `meta.fontSize` safely (meta is opaque Json) */
function textMeta(meta: unknown): { text: string; fontSize: number } {
  const m = (meta ?? null) as { text?: unknown; fontSize?: unknown } | null
  return {
    text: typeof m?.text === 'string' ? m.text : '',
    fontSize: typeof m?.fontSize === 'number' && Number.isFinite(m.fontSize) ? m.fontSize : 14,
  }
}

const EMPTY_DRAWINGS: Drawing[] = []

// ---- technical indicators (SMA / EMA / Bollinger / RSI / MACD) ----
const MACD_HIST_UP = 'rgba(34,197,94,0.55)'
const MACD_HIST_DOWN = 'rgba(239,68,68,0.55)'

/** Compact volume for the VOL strip title (12.4M / 842.1K / 13B). */
const fmtVolCompact = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B`
  : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M`
  : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K`
  : v.toFixed(0)

/** Sign-prefixed value for MACD axis chips / strip titles. */
const fmtSigned = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`

/** Value label per pane: volume compact / RSI 2dp / MACD signed / price. */
const fmtPaneValue = (pane: DrawingPane | undefined, v: number) =>
  pane === 'vol' ? fmtVolCompact(v)
  : pane === 'rsi' ? v.toFixed(2)
  : pane === 'macd' ? fmtSigned(v)
  : fmtPrice(v)

/** lightweight-charts series for every ENABLED indicator (slots optional). */
interface IndSeriesBundle {
  settings: IndicatorSettings
  /** last computed value per slot (E2E probe / debug) */
  lastPts: Record<string, number | null>
  sma?: ISeriesApi<'Line'>
  ema?: ISeriesApi<'Line'>
  bbU?: ISeriesApi<'Line'>
  bbM?: ISeriesApi<'Line'>
  bbL?: ISeriesApi<'Line'>
  rsi?: ISeriesApi<'Line'>
  macdLine?: ISeriesApi<'Line'>
  macdSig?: ISeriesApi<'Line'>
  macdHist?: ISeriesApi<'Histogram'>
}

/** Tiny numeric field for indicator params — commits on blur/Enter. Remounts
 *  when the (clamped) canonical value changes so out-of-range input snaps back. */
function NumField({ label, value, min, max, step, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onCommit: (v: number) => void
}) {
  return (
    <Input
      key={value}
      type="number"
      defaultValue={value}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      className="h-6 w-14 border-zinc-800 bg-zinc-900 px-1.5 text-right text-[11px] tabular-nums text-zinc-200"
      onBlur={(e) => {
        const v = Number(e.target.value)
        if (e.target.value !== '' && Number.isFinite(v)) onCommit(v)
        else e.target.value = String(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export interface ChartPanelProps {
  symbol: string
  timeframe: Timeframe
  onSymbolChange: (s: string) => void
  onTimeframeChange: (tf: Timeframe) => void
  /** persisted per-pane chart style (candles default); undefined = candles */
  chartType?: 'candles' | 'line'
  /** persist a chart-style change into the pane (layout autosave) */
  onChartTypeChange?: (t: 'candles' | 'line') => void
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

export function ChartPanel({ symbol, timeframe: tf, onSymbolChange, onTimeframeChange, chartType: chartTypeProp, onChartTypeChange, onFocus, focused, syncKey, syncGroup, compact }: ChartPanelProps) {
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
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const indSeriesRef = useRef<IndSeriesBundle | null>(null)
  // strip layout (fractions of pane height) for the overlay-canvas chrome —
  // separators, VOL/RSI/MACD pane titles and the right-axis value chips are
  // all derived from these margins (v4 overlay scales draw no axis labels of
  // their own, and the main price scale's labels bleed into the strips)
  const indStripsRef = useRef<{
    price: { top: number; bottom: number }
    vol: { top: number; bottom: number }
    rsi?: { top: number; bottom: number }
    macd?: { top: number; bottom: number }
  } | null>(null)
  // crosshair snapshot for the strip axis chips (RSI/MACD/vol value that
  // follows the cursor while it is inside a strip); null when not hovering
  const crossInfoRef = useRef<{ y: number; vol: number | null; rsi: number | null; macd: number | null } | null>(null)
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
  // technical indicators (persisted globally in localStorage)
  const [ind, setIndState] = useState<IndicatorSettings>(() => loadIndicators())
  const [indDataVer, setIndDataVer] = useState(0) // bumped whenever bars change
  const [indOpen, setIndOpen] = useState(false)
  // chart style — seeded from the persisted pane setting, changes are pushed
  // up through onChartTypeChange so the layout autosave carries them
  const [chartType, setChartType] = useState<'candles' | 'line'>(chartTypeProp ?? 'candles')
  const [quote, setQuote] = useState<{ price: number; changePct: number; change: number; prevClose?: number } | null>(null)
  // streaming ticks (stream-service socket.io): badge + pending-tick bookkeeping
  const liveAtRef = useRef(0)
  const [liveBadge, setLiveBadge] = useState<'live' | null>(null)
  const pendingTickRef = useRef<StreamTick | null>(null)
  // drawings visibility eye toggle — persisted in the layout blob so the
  // choice survives reloads and travels with export/import (Task 52.1)
  const showDrawings = useTerminal((s) => s.showDrawings)
  const setShowDrawingsStore = useTerminal((s) => s.setShowDrawings)
  // extended trading hours (Task 59): show/hide pre-market + after-hours bars
  // on STOCK intraday charts — persisted in the layout blob like showDrawings
  const showExtendedHours = useTerminal((s) => s.showExtendedHours)
  const setShowExtendedHoursStore = useTerminal((s) => s.setShowExtendedHours)
  // session gate: ETH only means something for stocks on intraday timeframes
  // (crypto is 24/7; daily+ bars can't be split by session)
  const sessionGate = !isCryptoSymbol(symbol) && TIMEFRAMES[tf].seconds < 86400
  const ethShown = sessionGate && showExtendedHours
  // When the user flips ETH on, tell them exactly what the FREE feed covers —
  // feed=iex only carries IEX's own prints: pre-market 08:00–09:30 ET and
  // after-hours 16:00–17:00 ET. Unlike TradingView's consolidated SIP view,
  // most of the 04:00–20:00 extended window legitimately stays empty, and the
  // bars that do appear are sparse — that's feed coverage, not a toggle bug
  // (Task 76: verified extBarCount matches IEX prints 1:1).
  const prevEthRef = useRef(showExtendedHours)
  useEffect(() => {
    if (showExtendedHours && !prevEthRef.current && sessionGate) {
      ttLog(
        'data',
        `${symbol} ETH on — free IEX feed prints pre-market 08:00–09:30 ET & after-hours 16:00–17:00 ET only (full 04:00–20:00 coverage needs a SIP subscription)`,
        'info',
      )
    }
    prevEthRef.current = showExtendedHours
  }, [showExtendedHours, sessionGate, symbol])
  const [activeColor, setActiveColor] = useState(DRAW_COLORS[4])
  const activeColorRef = useRef(activeColor)
  activeColorRef.current = activeColor
  // text annotation editor — CREATE mode carries the clicked anchor point,
  // EDIT mode carries the existing drawing id
  const [textEdit, setTextEdit] = useState<{
    text: string
    fontSize: number
    color: string
    create?: { time: number | null; price: number; pane: DrawingPane }
    target?: { id: string; symbol: string }
  } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editValue, setEditValue] = useState<{
    type: 'drawing' | 'alert' | 'exit' | 'ghost' | 'pending'; id?: string; part?: 'sl' | 'tp' | 'entry'; price: number; pctMode?: boolean; pane?: DrawingPane; exit?: { info: ExitInfo; kind: 'sl' | 'tp' }; pending?: PendingOrderInfo
  } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [tradeOpen, setTradeOpen] = useState(false)
  const [ticketPrefill, setTicketPrefill] = useState<TicketPrefill | null>(null)
  const [advisorOpen, setAdvisorOpen] = useState(false)
  // Bumping this REMOUNTS the trade ticket. The ticket intentionally keeps its
  // state while open (stays open after placing an order), but its prefill is
  // only read on mount — so a right-click "Sell limit @ …" while the ticket
  // was already open used to be silently ignored ("didn't pop up"). A key
  // change forces a fresh mount with the new prefill.
  const [ticketSeq, setTicketSeq] = useState(0)
  // ---- Auto S/R (Task 58) — analyzer popover options ----
  const [srOpen, setSrOpen] = useState(false)
  const [srDays, setSrDays] = useState(730)
  const [srMinTouches, setSrMinTouches] = useState(3)
  const [srTfs, setSrTfs] = useState({ d: true, h4: true, h1: true })
  const [srReplace, setSrReplace] = useState(true)
  const [srBusy, setSrBusy] = useState(false)
  const { toast } = useToast()

  // trading positions + SL/TP exits for this symbol (polls every 15s)
  const posData = useSymbolPositions(symbol)
  const posRefresh = posData.refresh
  const posRef = useRef(posData.data)
  posRef.current = posData.data
  // live quote ref for the S/R analyzer (side classification uses the price
  // the user actually sees, not a possibly-lagging intraday feed's last close)
  const quoteRef = useRef(quote)
  quoteRef.current = quote
  const exitDragRef = useRef<{ kind: 'sl' | 'tp'; price: number | null; trailPct?: number | null } | null>(null)
  // pending-order drag (entry / planned TP / planned SL of an unfilled order).
  // `pl` freezes the P/L baseline (entry limit, qty, side) at drag start so the
  // predicted profit/loss chip can be drawn between the line and its entry.
  const pendingDragRef = useRef<{ part: 'entry' | 'tp' | 'sl'; price: number | null; pl?: { entry: number; qty: number; side: string } } | null>(null)
  // ghost [+TP]/[+SL] chip rects (rebuilt each overlay pass, hit-tested to
  // let the user DRAG a new exit out of the position line)
  const ghostChipRectsRef = useRef<{ part: 'sl' | 'tp'; x: number; y: number; w: number; h: number }[]>([])
  // text annotation hit rects (rebuilt each overlay pass, keyed by drawing id —
  // hitTest reads the exact measured text bounds from here)
  const textHitRectsRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({})

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

  // ---------- indicators: shared helpers ----------
  // Merge + clamp + persist an indicator-settings change (identity swap drives
  // the series lifecycle / data effects). Also marks the layout dirty so the
  // 5s autosave / unload beacon carries the new settings server-side.
  const setInd = useCallback((fn: (prev: IndicatorSettings) => IndicatorSettings) => {
    setIndState((prev) => {
      const next = normalizeIndicators(fn(prev))
      saveIndicators(next)
      useTerminal.getState().markLayoutDirty()
      return next
    })
  }, [])

  // Full (re)fill of every enabled indicator series from barsRef — called on
  // bars reload / config change, NOT per tick.
  const fillIndData = useCallback((b: IndSeriesBundle) => {
    const bars = barsRef.current
    if (bars.length === 0) return
    const asL = (pts: LinePoint[]) => pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
    const put = (ser: ISeriesApi<'Line'> | undefined, pts: LinePoint[] | undefined, slot: string) => {
      if (!ser) return
      const arr = pts ?? []
      ser.setData(asL(arr))
      b.lastPts[slot] = arr.length > 0 ? arr[arr.length - 1].value : null
    }
    const s = b.settings
    const ov = computeOverlays(bars, s)
    put(b.sma, ov.sma, 'sma')
    put(b.ema, ov.ema, 'ema')
    put(b.bbU, ov.bbUpper, 'bbU')
    put(b.bbM, ov.bbMid, 'bbM')
    put(b.bbL, ov.bbLower, 'bbL')
    if (b.rsi) put(b.rsi, computeRsi(bars, s.rsi.period), 'rsi')
    if (b.macdHist) {
      const m = computeMacd(bars, s.macd.fast, s.macd.slow, s.macd.signal)
      put(b.macdLine, m.macd, 'macd')
      put(b.macdSig, m.signal, 'sig')
      b.macdHist.setData(m.hist.map((h) => ({ time: h.time as UTCTimestamp, value: h.value, color: h.rising ? MACD_HIST_UP : MACD_HIST_DOWN })))
      b.lastPts['hist'] = m.hist.length > 0 ? m.hist[m.hist.length - 1].value : null
    }
  }, [])

  // Update ONLY the last point of each enabled indicator after a live tick or
  // REST quote refresh mutated the last bar (O(n) recompute, a few calls per
  // second per pane at most).
  const updateIndicatorsLast = useCallback(() => {
    const b = indSeriesRef.current
    const bars = barsRef.current
    if (!b || bars.length === 0) return
    const lastT = bars[bars.length - 1].time
    const s = b.settings
    const updLine = (ser: ISeriesApi<'Line'> | undefined, pts: LinePoint[] | undefined, slot: string) => {
      if (!ser || !pts || pts.length === 0) return
      const p = pts[pts.length - 1]
      if (p.time !== lastT) return // warm-up gap — full fill happens on reload
      ser.update({ time: p.time as UTCTimestamp, value: p.value })
      b.lastPts[slot] = p.value
    }
    const ov = computeOverlays(bars, s)
    updLine(b.sma, ov.sma, 'sma')
    updLine(b.ema, ov.ema, 'ema')
    updLine(b.bbU, ov.bbUpper, 'bbU')
    updLine(b.bbM, ov.bbMid, 'bbM')
    updLine(b.bbL, ov.bbLower, 'bbL')
    if (b.rsi) updLine(b.rsi, computeRsi(bars, s.rsi.period), 'rsi')
    if (b.macdHist) {
      const m = computeMacd(bars, s.macd.fast, s.macd.slow, s.macd.signal)
      updLine(b.macdLine, m.macd, 'macd')
      updLine(b.macdSig, m.signal, 'sig')
      if (m.hist.length > 0) {
        const h = m.hist[m.hist.length - 1]
        if (h.time === lastT) {
          b.macdHist.update({ time: h.time as UTCTimestamp, value: h.value, color: h.rising ? MACD_HIST_UP : MACD_HIST_DOWN })
          b.lastPts['hist'] = h.value
        }
      }
    }
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

  // ---------- pane-aware coordinates (drawings inside VOL/RSI/MACD strips) ----------
  // lightweight-charts v4 squeezes the volume/RSI/MACD strips into the SAME
  // pane on hidden price scales of their own, so a y pixel maps to a DIFFERENT
  // value depending on which strip it is in. Drawings remember the pane they
  // were drawn on (DrawingPoint.pane) and convert value↔pixel through THAT
  // pane's series — a line drawn at RSI 70 stays glued to RSI 70 (not to the
  // nonsense price the main scale extrapolates at that pixel).
  const paneSeries = useCallback((pane: DrawingPane): ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | ISeriesApi<'Candlestick'> | null => {
    if (pane === 'vol') return volSeriesRef.current
    if (pane === 'rsi') return indSeriesRef.current?.rsi ?? null
    if (pane === 'macd') return indSeriesRef.current?.macdLine ?? null
    return seriesRef.current
  }, [])

  /** value → y inside a SPECIFIC pane's scale. */
  const yOfPane = useCallback((pane: DrawingPane, v: number): number | null => {
    const s = paneSeries(pane)
    if (!s) return null
    try { const y = s.priceToCoordinate(v); return y == null ? null : Number(y) } catch { return null }
  }, [paneSeries])

  /** y → value inside a SPECIFIC pane's scale (volume / RSI level / macd). */
  const valueAtPane = useCallback((pane: DrawingPane, y: number): number | null => {
    const s = paneSeries(pane)
    if (!s) return null
    try { const v = s.coordinateToPrice(y); return v == null ? null : Number(v) } catch { return null }
  }, [paneSeries])

  /** which pane (price / vol / rsi / macd strip) a container-y coordinate is in. */
  const paneAt = useCallback((y: number): DrawingPane => {
    const strips = indStripsRef.current
    const chart = chartRef.current
    if (!strips || !chart) return 'price'
    let paneH = 0
    try { paneH = chart.paneSize().height } catch { return 'price' }
    if (!(paneH > 0)) return 'price'
    const rsiTop = strips.rsi ? strips.rsi.top * paneH : Infinity
    const macdTop = strips.macd ? strips.macd.top * paneH : Infinity
    if (y >= macdTop) return 'macd'
    if (y >= rsiTop) return 'rsi'
    if (y >= strips.vol.top * paneH) return 'vol'
    return 'price'
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

    // ---- extended-hours shading (Task 59) — TradingView-style translucent
    // gray bands behind every pre/post-market bar while ETH is shown. Drawn
    // FIRST so candles, drawings and chrome stay on top of the wash. ----
    if (ethShown) {
      const tsShade = chartRef.current?.timeScale()
      if (tsShade) {
        try {
          const half = Math.max(1, (tsShade.options().barSpacing ?? 6) / 2)
          let paneH = h
          try {
            const ps = chartRef.current?.paneSize()
            if (ps && ps.height > 0) paneH = ps.height
          } catch { /* keep full height */ }
          // collect x-intervals of extended-session bars, merging neighbors —
          // timeToCoordinate is monotonic and returns null only outside the
          // visible window, so skipping nulls never tears a band apart
          let curA: number | null = null
          let curB: number | null = null
          const bands: { a: number; b: number }[] = []
          const flush = () => {
            if (curA != null && curB != null) bands.push({ a: curA, b: curB })
            curA = null
            curB = null
          }
          for (const b of barsRef.current) {
            if (sessionOf(b.time) !== 'extended') {
              flush()
              continue
            }
            const x = tsShade.timeToCoordinate(b.time as UTCTimestamp)
            if (x == null) continue
            if (curA != null && curB != null && x - half <= curB + 1.5) curB = x + half
            else {
              flush()
              curA = x - half
              curB = x + half
            }
          }
          flush()
          if (bands.length > 0) {
            ctx.fillStyle = 'rgba(113,113,122,0.13)'
            for (const band of bands) ctx.fillRect(band.a, 0, band.b - band.a, paneH)
          }
        } catch { /* chart disposed mid-pass */ }
      }
    }

    const st = useTerminal.getState()
    const ds = st.drawingsBySymbol[symbol] || []
    // indicator alarms (RSI/MACD) have no price level — they live in the
    // Alerts drawer only, never drawn/hittable as price lines
    const als = st.alerts.filter((a) => a.symbol === symbol && a.status !== 'triggered' && (a.kind ?? 'price') === 'price')

    // ---- indicator strip chrome (TradingView-style pane titles + axis) ----
    // lightweight-charts v4 has no real panes: RSI/MACD live on hidden price
    // scales squeezed into stacked bottom strips. Draw hairline separators
    // between the strips and each strip's title + last value at its top-left,
    // so oscillators read as real sub-panes. On the right axis the main price
    // scale's labels bleed into the strip regions (extrapolated noise) while
    // overlay scales draw NO labels of their own — so cover that column inside
    // the strips and render proper oscillator labels: RSI 70/30 + last-value
    // chip, MACD zero line + last-value chip (chips follow the crosshair while
    // it is inside a strip). Drawn FIRST — everything else renders on top.
    {
      const strips = indStripsRef.current
      const chartApiS = chartRef.current
      if (strips && chartApiS) {
        let paneH = h
        try {
          const ps = chartApiS.paneSize()
          if (ps && ps.height > 0) paneH = ps.height
        } catch { /* fallback: keep full container height */ }
        ctx.save()
        ctx.strokeStyle = 'rgba(63,63,70,0.5)'
        ctx.lineWidth = 1
        for (const f of [strips.vol.top, strips.rsi?.top, strips.macd?.top]) {
          if (f == null || f <= 0.02 || f >= 1) continue
          const y = Math.round(f * paneH) + 0.5
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
        }
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        const ibS = indSeriesRef.current
        const stripLabel = (yFrac: number, txt: string, color: string) => {
          ctx.font = '600 10px ui-sans-serif, system-ui'
          ctx.fillStyle = color
          ctx.fillText(txt, 8, yFrac * paneH + 3)
          return 8 + ctx.measureText(txt).width + 6
        }
        const stripValue = (x: number, yFrac: number, txt: string, color: string) => {
          ctx.font = '10px ui-monospace, monospace'
          ctx.fillStyle = color
          ctx.fillText(txt, x, yFrac * paneH + 3)
        }
        // volume strip title + last bar volume
        const lastVol = barsRef.current.length > 0 ? barsRef.current[barsRef.current.length - 1].volume : null
        const volX = stripLabel(strips.vol.top, 'VOL', '#71717a')
        if (lastVol != null && Number.isFinite(lastVol) && lastVol > 0) {
          stripValue(volX, strips.vol.top, fmtVolCompact(lastVol), '#a1a1aa')
        }
        // rsi strip title + last value
        if (strips.rsi && ibS) {
          const xR = stripLabel(strips.rsi.top, `RSI ${ibS.settings.rsi.period}`, '#f472b6')
          const rv = ibS.lastPts.rsi
          if (rv != null && Number.isFinite(rv)) stripValue(xR, strips.rsi.top, rv.toFixed(2), '#f9a8d4')
        }
        // macd strip title + last macd/signal/histogram values
        if (strips.macd && ibS) {
          const mSet = ibS.settings.macd
          let xm = stripLabel(strips.macd.top, `MACD ${mSet.fast} ${mSet.slow} ${mSet.signal}`, '#f59e0b')
          const segs: [number | null | undefined, string][] = [
            [ibS.lastPts.macd, '#fbbf24'],
            [ibS.lastPts.sig, '#c4b5fd'],
            [ibS.lastPts.hist, '#a1a1aa'],
          ]
          for (const [v, color] of segs) {
            if (v == null || !Number.isFinite(v)) continue
            const txt = fmtSigned(v)
            stripValue(xm, strips.macd.top, txt, color)
            xm += ctx.measureText(txt).width + 6
          }
        }

        // ---- right axis inside the strips ----
        let axisW = 0
        try { axisW = chartApiS.priceScale('right').width() } catch { /* disposed */ }
        if (axisW > 0) {
          const x0 = w - axisW
          const coverTop = Math.round(strips.vol.top * paneH)
          ctx.fillStyle = '#09090b'
          ctx.fillRect(x0, coverTop, axisW, Math.round(paneH) - coverTop)
          ctx.textBaseline = 'middle'
          const axisLabel = (y: number, txt: string, color: string) => {
            ctx.font = '10px ui-monospace, monospace'
            ctx.fillStyle = color
            ctx.textAlign = 'right'
            ctx.fillText(txt, w - 5, Math.round(y) + 0.5)
          }
          const chip = (y: number, txt: string, color: string, topPx: number, botPx: number) => {
            ctx.font = '600 10px ui-monospace, monospace'
            const tw = ctx.measureText(txt).width + 10
            const th = 16
            const cy = Math.max(topPx + th / 2 + 1, Math.min(botPx - th / 2 - 1, y))
            const cx = x0 + axisW - tw - 3
            ctx.fillStyle = 'rgba(9,9,11,0.92)'
            ctx.strokeStyle = color
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.roundRect(cx, Math.round(cy - th / 2), tw, th, 3)
            ctx.fill()
            ctx.stroke()
            ctx.fillStyle = color
            ctx.textAlign = 'center'
            ctx.fillText(txt, cx + tw / 2, Math.round(cy) + 0.5)
          }
          const stripBox = (m: { top: number; bottom: number }) => ({ a: m.top * paneH, b: (1 - m.bottom) * paneH })
          const pxOf = (ser: ISeriesApi<'Line'> | undefined, price: number): number | null => {
            if (!ser) return null
            try { const y = ser.priceToCoordinate(price); return y == null ? null : Number(y) } catch { return null }
          }
          const ci = crossInfoRef.current
          const crossY = ci ? ci.y : null
          // chips are collected first so guide labels close to a chip can be
          // skipped (the chip would cover them anyway)
          type AxisChip = { y: number; txt: string; color: string; topPx: number; botPx: number }
          const chips: AxisChip[] = []
          // volume strip: crosshair value chip only (no static labels)
          {
            const vb = stripBox(strips.vol)
            if (crossY != null && crossY >= vb.a && crossY <= vb.b && ci && ci.vol != null && ci.vol > 0) {
              chips.push({ y: crossY, txt: fmtVolCompact(ci.vol), color: '#a1a1aa', topPx: vb.a, botPx: vb.b })
            }
          }
          // rsi strip: 70/30 guide labels + value chip (crosshair value wins)
          if (strips.rsi && ibS?.rsi) {
            const rb = stripBox(strips.rsi)
            const y70 = pxOf(ibS.rsi, 70)
            const y30 = pxOf(ibS.rsi, 30)
            const lastRsi = ibS.lastPts.rsi
            if (crossY != null && crossY >= rb.a && crossY <= rb.b && ci && ci.rsi != null && Number.isFinite(ci.rsi)) {
              const vy = pxOf(ibS.rsi, ci.rsi) ?? crossY
              chips.push({ y: vy, txt: ci.rsi.toFixed(2), color: '#f472b6', topPx: rb.a, botPx: rb.b })
            } else if (lastRsi != null && Number.isFinite(lastRsi)) {
              const ly = pxOf(ibS.rsi, lastRsi)
              if (ly != null) chips.push({ y: ly, txt: lastRsi.toFixed(2), color: '#f472b6', topPx: rb.a, botPx: rb.b })
            }
            if (y70 != null && !chips.some((c) => Math.abs(c.y - y70) < 10)) axisLabel(y70, '70', '#71717a')
            if (y30 != null && !chips.some((c) => Math.abs(c.y - y30) < 10)) axisLabel(y30, '30', '#71717a')
          }
          // macd strip: zero-line label + value chip (crosshair value wins)
          if (strips.macd && ibS?.macdLine) {
            const mb = stripBox(strips.macd)
            const zy = pxOf(ibS.macdLine, 0)
            const lastMacd = ibS.lastPts.macd
            if (crossY != null && crossY >= mb.a && crossY <= mb.b && ci && ci.macd != null && Number.isFinite(ci.macd)) {
              const vy = pxOf(ibS.macdLine, ci.macd) ?? crossY
              chips.push({ y: vy, txt: fmtSigned(ci.macd), color: '#fbbf24', topPx: mb.a, botPx: mb.b })
            } else if (lastMacd != null && Number.isFinite(lastMacd)) {
              const ly = pxOf(ibS.macdLine, lastMacd)
              if (ly != null) chips.push({ y: ly, txt: fmtSigned(lastMacd), color: '#fbbf24', topPx: mb.a, botPx: mb.b })
            }
            if (zy != null && !chips.some((c) => Math.abs(c.y - zy) < 10)) axisLabel(zy, '0', '#71717a')
          }
          for (const c of chips) chip(c.y, c.txt, c.color, c.topPx, c.botPx)
        }
        ctx.restore()
      }
    }

    if (st.drawingTool !== 'cursor' || draftRef.current) {
      // drawing hint strip
      ctx.fillStyle = 'rgba(161,161,170,0.75)'
      ctx.font = '11px ui-sans-serif, system-ui'
      const label =
        draftRef.current
          ? `${KIND_LABEL[draftRef.current.kind]}: click to set end point · Esc to cancel`
          : `${KIND_LABEL[st.drawingTool as DrawingKind]}: click on the chart${st.drawingTool === 'trend' || st.drawingTool === 'fib' || st.drawingTool === 'rect' ? ' (2 clicks)' : ''}`
      ctx.fillText(label, 46, 84)
    }

    // text annotation hit rects are rebuilt every pass (drawDrawing fills them)
    textHitRectsRef.current = {}
    // trend drawings with an ACTIVE line alert render a bell chip on the line
    const trendAlertIds = new Set(
      st.alerts
        .filter((a) => a.kind === 'trend' && a.status !== 'triggered')
        .map((a) => a.params?.drawingId)
        .filter((x): x is string => typeof x === 'string'),
    )
    if (st.drawingTool === 'cursor') {
      if (showDrawings) for (const d of ds) drawDrawing(ctx, d, w, h, hoverRef.current === d.id || (dragRef.current?.hit.type === 'drawing' && dragRef.current.hit.id === d.id), trendAlertIds.has(d.id))
      for (const a of als) drawAlert(ctx, a, w)
    } else if (showDrawings) {
      for (const d of ds) drawDrawing(ctx, d, w, h, false, trendAlertIds.has(d.id))
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
        if (exDrag.trailPct != null) {
          // trailing-stop drag: the ghost chip shows the COMMITTED value (the
          // trail %) — the ratcheted stop re-anchors to the live price on
          // commit, so a fixed "new SL <price>" would promise the wrong level
          drawChip(ctx, w - 122, yD, `SL trail ${exDrag.trailPct.toFixed(1)}%`, '#fb7185', true)
        } else {
          drawChip(ctx, w - 122, yD, `new ${exDrag.kind.toUpperCase()} ${fmtPrice(exDrag.price)}`, exDrag.kind === 'sl' ? '#fb7185' : '#4ade80', true)
          // predicted P/L (user spec): profit for TP / loss for SL, drawn BETWEEN
          // the dragged line and the position's entry price, sign-colored
          if (myPos && myPos.avgEntry > 0 && Math.abs(myPos.qty) > 0) {
            const yEntry = yOf(myPos.avgEntry)
            if (yEntry != null) {
              const perUnit = myPos.side === 'short' ? myPos.avgEntry - exDrag.price : exDrag.price - myPos.avgEntry
              const total = perUnit * Math.abs(myPos.qty)
              const pct = (perUnit / myPos.avgEntry) * 100
              drawPlChip(ctx, w, (yD + yEntry) / 2, total, pct)
            }
          }
        }
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
        // predicted P/L for a dragged pending TP/SL — baseline is the pending
        // order's entry (limit) price, frozen at drag start
        if ((pDrag.part === 'tp' || pDrag.part === 'sl') && pDrag.pl && pDrag.pl.entry > 0 && pDrag.pl.qty > 0) {
          const yEntryP = yOf(pDrag.pl.entry)
          if (yEntryP != null) {
            const perUnit = pDrag.pl.side === 'sell' ? pDrag.pl.entry - pDrag.price : pDrag.price - pDrag.pl.entry
            const total = perUnit * pDrag.pl.qty
            const pct = (perUnit / pDrag.pl.entry) * 100
            drawPlChip(ctx, w, (yD + yEntryP) / 2, total, pct)
          }
        }
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
        const maxW = 260
        // wrap the tip to the bubble width — the FIRST line renders bold, so it
        // must also be MEASURED bold (regular-font measurement left it a few px
        // wider than the bubble → clipped text)
        const measure = (s: string, bold: boolean) => {
          ctx.font = `${bold ? '600 ' : ''}10px ui-sans-serif, system-ui`
          return ctx.measureText(s).width
        }
        const words = hit.tip.split(' ')
        const lines: string[] = []
        const MAX_LINES = 8
        let line = ''
        let truncated = false
        for (let wi = 0; wi < words.length; wi++) {
          let wd = words[wi]
          // a single word wider than the bubble (URL/ticker) hard-breaks
          while (measure(wd, lines.length === 0 && !line) > maxW && wd.length > 1) {
            let cut = wd.length
            while (cut > 1 && measure(wd.slice(0, cut), lines.length === 0 && !line) > maxW) cut--
            if (line) { lines.push(line); line = '' }
            lines.push(wd.slice(0, cut))
            wd = wd.slice(cut)
            if (lines.length >= MAX_LINES) break
          }
          if (lines.length >= MAX_LINES) { truncated = true; break }
          const bold = lines.length === 0 && !line
          const cand = line ? `${line} ${wd}` : wd
          if (measure(cand, bold) > maxW && line) {
            lines.push(line)
            if (lines.length >= MAX_LINES) { truncated = true; line = ''; break }
            line = wd
          } else line = cand
        }
        if (line) {
          if (lines.length >= MAX_LINES) truncated = true
          else lines.push(line)
        }
        if (truncated) {
          // replace the tail of the last line with an ellipsis
          let last = lines[lines.length - 1] ?? ''
          while (last.length > 1 && measure(`${last}…`, lines.length === 1) > maxW) last = last.slice(0, -1)
          lines[lines.length - 1] = `${last}…`
        }
        // bubble must cover the WIDEST line (measured in its own weight)
        const tw = Math.max(...lines.map((l, i) => measure(l, i === 0))) + 14
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
      if (draft.kind === 'hline' && p1) {
        ctx.save()
        clipToPane(ctx, draft.p1.pane ?? 'price', w)
        hlinePath(ctx, p1.y, w)
        ctx.restore()
      }
      else if (draft.kind === 'vline' && p1) vlinePath(ctx, p1.x, h)
      else if (draft.kind === 'rect' && p1 && p2) {
        ctx.strokeRect(
          Math.min(p1.x, p2.x),
          Math.min(p1.y, p2.y),
          Math.abs(p2.x - p1.x),
          Math.abs(p2.y - p1.y),
        )
      }
      else if (p1 && p2) segPath(ctx, p1, p2, w, draft.kind === 'fib')
      ctx.restore()
    }
     
  }, [symbol, showDrawings, activeColor, xOf, yOf, priceAt, timeAt, ethShown])
  // keep the redraw scheduler pointed at the freshest overlay renderer
  // (see the stale-closure note above scheduleRedraw)
  renderOverlayRef.current = renderOverlay

  function pixelPoint(pt: DrawingPoint): { x: number; y: number } | null {
    const x = pt.time == null ? null : xOf(pt.time)
    // pane-aware: a point drawn in the RSI strip maps through the RSI scale
    const y = yOfPane(pt.pane ?? 'price', pt.price)
    if (x == null || y == null) return null
    return { x, y }
  }

  /** Vertical bounds (px, container space) a pane's horizontal lines may
   *  occupy. All strips live in ONE lightweight-charts pane: volume / RSI /
   *  MACD are hidden price scales squeezed into stacked bottom strips
   *  (stripMargins). priceToCoordinate() extrapolates LINEARLY beyond a
   *  series' autoscale range, so a price-pane hline whose level is far
   *  outside the visible zoom used to render INSIDE the vol/RSI/MACD strips
   *  (Task 60 — auto S/R lines overflowing the sub-panes). Horizontal lines
   *  are therefore clipped to their own pane region:
   *  price → [0, first strip top) · vol → [vol.top, next strip) · etc.
   *  Returns null when the chart geometry is unavailable (no clipping). */
  function paneYBounds(pane: DrawingPane): { top: number; bottom: number } | null {
    const strips = indStripsRef.current
    const chart = chartRef.current
    if (!strips || !chart) return null
    let paneH = 0
    try { paneH = chart.paneSize().height } catch { return null }
    if (!(paneH > 0)) return null
    const volTop = strips.vol.top * paneH
    const rsiTop = strips.rsi ? strips.rsi.top * paneH : Infinity
    const macdTop = strips.macd ? strips.macd.top * paneH : Infinity
    const nextTop = Math.min(rsiTop, macdTop)
    switch (pane) {
      case 'price': return { top: 0, bottom: volTop }
      case 'vol': return { top: volTop, bottom: Number.isFinite(nextTop) ? nextTop : paneH }
      case 'rsi': return { top: rsiTop, bottom: Number.isFinite(macdTop) ? macdTop : paneH }
      case 'macd': return { top: macdTop, bottom: paneH }
    }
  }

  /** Clip a pane's horizontal-line rendering to that pane's region so lines
   *  whose mapped y falls outside (off-scale prices) never bleed into the
   *  neighbouring strips. No-op when geometry is unavailable. */
  function clipToPane(ctx: CanvasRenderingContext2D, pane: DrawingPane, w: number): boolean {
    const b = paneYBounds(pane)
    if (!b || b.bottom <= b.top) return false
    ctx.beginPath()
    ctx.rect(0, b.top, w, b.bottom - b.top)
    ctx.clip()
    return true
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
      // degenerate leg (both anchors on the same bar — advisor fibs anchor
      // the whole leg at the swing time): dx*farX would be 0*Infinity = NaN
      // and the preview silently vanishes — fall back to a plain segment
      if (dx === 0 && dy === 0) {
        ctx.lineTo(p2.x, p2.y)
        ctx.stroke()
        return
      }
      const farX = dx !== 0 ? (w - p1.x) / dx : Infinity
      const ex = farX >= 0 ? w : p1.x - dx * 100
      const ey = p1.y + dy * (farX >= 0 ? farX : -100)
      ctx.lineTo(ex, ey)
    } else {
      ctx.lineTo(p2.x, p2.y)
    }
    ctx.stroke()
  }

  function drawDrawing(ctx: CanvasRenderingContext2D, d: Drawing, w: number, h: number, highlighted: boolean, alerted = false) {
    ctx.save()
    ctx.strokeStyle = d.color
    ctx.lineWidth = d.width + (highlighted ? 1 : 0)
    ctx.globalAlpha = 1

    if (d.kind === 'hline') {
      const pane = d.points[0]?.pane ?? 'price'
      const y = yOfPane(pane, d.points[0]?.price ?? 0)
      if (y != null) {
        // Task 60: a level far outside the visible zoom extrapolates into the
        // vol/RSI/MACD strips — clip the line + price chip + grip to the pane
        ctx.save()
        clipToPane(ctx, pane, w)
        hlinePath(ctx, y, w)
        drawChip(ctx, w - 74, y, fmtPaneValue(pane, d.points[0].price), d.color, highlighted)
        // move grip dots at center
        dot(ctx, w / 2, y, d.color, highlighted)
        ctx.restore()
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
          // trend-line alert chip at the line's end point (Task 54.1)
          if (alerted) {
            drawChip(ctx, Math.min(p2.x + 6, w - 46), Math.max(4, p2.y - 20), '🔔', d.color, highlighted)
          }
        } else {
          // fib: levels between p1..p2 extended to right edge (levels live in
          // the SAME pane the fib was drawn on — RSI fib levels are RSI units)
          const xLeft = Math.min(p1.x, p2.x)
          const fibPane = d.points[0]?.pane ?? 'price'
          const price1 = d.points[0].price
          const price2 = d.points[1].price
          const golden = (d.meta as { golden?: unknown } | null)?.golden === true
          ctx.font = '10px ui-monospace, monospace'
          // the fib LEG (p1→p2): a user-drawn fib shows its diagonal leg like
          // TradingView; the advisor fib anchors both ends at the swing bar so
          // the leg reads as a vertical spine connecting swing→S/R anchor.
          // Clipped to the pane like the levels (off-scale extremes would
          // otherwise extrapolate into the vol/RSI strips — Task 60 class).
          ctx.save()
          clipToPane(ctx, fibPane, w)
          ctx.globalAlpha = 0.55
          segPath(ctx, p1, p2, w, false)
          ctx.restore()
          // golden pocket (Task 82): translucent band across the 0.5–0.618 span
          if (golden) {
            const yA = yOfPane(fibPane, price2 + (price1 - price2) * 0.5)
            const yB = yOfPane(fibPane, price2 + (price1 - price2) * 0.618)
            if (yA != null && yB != null && yA !== yB) {
              ctx.save()
              clipToPane(ctx, fibPane, w)
              ctx.globalAlpha = 0.13
              ctx.fillStyle = d.color
              // xLeft can extrapolate off-screen left (swing anchored to a
              // higher-timeframe bar outside the zoom) — clamp to the pane
              const bx = Math.max(xLeft, 0)
              ctx.fillRect(bx, Math.min(yA, yB), w - bx, Math.abs(yB - yA))
              ctx.restore()
            }
          }
          for (const lv of FIB_LEVELS) {
            const priceLv = price2 + (price1 - price2) * lv
            const y = yOfPane(fibPane, priceLv)
            if (y == null) continue
            const emph = golden && (lv === 0.5 || lv === 0.618)
            // Task 82b: the whole level stack clips to its own pane — an
            // off-scale extreme (0.000/1.000 far outside the visible zoom)
            // extrapolated INTO the vol/RSI/MACD strips (same Task 60 class
            // as unclipped hlines). When pane geometry is unavailable the
            // clip is a no-op and the level draws unclipped (hline behavior).
            ctx.save()
            clipToPane(ctx, fibPane, w)
            ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : emph ? 0.95 : 0.6
            ctx.setLineDash(lv === 0.5 || emph ? [6, 3] : [])
            ctx.beginPath()
            ctx.moveTo(Math.max(xLeft, 0), Math.round(y) + 0.5)
            ctx.lineTo(w, Math.round(y) + 0.5)
            ctx.stroke()
            ctx.globalAlpha = 0.95
            ctx.fillStyle = d.color
            const label = `${lv.toFixed(3)}${emph ? ' ★' : ''}  ${fmtPaneValue(fibPane, priceLv)}`
            ctx.fillText(label, Math.max(xLeft + 4, 4), y - 3)
            ctx.restore()
          }
        }
        dot(ctx, p1.x, p1.y, d.color, highlighted)
        dot(ctx, p2.x, p2.y, d.color, highlighted)
      }
    } else if (d.kind === 'rect') {
      // two-corner rectangle: translucent fill + solid border, corner dots
      const p1 = pixelPoint(d.points[0])
      const p2 = pixelPoint(d.points[1])
      if (p1 && p2) {
        const x = Math.min(p1.x, p2.x)
        const y = Math.min(p1.y, p2.y)
        const rw = Math.abs(p2.x - p1.x)
        const rh = Math.abs(p2.y - p1.y)
        ctx.globalAlpha = 0.12
        ctx.fillStyle = d.color
        ctx.fillRect(x, y, rw, rh)
        ctx.globalAlpha = 1
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(rw), Math.round(rh))
        dot(ctx, p1.x, p1.y, d.color, highlighted)
        dot(ctx, p2.x, p2.y, d.color, highlighted)
      }
    } else if (d.kind === 'text') {
      // text annotation: anchor pixel = BASELINE LEFT; content + font size in
      // meta, color is the drawing color. Bounds are stashed for hit-testing.
      const p = pixelPoint(d.points[0])
      const { text: txt, fontSize: fs } = textMeta(d.meta)
      if (p && txt) {
        ctx.font = `600 ${fs}px ui-sans-serif, system-ui`
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = d.color
        ctx.fillText(txt, p.x, p.y)
        const tw = ctx.measureText(txt).width
        textHitRectsRef.current[d.id] = { x: p.x - 2, y: p.y - fs - 2, w: tw + 5, h: fs + 7 }
        if (highlighted) {
          ctx.setLineDash([3, 3])
          ctx.lineWidth = 1
          ctx.strokeStyle = d.color
          ctx.strokeRect(p.x - 3, p.y - fs - 3, tw + 7, fs + 9)
          ctx.setLineDash([])
        }
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

  /** Predicted P/L chip while dragging TP/SL (user spec): a bold, sign-colored
   * label ("+$245.00 (+2.3%)" green / "-$120.00 (-1.5%)" red) drawn vertically
   * BETWEEN the dragged line and the entry price, horizontally centered. */
  function drawPlChip(ctx: CanvasRenderingContext2D, chartW: number, y: number, total: number, pct: number) {
    const positive = total >= 0
    const money = Math.abs(total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const text = `${positive ? '+' : '-'}$${money} (${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%)`
    ctx.save()
    ctx.font = 'bold 11px ui-monospace, monospace'
    const bw = ctx.measureText(text).width + 14
    const bh = 18
    const x = Math.round((chartW - bw) / 2)
    const by = Math.round(y) - bh / 2
    ctx.globalAlpha = 0.95
    ctx.fillStyle = positive ? 'rgba(34,197,94,0.95)' : 'rgba(244,63,94,0.95)'
    ctx.beginPath()
    ctx.roundRect(x, by, bw, bh, 4)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = '#09090b'
    ctx.fillText(text, x + 7, by + 13)
    ctx.restore()
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
    // Task 60: alert levels live in the price pane — clip so an off-scale
    // alert line can't render inside the vol/RSI/MACD strips either
    clipToPane(ctx, 'price', w)
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

  // tolMul scales every hit tolerance: 1 = mouse precision, 2 = finger precision
  // (touch long-press menus open with the wider tolerance so an imprecise
  // finger still lands on the line it is holding)
  const hitTest = useCallback((x: number, y: number, tolMul = 1): SceneHit | null => {
    const st = useTerminal.getState()
    const ds = st.drawingsBySymbol[symbol] || []
    const als = st.alerts.filter((a) => a.symbol === symbol && a.status !== 'triggered' && (a.kind ?? 'price') === 'price')

    // trade lines take priority (pending orders / position entry / SL / TP)
    const posBundle = posRef.current
    const myPos = posBundle?.positions.find((p) => normSym(p.symbol) === normSym(symbol))
    const myExits = posBundle?.exits[normSym(symbol)]
    const pendings = (posBundle?.pending || []).filter((pp) => normSym(pp.symbol) === normSym(symbol) && pp.limitPrice != null)
    for (const p of pendings) {
      const yE = yOf(p.limitPrice!)
      if (yE != null && Math.abs(y - yE) < 7 * tolMul) {
        return { type: 'pending', id: p.orderId, part: 'whole', pending: p, origPrice: p.limitPrice! }
      }
      if (p.tpPrice != null) {
        const yT = yOf(p.tpPrice)
        if (yT != null && Math.abs(y - yT) < 7 * tolMul) {
          return { type: 'pending', id: p.orderId, part: 'tp', pending: p, origPrice: p.tpPrice }
        }
      }
      if (p.slPrice != null) {
        const yS = yOf(p.slPrice)
        if (yS != null && Math.abs(y - yS) < 7 * tolMul) {
          return { type: 'pending', id: p.orderId, part: 'sl', pending: p, origPrice: p.slPrice }
        }
      }
    }
    if (myExits?.sl && (myExits.sl.stopPrice != null || myExits.sl.limitPrice != null)) {
      const slPrice = myExits.sl.stopPrice ?? myExits.sl.limitPrice!
      const yl = yOf(slPrice)
      if (yl != null && Math.abs(y - yl) < 7 * tolMul) {
        // trailing stops are hittable too: right-click/dblclick edit the trail
        // %, and DRAGGING the line adjusts it (stop level → % of live price).
        // HELD (armed OCO sibling) legs stay hittable so the menu can explain
        // them — their handlers refuse to edit/drag (see onPointerDown).
        return { type: 'exit', id: myExits.sl.orderId, part: 'sl', origPrice: slPrice, exit: myExits.sl }
      }
    }
    if (myExits?.tp && myExits.tp.limitPrice != null) {
      const yl = yOf(myExits.tp.limitPrice)
      if (yl != null && Math.abs(y - yl) < 7 * tolMul) {
        return { type: 'exit', id: myExits.tp.orderId, part: 'tp', origPrice: myExits.tp.limitPrice, exit: myExits.tp }
      }
    }
    // ghost [+TP]/[+SL] chips — rect hit, tested BEFORE the position line
    // (the chips sit ON the entry line at the right edge)
    const gPad = 2 * tolMul
    for (const r of ghostChipRectsRef.current) {
      if (x >= r.x - gPad && x <= r.x + r.w + gPad && y >= r.y - gPad && y <= r.y + r.h + gPad) {
        return { type: 'ghost', id: r.part, part: r.part }
      }
    }
    if (myPos && myPos.avgEntry > 0) {
      const yl = yOf(myPos.avgEntry)
      if (yl != null && Math.abs(y - yl) < 6 * tolMul) {
        return { type: 'position', id: myPos.tradeSymbol, part: 'whole', origPrice: myPos.avgEntry }
      }
    }

    if (showDrawings) {
      for (let i = ds.length - 1; i >= 0; i--) {
        const d = ds[i]
        if (d.kind === 'hline') {
          const pane = d.points[0]?.pane ?? 'price'
          const yl = yOfPane(pane, d.points[0]?.price ?? 0)
          // Task 60: a line clipped out of its pane (off-scale level) is
          // invisible — it must not be hittable inside the vol/RSI strips
          const b = yl != null ? paneYBounds(pane) : null
          const visible = !b || (yl! >= b.top && yl! < b.bottom)
          if (yl != null && visible && Math.abs(y - yl) < 7 * tolMul) return { type: 'drawing', id: d.id, part: 'whole' }
        } else if (d.kind === 'vline') {
          const xl = xOf(d.points[0]?.time ?? null)
          if (xl != null && Math.abs(x - xl) < 7 * tolMul) return { type: 'drawing', id: d.id, part: 'whole' }
        } else if (d.kind === 'trend' || d.kind === 'fib') {
          const p1 = pixelPoint(d.points[0])
          const p2 = pixelPoint(d.points[1])
          if (p1 && Math.hypot(x - p1.x, y - p1.y) < 8 * tolMul) return { type: 'drawing', id: d.id, part: 'point', index: 0 }
          if (p2 && Math.hypot(x - p2.x, y - p2.y) < 8 * tolMul) return { type: 'drawing', id: d.id, part: 'point', index: 1 }
          if (d.kind === 'trend' && p1 && p2 && distToSeg(x, y, p1, p2) < 7 * tolMul) {
            return { type: 'drawing', id: d.id, part: 'whole' }
          }
          if (d.kind === 'fib' && p1 && p2) {
            const xLeft = Math.min(p1.x, p2.x)
            if (x >= xLeft - 4) {
              const fibPane = d.points[0]?.pane ?? 'price'
              const price1 = d.points[0].price
              const price2 = d.points[1].price
              // Task 82b: mirror the hline Task 60 guard — a level clipped
              // out of its pane is invisible and must not be hittable inside
              // the vol/RSI/MACD strips
              const bnd = paneYBounds(fibPane)
              for (const lv of FIB_LEVELS) {
                const yl = yOfPane(fibPane, price2 + (price1 - price2) * lv)
                const vis = !bnd || (yl != null && yl >= bnd.top && yl < bnd.bottom)
                if (yl != null && vis && Math.abs(y - yl) < 6 * tolMul) return { type: 'drawing', id: d.id, part: 'whole' }
              }
            }
          }
        } else if (d.kind === 'rect') {
          // corner dots win, then the 4 EDGES (a filled rect body must NOT
          // swallow clicks — only its outline is draggable)
          const p1 = pixelPoint(d.points[0])
          const p2 = pixelPoint(d.points[1])
          if (p1 && Math.hypot(x - p1.x, y - p1.y) < 8 * tolMul) return { type: 'drawing', id: d.id, part: 'point', index: 0 }
          if (p2 && Math.hypot(x - p2.x, y - p2.y) < 8 * tolMul) return { type: 'drawing', id: d.id, part: 'point', index: 1 }
          if (p1 && p2) {
            const x1 = Math.min(p1.x, p2.x)
            const x2 = Math.max(p1.x, p2.x)
            const y1 = Math.min(p1.y, p2.y)
            const y2 = Math.max(p1.y, p2.y)
            const edges: [{ x: number; y: number }, { x: number; y: number }][] = [
              [{ x: x1, y: y1 }, { x: x2, y: y1 }],
              [{ x: x1, y: y1 }, { x: x1, y: y2 }],
              [{ x: x2, y: y2 }, { x: x2, y: y1 }],
              [{ x: x2, y: y2 }, { x: x1, y: y2 }],
            ]
            for (const [a, b] of edges) {
              if (distToSeg(x, y, a, b) < 6 * tolMul) return { type: 'drawing', id: d.id, part: 'whole' }
            }
          }
        } else if (d.kind === 'text') {
          // exact measured bounds from the last overlay pass
          const r = textHitRectsRef.current[d.id]
          const tPad = 2 * tolMul
          if (r && x >= r.x - tPad && x <= r.x + r.w + tPad && y >= r.y - tPad && y <= r.y + r.h + tPad) {
            return { type: 'drawing', id: d.id, part: 'whole' }
          }
        }
      }
    }
    const priceB = paneYBounds('price')
    for (let i = als.length - 1; i >= 0; i--) {
      const yl = yOf(als[i].price)
      const vis = !priceB || (yl != null && yl >= priceB.top && yl < priceB.bottom)
      if (yl != null && vis && Math.abs(y - yl) < 7 * tolMul) return { type: 'alert', id: als[i].id, part: 'whole' }
    }
    return null
     
  }, [symbol, showDrawings, xOf, yOf, yOfPane])

  // ---------- drawing persistence ----------
  const createDrawing = useCallback(async (kind: DrawingKind, points: DrawingPoint[], opts?: { meta?: Record<string, unknown> | null; color?: string }) => {
    const color = opts?.color ?? activeColor
    const meta = opts?.meta ?? null
    const optimistic: Drawing = {
      id: `tmp-${Date.now()}`,
      symbol,
      kind,
      points,
      color,
      width: 2,
      meta,
    }
    addDrawingLocal(optimistic)
    try {
      const res = await fetch('/api/drawings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, kind, points, color, width: 2, meta }),
      })
      if (res.ok) {
        const json = await res.json()
        removeDrawingLocal(optimistic.id, symbol)
        addDrawingLocal(json.drawing)
      }
    } catch { /* offline — optimistic stays */ }
  }, [symbol, activeColor, addDrawingLocal, removeDrawingLocal])

  const patchDrawing = useCallback(async (id: string, patch: { points?: DrawingPoint[]; color?: string; meta?: Record<string, unknown> | null }) => {
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

  // ---- Auto S/R (Task 58) ----
  // Delete every auto-generated S/R hline of THIS symbol (meta.auto === 'sr').
  const removeAutoSr = useCallback(async (): Promise<number> => {
    const old = (useTerminal.getState().drawingsBySymbol[symbol] || []).filter(
      (d) => d.kind === 'hline' && (d.meta as { auto?: unknown } | null)?.auto === 'sr',
    )
    await Promise.all(old.map((d) => deleteDrawing(d.id)))
    return old.length
  }, [symbol, deleteDrawing])

  // Fetch history per selected timeframe, detect levels with >= N touches and
  // draw each one as a normal (draggable/alarm-able) hline colored by TF:
  // 1D red · 4H yellow · 1H green (Task 58).
  const runAutoSr = useCallback(async () => {
    setSrBusy(true)
    try {
      if (srReplace) {
        const n = await removeAutoSr()
        if (n > 0) void n // replaced silently — the toast below reports the fresh lines
      }
      const tfs: { key: Timeframe; on: boolean; color: string; tol: number; label: string }[] = [
        { key: '1D', on: srTfs.d, color: '#ef4444', tol: 0.012, label: '1D' },
        { key: '4h', on: srTfs.h4, color: '#f59e0b', tol: 0.009, label: '4H' },
        { key: '1h', on: srTfs.h1, color: '#22c55e', tol: 0.006, label: '1H' },
      ]
      const parts: string[] = []
      let created = 0
      for (const cfg of tfs) {
        if (!cfg.on) continue
        const res = await fetch(`/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=${cfg.key}&days=${Math.round(srDays)}`)
          .then((r) => r.json()).catch(() => null)
        const bars: SrBar[] = ((res?.bars ?? []) as Bar[]).map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }))
        if (bars.length === 0) {
          parts.push(`${cfg.label}: no data`)
          continue
        }
        const levels = detectSrLevels(bars, { minTouches: srMinTouches, maxLevels: 6, tolPct: cfg.tol, refPrice: quoteRef.current?.price })
        await Promise.all(levels.map((lv) =>
          createDrawing('hline', [{ time: null, price: lv.price, pane: 'price' }], {
            color: cfg.color,
            meta: { auto: 'sr', tf: cfg.label, touches: lv.touches, side: lv.side },
          }),
        ))
        created += levels.length
        parts.push(`${cfg.label} ${levels.length}`)
      }
      if (created === 0) {
        toast({
          title: 'No S/R levels found',
          description: `No level had ≥${srMinTouches} touches in the last ${Math.round(srDays)} days. Try more days or fewer required touches.`,
        })
      } else {
        toast({
          title: `Drew ${created} S/R line${created === 1 ? '' : 's'}`,
          description: `${parts.join(' · ')} · ≥${srMinTouches} touches · red 1D / yellow 4H / green 1H`,
        })
      }
    } finally {
      setSrBusy(false)
    }
  }, [symbol, srDays, srMinTouches, srTfs, srReplace, removeAutoSr, createDrawing, toast])

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

  // one-click indicator alarm from the chart's right-click menu — carries the
  // indicator config CURRENTLY shown on this chart and its timeframe
  // (declared BEFORE addAlertAtPrice, which delegates strip alarms to it)
  const addIndicatorAlarm = useCallback(async (req: {
    kind: 'rsi' | 'macd'
    label: string
    params: Record<string, number>
    direction?: 'above' | 'below'
    price?: number
    condition?: string
  }) => {
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, timeframe: tf, ...req }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.alert) {
        addAlertLocal(json.alert)
        toast({ title: `🔔 ${req.kind.toUpperCase()} alarm created`, description: `${req.label} · ${symbol}` })
      } else {
        toast({ title: 'Alarm failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Alarm failed', description: 'Network error', variant: 'destructive' })
    }
  }, [symbol, tf, addAlertLocal, toast])

  // price alarm at a level — or, when the level lives in an indicator strip
  // (drawing line / right-click inside RSI/MACD), the matching INDICATOR alarm
  // using this chart's indicator settings + timeframe
  const addAlertAtPrice = useCallback(async (price: number, pane?: DrawingPane) => {
    const ib = indSeriesRef.current
    if (pane === 'rsi' || pane === 'macd') {
      const period = ib?.settings.rsi.period ?? 14
      if (pane === 'rsi') {
        const level = Math.min(99, Math.max(1, Math.round(price * 100) / 100))
        const last = ib?.lastPts.rsi
        const direction: 'above' | 'below' = Number.isFinite(last!) ? ((last as number) > level ? 'below' : 'above') : 'above'
        await addIndicatorAlarm({
          kind: 'rsi',
          label: `RSI(${period}) crosses ${direction} ${level.toFixed(2)}`,
          params: { period },
          direction,
          price: level,
        })
        return
      }
      // macd line crossing the drawn level
      const m = ib?.settings.macd
      const lastMacd = ib?.lastPts.macd
      const level = Math.round(price * 10000) / 10000
      const condition: 'cross_above' | 'cross_below' = Number.isFinite(lastMacd!) ? ((lastMacd as number) > level ? 'cross_below' : 'cross_above') : 'cross_above'
      await addIndicatorAlarm({
        kind: 'macd',
        label: `MACD(${m?.fast ?? 12},${m?.slow ?? 26},${m?.signal ?? 9}) crosses ${condition === 'cross_above' ? 'above' : 'below'} ${fmtSigned(level)}`,
        params: { fast: m?.fast ?? 12, slow: m?.slow ?? 26, signal: m?.signal ?? 9 },
        condition,
        price: level,
      })
      return
    }
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
  }, [symbol, quote, addAlertLocal, addIndicatorAlarm])

  // TREND-LINE alert (Task 54.1): fires when price crosses the (extended) line
  // drawing. The server re-projects the line through its two points at every
  // poll, so the level MOVES with the line. Direction is auto-picked as the
  // NEXT crossing (price above the line → fires when it crosses down, and
  // vice-versa), matching TradingView's "alert on trend line" behaviour.
  const addTrendLineAlert = useCallback(async (d: Drawing) => {
    const p1 = d.points[0]
    const p2 = d.points[1]
    if (!p1 || !p2) return
    const bars = barsRef.current
    const now = bars.length ? bars[bars.length - 1].time : Math.floor(Date.now() / 1000)
    let level: number
    if (p1.time != null && p2.time != null && p1.time !== p2.time) {
      level = p1.price + ((p2.price - p1.price) * (now - p1.time)) / (p2.time - p1.time)
    } else {
      level = p2.price
    }
    const cur = quote?.price
    const direction: 'above' | 'below' = cur != null && cur > level ? 'below' : 'above'
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol, kind: 'trend', price: level, direction, timeframe: tf,
          params: { drawingId: d.id }, color: d.color, note: 'Trend line',
        }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.alert) {
        addAlertLocal(json.alert)
        toast({
          title: '🔔 Trend-line alert created',
          description: `Fires when price crosses ${direction === 'above' ? 'UP' : 'DOWN'} through the line · ${symbol}`,
        })
      } else {
        toast({ title: 'Alert failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Alert failed', description: 'Network error', variant: 'destructive' })
    }
  }, [symbol, tf, quote, addAlertLocal, toast])

  // CLONE drawing (Task 54.2): duplicate with every point shifted slightly
  // down-right (px-based through the pane scales, so the offset is visually
  // consistent at any zoom). Text clones get a " (copy)" suffix.
  const cloneDrawing = useCallback(async (d: Drawing) => {
    const DX = 30
    const DY = 26
    const pts: DrawingPoint[] = d.points.map((p) => {
      const pane: DrawingPane = p.pane ?? 'price'
      const x = xOf(p.time ?? null)
      const y = yOfPane(pane, p.price)
      if (x == null && y == null) return { ...p, pane }
      const nt = x != null ? timeAt(x + DX) : null
      const nv = y != null ? valueAtPane(pane, y + DY) : null
      return {
        ...p,
        pane,
        // fall back to a 2-bar time shift when the pixel projection fails
        time: nt ?? (p.time != null ? p.time + 2 * TIMEFRAMES[tf].seconds : p.time),
        price: nv ?? p.price,
      }
    })
    const meta = d.meta
      ? { ...d.meta, ...(typeof d.meta.text === 'string' ? { text: `${d.meta.text} (copy)` } : {}) }
      : null
    await createDrawing(d.kind, pts, { color: d.color, meta })
    toast({ title: `${KIND_LABEL[d.kind]} cloned`, description: 'Duplicated slightly below-right of the original.' })
  }, [xOf, yOfPane, timeAt, valueAtPane, tf, createDrawing, toast])

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

    // ---- touch long-press = right click (mobile context menu) ----
    // Phones have no right-click: pressing and HOLDING ~550ms opens the same
    // context menu (set alarm on a line, clone, delete, trade here…). Any real
    // movement (pan/zoom), a second finger, or lifting early cancels it.
    // On Android the browser ALSO fires a native contextmenu ~500ms into the
    // hold — lastNativeCtxAt de-duplicates the two paths.
    let lpTimer: ReturnType<typeof setTimeout> | null = null
    let lpX = 0
    let lpY = 0
    let lpPointerId = -1
    let touchDown = false
    let lastNativeCtxAt = 0
    const cancelLongPress = () => {
      if (lpTimer) {
        clearTimeout(lpTimer)
        lpTimer = null
      }
    }
    const openMenuAt = (clientX: number, clientY: number, tolMul: number) => {
      const { x, y } = rel({ clientX, clientY })
      const hit = hitTest(x, y, tolMul)
      // cursor price — used by "add TP/SL here" and the trade menu actions
      const price = priceAt(y)
      // which strip was clicked + the value IN THAT STRIP's scale — the menu
      // uses it for pane-aware actions (RSI/MACD alarm at the pointed value,
      // horizontal lines that hold volume/RSI/MACD values)
      const pane = paneAt(y)
      const paneValue = pane === 'price' ? null : valueAtPane(pane, y)
      if (hit) {
        setMenu({ x, y, hit, price, pane, paneValue })
        return
      }
      // empty chart: custom menu with price-aware actions (alert / trade / hline)
      setMenu({ x, y, hit: { type: 'chart', part: 'whole' }, price, pane, paneValue })
    }
    const fireLongPress = () => {
      lpTimer = null
      // native contextmenu already opened the menu — don't open it twice
      if (Date.now() - lastNativeCtxAt < 700) return
      // a drag may have started on this same press — abandon it, the menu takes over
      dragRef.current = null
      exitDragRef.current = null
      pendingDragRef.current = null
      el.style.cursor = ''
      try { navigator.vibrate?.(15) } catch { /* unsupported */ }
      // fingers are imprecise — open with the WIDER hit tolerance (tolMul 2)
      openMenuAt(lpX, lpY, 2)
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      // a chart context menu is open — clicks INSIDE it must pass through.
      // Without this, the capture-phase hitTest below eats the pointerdown
      // whenever the menu item happens to overlap a drawing/line hit zone
      // (e.g. a color swatch sitting on a rectangle edge) and the menu button
      // never receives the click. The trade ticket (incl. its drag header)
      // gets the same pass-through.
      if (e.target instanceof Element && (e.target.closest('[role="menu"]') || e.target.closest('[role="dialog"][aria-label^="Trade ticket"]'))) return
      // arm the touch long-press timer (mobile right-click equivalent).
      // Interactive HTML (header buttons, toolbars) is excluded — a held
      // finger there means a slow tap, not a chart menu.
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        cancelLongPress()
        const tEl = e.target instanceof Element ? e.target : null
        if (!tEl || !tEl.closest('button, a, input, select, textarea, label, [role="button"]')) {
          lpX = e.clientX
          lpY = e.clientY
          lpPointerId = e.pointerId
          touchDown = true
          lpTimer = setTimeout(fireLongPress, 550)
        }
      }
      const { x, y } = rel(e)
      const tool = useTerminal.getState().drawingTool

      if (tool !== 'cursor') {
        e.stopPropagation()
        e.preventDefault()
        const t = timeAt(x)
        // the point lives in WHATEVER pane was clicked — a line started in the
        // RSI strip stores an RSI level, in the VOL strip a volume value
        const pane = paneAt(y)
        const p = valueAtPane(pane, y)
        if (p == null) return
        const pt: DrawingPoint = { time: t, price: p, pane }
        if (tool === 'hline' || tool === 'vline') {
          void createDrawing(tool, [pt])
          setDrawingTool('cursor')
        } else if (tool === 'text') {
          // open the text editor anchored at the click (pane-aware: a text
          // placed in the RSI strip holds an RSI level and follows the strip)
          setTextEdit({ text: '', fontSize: 14, color: activeColorRef.current, create: { time: t, price: p, pane } })
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
        let orig: DrawingPoint[] = []
        let origPixels: ({ x: number; y: number } | null)[] = []
        let trailDrag: { exit: ExitInfo; refPx: number } | undefined
        if (hit.type === 'drawing') {
          const d = (st.drawingsBySymbol[symbol] || []).find((dd) => dd.id === hit.id)
          if (!d) return
          orig = d.points.map((p) => ({ ...p }))
          // hlines created from the RIGHT-CLICK menu carry time:null and
          // pixelPoint() returns null for them (x == null) — a null origPixel
          // made the drag a no-op ("right-click horizontal line cannot move").
          // hline dragging only needs the Y pixel, so fall back to it (via the
          // line's OWN pane — a strip hline maps through its strip's scale).
          origPixels = orig.map((p) =>
            pixelPoint(p) ?? (d.kind === 'hline' ? { x: 0, y: yOfPane(p.pane ?? 'price', p.price) ?? y } : null),
          )
        } else if (hit.type === 'alert') {
          const a = st.alerts.find((aa) => aa.id === hit.id)
          if (!a) return
          orig = [{ time: null, price: a.price }]
          origPixels = [{ x: 0, y: yOf(a.price) ?? y }]
        } else if (hit.type === 'exit') {
          if (hit.exit.status === 'held') {
            // ARMED OCO sibling: the stop is Alpaca-managed until the sibling
            // fills. Editing here would either 422 or (via the cancel+re-place
            // fallback) tear down the whole family — stay read-only; the
            // context menu explains (right-click / long-press on the line).
            return
          }
          if (hit.exit.type === 'trailing_stop') {
            // TRAILING-STOP DRAG: the line has no fixed price — dragging it
            // adjusts the trail % (dragged level's distance from the LIVE
            // price), committed on drop through the same patch path as the
            // ✏️ Change trail % editor (cancel+re-place with stale-id heal)
            const pos = posRef.current?.positions.find((pp) => normSym(pp.symbol) === normSym(symbol))
            const refPx = quoteRef.current?.price ?? pos?.current ?? hit.origPrice
            orig = [{ time: null, price: hit.origPrice }]
            origPixels = [{ x: 0, y: yOf(hit.origPrice) ?? y }]
            exitDragRef.current = { kind: hit.part, price: hit.origPrice, trailPct: hit.exit.trailPercent }
            trailDrag = { exit: hit.exit, refPx }
          } else {
            // exit line drag (SL/TP) — preview handled in onMove via exitDragRef
            orig = [{ time: null, price: hit.origPrice }]
            origPixels = [{ x: 0, y: yOf(hit.origPrice) ?? y }]
            exitDragRef.current = { kind: hit.part, price: hit.origPrice }
          }
        } else if (hit.type === 'pending') {
          // pending entry / planned TP/SL line drag — relative move like exits
          orig = [{ time: null, price: hit.origPrice }]
          origPixels = [{ x: 0, y: yOf(hit.origPrice) ?? y }]
          pendingDragRef.current = {
            part: hit.part === 'whole' ? 'entry' : hit.part,
            price: hit.origPrice,
            // P/L baseline for the predicted profit/loss chip (TP/SL drags only)
            pl: hit.part !== 'whole' && hit.pending.limitPrice != null
              ? { entry: hit.pending.limitPrice, qty: Math.abs(hit.pending.qty), side: hit.pending.side }
              : undefined,
          }
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
        dragRef.current = { hit, x0: x, y0: y, orig, origPixels, moved: false, trail: trailDrag }

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
              if (drag.trail) {
                // trailing stop: recompute the trail % from the dragged level
                // vs the live price (frozen at drag start) — the ghost chip
                // tracks it; clamped to the Alpaca-legal 0.1..20 band
                const pct = np != null ? trailPctFromDrag(np, drag.trail.refPx) : null
                if (np != null) {
                  exitDragRef.current = { kind: drag.hit.part, price: np, trailPct: pct }
                  scheduleRedraw()
                }
              } else if (np != null) {
                exitDragRef.current = { kind: drag.hit.part, price: np }
                scheduleRedraw()
              }
            }
            return
          }
          if (drag.hit.type === 'pending') {
            const oy = drag.origPixels[0]?.y
            if (oy != null) {
              const np = priceAt(oy + dy)
              pendingDragRef.current = { part: drag.hit.part === 'whole' ? 'entry' : drag.hit.part, price: np, pl: pendingDragRef.current?.pl }
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
            const pane = oo.pane // each point converts within its OWN pane
            if (d.kind !== 'hline') {
              // time needs the original x pixel (hlines never move in time and
              // may carry time:null — no origPixel — which is fine for them)
              if (op) {
                const nt = timeAt(op.x + dx)
                if (nt != null) time = nt
              }
            }
            if (d.kind !== 'vline') {
              const oy = yOfPane(pane ?? 'price', oo.price)
              if (oy != null) {
                const np = valueAtPane(pane ?? 'price', oy + dy)
                if (np != null) price = np
              }
            }
            return { time, price, pane }
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
            if (!drag.moved) return
            if (drag.trail) {
              // trailing stop drop: commit the dragged trail % through the SAME
              // path as the ✏️ editor (cancel+re-place + stale-id heal + toast).
              // Sub-threshold deltas (< 0.05pt) skip the churn entirely.
              const pct = d?.trailPct
              const level = d?.price
              // DIRECTION GUARD: an SL must stay on its own side of the live
              // price (sell-stop below for a long, buy-stop above for a short).
              // The % is |level − refPx|, so dragging ACROSS the price would
              // silently commit a trail on the wrong side — refuse instead.
              const refPx = drag.trail.refPx
              const wrongSide =
                level != null && refPx > 0 &&
                (drag.trail.exit.side === 'sell' ? level > refPx : level < refPx)
              if (wrongSide) {
                toast({
                  title: 'Trail stop stays on its side',
                  description:
                    drag.trail.exit.side === 'sell'
                      ? 'A long trailing stop must sit below the current price — drag the line down.'
                      : 'A short trailing stop must sit above the current price — drag the line up.',
                })
              } else if (pct != null && Math.abs(pct - (drag.trail.exit.trailPercent ?? 0)) >= 0.05) {
                void patchExitTrailPct(drag.trail.exit, pct)
              }
              return
            }
            if (d?.price != null) {
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
      // finger drifted — this is a pan/zoom, not a hold: cancel the long-press
      if (lpTimer !== null && e.pointerId === lpPointerId && Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) cancelLongPress()
      if (dragRef.current) return
      const { x, y } = rel(e)
      const tool = useTerminal.getState().drawingTool
      if (tool !== 'cursor' || draftRef.current) {
        el.style.cursor = 'crosshair'
        const t = timeAt(x)
        // draft preview converts in the DRAFT'S OWN pane (p1's pane): a trend
        // started in the RSI strip previews RSI values while the cursor stays
        // in the strip; each committed point keeps its own independent pane
        const draftPane = draftRef.current?.p1.pane ?? paneAt(y)
        const p = valueAtPane(draftPane, y)
        if (draftRef.current && p != null) {
          draftRef.current.p2 = { time: t, price: p, pane: draftPane }
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

    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId === lpPointerId) {
        cancelLongPress()
        touchDown = false
      }
    }

    const onContextMenu = (e: MouseEvent) => {
      // on Android a touch long-press fires this NATIVE event ~500ms in —
      // remember it so the synthesized timer doesn't open a second menu
      lastNativeCtxAt = Date.now()
      cancelLongPress()
      e.preventDefault()
      e.stopPropagation()
      // touch-originated long-press uses the wider finger tolerance
      openMenuAt(e.clientX, e.clientY, touchDown ? 2 : 1)
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
        if (hit.exit.status === 'held') {
          // armed OCO sibling — nothing is editable yet; say why instead of
          // silently doing nothing
          toast({
            title: 'Armed OCO leg',
            description: 'This stop activates automatically when the sibling fills — edit it after it becomes active.',
          })
        } else if (hit.exit.type === 'trailing_stop') {
          // trailing stop: edit the trail PERCENT, not a fixed price
          setEditValue({ type: 'exit', id: hit.id, price: Number((hit.exit.trailPercent ?? 5).toFixed(2)), pctMode: true, exit: { info: hit.exit, kind: hit.part } })
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
        if (d && d.kind === 'hline') setEditValue({ type: 'drawing', id: d.id, price: d.points[0].price, pane: d.points[0]?.pane ?? 'price' })
        else if (d && d.kind === 'text') {
          const tm = textMeta(d.meta)
          setTextEdit({ text: tm.text, fontSize: tm.fontSize, color: d.color, target: { id: d.id, symbol } })
        }
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dragRef.current) {
          // abort an in-flight line drag (exit/ghost/pending): nulling the drag
          // makes the trailing pointerup commit nothing and onMove a no-op
          dragRef.current = null
          exitDragRef.current = null
          pendingDragRef.current = null
        }
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
    el.addEventListener('pointerup', onPointerEnd, true)
    el.addEventListener('pointercancel', onPointerEnd, true)
    el.addEventListener('contextmenu', onContextMenu, true)
    el.addEventListener('dblclick', onDoubleClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelLongPress()
      el.removeEventListener('pointerdown', onPointerDown, true)
      el.removeEventListener('pointermove', onPointerMove, true)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('pointerup', onPointerEnd, true)
      el.removeEventListener('pointercancel', onPointerEnd, true)
      el.removeEventListener('contextmenu', onContextMenu, true)
      el.removeEventListener('dblclick', onDoubleClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [hitTest, createDrawing, patchDrawing, patchAlert, patchExitPrice, addExitToPosition, patchPendingOrder, symbol, timeAt, priceAt, yOf, yOfPane, valueAtPane, paneAt, scheduleRedraw, setDrawingTool, toast])

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
    volSeriesRef.current = vol
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      const bar = param.seriesData.get(series) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined
      const volBar = param.seriesData.get(vol) as { value?: number } | undefined
      // stash strip-relevant values for the overlay-canvas axis chips (the
      // RSI/MACD value chip follows the cursor while it is inside its strip)
      {
        const stripsC = indStripsRef.current
        const ibC = indSeriesRef.current
        let paneHC = 0
        try { paneHC = chart.paneSize().height } catch { /* disposed */ }
        const wasInStrips = !!crossInfoRef.current && !!stripsC && paneHC > 0 && crossInfoRef.current.y >= stripsC.vol.top * paneHC
        if (param.point && stripsC && ibC) {
          const rvC = (ser?: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>) => {
            if (!ser) return null
            const d = param.seriesData.get(ser as ISeriesApi<'Line'>) as { value?: number } | undefined
            return d?.value != null && Number.isFinite(d.value) ? d.value : null
          }
          crossInfoRef.current = {
            y: param.point.y,
            vol: volBar?.value != null ? volBar.value : null,
            rsi: rvC(ibC.rsi),
            macd: rvC(ibC.macdLine),
          }
        } else {
          crossInfoRef.current = null
        }
        const nowInStrips = !!crossInfoRef.current && paneHC > 0 && crossInfoRef.current.y >= stripsC!.vol.top * paneHC
        if (nowInStrips || wasInStrips) scheduleRedraw() // axis chips must track the cursor
      }
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
          // indicator readouts at the hovered bar (values straight from series data)
          const ib = indSeriesRef.current
          let indHtml = ''
          if (ib) {
            const rv = (ser?: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>) => {
              if (!ser) return undefined
              const d = param.seriesData.get(ser as ISeriesApi<'Line'>) as { value?: number } | undefined
              return d?.value
            }
            const parts: string[] = []
            const push = (color: string, label: string, v: number | undefined) => {
              if (v != null && Number.isFinite(v)) parts.push(`<span class="tabular-nums" style="color:${color}">${label} ${fmtPrice(v)}</span>`)
            }
            const st = ib.settings
            if (ib.sma) push('#f59e0b', `SMA${st.sma.period}`, rv(ib.sma))
            if (ib.ema) push('#a78bfa', `EMA${st.ema.period}`, rv(ib.ema))
            if (ib.bbU) push('#e879f9', `BB${st.bb.period},${st.bb.mult}`, rv(ib.bbM))
            if (ib.rsi) push('#f472b6', `RSI${st.rsi.period}`, rv(ib.rsi))
            if (ib.macdLine) push('#f59e0b', 'MACD', rv(ib.macdLine))
            if (ib.macdSig) push('#a78bfa', 'sig', rv(ib.macdSig))
            if (ib.macdHist) push('#a1a1aa', 'hist', rv(ib.macdHist))
            indHtml = parts.length > 0 ? `<div class="mt-0.5 flex flex-wrap gap-x-2">${parts.join('')}</div>` : ''
          }
          leg.innerHTML =
            `<div><span class="font-semibold text-zinc-100">${symEsc}</span>` +
            `<span class="text-zinc-500"> · ${tfLabelEsc} · </span>` +
            `<span class="text-zinc-500">O</span><span class="${col}"> ${fmtPrice(o)}</span>` +
            `<span class="text-zinc-500"> H</span><span class="${col}"> ${fmtPrice(bar.high ?? c)}</span>` +
            `<span class="text-zinc-500"> L</span><span class="${col}"> ${fmtPrice(bar.low ?? c)}</span>` +
            `<span class="text-zinc-500"> C</span><span class="${col}"> ${fmtPrice(c)}</span></div>` +
            (volTxt ? `<div class="text-zinc-500">${volTxt}</div>` : '') + indHtml
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
    // RTH-only mode (ETH off): the RAW oldest fetched bar can sit days before
    // the DISPLAYED oldest bar (weekend/holiday gaps are all extended bars) —
    // pagination pages on this raw cursor so a chunk of pure pre/post bars
    // can neither stall the scroll-back nor mark the history exhausted.
    let oldestRawTime: number | null = null
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
      // bars changed → indicator series refill (initial load / scroll-back)
      setIndDataVer((v) => v + 1)
    }
    const loadOlder = async () => {
      const bars = barsRef.current
      if (loadingOlder || olderExhausted || cancelled || bars.length === 0) return
      const oldest = bars[0].time
      // raw cursor: never NEWER than the displayed oldest bar
      const cursor = oldestRawTime != null ? Math.min(oldestRawTime, oldest) : oldest
      loadingOlder = true
      try {
        const res = await fetch(
          `/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}&before=${cursor}`,
        )
        if (!res.ok) throw new Error('older bars fetch failed')
        const json = await res.json()
        if (cancelled) return
        const incoming: Bar[] = (json.bars as Bar[]) || []
        // only bars STRICTLY older than the raw cursor (server windows overlap)
        const rawFresh = incoming.filter((b) => b.time < cursor)
        if (rawFresh.length === 0) {
          // nothing older exists — stop asking (until symbol/tf changes)
          olderExhausted = true
          return
        }
        oldestRawTime = Math.min(...rawFresh.map((b) => b.time))
        // ETH off → only regular-session bars reach the chart (Task 59)
        const rthOnly = sessionGate && !showExtendedHours
        const map = new Map<number, Bar>()
        for (const b of bars) map.set(b.time, b)
        for (const b of rawFresh) {
          if (rthOnly && sessionOf(b.time) !== 'regular') continue
          map.set(b.time, b)
        }
        const merged = [...map.values()].sort((a, b) => a.time - b.time)
        barsRef.current = merged
        // prepending N bars shifts every logical index by N — restore the exact
        // visible window so the view doesn't jump while the user is scrolling
        // (a chunk that filtered down to zero new bars must NOT shift anything)
        const prev = chart.timeScale().getVisibleLogicalRange()
        applyBars(merged)
        const added = merged.length - bars.length
        if (prev && added > 0) {
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
        // ETH option (Task 59): RTH-only mode hides pre/post-market bars on
        // stock intraday charts (crypto is 24/7, daily+ bars have no session)
        const shown = sessionGate && !showExtendedHours
          ? clean.filter((b) => sessionOf(b.time) === 'regular')
          : clean
        barsRef.current = shown

        applyBars(shown)
        // TradingView-like: show recent window, not the whole history
        if (shown.length > 0) {
          const from = Math.max(0, shown.length - 150)
          chart.timeScale().setVisibleLogicalRange({ from, to: shown.length + 6 })
        }

        // bars are on screen — dismiss loading NOW and let the [E]/⚡ markers
        // fill in asynchronously (their paginated news scan must never block
        // the first paint of the chart)
        setLoading(false)
        scheduleRedraw()

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
              scheduleRedraw()
            }
          } catch { /* markers optional */ }
        }
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
      // ETH (Task 59): gate state + session of the last displayed bar
      eth: () => ({
        gate: sessionGate,
        shown: ethShown,
        persisted: useTerminal.getState().showExtendedHours,
        bars: barsRef.current.length,
        lastBarSession: barsRef.current.length ? sessionOf(barsRef.current[barsRef.current.length - 1].time) : null,
        extBarCount: barsRef.current.filter((b) => sessionOf(b.time) === 'extended').length,
      }),
      ind: () => {
        const b = indSeriesRef.current
        if (!b) return null
        const slots = Object.entries(b)
          .filter(([k, v]) => k !== 'settings' && k !== 'lastPts' && v != null)
          .map(([k]) => k)
        return { slots, lastPts: { ...b.lastPts } }
      },
      indScales: () => {
        const probe = (id: string) => {
          try { return chart.priceScale(id).options().scaleMargins ?? null } catch { return null }
        }
        return { right: probe('right'), vol: probe('vol'), rsi: probe('rsi'), macd: probe('macd') }
      },
      oldestBarTime: () => barsRef.current[0]?.time ?? null,
      lastBarTime: () => barsRef.current[barsRef.current.length - 1]?.time ?? null,
      lastBar: () => {
        const b = barsRef.current[barsRef.current.length - 1]
        return b ? { ...b } : null
      },
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
      // lw-charts 4.2.3 teardown race: destroy() only cancels the paint rAF
      // that was planned BEFORE remove() — but any invalidation that lands
      // during/after the teardown (resize events as the chart's DOM leaves
      // the layout) still schedules a fresh paint, and that late paint reads
      // the DISPOSED fancy-canvas binding and throws an uncaught "Object is
      // disposed" (Next dev overlay pops a Runtime Error and the chart looks
      // broken — seen on every ETH toggle because showExtendedHours
      // recreates this effect). Neuter the dying instance's paint scheduler
      // before remove(): nothing post-destroy can schedule a paint anymore,
      // anything already queued is canceled inside remove(). NB the widget
      // method alone is NOT enough — ChartModel captured a `.bind()` copy of
      // it at construction, so the MODEL's stored handler must be replaced
      // too. Property names are pinned by the exact 4.2.3 dependency.
      const dying = chart as unknown as {
        _private__chartWidget?: {
          _private__invalidateHandler?: unknown
          _private__model?: { _private__invalidateHandler?: unknown }
        }
      }
      const dyingWidget = dying._private__chartWidget
      if (dyingWidget) {
        const dyingModel = dyingWidget._private__model
        if (dyingModel && typeof dyingModel._private__invalidateHandler === 'function') {
          dyingModel._private__invalidateHandler = () => {}
        }
        if (typeof dyingWidget._private__invalidateHandler === 'function') {
          dyingWidget._private__invalidateHandler = () => {}
        }
      }
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      volSeriesRef.current = null
      barsRef.current = []
      markersRef.current = { earnings: [], news: [] }
      axisIconsRef.current = []
    }
  }, [symbol, tf, chartType, settingsVer, scheduleRedraw, sessionGate, showExtendedHours])

  // ---------- technical indicators: series lifecycle ----------
  // lightweight-charts v4 has no real multi-pane support: SMA/EMA/BB are line
  // overlays on the price scale, RSI/MACD are dedicated price scales squeezed
  // into stacked bottom strips (price · volume · RSI · MACD). This effect owns
  // series creation/destroy on config or chart change; the effect after it
  // refills DATA whenever bars change. Declared AFTER the chart effect so a
  // live chart always exists when it runs.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = ind

    const destroyBundle = (b: IndSeriesBundle | null) => {
      indSeriesRef.current = null
      if (!b) return
      for (const ser of [b.sma, b.ema, b.bbU, b.bbM, b.bbL, b.rsi, b.macdLine, b.macdSig, b.macdHist]) {
        if (!ser) continue
        try { chart.removeSeries(ser) } catch { /* chart already disposed */ }
      }
    }
    destroyBundle(indSeriesRef.current)
    // restore chart-creation margins (the config below overrides when needed)
    try {
      chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.24 } })
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    } catch { /* chart disposed */ }
    indStripsRef.current = { price: { top: 0.1, bottom: 0.24 }, vol: { top: 0.82, bottom: 0 } }

    const bundle: IndSeriesBundle = { settings: s, lastPts: {} }
    const overlayOpts = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as const
    try {
      if (s.sma.enabled) bundle.sma = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, ...overlayOpts })
      if (s.ema.enabled) bundle.ema = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, ...overlayOpts })
      if (s.bb.enabled) {
        bundle.bbU = chart.addLineSeries({ color: 'rgba(232,121,249,0.8)', lineWidth: 1, ...overlayOpts })
        bundle.bbM = chart.addLineSeries({ color: 'rgba(232,121,249,0.55)', lineWidth: 1, lineStyle: LineStyle.Dashed, ...overlayOpts })
        bundle.bbL = chart.addLineSeries({ color: 'rgba(232,121,249,0.8)', lineWidth: 1, ...overlayOpts })
      }
      if (s.rsi.enabled) {
        bundle.rsi = chart.addLineSeries({
          priceScaleId: 'rsi', color: '#f472b6', lineWidth: 1, ...overlayOpts, crosshairMarkerVisible: true,
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        })
        bundle.rsi.createPriceLine({ price: 70, color: 'rgba(113,113,122,0.55)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
        bundle.rsi.createPriceLine({ price: 30, color: 'rgba(113,113,122,0.55)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      }
      if (s.macd.enabled) {
        bundle.macdHist = chart.addHistogramSeries({ priceScaleId: 'macd', lastValueVisible: false, priceLineVisible: false })
        bundle.macdLine = chart.addLineSeries({ priceScaleId: 'macd', color: '#f59e0b', lineWidth: 1, ...overlayOpts, crosshairMarkerVisible: true })
        bundle.macdSig = chart.addLineSeries({ priceScaleId: 'macd', color: '#a78bfa', lineWidth: 1, ...overlayOpts, crosshairMarkerVisible: true })
        bundle.macdLine.createPriceLine({ price: 0, color: 'rgba(113,113,122,0.55)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      }
      // squeeze price/volume upward when oscillator strips are enabled
      if (s.rsi.enabled || s.macd.enabled) {
        const m = stripMargins(s.rsi.enabled, s.macd.enabled)
        chart.priceScale('right').applyOptions({ scaleMargins: m.price })
        chart.priceScale('vol').applyOptions({ scaleMargins: m.vol })
        if (m.rsi) chart.priceScale('rsi').applyOptions({ scaleMargins: m.rsi })
        if (m.macd) chart.priceScale('macd').applyOptions({ scaleMargins: m.macd })
        indStripsRef.current = { price: m.price, vol: m.vol, rsi: m.rsi, macd: m.macd }
      } else {
        indStripsRef.current = { price: { top: 0.1, bottom: 0.24 }, vol: { top: 0.82, bottom: 0 } }
      }
      indSeriesRef.current = bundle
      fillIndData(bundle)
      scheduleRedraw() // strips changed → repaint separators/titles immediately
    } catch { /* chart disposed mid-setup */ }

    return () => {
      destroyBundle(indSeriesRef.current)
    }
  }, [symbol, tf, chartType, settingsVer, ind, fillIndData, scheduleRedraw])

  // indicators: refill data whenever bars change (initial load / scroll-back
  // prepend) — series lifecycle is owned by the effect above
  useEffect(() => {
    const b = indSeriesRef.current
    if (b) fillIndData(b)
  }, [ind, indDataVer, fillIndData])

  // load drawings for this symbol
  useEffect(() => {
    void loadDrawings(symbol)
  }, [symbol, loadDrawings])

  // ---------- live streaming ticks (stream-service via socket.io) ----------
  // Applies a stream tick to the chart: mutate the last bar intra-period, or
  // ROLL A NEW BAR once the tick's timestamp crosses the bar boundary (the
  // chart previously stayed pinned on one bar forever between reloads).
  const applyTick = (t: StreamTick) => {
    liveAtRef.current = Date.now()
    setLiveBadge('live') // every streamed tick is REAL — the SIM generator was permanently removed
    const bars = barsRef.current
    const s = seriesRef.current
    if (bars.length === 0 || !s) return
    const lastB = bars[bars.length - 1]
    const tfSec = TIMEFRAMES[tf].seconds
    const aligned = Math.floor(t.t / tfSec) * tfSec
    // ETH off (Task 59): stock intraday charts show the regular session only —
    // pre/post-market ticks must not roll or mutate RTH bars (quote still moves)
    if (sessionGate && !showExtendedHours && sessionOf(aligned) !== 'regular') {
      // skip bar mutation entirely — the header quote update below still runs
    } else if (aligned > lastB.time) {
      const nb: Bar = {
        time: aligned,
        open: lastB.close,
        high: Math.max(lastB.close, t.p),
        low: Math.min(lastB.close, t.p),
        close: t.p,
        volume: 0,
      }
      barsRef.current = [...bars, nb]
      const upd =
        chartType === 'candles'
          ? { time: nb.time as UTCTimestamp, open: nb.open, high: nb.high, low: nb.low, close: nb.close }
          : { time: nb.time as UTCTimestamp, value: nb.close }
      s.update(upd as CandlestickData<Time> | LineData<Time>)
      volSeriesRef.current?.update({ time: nb.time as UTCTimestamp, value: 0, color: 'rgba(34,197,94,0.35)' })
      scheduleRedraw()
      updateIndicatorsLast()
    } else if (lastB.close !== t.p || t.p > lastB.high || t.p < lastB.low) {
      const high = Math.max(lastB.high, t.p)
      const low = Math.min(lastB.low, t.p)
      const bar =
        chartType === 'candles'
          ? { time: lastB.time as UTCTimestamp, open: lastB.open, high, low, close: t.p }
          : { time: lastB.time as UTCTimestamp, value: t.p }
      s.update(bar as CandlestickData<Time> | LineData<Time>)
      barsRef.current = [...bars.slice(0, -1), { ...lastB, close: t.p, high, low }]
      scheduleRedraw()
      updateIndicatorsLast()
    }
    // header quote — recompute change vs the REST-known previous close
    setQuote((q) => {
      if (!q) return q
      const change = q.prevClose != null ? t.p - q.prevClose : q.change
      const changePct = q.prevClose ? (change / q.prevClose) * 100 : q.changePct
      return { ...q, price: t.p, change, changePct }
    })
  }
  const applyTickRef = useRef(applyTick)
  applyTickRef.current = applyTick

  // coalesce stream bursts to ≤4 renders/s per pane (8-pane grids stay smooth)
  useEffect(() => {
    const iv = setInterval(() => {
      const t = pendingTickRef.current
      if (t) {
        pendingTickRef.current = null
        applyTickRef.current(t)
      }
      // expire the LIVE badge when the stream goes quiet (>6s)
      if (liveAtRef.current && Date.now() - liveAtRef.current > 6000 && !pendingTickRef.current) {
        liveAtRef.current = 0
        setLiveBadge((b) => (b == null ? b : null))
      }
    }, 250)
    return () => clearInterval(iv)
  }, [])

  // subscribe this pane's symbol to the shared stream socket
  useEffect(() => {
    pendingTickRef.current = null
    return subscribeStream([symbol], (t) => {
      pendingTickRef.current = t
    })
  }, [symbol])

  // Remote control for the MOBILE shell (Task 56): the floating bottom toolbar
  // opens this panel's INTERNAL states — symbol search, indicators popover,
  // trade ticket — and sets the drawing color / chart type (tool + timeframe
  // live in the shared store, the rest is local). Desktop never dispatches
  // these events.
  const onChartTypeChangeRef = useRef(onChartTypeChange)
  onChartTypeChangeRef.current = onChartTypeChange
  useEffect(() => {
    const onSearch = () => setSearchOpen(true)
    const onIndicators = () => setIndOpen((v) => !v)
    const onSr = () => setSrOpen(true)
    const onAdvisor = () => setAdvisorOpen(true)
    const onTicket = () => {
      setTicketPrefill(null)
      setTradeOpen(true)
    }
    const onColor = (e: Event) => {
      const c = (e as CustomEvent).detail
      if (typeof c === 'string' && (DRAW_COLORS as readonly string[]).includes(c)) setActiveColor(c)
    }
    const onChartType = (e: Event) => {
      const t = (e as CustomEvent).detail
      if (t === 'candles' || t === 'line') {
        setChartType(t) // the internal state drives the series re-creation
        onChartTypeChangeRef.current?.(t)
      }
    }
    // mobile More sheet "Extended trading hours" row (Task 59)
    const onToggleEth = () => {
      const st = useTerminal.getState()
      st.setShowExtendedHours(!st.showExtendedHours)
    }
    window.addEventListener('tt:open-symbol-search', onSearch)
    window.addEventListener('tt:toggle-indicators', onIndicators)
    window.addEventListener('tt:open-sr', onSr)
    window.addEventListener('tt:open-advisor', onAdvisor)
    window.addEventListener('tt:open-ticket', onTicket)
    window.addEventListener('tt:set-color', onColor)
    window.addEventListener('tt:set-chart-type', onChartType)
    window.addEventListener('tt:toggle-eth', onToggleEth)
    return () => {
      window.removeEventListener('tt:open-symbol-search', onSearch)
      window.removeEventListener('tt:toggle-indicators', onIndicators)
      window.removeEventListener('tt:open-sr', onSr)
      window.removeEventListener('tt:open-advisor', onAdvisor)
      window.removeEventListener('tt:open-ticket', onTicket)
      window.removeEventListener('tt:set-color', onColor)
      window.removeEventListener('tt:set-chart-type', onChartType)
      window.removeEventListener('tt:toggle-eth', onToggleEth)
    }
  }, [])

  // quote polling (10s) — REST fallback that keeps prevClose/OHLC fresh while
  // the websocket stream provides the fast price path (skipped while ticks
  // are flowing so a cached REST snapshot never yanks the streamed price back)
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
          const fresh = liveAtRef.current && Date.now() - liveAtRef.current < 8000
          if (!fresh) {
            setQuote({ price: q.price, changePct: q.changePct, change: q.change, prevClose: q.prevClose })
            const bars = barsRef.current
            const s = seriesRef.current
            // ETH off (Task 59): don't stamp the live (possibly post-market)
            // price onto the last REGULAR-session bar in RTH-only mode
            if (bars.length > 0 && s && json.meta?.demo !== true && !(sessionGate && !showExtendedHours && sessionOf(bars[bars.length - 1].time) !== 'regular')) {
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
              updateIndicatorsLast()
            }
          } else {
            // stream is live — only refresh the prev-close anchor + change basis
            setQuote((prev) =>
              prev
                ? { ...prev, prevClose: q.prevClose }
                : { price: q.price, changePct: q.changePct, change: q.change, prevClose: q.prevClose },
            )
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
  }, [symbol, chartType, scheduleRedraw, sessionGate, showExtendedHours])

  const up = (quote?.changePct ?? 0) >= 0
  const indActiveCount = indicatorsActive(ind)

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative h-full w-full select-none overflow-hidden [-webkit-touch-callout:none]',
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
        <div className="pointer-events-auto flex min-w-0 max-w-[150px] items-center gap-0.5 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5 terminal-scroll sm:max-w-none">
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
        <div className="pointer-events-auto hidden items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5 sm:flex">
          <button
            className={cn('rounded px-1.5 py-1', chartType === 'candles' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300')}
            onClick={() => { setChartType('candles'); onChartTypeChange?.('candles') }}
            aria-label="Candlesticks"
          >
            <CandleIcon className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn('rounded px-1.5 py-1', chartType === 'line' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300')}
            onClick={() => { setChartType('line'); onChartTypeChange?.('line') }}
            aria-label="Line"
          >
            <LineIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="pointer-events-auto">
          <Popover open={indOpen} onOpenChange={setIndOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  'flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors',
                  indOpen
                    ? 'border-zinc-700 bg-zinc-800 text-emerald-400'
                    : indActiveCount > 0
                      ? 'border-zinc-800 bg-zinc-900/80 text-emerald-400'
                      : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:text-zinc-200',
                )}
                aria-label="Indicators"
                aria-expanded={indOpen}
                title="Indicators"
              >
                <Sigma className="h-3.5 w-3.5" />
                ƒx
                {indActiveCount > 0 && (
                  <Badge variant="outline" className="ml-0.5 border-emerald-500/40 px-1 text-[9px] text-emerald-400">
                    {indActiveCount}
                  </Badge>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="max-h-[70vh] w-[320px] overflow-y-auto border-zinc-800 bg-zinc-950/95 p-2.5 text-xs text-zinc-200 backdrop-blur-sm">
              <div className="flex items-center justify-between px-1.5 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Indicators</span>
                <button
                  className="text-[10px] text-zinc-500 transition-colors hover:text-zinc-300"
                  onClick={() => setInd(() => DEFAULT_INDICATORS)}
                >
                  Reset
                </button>
              </div>
              <div className="px-1.5 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">Overlays</div>
              <div className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-zinc-900/70">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Switch checked={ind.sma.enabled} onCheckedChange={(v) => setInd((p) => ({ ...p, sma: { ...p.sma, enabled: v } }))} aria-label="Toggle SMA" />
                    <span className="font-medium text-amber-500">SMA</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-zinc-500">
                    length
                    <NumField label="SMA length" value={ind.sma.period} min={2} max={500} onCommit={(v) => setInd((p) => ({ ...p, sma: { ...p.sma, period: v } }))} />
                  </label>
                </div>
              </div>
              <div className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-zinc-900/70">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Switch checked={ind.ema.enabled} onCheckedChange={(v) => setInd((p) => ({ ...p, ema: { ...p.ema, enabled: v } }))} aria-label="Toggle EMA" />
                    <span className="font-medium text-violet-400">EMA</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-zinc-500">
                    length
                    <NumField label="EMA length" value={ind.ema.period} min={2} max={500} onCommit={(v) => setInd((p) => ({ ...p, ema: { ...p.ema, period: v } }))} />
                  </label>
                </div>
              </div>
              <div className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-zinc-900/70">
                <div className="flex items-center gap-2">
                  <Switch checked={ind.bb.enabled} onCheckedChange={(v) => setInd((p) => ({ ...p, bb: { ...p.bb, enabled: v } }))} aria-label="Toggle Bollinger Bands" />
                  <span className="font-medium text-fuchsia-400">Bollinger Bands</span>
                </div>
                <div className="mt-1 flex items-center justify-end gap-3 text-zinc-500">
                  <label className="flex items-center gap-1.5">
                    length
                    <NumField label="BB length" value={ind.bb.period} min={2} max={500} onCommit={(v) => setInd((p) => ({ ...p, bb: { ...p.bb, period: v } }))} />
                  </label>
                  <label className="flex items-center gap-1.5">
                    mult
                    <NumField label="BB standard deviation multiplier" value={ind.bb.mult} min={0.5} max={10} step={0.5} onCommit={(v) => setInd((p) => ({ ...p, bb: { ...p.bb, mult: v } }))} />
                  </label>
                </div>
              </div>
              <div className="px-1.5 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">Oscillators</div>
              <div className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-zinc-900/70">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Switch checked={ind.rsi.enabled} onCheckedChange={(v) => setInd((p) => ({ ...p, rsi: { ...p.rsi, enabled: v } }))} aria-label="Toggle RSI" />
                    <span className="font-medium text-pink-400">RSI</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-zinc-500">
                    length
                    <NumField label="RSI length" value={ind.rsi.period} min={2} max={200} onCommit={(v) => setInd((p) => ({ ...p, rsi: { ...p.rsi, period: v } }))} />
                  </label>
                </div>
              </div>
              <div className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-zinc-900/70">
                <div className="flex items-center gap-2">
                  <Switch checked={ind.macd.enabled} onCheckedChange={(v) => setInd((p) => ({ ...p, macd: { ...p.macd, enabled: v } }))} aria-label="Toggle MACD" />
                  <span className="font-medium text-amber-500">MACD</span>
                </div>
                <div className="mt-1 flex items-center justify-end gap-2 text-zinc-500">
                  <label className="flex items-center gap-1.5">
                    fast
                    <NumField label="MACD fast" value={ind.macd.fast} min={1} max={200} onCommit={(v) => setInd((p) => ({ ...p, macd: { ...p.macd, fast: v } }))} />
                  </label>
                  <label className="flex items-center gap-1.5">
                    slow
                    <NumField label="MACD slow" value={ind.macd.slow} min={2} max={400} onCommit={(v) => setInd((p) => ({ ...p, macd: { ...p.macd, slow: v } }))} />
                  </label>
                  <label className="flex items-center gap-1.5">
                    signal
                    <NumField label="MACD signal" value={ind.macd.signal} min={1} max={200} onCommit={(v) => setInd((p) => ({ ...p, macd: { ...p.macd, signal: v } }))} />
                  </label>
                </div>
              </div>
              <div className="mt-1 border-t border-zinc-800/80 px-1.5 pt-1.5 text-[10px] leading-4 text-zinc-600">
                Saved automatically · applies to every chart
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="pointer-events-auto">
          <Popover open={srOpen} onOpenChange={setSrOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  'flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors',
                  srOpen
                    ? 'border-zinc-700 bg-zinc-800 text-emerald-400'
                    : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:text-zinc-200',
                )}
                aria-label="Auto support resistance"
                aria-expanded={srOpen}
                title="Auto support/resistance lines (≥ N touches)"
              >
                <AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />
                S/R
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-[272px] border-zinc-800 bg-zinc-950/95 p-3 text-xs text-zinc-200 backdrop-blur-sm">
              <div className="flex items-center justify-between px-0.5 pb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Auto S/R lines</span>
                <AlignHorizontalJustifyCenter className="h-3.5 w-3.5 text-zinc-600" />
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">History</span>
                  <label className="flex items-center gap-1.5 text-zinc-500">
                    last
                    <NumField label="S/R lookback days" value={srDays} min={30} max={3000} onCommit={(v) => setSrDays(Math.min(3000, Math.max(30, Math.round(v))))} />
                    days
                  </label>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Min touches</span>
                  <NumField label="S/R minimum touches" value={srMinTouches} min={2} max={10} onCommit={(v) => setSrMinTouches(Math.min(10, Math.max(2, Math.round(v))))} />
                </div>
                <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 p-2">
                  <div className="pb-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">Timeframes</div>
                  {([
                    { on: 'd' as const, label: '1D', color: '#ef4444' },
                    { on: 'h4' as const, label: '4H', color: '#f59e0b' },
                    { on: 'h1' as const, label: '1H', color: '#22c55e' },
                  ]).map(({ on, label, color }) => (
                    <label key={on} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 transition-colors hover:bg-zinc-900/70">
                      <Checkbox
                        checked={srTfs[on]}
                        onCheckedChange={(v) => setSrTfs((p) => ({ ...p, [on]: v === true }))}
                        aria-label={`Include ${label} S/R lines`}
                        className="h-3.5 w-3.5 border-zinc-700"
                      />
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
                      <span className="font-medium text-zinc-300">{label}</span>
                    </label>
                  ))}
                </div>
                <label className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Replace previous auto lines</span>
                  <Switch checked={srReplace} onCheckedChange={setSrReplace} aria-label="Replace previous auto S/R lines" />
                </label>
                <div className="flex items-center gap-2 pt-0.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 border-zinc-800 px-2 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    disabled={srBusy}
                    onClick={() => { void removeAutoSr().then((n) => toast({ title: n > 0 ? `Removed ${n} auto S/R line${n === 1 ? '' : 's'}` : 'No auto S/R lines on this chart' })) }}
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 flex-1 gap-1 bg-emerald-500 px-2 text-[11px] font-semibold text-zinc-950 hover:bg-emerald-400"
                    disabled={srBusy}
                    onClick={() => void runAutoSr()}
                  >
                    {srBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    {srBusy ? 'Analyzing…' : 'Draw S/R'}
                  </Button>
                </div>
                <div className="text-[9px] leading-4 text-zinc-600">
                  Levels with ≥ N touches, max 6 per timeframe · red 1D / yellow 4H / green 1H · lines are normal drawings (drag, alarm, delete).
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="ml-auto flex items-center gap-2 pr-1">
          {sessionGate && !compact && (
            <button
              onClick={() => setShowExtendedHoursStore(!showExtendedHours)}
              title="Extended trading hours — show pre/post-market bars (Alt+Shift+E)"
              aria-label="Extended trading hours"
              aria-pressed={showExtendedHours}
              className={cn(
                'pointer-events-auto rounded border px-1.5 py-0.5 text-[10px] font-semibold transition-colors',
                ethShown
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-zinc-800 bg-zinc-900/80 text-zinc-500 hover:text-zinc-300',
              )}
            >
              ETH
            </button>
          )}
          {liveBadge && (
            <span
              title="Streaming live prices (websocket)"
              className="hidden items-center gap-1 rounded-full border border-emerald-500/40 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400 sm:inline-flex"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              LIVE
            </span>
          )}
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

      {/* drawing toolbar — semi-transparent so values behind stay visible (Task 14 #4).
          Hidden on mobile (Task 56): the shell's draw sheet drives the same tools
          from the floating bottom toolbar. */}
      <div className="absolute left-2 top-12 z-30 hidden flex-col gap-0.5 rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-1 opacity-40 backdrop-blur-sm transition-opacity hover:opacity-100 focus-within:opacity-100 sm:flex">
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
        <button
          title="Trade Advisor — high-score S/R + fib golden-pocket plan (limit order, any time)"
          aria-label="Trade Advisor"
          aria-pressed={advisorOpen}
          onClick={() => setAdvisorOpen((v) => !v)}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            advisorOpen ? 'bg-amber-500/25 text-amber-400' : 'text-zinc-300 hover:bg-amber-500/15 hover:text-amber-400',
          )}
        >
          <Lightbulb className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 my-0.5 h-px bg-zinc-800" />
        {(
          [
            { tool: 'cursor' as const, icon: MousePointer2, label: 'Cursor (pan/zoom)' },
            { tool: 'hline' as const, icon: Minus, label: 'Horizontal line' },
            { tool: 'vline' as const, icon: ArrowUpDown, label: 'Vertical line' },
            { tool: 'trend' as const, icon: TrendingUp, label: 'Trend line (2 clicks)' },
            { tool: 'fib' as const, icon: Ruler, label: 'Fib retracement (2 clicks)' },
            { tool: 'rect' as const, icon: Square, label: 'Rectangle (2 clicks)' },
            { tool: 'text' as const, icon: Type, label: 'Text (click to place)' },
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
          onClick={() => setShowDrawingsStore(!showDrawings)}
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
        indicators={ind}
        timeframe={tf}
        alerts={symbolAlerts}
        onAddAlert={(price, pane) => void addAlertAtPrice(price, pane)}
        onAddIndicatorAlarm={(req) => void addIndicatorAlarm(req)}
        onAddTrendAlert={(d) => void addTrendLineAlert(d)}
        onCloneDrawing={(d) => void cloneDrawing(d)}
        onAddHline={(pane, value) => {
          void createDrawing('hline', [{ time: null, price: value, pane }])
        }}
        onTrade={(side, price) => {
          // right-click price => limit order AT that price
          setTicketPrefill({ side, price, type: 'limit' })
          setTicketSeq((s) => s + 1) // remount: apply prefill even if already open
          setTradeOpen(true)
        }}
        onOpenTicket={() => {
          setTicketPrefill(null)
          setTicketSeq((s) => s + 1) // fresh blank ticket
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
              setEditValue({ type: 'exit', id: hit.id, price: Number((hit.exit.trailPercent ?? 5).toFixed(2)), pctMode: true, exit: { info: hit.exit, kind: hit.part } })
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
            if (d?.kind === 'hline') setEditValue({ type: 'drawing', id: d.id, price: d.points[0].price, pane: d.points[0]?.pane ?? 'price' })
          }
        }}
        onPatchDrawing={patchDrawing}
        onDeleteDrawing={deleteDrawing}
        onEditText={(d) => {
          const tm = textMeta(d.meta)
          setTextEdit({ text: tm.text, fontSize: tm.fontSize, color: d.color, target: { id: d.id, symbol } })
        }}
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
          label={
            editValue.pctMode ? 'Set trail % (stop distance from price)'
            : editValue.type === 'drawing' && editValue.pane === 'rsi' ? 'Set RSI level (0-100)'
            : editValue.type === 'drawing' && editValue.pane === 'vol' ? 'Set volume level'
            : editValue.type === 'drawing' && editValue.pane === 'macd' ? 'Set MACD level'
            : undefined
          }
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
              // strip drawings: RSI levels clamp to 0-100 so an edited line
              // stays inside the oscillator's range
              const v = editValue.pane === 'rsi' ? Math.min(100, Math.max(0, price)) : price
              const d = (useTerminal.getState().drawingsBySymbol[symbol] || []).find((dd) => dd.id === editValue.id)
              if (d) void patchDrawing(d.id, { points: d.points.map((p, i) => (i === 0 ? { ...p, price: v } : p)) })
            }
            setEditValue(null)
          }}
        />
      )}

      {/* text annotation editor (create / edit) */}
      {textEdit && (
        <TextEditPopover
          initial={{ text: textEdit.text, fontSize: textEdit.fontSize, color: textEdit.color }}
          onCancel={() => setTextEdit(null)}
          onSave={({ text, fontSize, color }) => {
            const te = textEdit
            setTextEdit(null)
            if (!te) return
            if (te.create) {
              void createDrawing('text', [{ time: te.create.time, price: te.create.price, pane: te.create.pane }], { meta: { text, fontSize }, color })
            } else if (te.target) {
              void patchDrawing(te.target.id, { meta: { text, fontSize }, color })
            }
          }}
        />
      )}

      {/* trade ticket (paper / live via Alpaca Trading API) */}
      {tradeOpen && (
        <TradeTicket
          key={ticketSeq}
          symbol={symbol}
          livePrice={quote?.price ?? null}
          prefill={ticketPrefill}
          onClose={() => setTradeOpen(false)}
          onPlaced={() => void posData.refresh()}
        />
      )}

      {/* trade advisor (Task 82): high-score HTF S/R + fib golden pocket →
          limit-order plan with live monitoring + line cleanup */}
      {advisorOpen && (
        <TradeAdvisor
          key={symbol}
          symbol={symbol}
          livePrice={quote?.price ?? null}
          onClose={() => setAdvisorOpen(false)}
          createDrawing={createDrawing}
          deleteDrawing={deleteDrawing}
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
  menu, onClose, container, symbol, posData, indicators, timeframe, alerts,
  onAddAlert, onAddIndicatorAlarm, onAddTrendAlert, onCloneDrawing, onAddHline, onTrade, onOpenTicket,
  onEditValue, onEditText, onPatchDrawing, onDeleteDrawing, onPatchAlert, onDeleteAlert,
  onPatchExit, onAddExit, onCancelExit, onCancelPending, onClosePosition,
}: {
  menu: MenuState
  onClose: () => void
  container: HTMLElement | null
  symbol: string
  posData: { positions: { symbol: string; tradeSymbol: string; qty: number; side: string; avgEntry: number }[]; exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }> } | null
  indicators: IndicatorSettings
  timeframe: Timeframe
  alerts: Alert[]
  onAddAlert: (price: number, pane?: DrawingPane) => void
  onAddIndicatorAlarm: (req: { kind: 'rsi' | 'macd'; label: string; params: Record<string, number>; direction?: 'above' | 'below'; price?: number; condition?: string }) => void
  onAddTrendAlert: (d: Drawing) => void
  onCloneDrawing: (d: Drawing) => void
  onAddHline: (pane: DrawingPane, value: number) => void
  onTrade: (side: 'buy' | 'sell', price?: number) => void
  onOpenTicket: () => void
  onEditValue: (hit: SceneHit) => void
  onEditText: (d: Drawing) => void
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
  const left = Math.max(4, Math.min(menu.x + 4, w - 230))
  const top = Math.max(4, Math.min(menu.y + 4, h - 320))
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
    // a drawing line lives in the pane its point was placed in — "Add alert"
    // offers the matching alarm kind (RSI level / MACD level / price); volume
    // has no alarm kind so the item is hidden there
    const alertPoint = d.kind === 'hline' ? d.points[0] : d.points[d.points.length - 1]
    const alertPane = alertPoint?.pane ?? 'price'
    const alertValue = alertPoint?.price ?? 0
    // price-pane trend lines alert on the LINE itself (dynamic level that
    // follows the drawing) instead of a static endpoint price
    const isPriceTrend = d.kind === 'trend' && alertPane === 'price'
    const lineAlert = isPriceTrend
      ? alerts.find((a) => a.kind === 'trend' && a.params?.drawingId === d.id && a.status !== 'triggered')
      : undefined
    // auto S/R lines (Task 58) carry their touch count in meta — show it in the
    // menu header so the user can see WHY the level was drawn
    const srMeta = (d.meta ?? null) as { auto?: unknown; touches?: unknown } | null
    const srTag = srMeta?.auto === 'sr' && typeof srMeta.touches === 'number'
      ? ` · S/R · ${srMeta.touches} touches`
      : ''
    return (
      <div
        className="absolute z-40 w-56 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {KIND_LABEL[d.kind]}{srTag}
          {d.kind === 'hline' && alertPane !== 'price' ? ` · ${alertPane.toUpperCase()} ${fmtPaneValue(alertPane, alertValue)}` : ''}
        </div>
        {d.kind !== 'vline' && d.kind !== 'text' && alertPane !== 'vol' && !isPriceTrend && (
          <MenuItem
            label={
              <span className="flex items-center gap-1.5">
                <BellPlus className="h-3.5 w-3.5 text-amber-400" />
                {alertPane === 'rsi'
                  ? `Add RSI alarm at ${fmtPaneValue(alertPane, alertValue)}`
                  : alertPane === 'macd'
                    ? `Add MACD alarm at ${fmtPaneValue(alertPane, alertValue)}`
                    : `Add alert at ${fmtPrice(alertValue)}`}
              </span>
            }
            onClick={() => {
              onAddAlert(alertValue, alertPane)
              onClose()
            }}
          />
        )}
        {isPriceTrend && (lineAlert ? (
          <>
            <div className="px-3 py-1 text-[10px] leading-snug text-zinc-500">
              🔔 Line alert {lineAlert.status === 'paused' ? 'paused' : 'active'} — fires when price crosses{' '}
              {lineAlert.direction === 'above' ? 'UP' : 'DOWN'} the line
            </div>
            <MenuItem label="🔔 Delete line alert" danger onClick={() => { void onDeleteAlert(lineAlert.id); onClose() }} />
          </>
        ) : (
          <MenuItem
            label={
              <span className="flex items-center gap-1.5">
                <BellPlus className="h-3.5 w-3.5 text-amber-400" />
                Add alert on line
              </span>
            }
            onClick={() => {
              onAddTrendAlert(d)
              onClose()
            }}
          />
        ))}
        <MenuItem label="⧉ Clone drawing" onClick={() => { onCloneDrawing(d); onClose() }} />
        {d.kind === 'hline' && (
          <MenuItem label="✏️ Change value…" onClick={() => { onEditValue(drawingHit); onClose() }} />
        )}
        {d.kind === 'text' && (
          <MenuItem label="✏️ Edit text…" onClick={() => { onEditText(d); onClose() }} />
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
    const held = hit.exit.status === 'held'
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
          {held && <span className="text-amber-400"> · armed</span>}
        </div>
        {held && (
          <div className="mx-2 mb-1 rounded bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-400" role="note">
            Armed OCO leg — this leg activates automatically when the sibling fills; edit it after it becomes active. Canceling it would tear down the whole OCO family.
          </div>
        )}
        {isTrail ? (
          <MenuItem label="✏️ Change trail %…" disabled={held} onClick={() => { onEditValue(hit); onClose() }} />
        ) : (
          <MenuItem label="✏️ Change value…" disabled={held} onClick={() => { onEditValue(hit); onClose() }} />
        )}
        <MenuItem
          label="🧾 Trade ticket…"
          onClick={() => { onOpenTicket(); onClose() }}
        />
        <div className="my-1 h-px bg-zinc-800" />
        <MenuItem label={`🗑 Cancel ${hit.part.toUpperCase()} order`} danger disabled={held} onClick={() => { onCancelExit(hit.exit.orderId); onClose() }} />
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
    // pane-aware menu: inside a strip the pointed value is an RSI level /
    // volume / MACD value — alarms and hlines use THAT value, not the price
    // the main scale extrapolates at the same pixel
    const pane = menu.pane ?? 'price'
    const pv = menu.paneValue ?? null
    const rsiLvl = pane === 'rsi' && pv != null ? Math.min(99, Math.max(1, Math.round(pv * 100) / 100)) : null
    const macdLvl = pane === 'macd' && pv != null ? Math.round(pv * 10000) / 10000 : null
    const hlineValue = pane === 'price' ? price : pv
    return (
      <div
        className="absolute z-40 w-60 rounded-md border border-zinc-700/80 bg-zinc-900 py-1 text-xs shadow-xl"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {symbol}
          {pane === 'price'
            ? price != null ? ` · ${fmtPrice(price)}` : ''
            : pv != null ? ` · ${pane === 'rsi' ? 'RSI ' : pane === 'vol' ? 'VOL ' : 'MACD '}${fmtPaneValue(pane, pv)}` : ''}
        </div>
        {pane === 'price' && price != null && (
          <MenuItem
            label={<span className="flex items-center gap-1.5"><BellPlus className="h-3.5 w-3.5 text-amber-400" /> Add price alert at {fmtPrice(price)}</span>}
            onClick={() => { onAddAlert(price); onClose() }}
          />
        )}
        {(indicators.rsi.enabled || indicators.macd.enabled) && (
          <>
            <div className="my-1 h-px bg-zinc-800" />
            {indicators.rsi.enabled && (
              rsiLvl != null ? (
                // right-click INSIDE the RSI strip: the alarm level follows the
                // RSI value the cursor points at (not the fixed 70/30)
                <>
                  <MenuItem
                    label={<span className="text-pink-300">🔔 RSI({indicators.rsi.period}) crosses above {rsiLvl.toFixed(2)}</span>}
                    onClick={() => {
                      onAddIndicatorAlarm({ kind: 'rsi', label: `RSI(${indicators.rsi.period}) crosses above ${rsiLvl.toFixed(2)}`, params: { period: indicators.rsi.period }, direction: 'above', price: rsiLvl })
                      onClose()
                    }}
                  />
                  <MenuItem
                    label={<span className="text-pink-300">🔔 RSI({indicators.rsi.period}) crosses below {rsiLvl.toFixed(2)}</span>}
                    onClick={() => {
                      onAddIndicatorAlarm({ kind: 'rsi', label: `RSI(${indicators.rsi.period}) crosses below ${rsiLvl.toFixed(2)}`, params: { period: indicators.rsi.period }, direction: 'below', price: rsiLvl })
                      onClose()
                    }}
                  />
                </>
              ) : (
                <>
                  <MenuItem
                    label={<span className="text-pink-300">🔔 RSI({indicators.rsi.period}) crosses above 70</span>}
                    onClick={() => {
                      onAddIndicatorAlarm({ kind: 'rsi', label: `RSI(${indicators.rsi.period}) crosses above 70`, params: { period: indicators.rsi.period }, direction: 'above', price: 70 })
                      onClose()
                    }}
                  />
                  <MenuItem
                    label={<span className="text-pink-300">🔔 RSI({indicators.rsi.period}) crosses below 30</span>}
                    onClick={() => {
                      onAddIndicatorAlarm({ kind: 'rsi', label: `RSI(${indicators.rsi.period}) crosses below 30`, params: { period: indicators.rsi.period }, direction: 'below', price: 30 })
                      onClose()
                    }}
                  />
                </>
              )
            )}
            {indicators.macd.enabled && (
              macdLvl != null ? (
                // right-click INSIDE the MACD strip: level alarms at the
                // pointed MACD value
                <>
                  <MenuItem
                    label={<span className="text-amber-300">🔔 MACD({indicators.macd.fast},{indicators.macd.slow},{indicators.macd.signal}) crosses above {fmtSigned(macdLvl)}</span>}
                    onClick={() => {
                      const m = indicators.macd
                      onAddIndicatorAlarm({ kind: 'macd', label: `MACD(${m.fast},${m.slow},${m.signal}) crosses above ${fmtSigned(macdLvl)}`, params: { fast: m.fast, slow: m.slow, signal: m.signal }, condition: 'cross_above', price: macdLvl })
                      onClose()
                    }}
                  />
                  <MenuItem
                    label={<span className="text-amber-300">🔔 MACD({indicators.macd.fast},{indicators.macd.slow},{indicators.macd.signal}) crosses below {fmtSigned(macdLvl)}</span>}
                    onClick={() => {
                      const m = indicators.macd
                      onAddIndicatorAlarm({ kind: 'macd', label: `MACD(${m.fast},${m.slow},${m.signal}) crosses below ${fmtSigned(macdLvl)}`, params: { fast: m.fast, slow: m.slow, signal: m.signal }, condition: 'cross_below', price: macdLvl })
                      onClose()
                    }}
                  />
                </>
              ) : (
                <>
                  <MenuItem
                    label={<span className="text-amber-300">🔔 MACD({indicators.macd.fast},{indicators.macd.slow},{indicators.macd.signal}) bull crossover</span>}
                    onClick={() => {
                      const m = indicators.macd
                      onAddIndicatorAlarm({ kind: 'macd', label: `MACD(${m.fast},${m.slow},${m.signal}) bull crossover`, params: { fast: m.fast, slow: m.slow, signal: m.signal }, condition: 'bull_cross' })
                      onClose()
                    }}
                  />
                  <MenuItem
                    label={<span className="text-amber-300">🔔 MACD({indicators.macd.fast},{indicators.macd.slow},{indicators.macd.signal}) bear crossover</span>}
                    onClick={() => {
                      const m = indicators.macd
                      onAddIndicatorAlarm({ kind: 'macd', label: `MACD(${m.fast},${m.slow},${m.signal}) bear crossover`, params: { fast: m.fast, slow: m.slow, signal: m.signal }, condition: 'bear_cross' })
                      onClose()
                    }}
                  />
                </>
              )
            )}
            <div className="px-3 pb-1 text-[10px] text-zinc-600">alarms use this chart's timeframe ({TIMEFRAMES[timeframe]?.label ?? timeframe}) and indicator settings</div>
          </>
        )}
        {hlineValue != null && (
          <MenuItem
            label={pane === 'price' ? '─ Horizontal line here' : `─ Horizontal line at ${fmtPaneValue(pane, hlineValue)}`}
            onClick={() => { onAddHline(pane, hlineValue); onClose() }}
          />
        )}
        <div className="my-1 h-px bg-zinc-800" />
        {pane === 'price' && price != null && (
          <MenuItem
            label={<span className="text-emerald-400">🟢 Buy limit @ {fmtPrice(price)}</span>}
            onClick={() => { onTrade('buy', price); onClose() }}
          />
        )}
        {pane === 'price' && price != null && (
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

function MenuItem({ label, onClick, danger, disabled }: { label: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      className={cn(
        'flex w-full items-center px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800',
        danger && 'text-rose-400 hover:text-rose-300',
        disabled && 'pointer-events-none opacity-40',
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

/** Text annotation editor (Task 51): type the content, pick a font size and
 *  color, live preview, Enter/Apply commits. Empty text = cancel. */
function TextEditPopover({
  initial, onSave, onCancel,
}: {
  initial: { text: string; fontSize: number; color: string }
  onSave: (v: { text: string; fontSize: number; color: string }) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial.text)
  const [fontSize, setFontSize] = useState(initial.fontSize)
  const [color, setColor] = useState(initial.color)
  const commit = () => {
    const t = text.trim()
    if (!t) return
    onSave({ text: t, fontSize, color })
  }
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <button className="absolute inset-0 bg-black/40" onClick={onCancel} aria-label="Cancel" />
      <div className="relative w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <p className="mb-2 text-xs font-medium text-zinc-300">{initial.text ? 'Edit text' : 'Add text'}</p>
        <Input
          autoFocus
          value={text}
          maxLength={120}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="Type the annotation…"
          aria-label="Text content"
          className="border-zinc-700 bg-zinc-950 text-sm"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Size</span>
          <select
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            aria-label="Font size"
            className="h-7 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 text-xs text-zinc-200"
          >
            {TEXT_SIZES.map((s) => (
              <option key={s} value={s}>{s}px</option>
            ))}
          </select>
          <span className="ml-1 text-[10px] uppercase tracking-wider text-zinc-500">Color</span>
          <div className="flex items-center gap-1">
            {DRAW_COLORS.map((c) => (
              <button
                key={c}
                aria-label={`Text color ${c}`}
                className={cn('h-4 w-4 rounded-full', color === c && 'ring-2 ring-white/70')}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        {/* live preview — same font stack/weight the canvas renderer uses */}
        <div className="mt-3 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5">
          <span className="block truncate font-semibold" style={{ fontSize, color }}>
            {text || 'Preview'}
          </span>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
          <Button size="sm" className="h-7 bg-emerald-500 text-xs text-zinc-950 hover:bg-emerald-400" disabled={!text.trim()} onClick={commit}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  )
}
