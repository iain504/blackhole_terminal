'use client'

// Session splash (v1.87.0) — full-screen alert when the US REGULAR trading
// session OPENS (09:30 ET) or CLOSES (16:00 ET), Mon–Fri — the hours stock
// orders actually fill on Alpaca (the grid engine and RTH-gated algo runs
// idle outside them; crypto is unaffected and trades 24/7).
//
// Behaviour:
//  • Fires on a LIVE closed→open / open→closed transition while the terminal
//    is open, plus a 10-minute catch-up if the app was (re)loaded shortly
//    after the event. Each event shows at most once per ET calendar day
//    (dedup key in localStorage), so reloads never re-spam it.
//  • Auto-dismisses after 10 s (with a draining progress bar); the Dismiss
//    button or a backdrop tap closes it immediately. Purely informational —
//    it never blocks trading.
//  • Config: Settings → "Trading session alerts" (per-account via
//    /api/settings; mirrored to localStorage `tt:session-splash` for a
//    flash-free boot). Disabled → the component renders nothing but keeps
//    listening so re-enabling works without a reload.
//
// Session math reuses src/lib/sessions.ts — the SINGLE SOURCE OF TRUTH for
// RTH bounds (same helpers the algo engine / grid gates / ETH shading use).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Sunrise, Sunset, X } from 'lucide-react'
import { isRegularSession, RTH_START_MIN, RTH_END_MIN, etMinutesOfDay } from '@/lib/sessions'
import { cn } from '@/lib/utils'

const LS_ENABLED = 'tt:session-splash' // '0' = disabled, absent/'1' = enabled
const LS_LAST = 'tt:session-splash:last' // event key of the last splash fired
const TICK_MS = 10_000
const CATCHUP_MIN = 10 // minutes after open/close that still triggers a splash
const AUTO_DISMISS_MS = 10_000

type SplashKind = 'open' | 'close'

interface Splash {
  kind: SplashKind
  firedAt: number
}

function etMinLabel(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

// Current ET wall-clock "HH:mm" (the session lives in America/New_York).
function etClockNow(): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    return ''
  }
}

// ET weekday of `nowSec` — 'Sat'/'Sun' must never fire catch-up splashes
// (Saturday 16:05 ET is NOT "the session just closed").
function etWeekday(nowSec: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(
      new Date(nowSec * 1000),
    )
  } catch {
    return 'Mon'
  }
}

// Human label for the next open after a close splash (Fri/Sat → Monday).
function nextOpenLabel(nowSec: number): string {
  const wd = etWeekday(nowSec)
  return wd === 'Fri' || wd === 'Sat' ? 'Reopens Monday 09:30 ET' : 'Reopens tomorrow 09:30 ET'
}

