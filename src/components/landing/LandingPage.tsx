'use client'

// BLACKHOLE Terminal landing — v2.12.15 道家風格. The page unrolls like a
// handscroll: 毛筆繁中 copy (LXGW WenKai TC body + Ma Shan Zheng calligraphy
// display, loaded in layout.tsx), an AI-generated 水墨山水 掛軸 as the hero
// art (replacing the v2.9.2 F1 photo), a taiji ink mark instead of the old
// orange/blue conic logo, a 觀勢/馭水/藏器 triptych, and a full-bleed ink
// handscroll band carrying 《道德經》「道法自然」. Cinnabar 朱砂 (#a8402c) is
// the single color accent — the seal-stamp red of classical ink painting.
// What stays live: the nav ticker strip and the small Binance BTC chip pinned
// over the painting (public /api/landing/btc route, 45s cadence).
import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { motion } from 'framer-motion'
import { ArrowRight, Bell, LogIn, Search, Settings } from 'lucide-react'
import { useIsClient, useUiTheme } from '@/lib/ui-theme'
import { APP_VERSION } from '@/generated/version'

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

const NAV_LINKS = ['行情', '交易', '洞察', '持倉', '心法'] as const

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  const [latency, setLatency] = useState<number | null>(null)
  const onLatency = useCallback((ms: number) => setLatency(ms), [])
  // Task 28 — Christmas theme. uiTheme is read post-mount only (mounted gate)
  // so SSR/hydration always render the default tree; the boot script in
  // layout.tsx already put the theme class on <html>, so COLORS are correct
  // from first paint — only the decorative DOM (snow, chip) appears a beat
  // later, avoiding a hydration mismatch.
  const uiTheme = useUiTheme()
  const isClient = useIsClient()
  const christmas = isClient && uiTheme === 'christmas'
  return (
    // lang="zh-Hant" — the landing copy is Traditional Chinese; the terminal
    // keeps its own UI language, so the lang lives on this root, not <html>.
    <div lang="zh-Hant" className="lp-root relative z-10 flex min-h-screen flex-col bg-[#08080b]/78 text-zinc-100">
      <GridBackdrop />
      {christmas && <Snowfall />}
      <div className="relative z-10 flex min-h-screen flex-col">
        <NavBar onLaunch={onLaunch} onLatency={onLatency} christmas={christmas} />
        <main className="flex-1">
          <Hero onLaunch={onLaunch} christmas={christmas} />
          <DaoFeatures onLaunch={onLaunch} />
          <DaoScrollBand />
        </main>
        <StatusBar latency={latency} />
      </div>
    </div>
  )
}

/* ---------------------------------- nav ---------------------------------- */

