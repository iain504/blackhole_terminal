'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ types */

interface CalEvent {
  time: string // ISO UTC
  country: string // currency code e.g. USD, EUR, GBP
  importance: 'high' | 'medium' | 'low' | string
  event: string
  actual: string | null
  forecast: string | null
  prior: string | null
}

type CalendarSource = 'forexfactory' | 'sample'

/* ---------------------------------------------------------------- helpers */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** "Monday, 16 Dec 2025" (local timezone) */
function formatDayHeader(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** "14:30" local time */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function normalizeImportance(v: string): 'high' | 'medium' | 'low' {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium'
}

const IMPORTANCE_DOT: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-slate-500',
}

const IMPORTANCE_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const REFRESH_INTERVAL_MS = 10 * 60 * 1000 // auto-refresh every 10 minutes

/* -------------------------------------------------------------- component */

export default function CalendarTab() {
  const [events, setEvents] = useState<CalEvent[]>([])
  const [source, setSource] = useState<CalendarSource | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/market/calendar', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`)
      const data = (await res.json()) as { events?: CalEvent[]; source?: CalendarSource }
      setEvents(Array.isArray(data.events) ? data.events : [])
      setSource(data.source === 'forexfactory' ? 'forexfactory' : 'sample')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + auto-refresh every 10 minutes
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Group events by local calendar date, sorted chronologically within each day
  const days = useMemo(() => {
    const groups = new Map<string, CalEvent[]>()
    const sorted = [...events].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    )
    for (const ev of sorted) {
      const d = new Date(ev.time)
      if (Number.isNaN(d.getTime())) continue
      const key = dayKey(d)
      const list = groups.get(key)
      if (list) list.push(ev)
      else groups.set(key, [ev])
    }
    return Array.from(groups.entries())
  }, [events])

  const now = Date.now()
  const today = dayKey(new Date())
  const hasData = events.length > 0

  return (
    <div className="flex h-full flex-col bg-zinc-950/40">
      {/* ------------------------------------------------------------ header */}
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-zinc-100">Economic Calendar</h2>
          {source && (
            <Badge
              variant="outline"
              className={cn(
                'hidden h-5 px-1.5 text-[10px] font-medium sm:inline-flex',
                source === 'forexfactory'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-zinc-700 bg-zinc-800/80 text-zinc-400',
              )}
            >
              {source === 'forexfactory' ? 'Live — ForexFactory' : 'Sample data'}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh economic calendar"
          title="Refresh"
          className="size-7 text-zinc-400 hover:text-zinc-100"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden="true" />
        </Button>
      </header>

      {/* ------------------------------------------------------------- body */}
      <div
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-zinc-700"
        role="region"
        aria-label="Economic events list"
        tabIndex={0}
      >
        {/* Loading skeleton (only when there is no data yet) */}
        {loading && !hasData && !error && (
          <div className="p-3" aria-hidden="true">
            <Skeleton className="mb-3 h-4 w-44" />
            <div className="space-y-2.5">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 border-b border-zinc-800/40 pb-2.5">
                  <Skeleton className="h-3 w-9" />
                  <Skeleton className="h-4 w-10 rounded" />
                  <Skeleton className="size-1.5 rounded-full" />
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="h-3 w-10" />
                  <Skeleton className="hidden h-3 w-10 md:block" />
                  <Skeleton className="hidden h-3 w-10 md:block" />
                </div>
              ))}
            </div>
            <span className="sr-only">Loading economic calendar…</span>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertTriangle className="size-6 text-amber-500" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Couldn&apos;t load the calendar</p>
              <p className="mt-1 max-w-xs text-xs text-zinc-500">
                {error}. The data feed may be temporarily unavailable — please try again.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Retry
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && !hasData && (
          <p className="p-8 text-center text-xs text-zinc-500">
            No economic events scheduled for the rest of this week.
          </p>
        )}

        {/* One section per day */}
        {!error &&
          hasData &&
          days.map(([key, dayEvents]) => {
            const headerDate = new Date(dayEvents[0].time)
            const label = formatDayHeader(headerDate)
            const isToday = key === today
            return (
              <section key={key} aria-labelledby={`cal-day-${key}`}>
                <h3
                  id={`cal-day-${key}`}
                  className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
                >
                  {label}
                  {isToday && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-emerald-400">
                      Today
                    </span>
                  )}
                </h3>

                <table className="w-full border-collapse text-left text-xs">
                  <caption className="sr-only">
                    Economic events on {label}. Times shown in your local timezone.
                  </caption>
                  <thead>
                    <tr className="border-b border-zinc-800/70 text-[10px] uppercase tracking-wider text-zinc-500">
                      <th scope="col" className="px-3 py-1.5 font-medium">Time</th>
                      <th scope="col" className="px-2 py-1.5 font-medium">Country</th>
                      <th scope="col" className="px-2 py-1.5 font-medium">Importance</th>
                      <th scope="col" className="px-2 py-1.5 font-medium">Event</th>
                      <th scope="col" className="px-2 py-1.5 font-medium">Actual</th>
                      <th scope="col" className="hidden px-2 py-1.5 font-medium md:table-cell">Forecast</th>
                      <th scope="col" className="hidden px-2 py-1.5 font-medium md:table-cell">Prior</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayEvents.map((ev, i) => {
                      const imp = normalizeImportance(ev.importance)
                      const high = imp === 'high'
                      const past = new Date(ev.time).getTime() < now
                      return (
                        <tr
                          key={`${ev.time}-${ev.country}-${ev.event}-${i}`}
                          className={cn(
                            'border-b border-zinc-800/50 transition-colors',
                            high
                              ? 'bg-red-500/[0.04] hover:bg-red-500/10'
                              : 'hover:bg-zinc-800/40',
                            past && 'opacity-60',
                          )}
                        >
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-zinc-400">
                            {formatTime(ev.time)}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge
                              variant="outline"
                              className="h-5 border-zinc-700 bg-zinc-800/70 px-1.5 font-mono text-[10px] tracking-wide text-zinc-300"
                            >
                              {ev.country || '—'}
                            </Badge>
                          </td>
                          <td className="px-2 py-1.5">
                            <span
                              className="inline-flex items-center"
                              title={`${IMPORTANCE_LABEL[imp]} importance`}
                            >
                              <span
                                className={cn('size-1.5 rounded-full', IMPORTANCE_DOT[imp])}
                                aria-hidden="true"
                              />
                              <span className="sr-only">{IMPORTANCE_LABEL[imp]} importance</span>
                            </span>
                          </td>
                          <td className={cn('px-2 py-1.5', high ? 'font-medium text-zinc-100' : 'text-zinc-300')}>
                            {ev.event}
                          </td>
                          <td
                            className={cn(
                              'px-2 py-1.5 font-mono',
                              ev.actual ? 'font-medium text-emerald-500' : 'text-zinc-600',
                            )}
                          >
                            {ev.actual ?? '—'}
                          </td>
                          <td className="hidden px-2 py-1.5 font-mono text-zinc-400 md:table-cell">
                            {ev.forecast ?? <span className="text-zinc-600">—</span>}
                          </td>
                          <td className="hidden px-2 py-1.5 font-mono text-zinc-400 md:table-cell">
                            {ev.prior ?? <span className="text-zinc-600">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            )
          })}
      </div>

      {/* ------------------------------------------------------------ footer */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/60 px-3 text-[10px] text-zinc-500">
        <span>Times shown in your local timezone</span>
        <span className="hidden sm:inline">Auto-refreshes every 10 min</span>
      </footer>
    </div>
  )
}