export function SessionSplash() {
  const [enabled, setEnabled] = useState(false)
  const [splash, setSplash] = useState<Splash | null>(null)
  // remaining ms for the auto-dismiss progress bar (null = not running)
  const [remaining, setRemaining] = useState<number | null>(null)
  const enabledRef = useRef(false)
  const prevInRth = useRef<boolean | null>(null)

  // Config load: server first (per-account), localStorage as offline fallback.
  // Re-runs on tt:settings-changed so the Settings toggle applies instantly.
  const loadEnabled = useCallback(async () => {
    let on = true
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { sessionSplash?: unknown } | null
        on = json?.sessionSplash !== false
      } else {
        try { on = localStorage.getItem(LS_ENABLED) !== '0' } catch { /* keep default */ }
      }
    } catch {
      try { on = localStorage.getItem(LS_ENABLED) !== '0' } catch { /* keep default */ }
    }
    enabledRef.current = on
    setEnabled(on)
    try { localStorage.setItem(LS_ENABLED, on ? '1' : '0') } catch { /* private mode */ }
  }, [])

  useEffect(() => {
    void loadEnabled()
    const onChanged = () => { void loadEnabled() }
    window.addEventListener('tt:settings-changed', onChanged)
    return () => window.removeEventListener('tt:settings-changed', onChanged)
  }, [loadEnabled])

  // Fire a splash once per ET-day+kind (localStorage dedup survives reloads).
  const fire = useCallback((kind: SplashKind, nowSec: number) => {
    const key = `${kind}:${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(nowSec * 1000))}`
    try {
      if (localStorage.getItem(LS_LAST) === key) return
      localStorage.setItem(LS_LAST, key)
    } catch { /* private mode — session-only dedup */ }
    setSplash({ kind, firedAt: Date.now() })
  }, [])

  // Session watch: 10 s tick + catch-up on tab focus/visibility return.
  const check = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    const inRth = isRegularSession(nowSec)
    const prev = prevInRth.current
    prevInRth.current = inRth
    if (!enabledRef.current) return
    if (prev === null) {
      // First tick after mount — no transition known yet, but catch up when
      // the app was loaded within CATCHUP_MIN minutes of the event.
      const etMin = etMinutesOfDay(nowSec)
      const weekday = etWeekday(nowSec)
      const isWeekday = weekday !== 'Sat' && weekday !== 'Sun'
      if (isWeekday && inRth && etMin >= RTH_START_MIN && etMin - RTH_START_MIN <= CATCHUP_MIN) {
        fire('open', nowSec)
      } else if (isWeekday && !inRth && etMin >= RTH_END_MIN && etMin - RTH_END_MIN <= CATCHUP_MIN) {
        fire('close', nowSec)
      }
      return
    }
    if (!prev && inRth) fire('open', nowSec)
    else if (prev && !inRth) fire('close', nowSec)
  }, [fire])

  useEffect(() => {
    check()
    const t = setInterval(check, TICK_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [check])

  const dismiss = useCallback(() => setSplash(null), [])

  // Auto-dismiss countdown + draining progress bar (100 ms steps are plenty).
  useEffect(() => {
    if (!splash) {
      setRemaining(null)
      return
    }
    setRemaining(AUTO_DISMISS_MS)
    const started = Date.now()
    const t = setInterval(() => {
      const left = AUTO_DISMISS_MS - (Date.now() - started)
      if (left <= 0) {
        setSplash(null)
      } else {
        setRemaining(left)
      }
    }, 100)
    return () => clearInterval(t)
  }, [splash])

  if (!enabled || !splash) return null
  const isOpen = splash.kind === 'open'

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={isOpen ? 'Regular trading session opened' : 'Regular trading session closed'}
      onClick={dismiss}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/80 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-center shadow-2xl"
      >
        <div className="flex flex-col items-center gap-3 px-6 pb-5 pt-7">
          <div
            className={cn(
              'flex h-14 w-14 items-center justify-center rounded-full',
              isOpen ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400',
            )}
          >
            {isOpen ? <Sunrise className="h-7 w-7" aria-hidden /> : <Sunset className="h-7 w-7" aria-hidden />}
          </div>

          <h2 className="text-lg font-semibold text-zinc-100">
            {isOpen ? 'Regular trading is open' : 'Regular trading has closed'}
          </h2>

          <p className="text-xs leading-relaxed text-zinc-400">
            US stocks trade 09:30–16:00 ET, Mon–Fri — the hours stock orders fill.
            Crypto is unaffected (24/7).
          </p>

          <div className="flex w-full flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">{isOpen ? 'Session opened' : 'Session closed'}</span>
              <span className="font-semibold tabular-nums text-zinc-200">
                {etMinLabel(isOpen ? RTH_START_MIN : RTH_END_MIN)} ET
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">{isOpen ? 'Closes today' : nextOpenLabel(Date.now() / 1000)}</span>
              <span className="font-semibold tabular-nums text-zinc-200">
                {etMinLabel(isOpen ? RTH_END_MIN : RTH_START_MIN)} ET
              </span>
            </div>
            {etClockNow() && (
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">New York now</span>
                <span className="tabular-nums text-zinc-400">{etClockNow()}</span>
              </div>
            )}
          </div>

          <button
            onClick={dismiss}
            aria-label="Dismiss session alert"
            className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-zinc-800 text-sm font-semibold text-zinc-100 transition-colors active:bg-zinc-700"
          >
            <X className="h-4 w-4" aria-hidden />
            Dismiss
          </button>
        </div>

        {/* draining auto-dismiss bar */}
        <div className="h-1 w-full bg-zinc-800" aria-hidden>
          <div
            className={cn('h-full', isOpen ? 'bg-emerald-500' : 'bg-amber-500')}
            style={{ width: `${Math.max(0, Math.min(100, ((remaining ?? 0) / AUTO_DISMISS_MS) * 100))}%` }}
          />
        </div>
      </div>
    </div>
  )
}
