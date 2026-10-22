'use client'

// Performance Report tab (Task 55) — a performance dashboard built from the
// FIFO-matched round-trip trades (/api/trading/history, the same matcher that
// powers the Positions tab's "Trade history" group):
//   1. Win / Loss bar chart bucketed per day / week / month / weekday /
//      month-of-year (by exit time; Task 70 added the fixed ET calendar modes)
//   2. Long vs Short donut (closed trades counted by entry direction)
//   3. Trades per week (weekly activity bars, zero weeks included)
//   4. Average hold time (mean + median of the round-trip durations)
//   5. Profit factor (gross profit ÷ gross loss) — plus win rate & net P&L
// Day/Week/Month aggregation runs client-side in the browser's local time, so
// the toggle is instant and the buckets are timezone-honest. The Weekday /
// Month-of-Year modes group ALL trades by the exit's America/New_York calendar
// day/month — the same ET day logic the rest of the terminal uses.
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
type Gran = 'day' | 'week' | 'month' | 'weekday' | 'monthyear'

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
const MANUAL_C = '#a1a1aa'
const ALGO_C = '#a78bfa'

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

// Weekday / month-of-year buckets use the exit's AMERICA/NEW_YORK calendar
// day/month (explicit timeZone → deterministic, no browser-TZ drift).
const etWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
const etMonth = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short' })
const WDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const MOY_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

interface Bucket {
  key: string
  label: string
  sort: number
}

