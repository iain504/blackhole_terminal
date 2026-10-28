'use client'

// Market-status indicator shown next to the symbol on every chart (Task 35).
//
//   ● green (pulsing) — US regular trading hour
//   ☀ yellow sun      — US pre-market (04:00 → open ET)
//   ☾ purple moon     — US post/after-hours (close → 20:00 ET)
//   ○ dim dot         — closed (overnight / weekend / holiday / halted)
//   ● green (steady)  — crypto, 24/7 open (verified via Alpaca asset status)
//
// States come from POST /api/market/hours (Alpaca clock + calendar + asset
// status, server-cached 30s). This badge polls every 60s and shares one
// in-flight request + 50s tab-level cache across all chart panes, so a 4-pane
// grid hits the API once per poll, not four times.
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { MarketHoursResponse, MarketStatusEntry } from '@/lib/market-types'

type Pack = { entry: MarketStatusEntry; demo: boolean; at: number }

const TTL_MS = 50_000
const POLL_MS = 60_000

// tab-level cache — one fetch per symbol per TTL regardless of pane count
const cache = new Map<string, Pack>()
const inflight = new Map<string, Promise<Pack | null>>()

async function fetchEntry(symbol: string): Promise<Pack | null> {
  const hit = cache.get(symbol)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  const running = inflight.get(symbol)
  if (running) return running
  const p = (async () => {
    try {
      const res = await fetch('/api/market/hours', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols: [symbol] }),
      })
      if (!res.ok) return null
      const json = (await res.json()) as MarketHoursResponse
      const entry = json.hours?.[symbol]
      if (!entry) return null
      const pack: Pack = { entry, demo: json.meta?.demo === true, at: Date.now() }
      cache.set(symbol, pack)
      return pack
    } catch {
      return null
    } finally {
      inflight.delete(symbol)
    }
  })()
  inflight.set(symbol, p)
  return p
}

export function MarketStatusBadge({ symbol }: { symbol: string }) {
  const [pack, setPack] = useState<Pack | null>(() => cache.get(symbol) ?? null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const p = await fetchEntry(symbol)
      if (p && alive) setPack(p)
    }
    load()
    const iv = setInterval(load, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [symbol])

  if (!pack) return <span className="inline-block h-2 w-2" aria-hidden /> // stable width — no header jump on first paint

  const { entry, demo } = pack
  const aria = `${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`
  const extra = demo || entry.estimated ? ' · estimate (live Alpaca check unavailable)' : ''

  let visual: React.ReactNode
  switch (entry.state) {
    case 'regular': // GREEN LIGHT — pulsing
      visual = (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      )
      break
    case 'open24': // crypto 24/7 — steady green
      visual = <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
      break
    case 'pre': // YELLOW SUNLIGHT
      visual = <Sun className="h-3 w-3 text-amber-400" strokeWidth={2.5} aria-hidden />
      break
    case 'post': // PURPLE MOON
      visual = <Moon className="h-3 w-3 text-purple-400" strokeWidth={2.5} aria-hidden />
      break
    default: // closed
      visual = <span className="inline-block h-2 w-2 rounded-full border border-zinc-500 bg-zinc-700/60" aria-hidden />
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={`Market status: ${aria}`} className="ml-0.5 inline-flex cursor-default items-center align-middle">
          {visual}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] border-zinc-800 bg-zinc-900 text-zinc-200">
        <div className="text-xs">
          <div className="font-semibold">{entry.label}</div>
          {entry.detail && <div className="text-zinc-400">{entry.detail}</div>}
          {extra && <div className="mt-0.5 text-[10px] text-zinc-500">{extra.trim()}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
