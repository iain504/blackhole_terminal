'use client'

// BLACKHOLE Terminal landing page — dark hero, live ticker strip, stats, status bar.
// Reference style: blackhole art + candlesticks, blue CTA, subtle grid background.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { motion } from 'framer-motion'
import { Bell, Search, Settings, ArrowRight } from 'lucide-react'

interface TickerState {
  symbol: string
  price: number
  changePct: number
}

const FALLBACK_TICKERS: TickerState[] = [
  { symbol: 'BTC/USD', price: 63427.12, changePct: 2.34 },
  { symbol: 'ETH/USD', price: 3121.55, changePct: -1.08 },
  { symbol: 'SOL/USD', price: 148.9, changePct: 0.72 },
]

const TICKER_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD']

const NAV_LINKS = ['Markets', 'Trade', 'Analytics', 'Portfolio', 'Learn'] as const

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  const [latency, setLatency] = useState<number | null>(null)
  const onLatency = useCallback((ms: number) => setLatency(ms), [])
  return (
    <div className="relative flex min-h-screen flex-col bg-[#08080b] text-zinc-100">
      <GridBackdrop />
      <div className="relative z-10 flex min-h-screen flex-col">
        <NavBar onLaunch={onLaunch} onLatency={onLatency} />
        <main className="flex-1">
          <Hero onLaunch={onLaunch} />
        </main>
        <StatusBar latency={latency} />
      </div>
    </div>
  )
}

/* ---------------------------------- nav ---------------------------------- */

function NavBar({ onLaunch, onLatency }: { onLaunch: () => void; onLatency: (ms: number) => void }) {
  const [tickers, setTickers] = useState<TickerState[]>(FALLBACK_TICKERS)

  // Live ticker strip — polls public quote endpoint, falls back to static values.
  useEffect(() => {
    let alive = true
    const fetchTickers = async () => {
      if (document.hidden) return
      const t0 = performance.now()
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: TICKER_SYMBOLS }),
        })
        if (!res.ok || !alive) return
        const ms = Math.round(performance.now() - t0)
        const json = await res.json()
        const quotes = (json.quotes || []) as { symbol: string; price: number; changePct: number }[]
        if (!alive || quotes.length === 0) return
        const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]))
        setTickers(
          FALLBACK_TICKERS.map((f) => {
            const q = bySymbol.get(f.symbol)
            return q && Number.isFinite(q.price)
              ? { symbol: f.symbol, price: q.price, changePct: q.changePct }
              : f
          }),
        )
        onLatency(ms)
      } catch {
        /* offline — keep fallback */
      }
    }
    fetchTickers()
    const timer = setInterval(fetchTickers, 20000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [onLatency])

  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#08080b]/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-4 sm:px-6 lg:px-10">
        {/* brand */}
        <button
          onClick={onLaunch}
          className="flex shrink-0 items-center gap-2.5"
          aria-label="BLACKHOLE Terminal home"
        >
          <BlackHoleMark size={34} />
          <span className="hidden flex-col leading-none min-[420px]:flex">
            <span className="text-[15px] font-extrabold tracking-wide text-white">BLACKHOLE</span>
            <span className="text-[11px] font-medium text-zinc-400">Terminal</span>
          </span>
        </button>

        {/* links */}
        <nav className="hidden items-center gap-7 self-stretch md:flex" aria-label="Primary">
          {NAV_LINKS.map((label, i) => {
            const active = i === 0
            return (
              <a
                key={label}
                href={active ? '#markets' : '#'}
                onClick={active ? undefined : (e) => { e.preventDefault(); onLaunch() }}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-16 items-center text-sm transition-colors ${
                  active
                    ? 'font-medium text-zinc-100 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-blue-500'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {label}
              </a>
            )
          })}
        </nav>

        <div className="flex-1" />

        {/* tickers */}
        <div className="hidden items-center gap-6 xl:flex" aria-label="Live market tickers">
          {tickers.map((t) => (
            <Ticker key={t.symbol} ticker={t} />
          ))}
        </div>

        <div className="hidden items-center gap-1 sm:flex">
          <IconBtn label="Search" onClick={onLaunch}><Search className="h-[17px] w-[17px]" /></IconBtn>
          <IconBtn label="Notifications" onClick={onLaunch}><Bell className="h-[17px] w-[17px]" /></IconBtn>
          <IconBtn label="Settings" onClick={onLaunch}><Settings className="h-[17px] w-[17px]" /></IconBtn>
        </div>

        <button
          onClick={onLaunch}
          className="whitespace-nowrap rounded-md bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-colors hover:bg-blue-500 sm:px-4"
        >
          Connect Wallet
        </button>
      </div>
    </header>
  )
}

function IconBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
    >
      {children}
    </button>
  )
}

function Ticker({ ticker }: { ticker: TickerState }) {
  const up = ticker.changePct >= 0
  const color = up ? 'text-emerald-400' : 'text-rose-400'
  return (
    <div className="flex items-start gap-1.5 text-[13px] leading-tight">
      <span className={`mt-0.5 text-[9px] ${color}`} aria-hidden>{up ? '▲' : '▼'}</span>
      <div className="flex flex-col">
        <span className={`font-semibold ${color}`}>{ticker.symbol}</span>
        <span className={color}>
          ${ticker.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
          <span className="tabular-nums">{up ? '+' : ''}{ticker.changePct.toFixed(2)}%</span>
        </span>
      </div>
    </div>
  )
}

/* ---------------------------------- hero --------------------------------- */

function Hero({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section className="mx-auto grid w-full max-w-[1400px] grid-cols-1 items-center gap-10 px-4 pb-10 pt-10 sm:px-6 lg:min-h-[calc(100vh-6.5rem)] lg:grid-cols-[1.05fr_1.2fr] lg:gap-14 lg:px-10 lg:pb-16 lg:pt-20">
      {/* left */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        <div className="flex items-center gap-4">
          <BlackHoleMark size={58} />
          <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-[2.6rem]">
            BLACKHOLE Terminal
          </h2>
        </div>

        <h1 className="mt-8 text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-[3.6rem]">
          Trade the Edge of the Market.
        </h1>
        <p className="mt-4 text-lg text-zinc-400 sm:text-xl">
          Data, Perpetuals, and Insights distorted by Gravity.
        </p>
        <p className="mt-6 text-sm text-zinc-500 sm:text-[15px]">
          Real-time charts <span className="mx-1.5 text-zinc-600">•</span> Price alerts{' '}
          <span className="mx-1.5 text-zinc-600">•</span> Gravity-powered risk analytics.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3.5">
          <button
            onClick={onLaunch}
            className="rounded-lg bg-blue-600 px-7 py-3 text-[15px] font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 hover:shadow-blue-500/30 active:scale-[0.98]"
          >
            Launch Terminal
          </button>
          <a
            href="https://docs.alpaca.markets"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-white/15 px-7 py-3 text-[15px] font-medium text-zinc-200 transition-colors hover:border-white/25 hover:bg-white/5"
          >
            Docs <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <dl id="markets" className="mt-12 grid max-w-lg grid-cols-3 gap-6 sm:gap-10">
          <Stat label="24h Volume" value="$2.1B" />
          <Stat label="Active Traders" value="12.4k" />
          <Stat label="Open Interest" value="$540M" />
        </dl>
      </motion.div>

      {/* right — hero art */}
      <motion.div
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut', delay: 0.08 }}
        className="relative aspect-[7/4] w-full overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-2xl shadow-black/60"
      >
        <Image
          src="/hero-blackhole.png"
          alt="Black hole with orange accretion swirl, blue gravitational grid and candlestick chart"
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 55vw"
          className="object-cover"
        />
        {/* mini chart overlay card */}
        <div className="absolute bottom-3 right-3 rounded-lg border border-white/10 bg-zinc-950/85 px-3 py-2 backdrop-blur-sm sm:bottom-4 sm:right-4">
          <div className="flex items-center gap-1.5 text-[11px] leading-none">
            <span className="font-semibold text-orange-400">BTC/USD</span>
            <span className="text-zinc-500">• 1m • Vol 1.24K</span>
          </div>
          <MiniSparkline />
        </div>
      </motion.div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-zinc-400 sm:text-sm">{label}</dt>
      <dd className="mt-1.5 text-2xl font-bold tracking-tight text-white sm:text-3xl lg:text-4xl">{value}</dd>
    </div>
  )
}

/* ------------------------------ mini sparkline ---------------------------- */

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function MiniSparkline() {
  const candles = useMemo(() => {
    const rnd = mulberry32(20240613)
    const out: { o: number; c: number; h: number; l: number }[] = []
    let price = 20
    for (let i = 0; i < 30; i++) {
      const drift = i > 20 ? 1.1 : 0.15
      const o = price
      const c = Math.max(4, Math.min(40, o + (rnd() - 0.42) * 5 + drift))
      const h = Math.max(o, c) + rnd() * 2.2
      const l = Math.min(o, c) - rnd() * 2.2
      out.push({ o, c, h: Math.min(42, h), l: Math.max(1, l) })
      price = c
    }
    return out
  }, [])

  const w = 132
  const step = w / candles.length
  return (
    <svg width={w} height={40} viewBox={`0 0 ${w} 40`} className="mt-1.5 block" aria-hidden>
      {candles.map((k, i) => {
        const x = i * step + step / 2
        const up = k.c >= k.o
        const color = up ? '#fb923c' : '#3b82f6'
        const top = Math.min(k.o, k.c)
        const h = Math.max(1.4, Math.abs(k.c - k.o))
        return (
          <g key={i}>
            <line x1={x} y1={40 - k.h} x2={x} y2={40 - k.l} stroke={color} strokeWidth={0.8} opacity={0.75} />
            <rect x={x - step * 0.3} y={40 - top - h} width={step * 0.6} height={h} fill={color} rx={0.5} />
          </g>
        )
      })}
    </svg>
  )
}

/* -------------------------------- status bar ------------------------------ */

function StatusBar({ latency }: { latency: number | null }) {
  const open = useMarketOpen()

  return (
    <footer className="mt-auto border-t border-white/5 bg-black/40">
      <div className="mx-auto flex h-10 max-w-[1400px] items-center justify-between gap-3 px-4 text-[11px] text-zinc-500 sm:px-6 lg:px-10">
        <p className="flex min-w-0 items-center gap-2 truncate">
          <span>
            Market status:{' '}
            <span className={open ? 'font-medium text-emerald-400' : 'font-medium text-zinc-300'}>
              {open ? 'OPEN' : 'CLOSED'}
            </span>
          </span>
          <span aria-hidden className="text-zinc-700">•</span>
          <span className="whitespace-nowrap">
            Latency <span className="text-zinc-300 tabular-nums">{latency ?? '—'}{latency != null ? 'ms' : ''}</span>
          </span>
          <span aria-hidden className="hidden text-zinc-700 sm:inline">•</span>
          <span className="hidden sm:inline">WSS: Connected</span>
        </p>
        <p className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5 text-zinc-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
            Live
          </span>
          <span className="tabular-nums text-zinc-600">v1.12.4</span>
        </p>
      </div>
    </footer>
  )
}

function useMarketOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = () => {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(new Date())
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
        const wd = get('weekday')
        const h = parseInt(get('hour'), 10) % 24
        const m = parseInt(get('minute'), 10)
        const mins = h * 60 + m
        const weekday = wd !== 'Sat' && wd !== 'Sun'
        setOpen(weekday && mins >= 570 && mins < 960)
      } catch {
        setOpen(false)
      }
    }
    check()
    const timer = setInterval(check, 60000)
    return () => clearInterval(timer)
  }, [])
  return open
}

/* ------------------------------- backdrop --------------------------------- */

function GridBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse 95% 85% at 50% 15%, black 25%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(ellipse 95% 85% at 50% 15%, black 25%, transparent 78%)',
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_72%_38%,rgba(59,130,246,0.07),transparent_70%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_45%_40%_at_75%_55%,rgba(249,115,22,0.05),transparent_70%)]" />
    </div>
  )
}

/* --------------------------------- logo ----------------------------------- */

function BlackHoleMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="relative inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background:
          'conic-gradient(from 210deg, #f97316, #fdba74 22%, #38bdf8 48%, #1e40af 68%, #f97316 100%)',
        boxShadow: '0 0 18px rgba(249,115,22,0.25), 0 0 10px rgba(56,189,248,0.15)',
      }}
      aria-hidden
    >
      <span className="absolute rounded-full bg-black" style={{ inset: size * 0.1 }} />
      <span
        className="absolute rounded-full"
        style={{
          inset: size * 0.18,
          background: 'radial-gradient(circle at 35% 30%, #2a2a30 0%, #000 58%)',
        }}
      />
    </span>
  )
}
