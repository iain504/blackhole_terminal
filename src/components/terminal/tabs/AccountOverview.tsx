'use client'

// Account strip for the Positions tab:
//  - paper + live account cards (equity / daily P&L / cash / buying power)
//    with a full account-details dialog each
//  - an equity curve from Alpaca's /v2/account/portfolio/history with
//    Hour / Day / Week / Month / Year ranges and a paper/live toggle
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Settings2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'
type Range = 'today' | 'hour' | 'day' | 'week' | 'month' | 'year'

interface AccountInfo {
  accountNumber?: string | null
  status?: string
  currency?: string
  equity: number | null
  cash: number | null
  buyingPower: number | null
  portfolioValue?: number | null
  lastEquity?: number | null
  dailyPl?: number | null
  dailyPlPct?: number | null
  regtBuyingPower?: number | null
  daytradeBuyingPower?: number | null
  nonMarginableBuyingPower?: number | null
  daytradeCount?: number | null
  multiplier?: string | null
  shortingEnabled?: boolean | null
  tradingBlocked?: boolean | null
  transfersBlocked?: boolean | null
  accountBlocked?: boolean | null
  patternDayTrader?: boolean | null
  initialMargin?: number | null
  maintenanceMargin?: number | null
  sma?: number | null
  createdAt?: string | null
}

interface ModeState {
  account: AccountInfo | null
  error?: string // 'no-keys' | message
  loaded: boolean
}

interface HistoryPoint { t: number; eq: number; pl: number | null; plPct: number | null }

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'hour', label: 'Hour' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
]

const usd = (v: number | null | undefined, dp = 2): string =>
  v == null ? '—' : `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
const usdSigned = (v: number | null | undefined, dp = 2): string =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}${usd(v, dp)}`

