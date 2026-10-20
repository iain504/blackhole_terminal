'use client'

// Performance Report tab (Task 55) — a performance dashboard built from the
// FIFO-matched round-trip trades (/api/trading/history, the same matcher that
// powers the Positions tab's "Trade history" group):
//   1. Win / Loss bar chart bucketed per day / week / month (by exit time)
//   2. Long vs Short donut (closed trades counted by entry direction)
//   3. Trades per week (weekly activity bars, zero weeks included)
//   4. Average hold time (mean + median of the round-trip durations)
//   5. Profit factor (gross profit ÷ gross loss) — plus win rate & net P&L
// All aggregation runs client-side in the browser's local time, so the
// Day/Week/Month toggle is instant and the buckets are timezone-honest.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts'
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ListChecks, RefreshCw, Scale, Target, Timer, TrendingUp } from 'lucide-react'
import { ClosedTrade, fmtHeldDuration } from '@/lib/market-types'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'
type Gran = 'day' | 'week' | 'month'

interface ModeHistory {
  trades: ClosedTrade[]
  configured: boolean
  loaded: boolean
  error?: string
}

const EMPTY: ModeHistory = { trades: [], configured: true, loaded: false }
const MODES: Mode[] = ['paper', 'live']

const WIN_C = '#10b981'
const LOSS_C = '#f43f5e'
const LONG_C = '#14b8a6'
const SHORT_C = '#f59e0b'
const WEEK_C = '#a1a1aa'

const DAY = 86_400_000
const WEEK = 7 * DAY

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Monday 00:00 (local) of the week containing d. */
function weekStart(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7))
  return s
}

// Explicit locale → server and client render identical labels (no hydration drift).
const fmtShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const fmtMonth = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' })

interface Bucket {
  key: string
  label: string
  sort: number
}

function bucketOf(exitAt: string, gran: Gran): Bucket | null {
  const d = new Date(exitAt)
  const t = d.getTime()
  if (!Number.isFinite(t)) return null
  if (gran === 'month') {
    return {
      key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      label: fmtMonth.format(d),
      sort: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    }
  }
  if (gran === 'week') {
    const s = weekStart(d)
    return { key: `w${s.getTime()}`, label: fmtShort.format(s), sort: s.getTime() }
  }
  return {
    key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    label: fmtShort.format(d),
    sort: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
  }
}

interface WlRow {
  key: string
  label: string
  sort: number
  wins: number
  losses: number
  pnl: number
}

interface WeekRow {
  key: string
  label: string
  trades: number
}

