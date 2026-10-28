'use client'

// Market-status indicator (Task 35, v1.95.0): the dot lives INSIDE every
// chart pane's symbol button again (ChartPanel header, all breakpoints —
// user: "move back the market status back to the chart align with the
// symbol"). The desktop footer chip was removed.
//
//   ● green (pulsing) — US Regular Trading Hour
//   ☀ yellow sun      — US pre-market (04:00 → open ET)
//   ☾ purple moon     — US post/after-hours (close → 20:00 ET)
//   ○ dim dot         — closed (overnight / weekend / holiday / halted)
//   ● green (steady)  — crypto, 24/7 open (verified via Alpaca asset status)
//
// Tooltip: the Alpaca-sourced session detail PLUS the next open/close
// rendered in the BROWSER's timezone — the same clock the footer uses (user:
// "when mouse over the market status symbol, the clock on the hints should
// be in London time, aligned with the bottom right bar clock"), so a
// Europe/London user reads London times instead of ET.
//
// States come from POST /api/market/hours (Alpaca clock + calendar + asset
// status, server-cached 30s). The badge polls every 60s and shares one
// in-flight request + 50s tab-level cache across ALL chart panes, so a
// 4-pane grid hits the API once per poll.
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

export function MarketStatusBadge({
  symbol,
  withLabel = false,
  showSymbol = false,
}: {
  symbol: string
  withLabel?: boolean
  /** withLabel variant only — prefix the chip with the symbol (footer chip) */
  showSymbol?: boolean
}) {
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

  if (!pack) return withLabel ? null : <span className="inline-block h-2 w-2" aria-hidden /> // stable width — no header jump on first paint

  const { entry, demo } = pack
  const aria = `${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`
  const extra = demo || entry.estimated ? ' · estimate (live Alpaca check unavailable)' : ''

  // v1.95.0 — next open/close in the BROWSER's timezone (the same clock the
  // footer renders, e.g. Europe/London), so the hint's times are readable in
  // the user's own wall clock instead of Alpaca's ET. Absent when the live
  // Alpaca check failed (estimated mode) — the ET fallback strings stay.
  const localTimes = (() => {
    const parts: string[] = []
    let city = ''
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz) {
        city = tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') : tz
        const fmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        })
        if (entry.nextOpen) parts.push(`opens ${fmt.format(new Date(entry.nextOpen))}`)
        if (entry.nextClose) parts.push(`closes ${fmt.format(new Date(entry.nextClose))}`)
      }
    } catch {
      /* Intl/timezone unavailable — omit the line, ET detail still shows */
    }
    return parts.length > 0 ? { text: parts.join(' · '), city } : null
  })()

  // Task 94 — short label for the bottom-right chip variant (aligned with
  // the footer clock). Long human detail stays in the tooltip.
  const shortLabel: string =
    entry.state === 'regular' ? 'US market open'
    : entry.state === 'open24' ? '24/7 open'
    : entry.state === 'pre' ? 'Pre-market'
    : entry.state === 'post' ? 'Post-market'
    : 'Market closed'

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

  if (withLabel) {
    // chip variant — desktop footer renders it BESIDE the clock (user:
    // "align it with the clock at the bottom right"); same small-text
    // aesthetic as the clock
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={`Market status: ${symbol} — ${aria}`}
            className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-950/70 px-2 py-1 text-[10px] leading-none text-zinc-300"
          >
            {showSymbol && <span className="font-semibold text-zinc-100">{symbol}</span>}
            {visual}
            <span>{shortLabel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[300px] border-zinc-800 bg-zinc-900 text-zinc-200">
          <div className="text-xs">
            <div className="font-semibold">{symbol} — {entry.label}</div>
            {entry.detail && <div className="text-zinc-400">{entry.detail}</div>}
            {localTimes && (
              <div className="mt-0.5 text-zinc-300">Your time ({localTimes.city}): {localTimes.text}</div>
            )}
            {extra && <div className="mt-0.5 text-[10px] text-zinc-500">{extra.trim()}</div>}
          </div>
        </TooltipContent>
      </Tooltip>
    )
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
          {localTimes && (
            <div className="mt-0.5 text-zinc-300">Your time ({localTimes.city}): {localTimes.text}</div>
          )}
          {extra && <div className="mt-0.5 text-[10px] text-zinc-500">{extra.trim()}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