function NavBar({ onLaunch, onLatency, christmas }: { onLaunch: () => void; onLatency: (ms: number) => void; christmas: boolean }) {
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
    <header className="lp-nav sticky top-0 z-30 border-b border-white/5 bg-[#08080b]/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-4 sm:px-6 lg:px-10">
        {/* brand */}
        <button
          onClick={onLaunch}
          className="flex shrink-0 items-center gap-2.5"
          aria-label="黑洞終端首頁 — 進入終端"
        >
          <BlackHoleMark size={34} />
          <span className="hidden flex-col leading-none min-[420px]:flex">
            <span className="lp-brush text-[17px] tracking-[0.08em] text-white">黑洞終端</span>
            <span className="text-[10px] uppercase tracking-[0.28em] text-zinc-500">Terminal</span>
          </span>
          {christmas && (
            <span className="ml-0.5 text-base leading-none" aria-hidden title="聖誕主題已啟用">
              🎄
            </span>
          )}
        </button>

        {/* links */}
        <nav className="hidden items-center gap-7 self-stretch md:flex" aria-label="主導覽">
          {NAV_LINKS.map((label, i) => {
            const active = i === 0
            return (
              <a
                key={label}
                href={active ? '#markets' : '#'}
                onClick={active ? undefined : (e) => { e.preventDefault(); onLaunch() }}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-16 items-center text-[15px] transition-colors ${
                  active
                    ? 'font-medium text-zinc-100 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-[#a8402c]'
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
        <div className="hidden items-center gap-6 xl:flex" aria-label="實時行情">
          {tickers.map((t) => (
            <Ticker key={t.symbol} ticker={t} />
          ))}
        </div>

        <div className="hidden items-center gap-1 sm:flex">
          <IconBtn label="搜尋" onClick={onLaunch}><Search className="h-[17px] w-[17px]" /></IconBtn>
          <IconBtn label="通知" onClick={onLaunch}><Bell className="h-[17px] w-[17px]" /></IconBtn>
          <IconBtn label="設定" onClick={onLaunch}><Settings className="h-[17px] w-[17px]" /></IconBtn>
        </div>

        <button
          onClick={onLaunch}
          className="lp-cta flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#a8402c] px-3.5 py-2 text-[14px] font-medium text-[#faf5ea] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] transition-colors hover:bg-[#b94b35] sm:px-4"
        >
          <LogIn className="h-4 w-4" aria-hidden />
          登入
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

function Hero({ onLaunch, christmas }: { onLaunch: () => void; christmas: boolean }) {
  return (
    <section id="markets" className="mx-auto grid w-full max-w-[1400px] scroll-mt-20 grid-cols-1 items-center gap-10 px-4 pb-10 pt-10 sm:px-6 lg:min-h-[calc(100vh-6.5rem)] lg:grid-cols-[1.05fr_1.2fr] lg:gap-14 lg:px-10 lg:pb-16 lg:pt-20">
      {/* left — 毛筆繁中 copy */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        <div className="flex items-center gap-4">
          <BlackHoleMark size={58} />
          <div className="flex flex-col leading-none">
            <span className="lp-brush text-[2rem] tracking-[0.06em] text-white sm:text-[2.5rem]">黑洞終端</span>
            <span className="mt-2 text-[11px] uppercase tracking-[0.34em] text-zinc-500">Blackhole Terminal</span>
          </div>
        </div>

        <h1 className="lp-brush mt-9 text-[2.9rem] leading-[1.14] tracking-[0.04em] text-white sm:text-6xl lg:text-[4.1rem]">
          玄之又玄，
          <br />
          眾妙之門。
        </h1>
        {christmas && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-300">
            <span aria-hidden>🎄</span> 聖誕快樂 — 節日主題已啟用
          </p>
        )}
        <p className="mt-6 max-w-xl text-lg font-light leading-relaxed text-zinc-300 sm:text-xl">
          萬象、行情與洞見，皆受引力所攝——墮入黑洞，復歸於道。
        </p>
        <p className="mt-5 text-sm text-zinc-500 sm:text-[15px]">
          實時走勢 <span className="mx-1.5 text-zinc-600">‧</span> 價格警報{' '}
          <span className="mx-1.5 text-zinc-600">‧</span> 引力風控
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3.5">
          <button
            onClick={onLaunch}
            className="lp-cta rounded-lg bg-[#a8402c] px-7 py-3 text-[16px] tracking-[0.12em] text-[#faf5ea] shadow-lg shadow-black/50 transition-all hover:bg-[#b94b35] active:scale-[0.98]"
          >
            進入終端
          </button>
          <a
            href="https://docs.alpaca.markets"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-white/15 px-7 py-3 text-[15px] text-zinc-200 transition-colors hover:border-white/25 hover:bg-white/5"
          >
            文檔 <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <dl className="mt-12 grid max-w-lg grid-cols-3 gap-6 sm:gap-10">
          <Stat label="廿四小時成交" value="$2.1B" />
          <Stat label="活躍交易者" value="12.4k" />
          <Stat label="未平倉量" value="$540M" />
        </dl>
      </motion.div>

      {/* right — v2.12.15 hero art: 水墨山水掛軸. AI-generated ink-wash
          shan-shui (misty peaks, lone boat, pines) framed in dark silk
          mounting (裱工), with a vertical 題跋 inscription + cinnabar seal.
          (No WebGL, no 3D bundle; the live Binance BTC chip stays.) */}
      <motion.div
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut', delay: 0.08 }}
        className="lp-scroll-frame relative aspect-[7/5] w-full lg:aspect-[7/4]"
      >
        <div className="lp-scroll-inner relative h-full w-full">
          <Image
            src="/dao/dao-hero-shanshui.png"
            alt="水墨山水：雲霧群山之下一葉孤舟垂釣，崖畔孤松，遠峰有鶴飛翔"
            fill
            priority
            sizes="(min-width: 1024px) 55vw, 100vw"
            className="object-cover"
          />
          {/* 題跋 — vertical inscription in the painting's empty sky, sealed */}
          <div className="absolute right-3 top-3 z-10 flex flex-col items-center gap-2.5 sm:right-4 sm:top-4">
            <span className="lp-vertical lp-brush text-[15px] text-[#2e2a23] sm:text-base">以道馭市</span>
            <span className="lp-seal h-6 w-6 text-[13px] sm:h-7 sm:w-7 sm:text-[15px]" aria-hidden>道</span>
          </div>
          {/* bottom fade so the scroll blends into the dark page */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/35 to-transparent" />
          <LiveBtcChip />
        </div>
      </motion.div>
    </section>
  )
}

/* ------------------------------- live btc chip --------------------------- */

// Small real-price badge over the painting — same public route as the retired
// v2.9.0 chart, lighter payload (50 × 1h candles), 45s cadence, tab-hidden safe.
function LiveBtcChip() {
  const [s, setS] = useState<{ price: number; changePct: number } | null>(null)
  useEffect(() => {
    let alive = true
    const go = async () => {
      try {
        const res = await fetch('/api/landing/btc?tf=1h&limit=50', { cache: 'no-store' })
        if (!res.ok || !alive) return
        const j = (await res.json()) as { price?: number; changePct?: number }
        if (alive && Number.isFinite(j.price)) setS({ price: j.price as number, changePct: j.changePct ?? 0 })
      } catch {
        /* keep last value */
      }
    }
    void go()
    const t = setInterval(() => {
      if (!document.hidden) void go()
    }, 45_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  const up = (s?.changePct ?? 0) >= 0
  return (
    <div className="absolute bottom-3 right-3 rounded-lg border border-white/20 bg-black/45 px-3 py-2 backdrop-blur-md">
      <div className="flex items-center gap-1.5 text-[10px] leading-none text-zinc-300">
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </span>
        <span className="font-semibold text-white">BTC/USD</span>
        <span className="text-zinc-400">‧ 幣安實時</span>
      </div>
      <div className="mt-1 font-mono text-sm font-bold tabular-nums text-white">
        {s ? `$${s.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
        {s && (
          <span className={`ml-1.5 text-[11px] font-semibold ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
            {up ? '+' : ''}
            {s.changePct.toFixed(2)}%
          </span>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-zinc-400 sm:text-sm">{label}</dt>
      <dd className="lp-brush mt-1.5 text-2xl tracking-wide text-white sm:text-3xl lg:text-4xl">{value}</dd>
    </div>
  )
}

/* ------------------------------ dao features ------------------------------ */

// v2.12.15 — 終端三境: 觀勢 / 馭水 / 藏器. Each card carries a giant brush
// watermark character (純裝飾) behind kai body text. Pure CSS/typography —
// no images, no JS beyond the hover tint.
function DaoFeatures({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section id="dao" className="mx-auto w-full max-w-[1400px] scroll-mt-20 px-4 pb-16 sm:px-6 lg:px-10 lg:pb-20">
      <div className="flex flex-col items-center text-center">
        <p className="text-xs uppercase tracking-[0.42em] text-zinc-500">道 ‧ 終端三境</p>
        <h2 className="lp-brush mt-4 text-3xl tracking-[0.05em] text-white sm:text-4xl">執道而行 ‧ 萬象歸玄</h2>
      </div>
      <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
        <DaoCard char="觀" title="觀勢如觀山" body="實時 K 線、深度圖表與畫線工具——千峰在目，走勢自成山水。" />
        <DaoCard char="馭" title="馭水如馭市" body="價格警報、Telegram 通報與流暢下單——上善若水，先至而不爭。" />
        <DaoCard char="藏" title="藏器待時動" body="引力風控與持倉洞察——藏器於身，待時而動；勝人者有力，自勝者強。" />
      </div>
      <div className="mt-9 flex justify-center">
        <button
          onClick={onLaunch}
          className="lp-cta rounded-lg border border-[#a8402c]/60 bg-[#a8402c]/10 px-6 py-2.5 text-[15px] tracking-[0.2em] text-[#e8c9b2] transition-colors hover:bg-[#a8402c]/25"
        >
          親證此道
        </button>
      </div>
    </section>
  )
}

function DaoCard({ char, title, body }: { char: string; title: string; body: string }) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.035] p-6 transition-colors hover:border-white/20 hover:bg-white/[0.06]">
      <span
        aria-hidden
        className="lp-brush pointer-events-none absolute -right-3 -top-6 select-none text-[7rem] leading-none text-white/[0.05] transition-colors group-hover:text-white/[0.085]"
      >
        {char}
      </span>
      <h3 className="lp-brush text-xl tracking-[0.08em] text-zinc-100 sm:text-2xl">{title}</h3>
      <p className="mt-3 max-w-[26rem] text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  )
}

/* ------------------------------- scroll band ------------------------------ */

// v2.12.15 — full-bleed 水墨手卷 band: the AI-generated handscroll unrolls out
// of the dark page (gradient shroud top/bottom), carrying 《道德經》25章. The
// quote sits on a translucent paper chip (宣紙) in ink text with a cinnabar
// seal — a painting inscription set INTO the scroll.
function DaoScrollBand() {
  return (
    <section aria-label="《道德經》語帶 — 道法自然" className="relative w-full">
      <div className="relative h-[320px] w-full overflow-hidden sm:h-[400px] lg:h-[460px]">
        <Image
          src="/dao/dao-scroll-band.png"
          alt="水墨手卷：連綿雲山與江水，其間一葉漁舟"
          fill
          sizes="100vw"
          className="object-cover"
        />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-[#08080b] via-transparent to-[#08080b]" />
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <figure className="lp-ink-in rounded-md border border-[#2c261c]/25 bg-[#f2ead9]/90 px-6 py-5 shadow-2xl shadow-black/50 backdrop-blur-[2px] sm:px-10 sm:py-7">
            <blockquote className="lp-brush text-[1.7rem] leading-snug tracking-[0.03em] text-[#26221a] sm:text-4xl lg:text-[2.7rem]">
              人法地，地法天，天法道，道法自然。
            </blockquote>
            <figcaption className="mt-3 flex items-center justify-end gap-2.5 text-xs text-[#5c5344] sm:text-sm">
              ——《道德經 ‧ 第二十五章》
              <span className="lp-seal h-5 w-5 text-[11px]" aria-hidden>道</span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------ mini sparkline ---------------------------- */

// MiniSparkline (fake seeded candles) retired in v2.9.0, the three.js sky
// scene followed in v2.9.1 — the hero is an ink scroll painting now.
// mulberry32 stays — Snowfall still needs its seeded RNG.
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* -------------------------------- status bar ------------------------------ */

function StatusBar({ latency }: { latency: number | null }) {
  const open = useMarketOpen()

  return (
    <footer className="mt-auto border-t border-white/5 bg-black/40">
      <div className="mx-auto flex h-10 max-w-[1400px] items-center justify-between gap-3 px-4 text-[12px] text-zinc-500 sm:px-6 lg:px-10">
        <p className="flex min-w-0 items-center gap-2 truncate">
          <span>
            市場狀態：{' '}
            <span className={open ? 'font-medium text-emerald-400' : 'font-medium text-zinc-300'}>
              {open ? '開市' : '休市'}
            </span>
          </span>
          <span aria-hidden className="text-zinc-700">‧</span>
          <span className="whitespace-nowrap">
            延遲 <span className="text-zinc-300 tabular-nums">{latency ?? '—'}{latency != null ? 'ms' : ''}</span>
          </span>
          <span aria-hidden className="hidden text-zinc-700 sm:inline">‧</span>
          <span className="hidden sm:inline">WSS 已連線</span>
        </p>
        <p className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5 text-zinc-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
            實時
          </span>
          <span className="tabular-nums text-zinc-600">{APP_VERSION.display}</span>
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
      {/* v2.12.11 — ink theme: the blue/orange glows become neutral mist so
          the painting (visible through the translucent root) stays grey/white */}
      <div className="absolute inset-0 lp-glow-blue bg-[radial-gradient(ellipse_55%_45%_at_72%_38%,rgba(226,226,235,0.05),transparent_70%)]" />
      <div className="absolute inset-0 lp-glow-orange bg-[radial-gradient(ellipse_45%_40%_at_75%_55%,rgba(205,205,214,0.04),transparent_70%)]" />
    </div>
  )
}

/* ------------------------------- snowfall --------------------------------- */

// Task 28 — Christmas-only decorative snow on the landing page. Seeded RNG
// (same mulberry32 as MiniSparkline) so SSR/CSR agree and flakes are stable
// across renders; CSS does the animation (globals.css xmas-fall) and honors
// prefers-reduced-motion by hiding the flakes entirely.
function Snowfall() {
  const flakes = useMemo(() => {
    const rnd = mulberry32(20251224)
    const glyphs = ['❄', '❅', '•']
    return Array.from({ length: 36 }, (_, i) => ({
      id: i,
      left: rnd() * 100,
      size: 8 + rnd() * 10,
      duration: 9 + rnd() * 14,
      // negative delay → every flake starts mid-fall (no empty first seconds)
      delay: -rnd() * 20,
      drift: (rnd() - 0.5) * 14,
      opacity: 0.35 + rnd() * 0.5,
      glyph: glyphs[Math.floor(rnd() * glyphs.length)],
    }))
  }, [])
  return (
    <div className="xmas-snow" aria-hidden>
      {flakes.map((f) => (
        <span
          key={f.id}
          className="xmas-snowflake"
          style={{
            left: `${f.left}%`,
            fontSize: f.size,
            opacity: f.opacity,
            animationDuration: `${f.duration}s`,
            animationDelay: `${f.delay}s`,
            ['--xmas-drift' as string]: `${f.drift.toFixed(1)}vw`,
          }}
        >
          {f.glyph}
        </span>
      ))}
    </div>
  )
}

/* --------------------------------- logo ----------------------------------- */

// v2.12.15 — the brand mark becomes 太極 in ink: one dark disc, one paper-white
// comma, two ink eyes. Replaces the old orange/blue conic black hole, which
// fought the grey/white 水墨 palette; the dao reading (多空相生, 陰陽互抱) fits
// a trading terminal better anyway.
function BlackHoleMark({ size = 36 }: { size?: number }) {
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 40 40" width={size} height={size} role="presentation" focusable="false">
        <circle cx="20" cy="20" r="18.5" fill="#0b0b0e" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
        <path d="M20,2 a18,18 0 0,1 0,36 a9,9 0 0,1 0,-18 a9,9 0 0,0 0,-18 Z" fill="#d9d9df" />
        <circle cx="20" cy="11" r="2.7" fill="#0b0b0e" />
        <circle cx="20" cy="29" r="2.7" fill="#d9d9df" />
      </svg>
    </span>
  )
}
