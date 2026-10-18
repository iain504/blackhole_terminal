'use client'

// Interactive chart: lightweight-charts + transparent overlay canvas for
// drawings (hline/vline/trend/fib) and alert lines. Lines stay draggable &
// resizable after drawing, with right-click context menus (Task 14 #1/#4,
// Task 16 #4/#5/#6). Earnings [E] + news ⚡ markers on the time axis.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle, UTCTimestamp, Time,
  IChartApi, ISeriesApi, MouseEventParams,
} from 'lightweight-charts'
import { useTerminal, Drawing, DrawingKind, DrawingPoint, DRAW_COLORS, Tab } from '@/store/terminal'
import { useShallow } from 'zustand/react/shallow'
import { TIMEFRAMES, fmtPrice, isCryptoSymbol, Bar } from '@/lib/market-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  MousePointer2, Minus, ArrowUpDown, TrendingUp, Ruler, Eye, EyeOff, Trash2,
  ChevronDown, CandlestickChart as CandleIcon, LineChart as LineIcon, Loader2, BellPlus,
} from 'lucide-react'
import { SymbolSearchDialog } from './SymbolSearchDialog'

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

type Hit =
  | { type: 'drawing'; id: string; part: 'whole' | 'point'; index?: number }
  | { type: 'alert'; id: string; part: 'whole' }

interface MenuState {
  x: number
  y: number
  hit: Hit
}

const KIND_LABEL: Record<DrawingKind, string> = {
  hline: 'Horizontal line',
  vline: 'Vertical line',
  trend: 'Trend line',
  fib: 'Fib retracement',
}

const EMPTY_DRAWINGS: Drawing[] = []

