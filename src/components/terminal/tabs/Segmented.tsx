'use client'

// Segmented (Task 78) — the compact radio-style pill control used across the
// Algo tab: the "Live runs | Backtest" view switcher, the timeframe picker,
// the Risk-Money sizing selector and the backtest win/loss granularity.
//
// Replaces the ad-hoc pill buttons with one consistent visual language:
//   • equal-height, evenly-padded segments inside a recessed track
//   • selected segment = raised zinc chip (inset highlight + hairline ring)
//   • unselected = muted, with hover feedback
//   • optional `grow` — segments stretch to equal widths (aligned space)
//   • `size` sm (h-6, dense toolbars) | md (h-8, form rows)
//
// Accessibility: a labelled group of real buttons with aria-pressed — honest
// toggle semantics (no fake radiogroup roving-tabindex), fully keyboard usable.
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  title?: string
}

export function Segmented<T extends string>({
  value, onChange, options, ariaLabel, size = 'sm', grow = false, className,
}: {
  value: T
  onChange: (v: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel: string
  size?: 'sm' | 'md'
  grow?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-stretch rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]',
        className,
      )}
    >
      {options.map((o) => {
        const sel = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={sel}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-md font-medium transition-colors duration-100',
              size === 'sm' ? 'h-6 px-2.5 text-[11px]' : 'h-7 px-3 text-xs',
              grow && 'min-w-0 flex-1',
              sel
                ? 'bg-zinc-800 text-zinc-100 ring-1 ring-zinc-600/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_1px_2px_rgba(0,0,0,0.4)]'
                : 'text-zinc-500 hover:bg-zinc-900/70 hover:text-zinc-300',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
