'use client'

// v2.9.0 — REAL BTC/USD chart for the landing page. Data comes from the
// public /api/landing/btc route (Binance spot klines + 24h ticker, cached
// server-side, deterministic fallback if upstream is unreachable — the route
// never fails, but it marks the source so we can badge it honestly).
// Rendered with lightweight-charts (same lib as the terminal charts).
//
//   1H · 4H · 1D · 1W selector · 60s auto-refresh · hover OHLC readout
import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { Flame, RefreshCw } from 'lucide-react'

type Tf = '1h' | '4h' | '1d' | '1w'
const TFS: { id: Tf; label: string }[] = [
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' },
]

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Snapshot {
  candles: Candle[]
  price: number
  changePct: number
  source: 'binance' | 'cache' | 'fallback'
  stale: boolean
}

const fmtUsd = (v: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function BtcChart() {
  const [tf, setTf] = useState<Tf>('1h')
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [hover, setHover] = useState<Candle | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  const load = useCallback(async (t: Tf) => {
    try {
      const res = await fetch(`/api/landing/btc?tf=${t}&limit=300`, { cache: 'no-store' })
      if (!res.ok) return
      const j = (await res.json()) as Snapshot
      if (Array.isArray(j.candles) && j.candles.length > 0) setSnap(j)
    } catch {
      /* route always answers; ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void load(tf)
    const timer = setInterval(() => {
      if (!document.hidden) void load(tf)
    }, 60_000)
    return () => clearInterval(timer)
  }, [tf, load])

  // chart lifecycle — create once, swap data on tf/refresh
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = createChart(host, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#71717a',
        fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.045)' },
        horzLines: { color: 'rgba(255,255,255,0.055)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.09)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.09)',
        timeVisible: tf === '1h' || tf === '4h',
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: false,
      width: host.clientWidth,
      height: host.clientHeight || 320,
    })
    const series = chart.addAreaSeries({
      lineColor: '#f97316',
      lineWidth: 2,
      topColor: 'rgba(249,115,22,0.38)',
      bottomColor: 'rgba(249,115,22,0.02)',
      priceLineColor: 'rgba(249,115,22,0.55)',
      priceLineStyle: 2,
    })
    series.applyOptions({ priceFormat: { type: 'price', precision: 2, minMove: 0.01 } })
    chart.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(series) as { value?: number } | undefined
      if (!param.time || d?.value == null) {
        setHover(null)
        return
      }
      // light readout: the area series carries close only — pull the full
      // candle from the snapshot for the OHLC row
      const t = param.time as number
      const c = snap?.candles.find((k) => k.time === t)
      setHover(c ?? null)
    })
    chartRef.current = chart
    seriesRef.current = series

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight || 320 })
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [tf])

  useEffect(() => {
    const series = seriesRef.current
    if (!series || !snap) return
    series.setData(snap.candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })))
    chartRef.current?.timeScale().fitContent()
  }, [snap])

  const up = (snap?.changePct ?? 0) >= 0
  const srcBadge =
    !snap
      ? null
      : snap.source === 'binance'
        ? { text: 'LIVE · Binance spot', cls: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10' }
        : snap.source === 'cache'
          ? { text: 'Delayed · cached', cls: 'text-amber-300 border-amber-400/30 bg-amber-500/10' }
          : { text: 'Demo feed · Binance unreachable', cls: 'text-zinc-300 border-zinc-500/30 bg-zinc-500/10' }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b0d12] shadow-2xl shadow-black/50">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/5 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-orange-400" aria-hidden />
          <h3 className="text-sm font-bold tracking-wide text-white">BTC / USD</h3>
          <span className="text-[11px] text-zinc-500">Binance spot · real-time</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xl font-bold tabular-nums text-white">
            {snap ? `$${fmtUsd(snap.price)}` : '—'}
          </span>
          {snap && (
            <span className={`text-sm font-semibold tabular-nums ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
              {up ? '+' : ''}
              {snap.changePct.toFixed(2)}% · 24h
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {srcBadge && (
            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide ${srcBadge.cls}`}>
              {srcBadge.text}
            </span>
          )}
          <button
            onClick={() => void load(tf)}
            aria-label="Refresh chart"
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* timeframe tabs */}
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-1.5">
        {TFS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTf(t.id)}
            aria-pressed={tf === t.id}
            className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              tf === t.id ? 'bg-orange-500/15 text-orange-300' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
        {hover && (
          <div className="ml-3 hidden items-center gap-3 font-mono text-[10px] tabular-nums text-zinc-500 sm:flex">
            <span>O {fmtUsd(hover.open)}</span>
            <span>H {fmtUsd(hover.high)}</span>
            <span>L {fmtUsd(hover.low)}</span>
            <span className={hover.close >= hover.open ? 'text-emerald-400' : 'text-rose-400'}>C {fmtUsd(hover.close)}</span>
          </div>
        )}
      </div>

      {/* chart */}
      <div ref={hostRef} className="h-[300px] w-full sm:h-[360px]" aria-label="BTC/USD price chart" role="img" />
    </div>
  )
}
