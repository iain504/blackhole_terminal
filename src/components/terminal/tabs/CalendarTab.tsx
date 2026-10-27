'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bell, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { FilterMultiSelect } from './FilterMultiSelect'

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

/** Stable per-event key used to persist alarms: "<ISO time>|<CCY>|<title>". */
function eventKey(ev: CalEvent): string {
  return `${ev.time}|${ev.country}|${ev.event}`
}

// Importance filter values (all on by default)
type Imp = 'high' | 'medium' | 'low'
const IMP_ALL: Imp[] = ['high', 'medium', 'low']

/* ------------------------------------------------ persistent filters (31) ---
 * The user's Importance (High/Medium/Low) and Country filter choices are
 * PERMANENT: mirrored into localStorage for an instant paint and saved to
 * the account via /api/calendar/filters so they survive reloads and follow
 * the user across devices.
 *
 * Representation: importance = the ENABLED levels; country = the EXCLUDED
 * codes. Storing exclusions (not inclusions) means countries/currencies that
 * newly appear in the feed are visible automatically — only what the user
 * deliberately switched OFF stays off.
 */

const FILTERS_LS_KEY = 'tt:cal:filters'

function sanitizeImpArr(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return [...new Set(v.filter((x): x is Imp => x === 'high' || x === 'medium' || x === 'low'))]
}

function sanitizeStrArr(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 12)
}

/** Read the localStorage mirror (null fields = no saved choice yet). */
function loadLocalFilters(): { imp: string[] | null; countryExclusions: string[] | null } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Record<string, unknown>
    return { imp: sanitizeImpArr(o.imp), countryExclusions: sanitizeStrArr(o.countryExclusions) }
  } catch {
    return null
  }
}

/** Refresh the localStorage mirror (never throws — private mode etc.). */
function mirrorLocalFilters(imp: Set<string>, excl: Set<string>): void {
  try {
    localStorage.setItem(FILTERS_LS_KEY, JSON.stringify({ imp: [...imp], countryExclusions: [...excl] }))
  } catch { /* ignore */ }
}

/* -------------------------------------------------------------- component */

