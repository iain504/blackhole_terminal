'use client'

// Heat Map tab — finviz-style NESTED squarified TREEMAP: each SECTOR is a big
// square sized by its total heat, and inside it each stock is a small square
// whose AREA is proportional to its own "heat" (|daily % change|, floored so
// flat names stay clickable). Color is green/red by sign and intensity.
// Sectors can be filtered via the multi-select; tiles are still clickable and
// select the symbol in the terminal store (switches to the chart).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTerminal } from '@/store/terminal'
import { FilterMultiSelect } from './FilterMultiSelect'

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

/** weight of one tile in the treemap (heat-sized mode) */
function heatWeight(t: HeatTile, sized: boolean): number {
  return sized ? Math.max(Math.abs(t.pct), 0.08) : 1
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
        // MUST advance the cursor: using `x` here stacked EVERY tile of a
        // horizontal row on the same left edge (overlapping tiles) — the
        // vertical branch correctly uses `cy`, this one now uses `cx`.
        out[it.i] = { x: cx, y, w: rw, h: rh }
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

/* ------------------------------------------------------ nested treemap ---- */

interface NestedTile { tile: HeatTile; rect: Rect }
interface NestedSector {
  group: HeatGroup
  rect: Rect
  labelH: number
  tiles: NestedTile[]
}

/**
 * Lays out the visible sectors as big squares (sized by total group heat)
 * inside the full map rect, then lays each sector's stocks out inside its
 * rect below a small label strip. Classic finviz "map within the map".
 */
function buildNestedLayout(groups: HeatGroup[], width: number, height: number, sized: boolean): NestedSector[] | null {
  if (width <= 0 || height <= 0 || groups.length === 0) return null
  const sectorWeights = groups.map((g) =>
    g.symbols.reduce((s, t) => s + heatWeight(t, sized), 0),
  )
  const sectorRects = squarify(sectorWeights, { x: 0, y: 0, w: width, h: height })
  return groups.map((g, i) => {
    const rect = sectorRects[i]
    // label strip only fits on reasonably large sector squares
    const labelH = rect.w >= 96 && rect.h >= 48 ? 16 : 0
    const inner: Rect = {
      x: rect.x + 2,
      y: rect.y + 2 + labelH,
      w: Math.max(0, rect.w - 4),
      h: Math.max(0, rect.h - 4 - labelH),
    }
    const weights = g.symbols.map((t) => heatWeight(t, sized))
    const rects = squarify(weights, inner)
    return {
      group: g,
      rect,
      labelH,
      tiles: g.symbols.map((tile, j) => ({ tile, rect: rects[j] })),
    }
  })
}

function NestedHeatmap({ groups, sized }: { groups: HeatGroup[]; sized: boolean }) {
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

  // map height adapts to the viewport: compact on phones, tall on desktop
  const height = width < 560 ? 460 : width < 1024 ? 560 : 660

  const layout = useMemo(
    () => buildNestedLayout(groups, width, height, sized),
    [groups, sized, width, height],
  )

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none"
      style={{ height }}
      role="grid"
      aria-label="Nested sector heat map"
    >
      {layout ? (
        <>
          {/* big sector squares (under the stock tiles) */}
          {layout.map(({ group, rect, labelH }) => (
            <div
              key={`sec-${group.name}`}
              aria-label={`Sector ${group.name}, ${group.symbols.length} symbols`}
              style={{
                position: 'absolute',
                left: Math.round(rect.x) + 1,
                top: Math.round(rect.y) + 1,
                width: Math.max(0, Math.round(rect.w) - 2),
                height: Math.max(0, Math.round(rect.h) - 2),
              }}
              className="rounded-md border border-zinc-600/70 bg-zinc-900/60"
            >
              {labelH > 0 && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-1.5 truncate rounded-t-md bg-zinc-950/75 px-1.5 text-[10px] font-semibold text-zinc-300 backdrop-blur-[1px]"
                  style={{ height: labelH }}
                >
                  <span className="truncate">{group.name}</span>
                  <span className="shrink-0 tabular-nums text-zinc-500">{group.symbols.length}</span>
                </div>
              )}
            </div>
          ))}
          {/* small stock tiles (coordinates are relative to the outer wrap) */}
          {layout.flatMap(({ tiles }) =>
            tiles.map(({ tile, rect }) => <TreeTile key={tile.symbol} tile={tile} rect={rect} />),
          )}
        </>
      ) : (
        <Skeleton className="h-full w-full rounded-md bg-zinc-800/70" />
      )}
    </div>
  )
}

function SkeletonMap() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-[140px] w-full rounded-md bg-zinc-800" />
      <Skeleton className="h-[240px] w-full rounded-md bg-zinc-800/80" />
      <Skeleton className="h-[180px] w-full rounded-md bg-zinc-800" />
    </div>
  )
}

export default function HeatmapTab() {
  const [data, setData] = useState<HeatmapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [sized, setSized] = useState(true) // heat-sized treemap vs equal grid
  // sector filter — set of INCLUDED sector names; kept in sync on refresh
  const [sectorSel, setSectorSel] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/market/heatmap', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as HeatmapData
      setData(json)
      setError(null)
      setUpdatedAt(Date.now())
      // register any NEW sectors, keep the user's exclusions untouched
      setSectorSel((prev) => {
        const next = new Set(prev)
        for (const g of [...(json.us ?? []), ...(json.crypto ?? [])]) next.add(g.name)
        return next
      })
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

  const allGroups = data ? [...(data.us ?? []), ...(data.crypto ?? [])] : []
  const sectorOptions = useMemo(
    () => allGroups.map((g) => ({ value: g.name, label: g.name, count: g.symbols?.length ?? 0 })),
    [allGroups],
  )
  const visibleGroups = useMemo(
    () => allGroups.filter((g) => sectorSel.has(g.name) && (g.symbols?.length ?? 0) > 0),
    [allGroups, sectorSel],
  )
  const filtersActive = sectorOptions.length > 0 && visibleGroups.length < allGroups.filter((g) => (g.symbols?.length ?? 0) > 0).length

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
          {/* sector filter */}
          <FilterMultiSelect
            label="Sectors"
            options={sectorOptions}
            selected={sectorSel}
            onChange={setSectorSel}
          />
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
                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                !sized ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200',
              )}
              title="Equal-size tiles"
            >
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

      {/* Scrollable content — ONE nested map: big sector squares, small stock
          squares inside them */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto p-3 sm:p-4',
          '[scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent]',
          '[&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2',
          '[&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700',
          'hover:[&::-webkit-scrollbar-thumb]:bg-zinc-600',
        )}
      >
        {data && visibleGroups.length > 0 ? (
          <NestedHeatmap groups={visibleGroups} sized={sized} />
        ) : data && filtersActive ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-xs text-zinc-500">All sectors are filtered out.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSectorSel(new Set(sectorOptions.map((o) => o.value)))}
              className="h-7 border-zinc-800 bg-zinc-900 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              Show all sectors
            </Button>
          </div>
        ) : data ? (
          <p className="py-16 text-center text-xs text-zinc-500">No heat map data available.</p>
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
          <SkeletonMap />
        )}
      </div>

      {/* footer hint */}
      <div className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/60 px-3 text-[10px] text-zinc-500">
        <span>
          Tile area ∝ {sized ? 'heat (|daily %|)' : 'equal'} · click a tile to chart it
          {filtersActive ? ` · ${visibleGroups.length}/${allGroups.length} sectors` : ''}
        </span>
        <span className="hidden sm:inline">Auto-refreshes every 60 s</span>
      </div>
    </div>
  )
}
