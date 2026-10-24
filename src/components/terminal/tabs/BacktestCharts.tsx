'use client'

// Backtest charts (Task 4-a) — split out of BacktestPanel so recharts leaves
// the main bundle. recharts is imported HERE (and transitively by
// @/components/ui/chart); BacktestPanel next/dynamic-imports these two
// components with ssr:false and shows a matching skeleton while the chunk
// streams in.
//
//   • EquityChart — realized equity curve. The server already downsamples the
//     series to ≤500 points (Task 3-d); the panel may stride further.
//   • WlChart — win/loss buckets by the EXIT bar's time in America/New_York
//     (Task 71-2): hour of day / weekday / month, zero-count buckets visible.
//
// The formatters below are deliberate local copies: importing them from
// BacktestPanel would add a static edge back into the recharts chunk and
// defeat the dynamic boundary.
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Segmented } from '@/components/terminal/tabs/Segmented'

type Gran = 'hour' | 'weekday' | 'monthyear'

const fmtUsd = (v: number) =>
  (Math.abs(v) >= 1000 ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`)
const fmtDay = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtClockT = (t: number) =>
  new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

const eqConfig = { equity: { label: 'Equity', color: '#34d399' } } satisfies ChartConfig
const btWlConfig = { wins: { label: 'Wins' }, losses: { label: 'Losses' } } satisfies ChartConfig

const BT_GRAN_TITLES: Record<Gran, string> = {
  hour: 'hour of day',
  weekday: 'day of week',
  monthyear: 'month of year',
}

export function EquityChart({ data }: { data: { t: number; equity: number }[] }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Equity curve (realized)</p>
      <ChartContainer config={eqConfig} className="h-40 w-full" aria-label="Backtest equity curve">
        <AreaChart data={data} margin={{ left: 2, right: 8, top: 6, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtDay} minTickGap={48} stroke="#52525b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => fmtUsd(v)} stroke="#52525b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={58} />
          <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(l) => fmtClockT(Number(l))} formatter={(v) => [fmtUsd(Number(v)), 'Equity']} />} />
          <Area type="monotone" dataKey="equity" stroke="#34d399" fill="#34d399" fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}

export function WlChart({ rows, gran, onGran, total }: {
  rows: { key: string; label: string; wins: number; losses: number; pnl: number }[]
  gran: Gran
  onGran: (g: Gran) => void
  total: number
}) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Win / Loss breakdown</p>
        <Segmented
          ariaLabel="Win/loss bucket size"
          size="sm"
          value={gran}
          onChange={onGran}
          options={[
            { value: 'hour', label: 'Hour of day' },
            { value: 'weekday', label: 'Day of week' },
            { value: 'monthyear', label: 'Month of year' },
          ]}
        />
        <span className="ml-auto flex items-center gap-3 text-[10px] text-zinc-500">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: '#10b981' }} aria-hidden />Wins</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: '#f43f5e' }} aria-hidden />Losses</span>
        </span>
      </div>
      <ChartContainer config={btWlConfig} className="mt-1 h-52 w-full" aria-label={`Backtest win/loss by ${BT_GRAN_TITLES[gran]}`}>
        <BarChart data={rows} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#27272a" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={10} tick={{ fontSize: 10, fill: '#71717a' }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={34} tick={{ fontSize: 10, fill: '#71717a' }} />
          <ChartTooltip
            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
            content={
              <ChartTooltipContent
                labelFormatter={(label, payload) => {
                  const row = payload?.[0]?.payload as { pnl?: number } | undefined
                  const net = row && typeof row.pnl === 'number' && Number.isFinite(row.pnl) && row.pnl !== 0 ? ` · net ${fmtUsd(row.pnl)}` : ''
                  return `${String(label)}${net}`
                }}
              />
            }
          />
          <Bar dataKey="wins" stackId="wl" fill="#10b981" />
          <Bar dataKey="losses" stackId="wl" fill="#f43f5e" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartContainer>
      <p className="mt-1 text-[11px] text-zinc-500">
        By exit time in America/New_York · fixed {gran === 'hour' ? '00–23 hours' : gran === 'weekday' ? 'Mon–Sun' : 'Jan–Dec'} · zero-count buckets included · all {total} trade{total === 1 ? '' : 's'}
      </p>
    </div>
  )
}
