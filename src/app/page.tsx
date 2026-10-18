'use client'

// Root view switch: BLACKHOLE landing page ↔ TradeTerminal app.
// The terminal is opened via "Launch Terminal" (#terminal hash — survives
// reloads natively); browser back / the footer home button returns to the
// landing page. The URL hash is the single source of truth.
import { useCallback, useEffect, useState } from 'react'
import { TerminalRoot } from '@/components/terminal/TerminalRoot'
import { LandingPage } from '@/components/landing/LandingPage'

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