function bucketOf(exitAt: string, gran: Gran): Bucket | null {
  const d = new Date(exitAt)
  const t = d.getTime()
  if (!Number.isFinite(t)) return null
  if (gran === 'weekday') {
    const label = etWeekday.format(d) // 'Mon'..'Sun' in ET
    return { key: label, label, sort: WDAY_ORDER.indexOf(label as (typeof WDAY_ORDER)[number]) }
  }
  if (gran === 'monthyear') {
    const label = etMonth.format(d) // 'Jan'..'Dec' in ET
    return { key: label, label, sort: MOY_ORDER.indexOf(label as (typeof MOY_ORDER)[number]) }
  }
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

/** Section title per bucket mode (day/week/month keep the "per X" wording). */
const GRAN_TITLE: Record<Gran, string> = {
  day: 'Win / Loss per day',
  week: 'Win / Loss per week',
  month: 'Win / Loss per month',
  weekday: 'Win / Loss by weekday',
  monthyear: 'Win / Loss by month of year',
}

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
  options, value, onChange, groupLabel, optionMeta,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  groupLabel: string
  /** optional explicit label + tooltip per option (falls back to the capitalized key) */
  optionMeta?: Partial<Record<T, { label?: string; title?: string }>>
}) {
  return (
    <div role="group" aria-label={groupLabel} className="flex overflow-hidden rounded-md border border-zinc-700">
      {options.map((o) => {
        const meta = optionMeta?.[o]
        return (
          <button
            key={o}
            type="button"
            aria-pressed={value === o}
            title={meta?.title}
            onClick={() => onChange(o)}
            className={cn(
              'min-h-[26px] px-2.5 py-0.5 text-[11px] font-medium transition-colors',
              meta?.label ? '' : 'capitalize',
              value === o
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
            )}
          >
            {meta?.label ?? o}
          </button>
        )
      })}
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

const srcConfig = {
  profit: { label: 'Gross profit' },
  loss: { label: 'Gross loss' },
} satisfies ChartConfig

interface SourceAcc {
  trades: number
  wins: number
  losses: number
  profit: number
  loss: number
  net: number
}

interface StratAcc {
  trades: number
  wins: number
  losses: number
  net: number
}

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

  // ---------- win / loss buckets (day | week | month | weekday | month of year) ----------
  const wlRows = useMemo<WlRow[]>(() => {
    if (agg.asc.length === 0) return []
    // Weekday / month-of-year: FIXED calendar buckets over ALL trades —
    // zero-count buckets stay visible so the shape of the week/year reads true.
    if (gran === 'weekday' || gran === 'monthyear') {
      const order: readonly string[] = gran === 'weekday' ? WDAY_ORDER : MOY_ORDER
      const rows: WlRow[] = order.map((label, i) => ({ key: label, label, sort: i, wins: 0, losses: 0, pnl: 0 }))
      const byKey = new Map(rows.map((r) => [r.key, r]))
      for (const t of agg.asc) {
        const b = bucketOf(t.exitAt, gran)
        const row = b ? byKey.get(b.key) : undefined
        if (!row) continue
        const pnl = Number.isFinite(t.pnl) ? t.pnl : 0
        row.pnl += pnl
        if (pnl > 0) row.wins++
        else if (pnl < 0) row.losses++
      }
      return rows
    }
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

  // ---------- Manual vs Algo attribution (Task 65) ----------
  // Each closed trade carries `source` (decoded from the entry order's
  // client_order_id: `ttr-` = algo run) and, for algo trades, the strategy name.
  const src = useMemo(() => {
    const acc: { manual: SourceAcc; algo: SourceAcc } = {
      manual: { trades: 0, wins: 0, losses: 0, profit: 0, loss: 0, net: 0 },
      algo: { trades: 0, wins: 0, losses: 0, profit: 0, loss: 0, net: 0 },
    }
    const strat = new Map<string, StratAcc>()
    for (const t of agg.asc) {
      const pnl = Number.isFinite(t.pnl) ? t.pnl : 0
      const a = t.source === 'algo' ? acc.algo : acc.manual
      a.trades++
      a.net += pnl
      if (pnl > 0) {
        a.wins++
        a.profit += pnl
      } else if (pnl < 0) {
        a.losses++
        a.loss += -pnl
      }
      if (t.source === 'algo') {
        const name = t.strategy || 'Algo'
        const s = strat.get(name) ?? { trades: 0, wins: 0, losses: 0, net: 0 }
        s.trades++
        s.net += pnl
        if (pnl > 0) s.wins++
        else if (pnl < 0) s.losses++
        strat.set(name, s)
      }
    }
    const chart = [
      // NOTE: no per-entry `fill` — recharts turns data-row fills into implicit
      // Cells that override the Bar's green/rose; source identity lives on the
      // X axis + the breakdown panel (MANUAL_C/ALGO_C dots there).
      { name: 'Manual', profit: Math.round(acc.manual.profit * 100) / 100, loss: Math.round(acc.manual.loss * 100) / 100, net: acc.manual.net, trades: acc.manual.trades },
      { name: 'Algo', profit: Math.round(acc.algo.profit * 100) / 100, loss: Math.round(acc.algo.loss * 100) / 100, net: acc.algo.net, trades: acc.algo.trades },
    ]
    return {
      acc,
      chart,
      strategies: [...strat.entries()].sort((a, b) => b[1].trades - a[1].trades),
    }
  }, [agg.asc])

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
                {GRAN_TITLE[gran]}
              </h2>
              <Segmented
                options={['day', 'week', 'month', 'weekday', 'monthyear'] as const}
                value={gran}
                onChange={setGran}
                groupLabel="Bucket size"
                optionMeta={{
                  weekday: { label: 'Weekday', title: 'All trades grouped by day of week (Mon–Sun, America/New_York)' },
                  monthyear: { label: 'Month of Year', title: 'All trades grouped by month of year (Jan–Dec, America/New_York)' },
                }}
              />
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
              {gran === 'weekday'
                ? 'By weekday of exit (America/New_York) · fixed Mon–Sun · zero buckets included · all trades'
                : gran === 'monthyear'
                  ? 'By month of exit (America/New_York) · fixed Jan–Dec · zero buckets included · all trades'
                  : `Buckets by exit time · ${gran === 'day' ? 'last 31 active days' : gran === 'week' ? 'last 26 active weeks' : 'last 24 active months'}`}
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
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 xl:col-span-2"
            aria-label="Manual vs algo profit and loss"
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Manual vs Algo — profit / loss</h2>
            <ChartContainer config={srcConfig} className="h-52 w-full" aria-label="Manual and algo gross profit and loss bar chart">
              <BarChart data={src.chart} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#27272a" />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={6}
                  tick={{ fontSize: 11, fill: '#a1a1aa' }}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`)}
                />
                <ChartTooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTooltipContent />} />
                <Bar dataKey="profit" fill={WIN_C} radius={[2, 2, 0, 0]} />
                <Bar dataKey="loss" fill={LOSS_C} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
            <p className="mt-1 text-[11px] text-zinc-500">
              Gross profit vs gross loss by placement source · Manual {src.acc.manual.trades} trade{src.acc.manual.trades === 1 ? '' : 's'} ({signedMoney(src.acc.manual.net)}) · Algo {src.acc.algo.trades} trade{src.acc.algo.trades === 1 ? '' : 's'} ({signedMoney(src.acc.algo.net)})
            </p>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4" aria-label="Trade source breakdown">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Trade source breakdown</h2>
            <div className="flex flex-col gap-1.5 text-xs">
              <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2">
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: MANUAL_C }} />
                <span className="font-semibold text-zinc-100">Manual</span>
                <span className="ml-auto tabular-nums text-zinc-400">
                  {src.acc.manual.trades} trade{src.acc.manual.trades === 1 ? '' : 's'} · {src.acc.manual.wins}W/{src.acc.manual.losses}L
                </span>
                <span className={cn('w-20 text-right font-semibold tabular-nums', pnlClass(src.acc.manual.net))}>
                  {signedMoney(src.acc.manual.net)}
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-violet-500/25 bg-violet-500/5 px-2.5 py-2">
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: ALGO_C }} />
                <span className="font-semibold text-zinc-100">Algo</span>
                <span className="ml-auto tabular-nums text-zinc-400">
                  {src.acc.algo.trades} trade{src.acc.algo.trades === 1 ? '' : 's'} · {src.acc.algo.wins}W/{src.acc.algo.losses}L
                </span>
                <span className={cn('w-20 text-right font-semibold tabular-nums', pnlClass(src.acc.algo.net))}>
                  {signedMoney(src.acc.algo.net)}
                </span>
              </div>
              {src.strategies.length > 0 && (
                <div className="mt-1 border-t border-zinc-800/80 pt-2">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">By strategy</div>
                  {src.strategies.map(([name, s]) => (
                    <div key={name} className="flex items-center gap-2 px-1 py-1 text-[11px]">
                      <span className="truncate text-violet-300" title={name}>{name}</span>
                      <span className="ml-auto tabular-nums text-zinc-500">{s.trades} trade{s.trades === 1 ? '' : 's'} · {s.wins}W/{s.losses}L</span>
                      <span className={cn('w-20 text-right font-semibold tabular-nums', pnlClass(s.net))}>
                        {signedMoney(s.net)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {src.acc.algo.trades === 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                  No algo trades yet — entries placed by Algo Trading runs are attributed automatically.
                </p>
              )}
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