export default function AccountOverview() {
  const [modes, setModes] = useState<Record<Mode, ModeState>>({
    paper: { account: null, loaded: false },
    live: { account: null, loaded: false },
  })
  const [range, setRange] = useState<Range>('today')
  const [chartMode, setChartMode] = useState<Mode>('paper')
  const [history, setHistory] = useState<{ range: Range; mode: Mode; points: HistoryPoint[]; error?: string; loaded: boolean; timeframe?: string; fallback?: string }>({
    range: 'today', mode: 'paper', points: [], loaded: false,
  })
  const [refreshing, setRefreshing] = useState(false)

  const fetchAccounts = useCallback(async (): Promise<Record<Mode, ModeState>> => {
    const one = async (mode: Mode): Promise<ModeState> => {
      try {
        const res = await fetch(`/api/trading/account?mode=${mode}`)
        const json = await res.json().catch(() => null)
        if (res.ok && json?.account) return { account: json.account as AccountInfo, loaded: true }
        return { account: null, error: json?.error === 'no-keys' ? 'no-keys' : json?.error || `HTTP ${res.status}`, loaded: true }
      } catch {
        return { account: null, error: 'network error', loaded: true }
      }
    }
    const [paper, live] = await Promise.all([one('paper'), one('live')])
    return { paper, live }
  }, [])

  // the browser's UTC offset so "Today" is sliced to the user's local midnight
  const histUrl = useCallback(
    (r: Range, m: Mode) =>
      `/api/trading/portfolio/history?mode=${m}&range=${r}&tzOffset=${new Date().getTimezoneOffset()}`,
    [],
  )

  const refreshHistory = useCallback(async (r: Range, m: Mode) => {
    try {
      const res = await fetch(histUrl(r, m))
      const json = await res.json().catch(() => null)
      if (res.ok && json) {
        setHistory({ range: r, mode: m, points: json.points || [], error: json.error, loaded: true, timeframe: json.timeframe, fallback: json.fallback })
      } else {
        setHistory({ range: r, mode: m, points: [], error: json?.error || `HTTP ${res.status}`, loaded: true })
      }
    } catch {
      setHistory({ range: r, mode: m, points: [], error: 'network error', loaded: true })
    }
  }, [histUrl])

  useEffect(() => {
    let alive = true
    void (async () => {
      const m = await fetchAccounts()
      if (alive) setModes(m)
    })()
    const t = setInterval(() => {
      void fetchAccounts().then((m) => {
        if (alive) setModes(m)
      })
    }, 30000)
    const onChanged = () => {
      void fetchAccounts().then((m) => {
        if (alive) setModes(m)
      })
    }
    window.addEventListener('tt:positions-changed', onChanged)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('tt:positions-changed', onChanged)
    }
  }, [fetchAccounts])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(histUrl(range, chartMode))
        const json = await res.json().catch(() => null)
        if (!alive) return
        if (res.ok && json) {
          setHistory({ range, mode: chartMode, points: json.points || [], error: json.error, loaded: true, timeframe: json.timeframe, fallback: json.fallback })
        } else {
          setHistory({ range, mode: chartMode, points: [], error: json?.error || `HTTP ${res.status}`, loaded: true })
        }
      } catch {
        if (alive) setHistory({ range, mode: chartMode, points: [], error: 'network error', loaded: true })
      }
    })()
    const t = setInterval(() => void refreshHistory(range, chartMode), 60000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [range, chartMode, refreshHistory, histUrl])

  const refreshAll = () => {
    setRefreshing(true)
    void fetchAccounts().then((m) => setModes(m)).finally(() => setRefreshing(false))
    void refreshHistory(range, chartMode)
  }

  // still showing the previous range's curve while the new one loads
  const historyStale = history.range !== range || history.mode !== chartMode

  return (
    <div className="grid shrink-0 gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {/* account cards */}
      <div className="grid gap-2 sm:grid-cols-2">
        <AccountCard mode="paper" state={modes.paper} />
        <AccountCard mode="live" state={modes.live} />
      </div>
      {/* equity curve */}
      <div className="flex min-w-0 flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/80 px-3 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Equity</span>
          <div className="ml-1 flex overflow-hidden rounded border border-zinc-700">
            {(['paper', 'live'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setChartMode(m)}
                aria-pressed={chartMode === m}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-semibold uppercase transition-colors',
                  chartMode === m
                    ? m === 'live' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded border border-zinc-700">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                aria-pressed={range === r.key}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-medium transition-colors',
                  range === r.key ? 'bg-zinc-700/80 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {!historyStale && history.fallback === 'last-session' && (
              <span
                className="rounded border border-amber-500/40 px-1 py-px text-[9px] uppercase tracking-wide text-amber-400"
                title="No equity change since midnight yet (weekend/holiday or flat market) — showing the most recent session"
              >
                last session
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-zinc-500 hover:text-zinc-200"
              onClick={refreshAll}
              aria-label="Refresh account and equity data"
            >
              <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
            </Button>
          </div>
        </div>
        <EquityChart
          points={history.points}
          loaded={history.loaded && !historyStale}
          error={history.error}
          range={range}
        />
      </div>
    </div>
  )
}

// ---------- account card ----------

function AccountCard({ mode, state }: { mode: Mode; state: ModeState }) {
  const { account: a, error } = state
  const live = mode === 'live'
  const dpl = a?.dailyPl ?? null
  const dplUp = (dpl ?? 0) >= 0

  return (
    <div className="flex flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn('text-[10px]', live ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400')}
        >
          {mode}
        </Badge>
        {a?.status && (
          <span className={cn('text-[10px]', a.status === 'ACTIVE' ? 'text-emerald-500' : 'text-zinc-500')}>
            ● {a.status.toLowerCase()}
          </span>
        )}
        <Dialog>
          <DialogTrigger asChild>
            <button
              className="ml-auto flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              aria-label={`Open ${mode} account details`}
              title="Account details"
              disabled={!a}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </DialogTrigger>
          <DialogContent className="max-h-[80vh] overflow-y-auto border-zinc-800 bg-zinc-950 sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-sm text-zinc-100">
                {mode === 'live' ? 'Live' : 'Paper'} account details
              </DialogTitle>
            </DialogHeader>
            {a && <DetailsGrid a={a} />}
          </DialogContent>
        </Dialog>
      </div>

      {!state.loaded ? (
        <div className="flex h-[86px] items-center justify-center text-zinc-600">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !a ? (
        <div className="flex h-[86px] flex-col justify-center text-[11px] text-zinc-600">
          {error === 'no-keys' ? (
            <>No Alpaca keys — add them in Settings.</>
          ) : (
            <>Unavailable<span className="mt-0.5 block text-[10px] text-zinc-700">{error}</span></>
          )}
        </div>
      ) : (
        <>
          <div className="text-xl font-bold tabular-nums text-zinc-50" title="Account equity (balance)">
            {usd(a.equity)}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold tabular-nums" title="Daily P&L (equity − last session close equity)">
            <span className={dplUp ? 'text-emerald-400' : 'text-rose-400'}>
              {dplUp ? '▲' : '▼'} {usdSigned(dpl)}
              {a.dailyPlPct != null ? ` (${dplUp ? '+' : '−'}${Math.abs(a.dailyPlPct).toFixed(2)}%)` : ''}
            </span>
            <span className="ml-1 font-normal text-zinc-600">today</span>
          </div>
          <dl className="mt-2 space-y-0.5 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Cash</dt>
              <dd className="tabular-nums text-zinc-300">{usd(a.cash)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">Buying power</dt>
              <dd className="tabular-nums text-zinc-300">{usd(a.buyingPower)}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  )
}

function DetailsGrid({ a }: { a: AccountInfo }) {
  const bool = (v: boolean | null | undefined, invert = false) => {
    if (v == null) return <span className="text-zinc-600">—</span>
    const good = invert ? !v : v
    return <span className={good ? 'text-emerald-400' : 'text-rose-400'}>{v ? 'Yes' : 'No'}</span>
  }
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Account number', value: a.accountNumber ?? '—' },
    { label: 'Status', value: a.status ?? '—' },
    { label: 'Currency', value: a.currency ?? '—' },
    { label: 'Created', value: a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—' },
    { label: 'Equity', value: usd(a.equity) },
    { label: 'Last equity', value: usd(a.lastEquity) },
    { label: 'Portfolio value', value: usd(a.portfolioValue) },
    { label: 'Cash', value: usd(a.cash) },
    { label: 'Daily P&L', value: usdSigned(a.dailyPl) },
    { label: 'Buying power', value: usd(a.buyingPower) },
    { label: 'RegT buying power', value: usd(a.regtBuyingPower) },
    { label: 'Daytrade buying power', value: usd(a.daytradeBuyingPower) },
    { label: 'Non-marginable buying power', value: usd(a.nonMarginableBuyingPower) },
    { label: 'Daytrade count', value: a.daytradeCount ?? '—' },
    { label: 'Pattern day trader', value: bool(a.patternDayTrader) },
    { label: 'Multiplier', value: a.multiplier ?? '—' },
    { label: 'Initial margin', value: usd(a.initialMargin) },
    { label: 'Maintenance margin', value: usd(a.maintenanceMargin) },
    { label: 'SMA', value: usd(a.sma) },
    { label: 'Shorting enabled', value: bool(a.shortingEnabled) },
    { label: 'Trading blocked', value: bool(a.tradingBlocked, true) },
    { label: 'Transfers blocked', value: bool(a.transfersBlocked, true) },
    { label: 'Account blocked', value: bool(a.accountBlocked, true) },
  ]
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 border-b border-zinc-900 py-1">
          <dt className="min-w-0 truncate text-zinc-500">{r.label}</dt>
          <dd className="text-right tabular-nums text-zinc-200">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------- equity chart (inline SVG, no extra deps) ----------

function EquityChart({ points, loaded, error, range }: {
  points: HistoryPoint[]
  loaded: boolean
  error?: string
  range: Range
}) {
  const [ref, size] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const W = Math.max(size.w, 0)
  const H = Math.max(size.h, 0)
  const pad = { l: 8, r: 64, t: 12, b: 20 }

  const n = points.length
  let min = 0
  let max = 1
  if (n > 0) {
    const eqs = points.map((p) => p.eq)
    min = Math.min(...eqs)
    max = Math.max(...eqs)
    if (max - min < 1e-9) {
      min -= Math.abs(min) * 0.001 + 0.5
      max += Math.abs(max) * 0.001 + 0.5
    } else {
      const padY = (max - min) * 0.1
      min -= padY
      max += padY
    }
  }
  const xOf = (i: number) => (n <= 1 ? (pad.l + W - pad.r) / 2 : pad.l + (i * (W - pad.l - pad.r)) / (n - 1))
  const yOf = (v: number) => pad.t + ((max - v) / (max - min)) * (H - pad.t - pad.b)

  const first = n > 0 ? points[0].eq : 0
  const last = n > 0 ? points[n - 1].eq : 0
  const change = last - first
  const up = change >= 0
  const stroke = up ? '#34d399' : '#fb7185'

  const fmtTime = (t: number) => {
    const d = new Date(t * 1000)
    if (range === 'today' || range === 'hour' || range === 'day') {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === 'year') {
      return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
    }
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  const fmtFull = (t: number) =>
    new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  let path = ''
  let area = ''
  if (n > 1) {
    path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.eq).toFixed(1)}`).join(' ')
    area = `${path} L${xOf(n - 1).toFixed(1)},${(H - pad.b).toFixed(1)} L${xOf(0).toFixed(1)},${(H - pad.b).toFixed(1)} Z`
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(xOf(i) - x)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setHover(best)
  }

  const hoverP = hover != null && hover < n ? points[hover] : null

  return (
    <div className="relative min-h-[132px] flex-1" ref={ref}>
      {!loaded ? (
        <div className="flex h-full min-h-[132px] items-center justify-center text-zinc-600">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : n === 0 ? (
        <div className="flex h-full min-h-[132px] flex-col items-center justify-center px-4 text-center text-[11px] text-zinc-600">
          {error === 'no-keys'
            ? 'Add Alpaca keys in Settings to see the equity curve.'
            : error || 'No equity history for this range yet.'}
        </div>
      ) : (
        <>
          <svg
            width={W}
            height={H}
            className="block"
            role="img"
            aria-label={`Equity curve, ${range} range`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* baseline at the period's starting equity */}
            {n > 1 && (
              <line
                x1={pad.l}
                x2={W - pad.r}
                y1={yOf(first)}
                y2={yOf(first)}
                stroke="#3f3f46"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
            )}
            {n > 1 && <path d={area} fill="url(#eqFill)" />}
            {n > 1 && <path d={path} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />}
            {n === 1 && <circle cx={xOf(0)} cy={yOf(points[0].eq)} r="3" fill={stroke} />}
            {hoverP && (
              <g>
                <line x1={xOf(hover!)} x2={xOf(hover!)} y1={pad.t} y2={H - pad.b} stroke="#52525b" strokeWidth="1" strokeDasharray="2 3" />
                <circle cx={xOf(hover!)} cy={yOf(hoverP.eq)} r="3" fill={stroke} stroke="#09090b" strokeWidth="1" />
              </g>
            )}
            {/* y labels */}
            <text x={W - pad.r + 6} y={pad.t + 8} fontSize="9" fill="#71717a" className="tabular-nums">
              {usd(max, 0)}
            </text>
            <text x={W - pad.r + 6} y={H - pad.b - 2} fontSize="9" fill="#71717a" className="tabular-nums">
              {usd(min, 0)}
            </text>
            {/* x labels */}
            <text x={pad.l} y={H - 6} fontSize="9" fill="#71717a">{fmtTime(points[0].t)}</text>
            <text x={W - pad.r} y={H - 6} fontSize="9" fill="#71717a" textAnchor="end">{fmtTime(points[n - 1].t)}</text>
          </svg>
          {/* headline + tooltip */}
          <div className="pointer-events-none absolute left-2 top-0.5 text-[11px] font-semibold tabular-nums">
            <span className="text-zinc-100">{usd(last)}</span>
            <span className={cn('ml-1.5', up ? 'text-emerald-400' : 'text-rose-400')}>
              {up ? '+' : '−'}
              {usd(Math.abs(change))}
              {first ? ` (${up ? '+' : '−'}${Math.abs((change / first) * 100).toFixed(2)}%)` : ''}
            </span>
          </div>
          {hoverP && (
            <div
              className="pointer-events-none absolute z-10 rounded border border-zinc-700 bg-zinc-950/95 px-2 py-1 text-[10px] shadow-lg"
              style={{
                left: Math.min(Math.max(xOf(hover!) - 60, 0), Math.max(W - 132, 0)),
                top: 4,
              }}
            >
              <div className="text-zinc-400">{fmtFull(hoverP.t)}</div>
              <div className="tabular-nums text-zinc-100">Equity {usd(hoverP.eq)}</div>
              {hoverP.pl != null && (
                <div className={cn('tabular-nums', (hoverP.pl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                  P&L {usdSigned(hoverP.pl)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Element size observer (the SVG needs exact pixel dimensions). */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}