export default function CalendarTab() {
  const [events, setEvents] = useState<CalEvent[]>([])
  const [source, setSource] = useState<CalendarSource | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ---- filters (Task 23 #2 · PERMANENT since Task 31): importance + country ----
  // countryExcl (what the user switched OFF) is the stored truth; the included
  // set is derived from it + the countries present in the current feed, so new
  // currencies show up automatically and user exclusions are never undone.
  const [impSel, setImpSel] = useState<Set<string>>(() => {
    const l = loadLocalFilters()
    return new Set(l?.imp ?? IMP_ALL) // an empty saved array stays empty (all levels off)
  })
  const [countryExcl, setCountryExcl] = useState<Set<string>>(
    () => new Set(loadLocalFilters()?.countryExclusions ?? []),
  )

  // user-driven change → optimistic state + localStorage mirror + debounced PUT
  const touchedRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ imp: string[]; countryExclusions: string[] } | null>(null)

  const applyFilterChange = useCallback((imp: Set<string>, excl: Set<string>) => {
    setImpSel(imp)
    setCountryExcl(excl)
    touchedRef.current = true
    mirrorLocalFilters(imp, excl)
    pendingSaveRef.current = { imp: [...imp], countryExclusions: [...excl] }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const payload = pendingSaveRef.current
      pendingSaveRef.current = null
      if (!payload) return
      void fetch('/api/calendar/filters', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => { /* offline — optimistic state kept, next change re-saves */ })
    }, 600)
  }, [])

  // Flush a still-pending save when the tab unmounts.
  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const p = pendingSaveRef.current
      pendingSaveRef.current = null
      if (p) {
        void fetch('/api/calendar/filters', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(p),
        }).catch(() => { /* ignore */ })
      }
    },
    [],
  )

  // Server-side hydration (per-account permanence): the saved choice wins over
  // localStorage unless the user already interacted during this mount.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/calendar/filters', { cache: 'no-store' })
        if (!res.ok || !alive) return
        const j = (await res.json()) as { imp?: unknown; countryExclusions?: unknown }
        const imp = sanitizeImpArr(j.imp)
        const excl = sanitizeStrArr(j.countryExclusions)
        if (!imp || !excl || touchedRef.current || !alive) return
        const impSet = new Set(imp)
        const exclSet = new Set(excl)
        setImpSel(impSet)
        setCountryExcl(exclSet)
        mirrorLocalFilters(impSet, exclSet) // keep the mirror fresh
      } catch { /* offline — localStorage state stands */ }
    })()
    return () => {
      alive = false
    }
  }, [])

  // ---- event alarms (Task 28 #3): grey = off (default), colored = on ----
  const [alarms, setAlarms] = useState<Set<string>>(new Set())

  const refresh = useCallback(async (fresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/market/calendar${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`)
      const data = (await res.json()) as { events?: CalEvent[]; source?: CalendarSource }
      const evs = Array.isArray(data.events) ? data.events : []
      setEvents(evs)
      // tolerate mirror-specific sources ('forexfactory-xml' / '-json')
      setSource(data.source?.startsWith('forexfactory') ? 'forexfactory' : 'sample')
      // New countries/currencies register themselves via the derived
      // `countrySel` (known options − persisted exclusions) — the user's
      // exclusions are never undone by a refresh (Task 31).
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + auto-refresh every 10 minutes.
  // OPENING the tab always pulls FRESH ForexFactory data first (the server's
  // 15-min cache is bypassed via ?fresh=1) so the list is up to date before
  // it is shown — the skeleton covers the fetch.
  useEffect(() => {
    void refresh(true)
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Load the user's enabled alarms once
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/calendar/alarms')
        if (!res.ok || !alive) return
        const json = await res.json()
        if (alive) setAlarms(new Set((json.keys as string[]) || []))
      } catch { /* offline */ }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Optimistic toggle + persisted via /api/calendar/alarms
  const toggleAlarm = useCallback((key: string, on: boolean) => {
    setAlarms((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
    void fetch('/api/calendar/alarms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, on }),
    }).catch(() => { /* offline — optimistic state kept */ })
  }, [])

  // ---- Task 28 #4: keep the calendar fresh around event times ----
  // Ticking clock so a row's "past" state (opacity, actual column) flips the
  // moment its time passes — no refresh needed for the visual state.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  // Next event still in the future (recomputed when the events data changes).
  const nextEventTime = useMemo(() => {
    let min: number | null = null
    for (const ev of events) {
      const t = new Date(ev.time).getTime()
      if (Number.isNaN(t)) continue
      if (t > Date.now() && (min === null || t < min)) min = t
    }
    return min
  }, [events])

  // When an event's time passes, its "actual" value is published shortly
  // AFTERWARDS (the server enriches actuals from ForexFactory's calendar
  // page on each fresh fetch) — poll fresh data a few times after the
  // release: first ~60s in, then every ~90s for up to 8 minutes, stopping
  // as soon as the value shows up. The 10-min interval above still covers
  // events nobody waits on.
  useEffect(() => {
    if (nextEventTime == null) return
    const wait = Math.min(nextEventTime + 60_000 - Date.now(), REFRESH_INTERVAL_MS)
    if (wait <= 0) return
    const id = setTimeout(() => {
      void refresh(true)
      setNow(Date.now())
    }, wait)
    return () => clearTimeout(id)
  }, [nextEventTime, refresh])

  // Country filter options (sorted by event count desc, then name)
  const countryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ev of events) {
      const c = ev.country || '—'
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, count }))
  }, [events])

  // INCLUDED countries = every country in the current feed minus the user's
  // persisted exclusions (derived, so new currencies auto-register visible).
  const countrySel = useMemo(
    () => new Set(countryOptions.map((o) => o.value).filter((v) => !countryExcl.has(v))),
    [countryOptions, countryExcl],
  )

  // Apply the filters BEFORE day grouping
  const filtered = useMemo(
    () =>
      events.filter((ev) => {
        const imp = normalizeImportance(ev.importance)
        if (!impSel.has(imp)) return false
        if (ev.country && !countrySel.has(ev.country)) return false
        if (!ev.country && !countrySel.has('—')) return false
        return true
      }),
    [events, impSel, countrySel],
  )

  // Group filtered events by local calendar date, sorted chronologically within each day
  const days = useMemo(() => {
    const groups = new Map<string, CalEvent[]>()
    const sorted = [...filtered].sort(
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
  }, [filtered])

  // Red "released" divider (the line the user asked for): the FIRST event
  // whose time is still in the future. The red line renders right before its
  // row — everything ABOVE it has been released, everything BELOW is still
  // upcoming. Computed over the FILTERED days so it always sits next to a
  // visible row; moves automatically as the 15s clock ticks.
  const lineEvent = useMemo(() => {
    for (const [, list] of days) {
      for (const ev of list) {
        const t = new Date(ev.time).getTime()
        if (!Number.isNaN(t) && t >= now) return ev
      }
    }
    return null
  }, [days, now])

  const today = dayKey(new Date())
  const hasData = events.length > 0
  // active = an importance level is off OR at least one FEED country is excluded
  // (stale exclusions for countries no longer in the feed don't count)
  const filtersActive =
    impSel.size !== IMP_ALL.length || countryOptions.some((o) => countryExcl.has(o.value))
  const hiddenCount = events.length - filtered.length

  const clearAllFilters = useCallback(
    () => applyFilterChange(new Set(IMP_ALL), new Set()),
    [applyFilterChange],
  )

  return (
    <div className="flex h-full flex-col bg-zinc-950/40">
      {/* ------------------------------------------------------------ header */}
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-zinc-100">Economic Calendar</h2>
          {alarms.size > 0 && (
            <Badge
              variant="outline"
              className="hidden h-5 gap-1 px-1.5 text-[10px] font-medium text-amber-400 sm:inline-flex sm:border-amber-500/30 sm:bg-amber-500/10"
            >
              <Bell className="size-2.5" aria-hidden="true" />
              {alarms.size} alarm{alarms.size === 1 ? '' : 's'}
            </Badge>
          )}
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
          onClick={() => void refresh(true)}
          disabled={loading}
          aria-label="Refresh economic calendar"
          title="Refresh (fetches the latest ForexFactory data)"
          className="size-7 text-zinc-400 hover:text-zinc-100"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden="true" />
        </Button>
      </header>

      {/* ---------------------------------------------------- filter toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/30 px-3 py-1.5">
        {/* importance chips — click to include/exclude a level */}
        <div
          className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5"
          role="group"
          aria-label="Importance filter"
        >
          {IMP_ALL.map((imp) => {
            const on = impSel.has(imp)
            return (
              <button
                key={imp}
                onClick={() => {
                  const next = new Set(impSel)
                  if (next.has(imp)) next.delete(imp)
                  else next.add(imp)
                  applyFilterChange(next, countryExcl) // remembered (Task 31)
                }}
                aria-pressed={on}
                title={`${IMPORTANCE_LABEL[imp]} importance events`}
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                  on ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                <span className={cn('size-1.5 rounded-full', IMPORTANCE_DOT[imp], !on && 'opacity-30')} aria-hidden="true" />
                {IMPORTANCE_LABEL[imp]}
              </button>
            )
          })}
        </div>
        {/* country / currency multi-select — exclusions are remembered (Task 31) */}
        <FilterMultiSelect
          label="Country"
          options={countryOptions}
          selected={countrySel}
          onChange={(nextIncluded) => {
            const nextExcl = new Set(
              countryOptions.map((o) => o.value).filter((v) => !nextIncluded.has(v)),
            )
            applyFilterChange(impSel, nextExcl)
          }}
        />
        {filtersActive && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] tabular-nums text-zinc-500">{hiddenCount} hidden</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              className="h-6 gap-1 rounded px-1.5 text-[10px] text-zinc-400 hover:text-zinc-100"
            >
              <X className="size-3" aria-hidden="true" />
              Clear filters
            </Button>
          </div>
        )}
      </div>

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
              onClick={() => void refresh(true)}
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

        {/* Everything filtered out */}
        {!loading && !error && hasData && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-xs text-zinc-500">No events match the current filters.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={clearAllFilters}
              className="h-7 border-zinc-800 bg-zinc-900 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <X className="size-3.5" aria-hidden="true" />
              Reset filters
            </Button>
          </div>
        )}

        {/* One section per day */}
        {!error &&
          hasData &&
          days.map(([key, dayEvents], di) => {
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
                      const key = eventKey(ev)
                      const alarmOn = alarms.has(key)
                      return (
                        <Fragment key={`${ev.time}-${ev.country}-${ev.event}-${i}`}>
                          {/* red divider — everything ABOVE has been released */}
                          {lineEvent === ev && <NowLineRow />}
                          <tr
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
                              <div className="flex items-center gap-1.5">
                                {/* event alarm — grey (off, default) / amber (on) */}
                                <button
                                  type="button"
                                  onClick={() => toggleAlarm(key, !alarmOn)}
                                  aria-pressed={alarmOn}
                                  aria-label={
                                    alarmOn
                                      ? `Disable alarm for ${ev.event}`
                                      : `Set alarm for ${ev.event}`
                                  }
                                  title={
                                    alarmOn
                                      ? 'Alarm on — click to disable'
                                      : 'Set an alarm for this event'
                                  }
                                  className={cn(
                                    '-ml-1 shrink-0 rounded p-1 transition-colors',
                                    alarmOn
                                      ? 'text-amber-400 hover:text-amber-300'
                                      : 'text-zinc-600 hover:text-zinc-400',
                                  )}
                                >
                                  <Bell
                                    className={cn('size-3.5', alarmOn && 'fill-amber-400/40')}
                                    aria-hidden="true"
                                  />
                                </button>
                                <span className="min-w-0">{ev.event}</span>
                              </div>
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
                        </Fragment>
                      )
                    })}
                    {/* no upcoming events left — mark where the released ones end */}
                    {lineEvent === null && di === days.length - 1 && <NowLineRow />}
                  </tbody>
                </table>
              </section>
            )
          })}
      </div>

      {/* ------------------------------------------------------------ footer */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/60 px-3 text-[10px] text-zinc-500">
        <span>
          Times shown in your local timezone
          {filtersActive && hiddenCount > 0 ? ` · ${filtered.length} of ${events.length} events shown` : ''}
        </span>
        <span className="hidden sm:inline">
          Auto-refreshes every 10 min · polls for actuals after each release
        </span>
      </footer>
    </div>
  )
}

/** Red horizontal divider marking where released events end ("now" line). */
function NowLineRow() {
  return (
    <tr title="Events above this line have been released — events below are still upcoming">
      <td colSpan={7} className="px-0 py-0">
        <div className="flex items-center" aria-hidden="true">
          <span className="h-px flex-1 bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]" />
          <span className="mx-2 my-0.5 rounded-sm bg-red-500/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-widest text-red-400">
            Now
          </span>
          <span className="h-px flex-1 bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]" />
        </div>
        <span className="sr-only">
          Released events end here. Events below this line have not been released yet.
        </span>
      </td>
    </tr>
  )
}
