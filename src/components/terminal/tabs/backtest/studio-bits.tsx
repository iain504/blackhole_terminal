'use client'

// v2.2.0 — Backtest Studio UI building blocks (Task 4-b).
//
// The step rail (✓ complete / ● current / ○ pending, click-to-jump), the
// collapsible step shell (expanded body ↔ compact summary row), and the few
// small controls the five steps share. All shadcn/ui primitives + Tailwind
// tokens; interactive elements keep ≥44px touch targets where they are
// standalone buttons.
import { Check, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export type RailState = 'done' | 'current' | 'pending'

export interface RailStep {
  n: number
  label: string
  state: RailState
  /** one-line status shown on the collapsed summary row + mobile chip title */
  summary?: string
}

function StateDot({ state }: { state: RailState }) {
  if (state === 'done') {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-400" aria-hidden>
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'current') {
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_8px_2px_rgb(251_191_36/0.4)]" aria-hidden />
  }
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-zinc-600" aria-hidden />
}

/**
 * Step rail — vertical sticky list on md+, horizontal scroll chips on mobile
 * (spec §2.2). Buttons carry aria-current="step" for the active step.
 */
export function StepperRail({ steps, onSelect, vertical, label }: {
  steps: RailStep[]
  onSelect: (n: number) => void
  vertical?: boolean
  label: string
}) {
  if (vertical) {
    return (
      <nav aria-label={label} className="flex w-44 shrink-0 flex-col gap-1">
        {steps.map((s) => (
          <button
            key={s.n}
            type="button"
            aria-current={s.state === 'current' ? 'step' : undefined}
            onClick={() => onSelect(s.n)}
            className={cn(
              'flex min-h-[44px] items-center gap-2 rounded-md border px-2.5 py-2 text-left text-[11px] transition-colors',
              s.state === 'current'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-zinc-800/70 bg-zinc-950/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
            )}
          >
            <StateDot state={s.state} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium leading-tight">{s.n}. {s.label}</span>
              {s.summary && s.state !== 'current' && (
                <span className="block truncate text-[9px] leading-tight text-zinc-600">{s.summary}</span>
              )}
            </span>
          </button>
        ))}
      </nav>
    )
  }
  return (
    <nav aria-label={label} className="flex gap-1.5 overflow-x-auto pb-1 terminal-scroll">
      {steps.map((s) => (
        <button
          key={s.n}
          type="button"
          aria-current={s.state === 'current' ? 'step' : undefined}
          title={s.summary}
          onClick={() => onSelect(s.n)}
          className={cn(
            'flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] transition-colors',
            s.state === 'current'
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
              : s.state === 'done'
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300/90'
                : 'border-zinc-800 bg-zinc-950/60 text-zinc-400',
          )}
        >
          <StateDot state={s.state} />
          {s.label}
        </button>
      ))}
    </nav>
  )
}

/**
 * One wizard step (spec §2.2): number badge + title + subtitle when expanded;
 * a compact clickable summary row once completed. `<section aria-labelledby>`
 * per the a11y contract.
 */
export function StudioStep({ id, n, icon: Icon, tone, title, sub, expanded, complete, summary, onExpand, refEl, children, last }: {
  id: string
  n: number
  icon: LucideIcon
  tone: string
  title: string
  sub: string
  expanded: boolean
  complete?: boolean
  summary?: string
  onExpand?: () => void
  refEl: (el: HTMLDivElement | null) => void
  children: React.ReactNode
  /** last step — no bottom connector padding tweak */
  last?: boolean
}) {
  return (
    <div ref={refEl} className="scroll-mt-16">
      <section
        id={id}
        aria-labelledby={`${id}-title`}
        className={cn(
          'rounded-md border bg-zinc-950/50 transition-colors',
          expanded ? 'border-zinc-700/80' : 'border-zinc-800/70 hover:border-zinc-700',
          last && 'border-violet-500/25',
        )}
      >
        {expanded ? (
          <>
            <header className="flex flex-wrap items-center gap-2 p-3 pb-1 md:p-4 md:pb-1">
              <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', tone)} aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-zinc-700 bg-zinc-900 text-[9px] font-bold text-zinc-300" aria-hidden>
                {n}
              </span>
              <div className="min-w-0 flex-1">
                <p id={`${id}-title`} className="text-xs font-semibold text-zinc-100">{title}</p>
                <p className="text-[10px] leading-tight text-zinc-500">{sub}</p>
              </div>
              {complete && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                  <Check className="h-2.5 w-2.5" aria-hidden /> done
                </span>
              )}
            </header>
            <div className="p-3 pt-1 md:p-4 md:pt-2">{children}</div>
          </>
        ) : (
          <button
            type="button"
            onClick={onExpand}
            aria-expanded={false}
            aria-controls={id}
            className="flex min-h-[44px] w-full items-center gap-2 p-3 text-left md:px-4"
          >
            <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg opacity-80', tone)} aria-hidden>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-zinc-800 bg-zinc-900 text-[9px] font-bold text-zinc-500" aria-hidden>
              {n}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold text-zinc-300">{title}</span>
              {summary && <span className="block truncate text-[10px] leading-tight text-zinc-500">{summary}</span>}
            </span>
            {complete && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />}
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
          </button>
        )}
      </section>
    </div>
  )
}

/** Next-step button at the bottom of steps ①–④ ("one click done" flow). */
export function NextStepButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/80 px-4 text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-40"
    >
      Next · {label}
      <ChevronDown className="h-3.5 w-3.5 -rotate-90" aria-hidden />
    </button>
  )
}

/** Small non-interactive info chip (status summaries inside steps). */
export function MiniChip({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', dim ? 'border-zinc-800/70 bg-zinc-900/50 text-zinc-600' : 'border-zinc-800 bg-zinc-900/80 text-zinc-400')}>
      {label} <span className="tabular-nums text-zinc-200">{value}</span>
    </span>
  )
}

/** Selectable pill chip (TF picker, history-window chips). */
export function ChipButton({ active, disabled, onClick, title, children, ariaLabel }: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'min-h-[36px] rounded border px-3 text-[11px] tabular-nums transition-colors',
        active
          ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
          : disabled
            ? 'border-zinc-800/60 text-zinc-700'
            : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800',
      )}
    >
      {children}
    </button>
  )
}

/** Switch row with label + micro-hint (guards, trailing, dyn-slip…). */
export function ToggleRow({ id, label, hint, checked, onChange, title }: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  title?: string
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-2 rounded border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-2">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-[11px] leading-tight text-zinc-300" title={title}>{label}</Label>
        {hint && <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="scale-90" />
    </div>
  )
}

/** Tiny labeled numeric input (grid min/max/step). */
export function NumIn({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode="decimal"
      aria-label={label}
      className="h-8 w-16 border-zinc-800 bg-zinc-950 text-xs"
    />
  )
}