function money(v: number): string {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '-' : ''}$${s}`
}

function signedMoney(v: number): string {
  return `${v > 0 ? '+' : ''}${money(v)}`
}

const pnlClass = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-100')

function StatCard({
  icon: Icon, label, value, sub, valueClass,
}: {
  icon: typeof Scale
  label: string
  value: string
  sub?: string
  valueClass?: string
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <div className={cn('mt-1.5 truncate text-xl font-semibold tabular-nums text-zinc-100', valueClass)}>
        {value}
      </div>
      {sub && <div className="mt-1 truncate text-[11px] text-zinc-500" title={sub}>{sub}</div>}
    </div>
  )
}

function Segmented<T extends string>({
  options, value, onChange, groupLabel,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  groupLabel: string
}) {
  return (
    <div role="group" aria-label={groupLabel} className="flex overflow-hidden rounded-md border border-zinc-700">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={cn(
            'min-h-[26px] px-2.5 py-0.5 text-[11px] font-medium capitalize transition-colors',
            value === o
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
          )}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

const wlConfig = {
  wins: { label: 'Wins' },
  losses: { label: 'Losses' },
} satisfies ChartConfig

const weekConfig = {
  trades: { label: 'Trades' },
} satisfies ChartConfig

const sideConfig = {
  Long: { label: 'Long' },
  Short: { label: 'Short' },
} satisfies ChartConfig

export default function ReportTab() {
  const [mode, setMode] = useState<Mode>('paper')
  const [gran, setGran] = useState<Gran>('day')
  const [data, setData] = useState<Record<Mode, ModeHistory>>({ paper: EMPTY, live: EMPTY })
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (m: Mode) => {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/trading/history?mode=${m}&limit=300`, { cache: 'no-store' })
      const json = (await res.json().catch(() => null)) as
        | { mode?: string; trades?: ClosedTrade[]; configured?: boolean; error?: string }
        | null
      if (!res.ok) {
        setData((prev) => ({
          ...prev,
          [m]: { trades: [], configured: true, loaded: true, error: json?.error || `Request failed (HTTP ${res.status})` },
        }))
        return
      }
      const trades = Array.isArray(json?.trades) ? json.trades : []
      setData((prev) => ({ ...prev, [m]: { trades, configured: json?.configured !== false, loaded: true } }))
    } catch {
      setData((prev) => ({
        ...prev,
        [m]: { trades: [], configured: true, loaded: true, error: 'Network error — could not load trade history' },
      }))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    for (const m of MODES) void load(m)
  }, [load])

  const cur = data[mode]
  const trades = cur.trades

  // ---------- headline stats ----------
  const agg = useMemo(() => {
    const asc = trades
      .filter((t) => Number.isFinite(new Date(t.exitAt).getTime()))
      .sort((a, b) => new Date(a.exitAt).getTime() - new Date(b.exitAt).getTime())
    let wins = 0
    let losses = 0
    let flat = 0
    let grossProfit = 0
    let grossLoss = 0
    let net = 0
    let longs = 0
    let shorts = 0
    let longPnl = 0
    let shortPnl = 0
    let holdSum = 0
    const holds: number[] = []
    for (const t of asc) {
      const pnl = Number.isFinite(t.pnl) ? t.pnl : 0
      net += pnl
      if (pnl > 0) {
        wins++
        grossProfit += pnl
      } else if (pnl < 0) {
        losses++
        grossLoss += -pnl
      } else {
        flat++
      }
      if (t.side === 'short') {
        shorts++
        shortPnl += pnl
      } else {
        longs++
        longPnl += pnl
      }
      const ms = Math.max(0, Number(t.durationMs) || 0)
      holdSum += ms
      holds.push(ms)
    }
    const total = asc.length
    const decided = wins + losses
    holds.sort((a, b) => a - b)
    return {
      asc,
      total,
      wins,
      losses,
      flat,
      grossProfit,
      grossLoss,
      net,
      winRate: decided > 0 ? (wins / decided) * 100 : null,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
      avgHold: total > 0 ? holdSum / total : 0,
      medianHold: holds.length > 0 ? holds[Math.floor(holds.length / 2)] : 0,
      longs,
      shorts,
      longPnl,
      shortPnl,
    }
  }, [trades])

  // ---------- win / loss buckets (day | week | month) ----------
  const wlRows = useMemo<WlRow[]>(() => {
    if (agg.asc.length === 0) return []
    const map = new Map<string, WlRow>()
    for (const t of agg.asc) {
      const b = bucketOf(t.exitAt, gran)
      if (!b) continue
      let row = map.get(b.key)
      if (!row) {
        row = { key: b.key, label: b.label, sort: b.sort, wins: 0, losses: 0, pnl: 0 }
        map.set(b.key, row)
      }
      const pnl = Number.isFinite(t.pnl) ? t.pnl : 0
      row.pnl += pnl
      if (pnl > 0) row.wins++
      else if (pnl < 0) row.losses++
    }
    const rows = [...map.values()].sort((a, b) => a.sort - b.sort)
    const cap = gran === 'day' ? 31 : gran === 'week' ? 26 : 24
    return rows.slice(-cap)
  }, [agg.asc, gran])

  // ---------- trades per week (zero weeks filled, ≥12 weeks window) ----------
  const weekRows = useMemo<WeekRow[]>(() => {
    if (agg.asc.length === 0) return []
    const counts = new Map<number, number>()
    for (const t of agg.asc) {
      const s = weekStart(new Date(t.exitAt)).getTime()
      if (!Number.isFinite(s)) continue
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    const nowW = weekStart(new Date()).getTime()
    const firstW = weekStart(new Date(agg.asc[0].exitAt)).getTime()
    const start = Math.max(nowW - 25 * WEEK, firstW)
    const rows: WeekRow[] = []
    // advance via +8 days snapped back to Monday so DST shifts cannot stall the loop
    for (let cursor = new Date(start); cursor.getTime() <= nowW; cursor = weekStart(new Date(cursor.getTime() + 8 * DAY))) {
      const t = cursor.getTime()
      rows.push({ key: `w${t}`, label: fmtShort.format(cursor), trades: counts.get(t) ?? 0 })
    }
    return rows
  }, [agg.asc])

  const pieData = useMemo(
    () => [
      { name: 'Long', value: agg.longs, fill: LONG_C },
      { name: 'Short', value: agg.shorts, fill: SHORT_C },
    ],
    [agg.longs, agg.shorts],
  )

  // ---------- render states ----------
  if (!cur.loaded) {
    return (
      <div className="flex h-full flex-col bg-zinc-950/40">
        <ReportHeader mode={mode} setMode={setMode} onRefresh={() => void load(mode)} refreshing={refreshing} />
        <div className="min-h-0 flex-1 p-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-[86px] animate-pulse rounded-lg bg-zinc-800/60" />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="h-64 animate-pulse rounded-lg bg-zinc-800/60 xl:col-span-2" />
            <div className="h-64 animate-pulse rounded-lg bg-zinc-800/60" />
            <div className="h-56 animate-pulse rounded-lg bg-zinc-800/60 xl:col-span-3" />
          </div>
        </div>
      </div>
    )
  }

  if (cur.error) {
    return (
      <div className="flex h-full flex-col bg-zinc-950/40">
        <ReportHeader mode={mode} setMode={setMode} onRefresh={() => void load(mode)} refreshing={refreshing} />
        <EmptyState
          icon={<RefreshCw className="h-5 w-5 text-rose-400" />}
          title="Could not load the report"
          body={cur.error}
          action={
            <Button variant="outline" size="sm" className="border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={() => void load(mode)}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!cur.configured) {
    return (
      <div className="flex h-full flex-col bg-zinc-950/40">
        <ReportHeader mode={mode} setMode={setMode} onRefresh={() => void load(mode)} refreshing={refreshing} />
        <EmptyState
          icon={<Scale className="h-5 w-5 text-zinc-400" />}
          title="No trading keys configured"
          body={`Add your Alpaca API keys in Settings to build a ${mode} performance report from your closed trades.`}
        />
      </div>
    )
  }

  if (agg.total === 0) {
    return (
      <div className="flex h-full flex-col bg-zinc-950/40">
        <ReportHeader mode={mode} setMode={setMode} onRefresh={() => void load(mode)} refreshing={refreshing} />
        <EmptyState
          icon={<ListChecks className="h-5 w-5 text-zinc-400" />}
          title="No closed trades yet"
          body="The report builds from realized round-trip trades — close a position (manually or via TP/SL) and it will show up here."
        />
      </div>
    )
  }

  const pf = agg.profitFactor
  const pfText = pf === Infinity ? '∞' : pf == null ? '—' : pf.toFixed(2)
  const pfClass = pf == null ? 'text-zinc-100' : pf >= 1.5 ? 'text-emerald-400' : pf >= 1 ? 'text-zinc-100' : 'text-rose-400'

  return (
    <div className="flex h-full flex-col bg-zinc-950/40">
      <ReportHeader mode={mode} setMode={setMode} onRefresh={() => void load(mode)} refreshing={refreshing} />

      <div className="terminal-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {/* stat cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <StatCard
            icon={Scale}
            label="Profit factor"
            value={pfText}
            valueClass={pfClass}
            sub={`gross win ${money(agg.grossProfit)} · loss ${money(agg.grossLoss)}`}
          />
          <StatCard
            icon={Target}
            label="Win rate"
            value={agg.winRate == null ? '—' : `${agg.winRate.toFixed(1)}%`}
            sub={`${agg.wins}W · ${agg.losses}L${agg.flat > 0 ? ` · ${agg.flat} flat` : ''}`}
          />
          <StatCard
            icon={Timer}
            label="Avg hold time"
            value={agg.total > 0 ? fmtHeldDuration(agg.avgHold) : '—'}
            sub={`median ${agg.total > 0 ? fmtHeldDuration(agg.medianHold) : '—'}`}
          />
          <StatCard
            icon={TrendingUp}
            label="Net P&L"
            value={signedMoney(agg.net)}
            valueClass={pnlClass(agg.net)}
            sub={`${agg.total} closed trade${agg.total === 1 ? '' : 's'}`}
          />
          <StatCard
            icon={ListChecks}
            label="Long / Short"
            value={`${agg.longs} / ${agg.shorts}`}
            sub={`long ${signedMoney(agg.longPnl)} · short ${signedMoney(agg.shortPnl)}`}
          />
        </div>

        {/* charts */}
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <section
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 xl:col-span-2"
            aria-label="Win and loss count per period"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Win / Loss per {gran}
              </h2>
              <Segmented options={['day', 'week', 'month'] as const} value={gran} onChange={setGran} groupLabel="Bucket size" />
            </div>
            <ChartContainer config={wlConfig} className="h-56 w-full" aria-label={`Win/loss bar chart per ${gran}`}>
              <BarChart data={wlRows} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#27272a" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={6}
                  minTickGap={22}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                />
                <ChartTooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTooltipContent />} />
                <Bar dataKey="wins" stackId="a" fill={WIN_C} />
                <Bar dataKey="losses" stackId="a" fill={LOSS_C} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
            <p className="mt-1 text-[11px] text-zinc-500">
              Buckets by exit time · {gran === 'day' ? 'last 31 active days' : gran === 'week' ? 'last 26 active weeks' : 'last 24 active months'}
            </p>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4" aria-label="Long vs short trades">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Long vs Short</h2>
            <div className="relative">
              <ChartContainer config={sideConfig} className="h-56 w-full" aria-label="Long and short trade count pie chart">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={54}
                    outerRadius={80}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {pieData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-semibold tabular-nums text-zinc-100">{agg.total}</span>
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">trades</span>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-zinc-400">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: LONG_C }} />
                Long {agg.longs} <span className={cn('tabular-nums', pnlClass(agg.longPnl))}>({signedMoney(agg.longPnl)})</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: SHORT_C }} />
                Short {agg.shorts} <span className={cn('tabular-nums', pnlClass(agg.shortPnl))}>({signedMoney(agg.shortPnl)})</span>
              </span>
            </div>
          </section>

          <section
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 xl:col-span-3"
            aria-label="Trades per week"
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Trades per week</h2>
            <ChartContainer config={weekConfig} className="h-48 w-full" aria-label="Trades per week bar chart">
              <BarChart data={weekRows} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#27272a" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={6}
                  minTickGap={22}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                />
                <ChartTooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTooltipContent />} />
                <Bar dataKey="trades" fill={WEEK_C} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
            <p className="mt-1 text-[11px] text-zinc-500">Weeks start Monday (local time) · zero weeks included</p>
          </section>
        </div>
      </div>
    </div>
  )
}

function ReportHeader({
  mode, setMode, onRefresh, refreshing,
}: {
  mode: Mode
  setMode: (m: Mode) => void
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
      <h1 className="text-sm font-semibold text-zinc-100">Performance Report</h1>
      <Badge variant="outline" className="border-zinc-700 text-[10px] uppercase text-zinc-400">
        {mode}
      </Badge>
      <div className="ml-auto flex items-center gap-2">
        <Segmented options={MODES} value={mode} onChange={setMode} groupLabel="Trading mode" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
          onClick={onRefresh}
          aria-label="Refresh report"
          title="Refresh report"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </Button>
      </div>
    </header>
  )
}

function EmptyState({
  icon, title, body, action,
}: {
  icon: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon}
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        <p className="text-xs leading-relaxed text-zinc-500">{body}</p>
        {action}
      </div>
    </div>
  )
}
