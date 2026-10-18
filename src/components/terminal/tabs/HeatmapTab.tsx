'use client'

// Task C-b — "Heat Map" tab: daily % change tiles for US stock sectors + crypto.
// Data: GET /api/market/heatmap → { us: HeatGroup[], crypto: HeatGroup[], demo }
// Clicking a tile selects the symbol in the terminal store (switches to chart tab).

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
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
// Green = emerald-500 rgb(16,185,129), Red = rose-500 rgb(244,63,94).
function tileBackground(pct: number): string {
  const t = Math.min(Math.abs(pct) / 3, 1)
  const alpha = 0.15 + t * 0.7 // 0.15 .. 0.85
  return pct >= 0
    ? `rgba(16, 185, 129, ${alpha.toFixed(3)})`
    : `rgba(244, 63, 94, ${alpha.toFixed(3)})`
}

function formatPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

// >=1000 → 2 decimals with thousands separators, >=1 → 2 decimals, else 4 decimals.
function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  if (price >= 1) return price.toFixed(2)
  return price.toFixed(4)
}

const GRID_CLS = 'grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8'

function HeatTileButton({ tile }: { tile: HeatTile }) {
  return (
    <button
      type="button"
      onClick={() => useTerminal.getState().selectSymbol(tile.symbol)}
      title={`${tile.symbol}  ${formatPct(tile.pct)}`}
      style={{ backgroundColor: tileBackground(tile.pct) }}
      className={cn(
        'flex min-h-[64px] cursor-pointer select-none flex-col items-center justify-center',
        'rounded-md border border-white/5 px-1 py-2 text-center',
        'transition-all duration-150 hover:z-10 hover:brightness-110 hover:ring-1 hover:ring-white/40',
        'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        'active:scale-[0.98]',
      )}
    >
      <span className="w-full truncate text-xs font-bold text-white">{tile.symbol}</span>
      <span className="mt-0.5 text-xs font-semibold text-white">{formatPct(tile.pct)}</span>
      <span className="mt-0.5 text-[10px] leading-none text-white/60">{formatPrice(tile.price)}</span>
    </button>
  )
}

function GroupSection({ group }: { group: HeatGroup }) {
  if (!group.symbols?.length) return null
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-zinc-400">
        {group.name}
        <span className="rounded border border-zinc-800 px-1 py-px text-[10px] font-normal text-zinc-600">
          {group.symbols.length}
        </span>
      </h3>
      <div className={GRID_CLS}>
        {group.symbols.map((tile) => (
          <HeatTileButton key={tile.symbol} tile={tile} />
        ))}
      </div>
    </section>
  )
}

function SkeletonGrid() {
  const groups = [8, 8, 8, 8, 8, 6, 8, 8, 8]
  return (
    <div className="space-y-6">
      {groups.map((n, gi) => (
        <div key={gi}>
          <Skeleton className="mb-2 h-3 w-28 bg-zinc-800" />
          <div className={GRID_CLS}>
            {Array.from({ length: n }).map((_, i) => (
              <Skeleton key={i} className="h-16 min-h-[64px] rounded-md bg-zinc-800/70" />
            ))}
          </div>
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
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
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
        <div className="flex shrink-0 items-center gap-3">
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
          'min-h-0 flex-1 space-y-6 overflow-y-auto p-4',
          '[scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent]',
          '[&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2',
          '[&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700',
          'hover:[&::-webkit-scrollbar-thumb]:bg-zinc-600',
        )}
      >
        {data ? (
          groups.map((group) => <GroupSection key={group.name} group={group} />)
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
