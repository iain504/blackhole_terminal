'use client'

// Root view switch: BLACKHOLE landing page ↔ TradeTerminal app.
// The terminal is opened via "Launch Terminal" (#terminal hash — survives
// reloads natively); browser back / the footer home button returns to the
// landing page. The URL hash is the single source of truth.
//
// v2.11.3 — the terminal (and its whole tab tree) is code-split: a landing
// visitor no longer downloads the ~6k-line chart stack at all; the chunk
// loads on first Launch (then cached). The fallback is a theme-matched blank
// so the hash deep-link paints instantly without a white flash.
import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { LandingPage } from '@/components/landing/LandingPage'

const TerminalRoot = dynamic(
  () => import('@/components/terminal/TerminalRoot').then((m) => ({ default: m.TerminalRoot })),
  { ssr: false, loading: () => <div className="min-h-dvh bg-black" aria-hidden /> },
)

type View = 'landing' | 'terminal'

export default function Home() {
  const [view, setView] = useState<View>('landing')

  // Keep URL hash ↔ view in sync (supports browser back/forward + deep link #terminal)
  useEffect(() => {
    const sync = () => setView(window.location.hash === '#terminal' ? 'terminal' : 'landing')
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const launch = useCallback(() => {
    if (window.location.hash !== '#terminal') window.location.hash = 'terminal'
    setView('terminal')
  }, [])

  const goHome = useCallback(() => {
    if (window.location.hash) window.history.pushState(null, '', window.location.pathname)
    setView('landing')
  }, [])

  if (view === 'terminal') return <TerminalRoot onExit={goHome} />
  return <LandingPage onLaunch={launch} />
}