export function ChartPanel({ tab }: { tab: Tab }) {
  const symbol = tab.symbol
  const tf = tab.timeframe

  // store
  const setTabSymbol = useTerminal((s) => s.setTabSymbol)
  const setTabTimeframe = useTerminal((s) => s.setTabTimeframe)
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
  const dragRef = useRef<{
    hit: Hit
    x0: number
    y0: number
    orig: { time: number | null; price: number }[]
    origPixels: ({ x: number; y: number } | null)[]
    moved: boolean
  } | null>(null)
  const draftRef = useRef<{ kind: DrawingKind; p1: DrawingPoint; p2: DrawingPoint } | null>(null)
  const rafRef = useRef(0)

  // ui state
  const [loading, setLoading] = useState(true)
  const [demo, setDemo] = useState(false)
  const [demoReason, setDemoReason] = useState<string | undefined>(undefined)
  const [settingsVer, setSettingsVer] = useState(0)
  const [chartType, setChartType] = useState<'candles' | 'line'>('candles')
  const [quote, setQuote] = useState<{ price: number; changePct: number; change: number } | null>(null)
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; v: number } | null>(null)
  const [showDrawings, setShowDrawings] = useState(true)
  const [activeColor, setActiveColor] = useState(DRAW_COLORS[4])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editValue, setEditValue] = useState<{ type: 'drawing' | 'alert'; id: string; price: number } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  const drawings = useTerminal(useShallow((s) => s.drawingsBySymbol[symbol] ?? EMPTY_DRAWINGS))
  const symbolAlerts = useTerminal(useShallow((s) => s.alerts.filter((a) => a.symbol === symbol)))

  // Refetch market data when credentials change in Settings (save/test keys)
  useEffect(() => {
    const onChanged = () => setSettingsVer((v) => v + 1)
    window.addEventListener('tt:settings-changed', onChanged)
    return () => window.removeEventListener('tt:settings-changed', onChanged)
  }, [])

  // ---------- coordinate helpers ----------
  const xOf = useCallback((t: number | null): number | null => {
    if (t == null || !chartRef.current) return null
    const x = chartRef.current.timeScale().timeToCoordinate(t as UTCTimestamp)
    return x == null ? null : Number(x)
  }, [])

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

  // time at x, extrapolating beyond the data range
  const timeAt = useCallback((x: number): number | null => {
    if (!chartRef.current) return null
    const ts = chartRef.current.timeScale()
    const t = ts.coordinateToTime(x)
    if (t != null) return Number(t)
    const logical = ts.coordinateToLogical(x)
    const bars = barsRef.current
    if (logical == null || bars.length === 0) return null
    const tfSec = TIMEFRAMES[tf].seconds
    return Number(bars[bars.length - 1].time + (Number(logical) - (bars.length - 1)) * tfSec)
  }, [tf])

  const scheduleRedraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      renderOverlay()
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

  function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, highlighted: boolean) {
    ctx.save()
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
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText(text, x + 6, by + 11.5)
    ctx.restore()
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
  }, [drawings, symbolAlerts, showDrawings, drawingTool, activeColor, scheduleRedraw])

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

  const hitTest = useCallback((x: number, y: number): Hit | null => {
    const st = useTerminal.getState()
    const ds = st.drawingsBySymbol[symbol] || []
    const als = st.alerts.filter((a) => a.symbol === symbol && a.status !== 'triggered')

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
      if (hit) {
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
          origPixels = orig.map((p) => pixelPoint(p))
        } else {
          const a = st.alerts.find((aa) => aa.id === hit.id)
          if (!a) return
          orig = [{ time: null, price: a.price }]
          origPixels = [{ x: 0, y: yOf(a.price) ?? y }]
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
            if (!op) return { ...p }
            let time = oo.time
            let price = oo.price
            if (d.kind !== 'hline') {
              const nt = timeAt(op.x + dx)
              if (nt != null) time = nt
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
          if (!drag || !drag.moved) {
            scheduleRedraw()
            return
          }
          const store = useTerminal.getState()
          if (drag.hit.type === 'alert') {
            const a = store.alerts.find((aa) => aa.id === drag.hit.id)
            if (a) void patchAlert(a.id, { price: a.price })
          } else {
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
      const newHover = hit ? `${hit.type}:${hit.id}` : null
      if (newHover !== hoverRef.current) {
        hoverRef.current = newHover
        scheduleRedraw()
      }
      el.style.cursor = hit ? (hit.part === 'point' ? 'nwse-resize' : 'grab') : ''
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
      if (!hit) {
        setMenu(null)
        return // browser default menu
      }
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x, y, hit })
    }

    const onDoubleClick = (e: MouseEvent) => {
      // double-click empty space near an hline edits its value quickly
      const { x, y } = rel(e)
      const hit = hitTest(x, y)
      if (!hit) return
      const st = useTerminal.getState()
      if (hit.type === 'alert') {
        const a = st.alerts.find((aa) => aa.id === hit.id)
        if (a) setEditValue({ type: 'alert', id: a.id, price: a.price })
      } else {
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
  }, [hitTest, createDrawing, patchDrawing, patchAlert, symbol, timeAt, priceAt, yOf, scheduleRedraw, setDrawingTool])

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

    let series: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>
    if (chartType === 'candles') {
      series = chart.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      })
    } else {
      series = chart.addLineSeries({ color: '#22c55e', lineWidth: 2 })
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
      if (bar && bar.close != null) {
        setLegend({
          o: bar.open ?? bar.close,
          h: bar.high ?? bar.close,
          l: bar.low ?? bar.close,
          c: bar.close,
          v: volBar?.value ?? 0,
        })
      }
    })

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/market/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`)
        if (!res.ok) throw new Error('bars fetch failed')
        const json = await res.json()
        if (cancelled) return
        setDemo(Boolean(json.meta?.demo))
        setDemoReason(json.meta?.reason as string | undefined)
        const bars: Bar[] = (json.bars as Bar[]) || []
        // dedupe + sort by time
        const map = new Map<number, Bar>()
        for (const b of bars) map.set(b.time, b)
        const clean = [...map.values()].sort((a, b) => a.time - b.time)
        barsRef.current = clean

        series.setData(
          clean.map((b) =>
            chartType === 'candles'
              ? { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close }
              : { time: b.time as UTCTimestamp, value: b.close },
          ),
        )
        vol.setData(
          clean.map((b) => ({
            time: b.time as UTCTimestamp,
            value: b.volume,
            color: b.close >= b.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
          })),
        )
        // TradingView-like: show recent window, not the whole history
        if (clean.length > 0) {
          const from = Math.max(0, clean.length - 150)
          chart.timeScale().setVisibleLogicalRange({ from, to: clean.length + 6 })
        }

        // markers: earnings [E] + news ⚡ (Task 16 #7/#8)
        if (clean.length > 0) {
          try {
            const from = clean[0].time
            const lastT = clean[clean.length - 1].time
            const mres = await fetch(`/api/market/markers?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${lastT}`)
            if (mres.ok && !cancelled) {
              const mj = await mres.json()
              type Mk = { time: UTCTimestamp; position: 'belowBar'; color: string; shape: 'square' | 'circle'; text: string; id: string }
              const markers: Mk[] = []
              for (const t of (mj.earnings as number[]) || []) {
                if (t <= lastT) markers.push({ time: t as UTCTimestamp, position: 'belowBar', color: '#f59e0b', shape: 'square', text: 'E', id: `e${t}` })
              }
              // space news markers so they don't clutter the axis; drop future ones
              const rawNews = ((mj.news as number[]) || []).filter((t: number) => t <= lastT).sort((a: number, b: number) => a - b)
              const minGap = Math.max(3600, Math.floor((lastT - from) / 25))
              const spacedNews: number[] = []
              for (const t of rawNews) {
                if (spacedNews.length === 0 || t - spacedNews[spacedNews.length - 1] >= minGap) spacedNews.push(t)
              }
              for (const t of spacedNews.slice(0, 14)) {
                markers.push({ time: t as UTCTimestamp, position: 'belowBar', color: '#e879f9', shape: 'circle', text: '⚡', id: `n${t}` })
              }
              markers.sort((a, b) => a.time - b.time)
              if (series.setMarkers) series.setMarkers(markers)
            }
          } catch { /* markers optional */ }
        }
        setLoading(false)
        scheduleRedraw()
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()

    const onRangeChange = () => scheduleRedraw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)

    return () => {
      cancelled = true
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      barsRef.current = []
    }
  }, [symbol, tf, chartType, settingsVer, scheduleRedraw])

  // load drawings for this symbol
  useEffect(() => {
    void loadDrawings(symbol)
  }, [symbol, loadDrawings])

  // quote polling (10s)
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
        if (q && alive) setQuote({ price: q.price, changePct: q.changePct, change: q.change })
      } catch { /* offline */ }
    }
    fetchQ()
    const timer = setInterval(fetchQ, 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [symbol])

  const up = (quote?.changePct ?? 0) >= 0
  const last = legend
  const tfLabel = TIMEFRAMES[tf].label

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden select-none" style={{ background: '#09090b' }}>
      {/* chart canvas is injected here by lightweight-charts */}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10" aria-hidden />

      {/* header overlay */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-10 items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/85 px-2 backdrop-blur-sm">
        <div className="pointer-events-auto flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-sm font-semibold text-zinc-100"
            onClick={() => setSearchOpen(true)}
          >
            {symbol}
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
            {isCryptoSymbol(symbol) && <Badge variant="outline" className="ml-1 border-amber-500/40 text-[9px] text-amber-400">7×24</Badge>}
          </Button>
        </div>
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5">
          {(Object.keys(TIMEFRAMES) as (keyof typeof TIMEFRAMES)[]).map((k) => (
            <button
              key={k}
              onClick={() => setTabTimeframe(tab.id, k)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
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
                  : demoReason.startsWith('alpaca-http-40')
                    ? 'Alpaca rejected the saved keys — check them in Settings'
                    : `Alpaca request failed (${demoReason}) — will retry`
              }
              className={
                demoReason && demoReason.startsWith('alpaca-http-40')
                  ? 'border-rose-500/40 text-[10px] text-rose-400'
                  : 'border-amber-500/40 text-[10px] text-amber-400'
              }
            >
              {!demoReason || demoReason === 'no-keys'
                ? 'demo'
                : demoReason.startsWith('alpaca-http-40')
                  ? 'keys rejected'
                  : 'data error'}
            </Badge>
          )}
          {quote && (
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

      {/* OHLC legend */}
      {last && (
        <div className="pointer-events-none absolute left-12 top-12 z-20 rounded bg-zinc-950/50 px-2 py-1 font-mono text-[11px] leading-4 text-zinc-300 backdrop-blur-sm">
          <div>
            <span className="font-semibold text-zinc-100">{symbol}</span>
            <span className="text-zinc-500"> · {tfLabel} · </span>
            <span className="text-zinc-500">O</span><span className={up ? 'text-emerald-400' : 'text-rose-400'}> {fmtPrice(last.o)}</span>
            <span className="text-zinc-500"> H</span><span className={up ? 'text-emerald-400' : 'text-rose-400'}> {fmtPrice(last.h)}</span>
            <span className="text-zinc-500"> L</span><span className={up ? 'text-emerald-400' : 'text-rose-400'}> {fmtPrice(last.l)}</span>
            <span className="text-zinc-500"> C</span><span className={up ? 'text-emerald-400' : 'text-rose-400'}> {fmtPrice(last.c)}</span>
          </div>
          <div className="text-zinc-500">Vol {(last.v / 1e6).toFixed(2)}M</div>
        </div>
      )}

      {/* loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/40">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
        </div>
      )}

      {/* context menu */}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} container={containerRef.current} symbol={symbol}
        onAddAlert={(price) => void addAlertAtPrice(price)}
        onEditValue={(hit) => {
          const st = useTerminal.getState()
          if (hit.type === 'alert') {
            const a = st.alerts.find((aa) => aa.id === hit.id)
            if (a) setEditValue({ type: 'alert', id: a.id, price: a.price })
          } else {
            const d = (st.drawingsBySymbol[symbol] || []).find((dd) => dd.id === hit.id)
            if (d?.kind === 'hline') setEditValue({ type: 'drawing', id: d.id, price: d.points[0].price })
          }
        }}
        onPatchDrawing={patchDrawing}
        onDeleteDrawing={deleteDrawing}
        onPatchAlert={patchAlert}
        onDeleteAlert={deleteAlert}
      />}

      {/* edit value popover */}
      {editValue && (
        <EditValuePopover
          value={editValue.price}
          onCancel={() => setEditValue(null)}
          onSave={(price) => {
            if (editValue.type === 'alert') void patchAlert(editValue.id, { price })
            else {
              const d = (useTerminal.getState().drawingsBySymbol[symbol] || []).find((dd) => dd.id === editValue.id)
              if (d) void patchDrawing(d.id, { points: d.points.map((p, i) => (i === 0 ? { ...p, price } : p)) })
            }
            setEditValue(null)
          }}
        />
      )}

      <SymbolSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={(s) => setTabSymbol(tab.id, s)}
      />
    </div>
  )
}

// ---------- context menu ----------
function ContextMenu({
  menu, onClose, container, symbol,
  onAddAlert, onEditValue, onPatchDrawing, onDeleteDrawing, onPatchAlert, onDeleteAlert,
}: {
  menu: MenuState
  onClose: () => void
  container: HTMLElement | null
  symbol: string
  onAddAlert: (price: number) => void
  onEditValue: (hit: Hit) => void
  onPatchDrawing: (id: string, patch: { color?: string }) => Promise<void>
  onDeleteDrawing: (id: string) => Promise<void>
  onPatchAlert: (id: string, patch: Record<string, unknown>) => Promise<void>
  onDeleteAlert: (id: string) => Promise<void>
}) {
  const symDrawing = menu.hit.type === 'drawing' ? (useTerminal.getState().drawingsBySymbol[symbol] || []).find((d) => d.id === menu.hit.id) : null
  const alert = menu.hit.type === 'alert' ? useTerminal.getState().alerts.find((a) => a.id === menu.hit.id) : null

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
  const top = Math.min(menu.y + 4, h - 300)

  if (menu.hit.type === 'alert' && alert) {
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
        <MenuItem label="✏️ Edit value…" onClick={() => { onEditValue(menu.hit); onClose() }} />
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

  if (menu.hit.type === 'drawing' && symDrawing) {
    const d = symDrawing
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
          <MenuItem label="✏️ Change value…" onClick={() => { onEditValue(menu.hit); onClose() }} />
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

function EditValuePopover({ value, onSave, onCancel }: { value: number; onSave: (v: number) => void; onCancel: () => void }) {
  const [v, setV] = useState(String(value))
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <button className="absolute inset-0 bg-black/40" onClick={onCancel} aria-label="Cancel" />
      <div className="relative w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <p className="mb-2 text-xs font-medium text-zinc-300">Set value</p>
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
