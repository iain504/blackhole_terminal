'use client'

// Reusable popover multi-select filter (used by the Economic Calendar country
// filter and the Heatmap sector filter). `selected` holds the INCLUDED values;
// an empty selection shows a "nothing matches" state managed by the caller.
import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface FilterOption {
  value: string
  label: string
  count?: number
  /** optional colored dot class shown next to the label */
  dotClass?: string
}

interface FilterMultiSelectProps {
  label: string
  options: FilterOption[]
  /** set of INCLUDED values */
  selected: Set<string>
  onChange: (next: Set<string>) => void
  /** total options count for the trigger label (options can grow on refresh) */
  triggerClassName?: string
}

export function FilterMultiSelect({ label, options, selected, onChange, triggerClassName }: FilterMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const allOn = options.length > 0 && options.every((o) => selected.has(o.value))
  const selCount = options.filter((o) => selected.has(o.value)).length

  const toggle = (v: string) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange(next)
  }
  const setAll = (on: boolean) => onChange(on ? new Set(options.map((o) => o.value)) : new Set())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 gap-1.5 border-zinc-800 bg-zinc-900/80 px-2 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
            !allOn && 'border-emerald-500/40 text-emerald-400',
            triggerClassName,
          )}
          aria-label={`Filter by ${label}`}
        >
          {allOn ? `${label}: All` : `${label}: ${selCount}/${options.length}`}
          <ChevronsUpDown className="h-3 w-3 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
          <div className="flex gap-1">
            <button
              onClick={() => setAll(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              All
            </button>
            <button
              onClick={() => setAll(false)}
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              None
            </button>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto [scrollbar-width:thin]">
          {options.length === 0 && <p className="px-1 py-2 text-xs text-zinc-500">No options</p>}
          {options.map((o) => {
            const on = selected.has(o.value)
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(o.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                  on ? 'text-zinc-100' : 'text-zinc-500',
                  'hover:bg-zinc-800/80',
                )}
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                    on ? 'border-emerald-500 bg-emerald-500/90 text-zinc-950' : 'border-zinc-600 bg-transparent',
                  )}
                  aria-hidden="true"
                >
                  {on && <Check className="size-2.5" strokeWidth={3.5} />}
                </span>
                {o.dotClass && <span className={cn('size-1.5 shrink-0 rounded-full', o.dotClass)} aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.count != null && <span className="tabular-nums text-[10px] text-zinc-500">{o.count}</span>}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
