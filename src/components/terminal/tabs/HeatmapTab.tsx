'use client'

// Heat Map tab — finviz-style squarified TREEMAP: tile AREA is proportional to
// the "heat" (|daily % change|, floored so flat names stay clickable), color is
// green/red by sign and intensity. Toggle between heat-sized and equal tiles.
// Clicking a tile selects the symbol in the terminal store (switches to chart).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTerminal } from '@/store/terminal'

interface HeatTile {
  symbol: string
  pct: number
  price: number
}

interface HeatGroup {
  name: string
  symbols: HeatTile[]
}

interface HeatmapData {
  us: HeatGroup[]
  crypto: HeatGroup[]
  demo: boolean
}

const REFRESH_MS = 60_000

// Map |pct| (capped at 3%) to a green/red background between 15% and 85% opacity.
function tileBackground(pct: number): string {
  const t = Math.min(Math.abs(pct) / 3, 1)
  const alpha = 0.18 + t * 0.72
  return pct >= 0
    ? `rgba(16, 185, 129, ${alpha.toFixed(3)})`
    : `rgba(244, 63, 94, ${alpha.toFixed(3)})`
}

function formatPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  if (price >= 1) return price.toFixed(2)
  return price.toFixed(4)
}

/* ------------------------------------------------- squarified treemap ---- */

interface Rect { x: number; y: number; w: number; h: number }

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): lays out items whose AREA is
 * proportional to `weights` inside `rect`, keeping tile aspect ratios close to
 * square. Returns one rect per weight (same order).
 */
function squarify(weights: number[], rect: Rect): Rect[] {
  const total = weights.reduce((s, w) => s + w, 0)
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) {
    return weights.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }))
  }
  const scale = (rect.w * rect.h) / total
  // index order by area desc (better aspect ratios), remember original index
  const items = weights
    .map((w, i) => ({ a: Math.max(w, 1e-6) * scale, i }))
    .sort((p, q) => q.a - p.a)

  const out: Rect[] = new Array(weights.length)
  let { x, y, w, h } = rect
  let k = 0 // cursor into sorted items
  while (k < items.length) {
    const shortSide = Math.min(w, h)
    // grow a row while it improves the worst aspect ratio
    const row: typeof items = [items[k]]
    let rowArea = items[k].a
    k += 1
    const worst = (rs: typeof items, area: number) => {
      const side = area / shortSide // thickness of the row
      let worstRatio = 0
      for (const it of rs) {
        const thickness = it.a / side
        const ratio = Math.max(side / thickness, thickness / side)
        if (ratio > worstRatio) worstRatio = ratio
      }
      return worstRatio
    }
    while (k < items.length) {
      // standard squarified test: does adding the next item improve the worst
      // aspect ratio of the row? (each row compared at its OWN total area)
      const currentWorst = worst(row, rowArea)
      const nextWorst = worst([...row, items[k]], rowArea + items[k].a)
      if (nextWorst <= currentWorst) {
        row.push(items[k])
        rowArea += items[k].a
        k += 1
      } else break
    }
    // lay the row along the shorter side
    if (w >= h) {
      const rw = rowArea / h
      let cy = y
      for (const it of row) {
        const rh = it.a / rw
        out[it.i] = { x, y: cy, w: rw, h: rh }
        cy += rh
      }
      x += rw
      w -= rw
    } else {
      const rh = rowArea / w
      let cx = x
      for (const it of row) {
        const rw = it.a / rh
        out[it.i] = { x, y, w: rw, h: rh }
        cx += rw
      }
      y += rh
      h -= rh
    }
  }
  return out
}

/* --------------------------------------------------------- tile component */

function TreeTile({ tile, rect }: { tile: HeatTile; rect: Rect }) {
  const big = rect.w >= 92 && rect.h >= 46
  const mid = rect.w >= 54 && rect.h >= 30
  const tiny = rect.w < 44 || rect.h < 20
  return (
    <button
      type="button"
      onClick={() => useTerminal.getState().selectSymbol(tile.symbol)}
      title={`${tile.symbol}  ${formatPct(tile.pct)}  ·  ${formatPrice(tile.price)} — click to chart`}
      aria-label={`${tile.symbol} ${formatPct(tile.pct)}`}
      style={{
        position: 'absolute',
        left: Math.round(rect.x),
        top: Math.round(rect.y),
        width: Math.max(0, Math.round(rect.w) - 2),
        height: Math.max(0, Math.round(rect.h) - 2),
        backgroundColor: tileBackground(tile.pct),
      }}
      className={cn(
        'cursor-pointer select-none overflow-hidden rounded-[4px] border border-black/30 text-left',
        'transition-[filter,box-shadow] duration-150 hover:z-10 hover:brightness-125 hover:shadow-md hover:ring-1 hover:ring-white/50',
        'focus-visible:z-10 outline-none focus-visible:ring-2 focus-visible:ring-white/70',
      )}
    >
      <span className={cn('block w-full truncate px-1 pt-0.5 font-bold leading-tight text-white', tiny ? 'text-[9px]' : mid ? 'text-[11px]' : 'text-xs')}>
        {tile.symbol}
      </span>
      {mid && <span className={cn('block w-full truncate px-1 font-semibold leading-tight text-white/95', big ? 'text-xs' : 'text-[10px]')}>{formatPct(tile.pct)}</span>}
      {big && <span className="block w-full truncate px-1 text-[10px] leading-tight text-white/70">{formatPrice(tile.price)}</span>}
    </button>
  )
}

function TreemapGroup({ group, sized, height }: { group: HeatGroup; sized: boolean; height: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rects = useMemo(() => {
    if (width <= 0) return null
    const syms = [...group.symbols].sort(
      (a, b) => Math.abs(b.pct) - Math.abs(a.pct),
    )
    const weights = syms.map((s) => (sized ? Math.max(Math.abs(s.pct), 0.08) : 1))
    return { syms, rects: squarify(weights, { x: 0, y: 0, w: width, h: height }) }
  }, [group.symbols, sized, width, height])

  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-zinc-400">
        {group.name}
        <span className="rounded border border-zinc-800 px-1 py-px text-[10px] font-normal text-zinc-600">
          {group.symbols.length}
        </span>
      </h3>
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        {rects ? (
          rects.syms.map((s, i) => (
            <TreeTile key={s.symbol} tile={s} rect={rects.rects[i]} />
          ))
        ) : (
          <div className="h-full w-full animate-pulse rounded-md bg-zinc-800/60" />
        )}
      </div>
    </section>
  )
}

function SkeletonGrid() {
  const groups = [8, 8, 8, 8, 8, 6, 8, 8]
  return (
    <div className="space-y-6">
      {groups.map((n, gi) => (
        <div key={gi}>
          <Skeleton className="mb-2 h-3 w-28 bg-zinc-800" />
          <Skeleton className="h-[260px] w-full rounded-md bg-zinc-800/70" />
          <span className="sr-only">{n} tiles</span>
        </div>
      ))}
    </div>
  )
}

export default function HeatmapTab() {
  const [data, setData] = useState<HeatmapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [sized, setSized] = useState(true) // heat-sized treemap vs equal grid

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/market/heatmap', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as HeatmapData
      setData(json)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + auto-refresh every 60s.
  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const groups = data ? [...(data.us ?? []), ...(data.crypto ?? [])] : []

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-zinc-100">Market Heat Map</h2>
          {data?.demo && (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-400"
            >
              Demo data
            </Badge>
          )}
          {error && data && (
            <span className="hidden text-[11px] text-rose-400/80 sm:inline">update failed — retrying</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* treemap sizing toggle */}
          <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5">
            <button
              onClick={() => setSized(true)}
              aria-pressed={sized}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                sized ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200',
              )}
              title="Tile size proportional to |daily change| (heat)"
            >
              Heat size
            </button>
            <button
              onClick={() => setSized(false)}
              aria-pressed={!sized}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                !sized ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200',
              )}
              title="Equal-size tiles"
            >
              <LayoutGrid className="h-3 w-3" />
              Equal
            </button>
          </div>
          {updatedAt && (
            <span className="hidden text-[11px] tabular-nums text-zinc-500 md:inline">
              Updated {new Date(updatedAt).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            className="h-7 gap-1.5 border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div
        className={cn(
          'min-h-0 flex-1 space-y-5 overflow-y-auto p-4',
          '[scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent]',
          '[&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2',
          '[&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700',
          'hover:[&::-webkit-scrollbar-thumb]:bg-zinc-600',
        )}
      >
        {data ? (
          groups.map((group) =>
            group.symbols?.length ? (
              <TreemapGroup key={group.name} group={group} sized={sized} height={group.symbols.length > 8 ? 300 : 240} />
            ) : null,
          )
        ) : error ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-rose-400">Failed to load heat map{error ? ` (${error})` : ''}.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              className="h-8 gap-1.5 border-zinc-800 bg-zinc-900 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Retry
            </Button>
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </div>
    </div>
  )
}
