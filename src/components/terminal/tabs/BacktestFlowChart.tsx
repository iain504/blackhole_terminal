'use client'

// BacktestFlowChart — v2.2.0 (Task 4-b, spec §2.4)
//
// The backtest pipeline as a VERTICAL production line, so the user can SEE
// where a run is instead of parsing a bare "34% · strategy 2/4 · ORB 15m" line:
//
//   Fetch bars
//     → [swing only] Aggregate HTF (trend + confirm · pivots/S-R)
//     → Prepare series
//     → Replay
//     → Validate (per level: WF folds | sweep + OOS | grid)
//     → Verdict
//     → 🏆 Result
//
//   • the phase currently executing BLINKS YELLOW
//   • a finished phase turns GREEN (with a check badge)
//   • when the whole run lands, the final result node turns GOLDEN
//   • the swing-only HTF node renders for swing lanes and is OMITTED for day
//     lanes; server job phases (fetch|prepare|replay|grid|sweep|oos|folds|
//     holdout|verdict|result) map onto the nodes via PHASE_NODE
//
// Compact and collapsible: open by default on md+, collapsed to a one-line
// disclosure on mobile (both toggleable).
import { useState, useSyncExternalStore } from 'react'
import {
  BadgeCheck, ChartLine, Check, Database, Grid3x3, Layers, Play, Repeat, ShieldCheck, Target, Trophy, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type BtFlowMode = 'run' | 'optimize' | 'sweep' | 'walkforward'

interface FlowNodeDef {
  id: string
  label: string
  icon: LucideIcon
  /** one-line "what happens here" for the native tooltip */
  hint: string
}

const NODES: Record<string, FlowNodeDef> = {
  fetch: { id: 'fetch', label: 'Fetch bars', icon: Database, hint: 'Download historical bars (symbol · entry TF · window) — cached after the first run' },
  htf: { id: 'htf', label: 'Aggregate HTF', icon: Layers, hint: 'Swing lane: bucket bars into the trend + confirm timeframes and detect S/R pivots — no look-ahead, closed bars only' },
  prepare: { id: 'prepare', label: 'Prepare', icon: ChartLine, hint: 'Build the price + indicator series (RSI, SMA, ATR, session maps) the strategy replays over' },
  replay: { id: 'replay', label: 'Replay', icon: Play, hint: 'Replay bar-by-bar: signal → next-open fill · brackets · exits, with the documented cost model' },
  grid: { id: 'grid', label: 'Grid search', icon: Grid3x3, hint: 'Score every parameter combination on the full period' },
  sweep: { id: 'sweep', label: 'Sweep', icon: Layers, hint: 'Backtest every lane-matching strategy at defaults + its auto grid' },
  folds: { id: 'folds', label: 'WF folds', icon: Repeat, hint: 'Re-optimize on each fold\'s in-sample window, verify out-of-sample' },
  oos: { id: 'oos', label: 'OOS verify', icon: ShieldCheck, hint: 'Re-run the winners untouched on the out-of-sample tail' },
  holdout: { id: 'holdout', label: 'Hold-out', icon: Target, hint: 'Stress the surviving config on pure unseen data' },
  verdict: { id: 'verdict', label: 'Verdict', icon: BadgeCheck, hint: 'Metrics · trust CI · Monte Carlo — plain-language significance verdict' },
}

/** Per-mode pipeline (swing inserts the HTF node; the golden result node is appended automatically). */
const PIPELINES: Record<BtFlowMode, string[]> = {
  run: ['fetch', 'prepare', 'replay', 'verdict'],
  optimize: ['fetch', 'prepare', 'replay', 'grid', 'verdict'],
  sweep: ['fetch', 'prepare', 'replay', 'sweep', 'oos', 'verdict'],
  walkforward: ['fetch', 'prepare', 'replay', 'folds', 'holdout', 'verdict'],
}

/** Server job phase → node id (the validate stage fan-in, spec §2.4). */
const PHASE_NODE: Record<string, string> = {
  fetch: 'fetch',
  htf: 'htf',
  prepare: 'prepare',
  replay: 'replay',
  grid: 'grid',
  sweep: 'sweep',
  oos: 'oos',
  folds: 'folds',
  holdout: 'holdout',
  verdict: 'verdict',
  result: 'verdict',
}

const MODE_LABEL: Record<BtFlowMode, string> = {
  run: 'Run backtest',
  optimize: 'Optimizer',
  sweep: 'Strategy sweep',
  walkforward: 'Walk-forward',
}

interface BacktestFlowChartProps {
  mode: BtFlowMode
  /** swing lane → the HTF aggregate node is drawn; day lane omits it */
  swing?: boolean
  /** id of the phase currently executing — it blinks yellow */
  activePhase?: string | null
  /** whole pipeline finished → every node green + the golden result node */
  finished?: boolean
  /** the run failed → the active node turns red */
  failed?: boolean
  /** overall 0..1 progress (thin bar under the chart) */
  frac?: number
  /** v2.6.0 — swing lanes: the resolved ladder ("1D + 4h"), shown on the HTF node */
  ladderLabel?: string
  /** live stage text from the engine, shown under the chart */
  stage?: string
  elapsedSec?: number
}

// media-query subscription — useSyncExternalStore keeps this hydration-safe
// (server snapshot = open) and out of the setState-in-effect lint trap.
function subscribeMd(cb: () => void): () => void {
  const mq = window.matchMedia('(min-width: 768px)')
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const mdSnapshot = (): boolean => window.matchMedia('(min-width: 768px)').matches
const mdServerSnapshot = (): boolean => true

export function BacktestFlowChart({ mode, swing = false, activePhase, finished = false, failed = false, frac, stage, elapsedSec, ladderLabel }: BacktestFlowChartProps) {
  // collapsible: open on md+, collapsed on mobile (spec §2.4); an explicit
  // user toggle wins over the breakpoint until the breakpoint itself changes
  const md = useSyncExternalStore(subscribeMd, mdSnapshot, mdServerSnapshot)
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? md

  const pipeline = swing && !PIPELINES[mode].includes('htf')
    ? ['fetch', 'htf', ...PIPELINES[mode].slice(1)]
    : PIPELINES[mode]
  const nodeState = (id: string): 'done' | 'active' | 'pending' | 'error' => {
    if (failed && id === activePhase) return 'error'
    if (finished) return 'done'
    if (id === activePhase) return 'active'
    const idx = pipeline.indexOf(id)
    const actIdx = activePhase ? pipeline.indexOf(activePhase) : -1
    return idx < actIdx ? 'done' : 'pending'
  }
  // resolve the server's raw phase to a node in THIS pipeline (unknown or
  // lane-omitted phases resolve to null → no node blinks, stage text still runs)
  const activeNode = activePhase ? (PHASE_NODE[activePhase] ?? null) : null
  const resolvedActive = activeNode && pipeline.includes(activeNode) ? activeNode : null
  const pct = frac != null ? Math.max(0, Math.min(100, Math.round(frac * 100))) : null
  const running = !finished && !failed && resolvedActive != null

  return (
    <div
      className="mt-2.5 rounded-md border border-zinc-800/80 bg-zinc-950/70 px-3 py-2.5"
      aria-label={`Backtest pipeline — ${finished ? 'finished' : failed ? 'failed' : running ? `running: ${resolvedActive}` : 'idle'}`}
    >
      {/* header: title + legend + collapse toggle */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Pipeline · {MODE_LABEL[mode]}
          {swing && <span className="ml-1.5 text-purple-400/80">swing MTF</span>}
        </p>
        <div className="flex items-center gap-2.5">
          <div className="hidden items-center gap-2.5 text-[9px] text-zinc-500 sm:flex" aria-hidden>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> running</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> done</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-yellow-500" /> result</span>
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Collapse pipeline' : 'Expand pipeline'}
            onClick={() => setToggled((v) => !open)}
            className="grid h-7 w-7 place-items-center rounded text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          >
            <Chevron className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        </div>
      </div>

      {/* the vertical flow chart */}
      {open && (
        <ol className="mt-2 flex flex-col" aria-hidden>
          {pipeline.map((id, i) => {
            const node = NODES[id]
            if (!node) return null
            const st = nodeState(id)
            const isLast = i === pipeline.length - 1
            return (
              <li key={id} className="flex gap-3" title={node.hint}>
                {/* node column: circle + connector down to the next node */}
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'relative grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 transition-colors duration-300',
                      st === 'done' && 'border-emerald-500 bg-emerald-500/15 text-emerald-400',
                      st === 'active' && 'bt-blink border-amber-400 bg-amber-400/10 text-amber-300 shadow-[0_0_12px_2px_rgb(251_191_36/0.35)]',
                      st === 'pending' && 'border-zinc-700 bg-zinc-900 text-zinc-600',
                      st === 'error' && 'border-rose-500 bg-rose-500/10 text-rose-400',
                      id === 'htf' && 'border-dashed',
                    )}
                  >
                    <node.icon className="h-3.5 w-3.5" />
                    {st === 'done' && (
                      <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-emerald-500">
                        <Check className="h-2 w-2 text-zinc-950" strokeWidth={4} />
                      </span>
                    )}
                  </span>
                  {!isLast && (
                    <span
                      className={cn(
                        'w-0.5 min-h-4 flex-1 rounded-full transition-colors duration-300',
                        st === 'done' && 'bg-emerald-500/60',
                        st === 'active' && 'bt-blink-fast bg-amber-400/70',
                        (st === 'pending' || st === 'error') && 'bg-zinc-800',
                      )}
                    />
                  )}
                </div>
                {/* label column */}
                <div className={cn('min-w-0 pb-3', isLast && 'pb-0')}>
                  <p
                    className={cn(
                      'text-[11px] font-medium leading-tight',
                      st === 'done' && 'text-emerald-400',
                      st === 'active' && 'text-amber-300',
                      st === 'pending' && 'text-zinc-600',
                      st === 'error' && 'text-rose-400',
                    )}
                  >
                    {node.label}
                    {id === 'htf' && ladderLabel && <span className="ml-1 text-purple-300/90">· {ladderLabel}</span>}
                  </p>
                  <p className="text-[9px] leading-tight text-zinc-700">{node.hint}</p>
                </div>
              </li>
            )
          })}
          {/* final GOLDEN result node */}
          <li className="flex gap-3" title="The backtest result is ready">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 transition-all duration-500',
                  finished
                    ? 'bt-gold border-yellow-500 bg-gradient-to-br from-amber-300 to-yellow-600 text-zinc-950'
                    : failed
                      ? 'border-zinc-700 bg-zinc-900 text-zinc-700'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-600',
                )}
              >
                <Trophy className="h-3.5 w-3.5" />
              </span>
            </div>
            <div className="min-w-0">
              <p className={cn('text-[11px] font-semibold leading-tight', finished ? 'text-yellow-400' : 'text-zinc-600')}>Result</p>
              <p className="text-[9px] leading-tight text-zinc-700">Metrics, trust CI and the full tables render below</p>
            </div>
          </li>
        </ol>
      )}

      {/* thin progress + live stage text */}
      {!finished && !failed && (
        <div className="mt-1.5 flex items-center gap-2" aria-live="polite">
          {pct != null && (
            <div className="h-1 w-16 shrink-0 overflow-hidden rounded bg-zinc-800">
              <div className="h-full bg-amber-400 transition-all duration-700" style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
          )}
          <span className="truncate text-[10px] tabular-nums text-zinc-400">
            {stage ? stage : 'starting…'}
            {elapsedSec != null ? ` · ${elapsedSec}s` : ''}
          </span>
        </div>
      )}
      {finished && (
        <p className="mt-1.5 text-[10px] font-medium text-yellow-500" aria-live="polite">
          ✓ Backtest complete — result below
        </p>
      )}
    </div>
  )
}

// inline chevron (keeps the icon import list honest)
function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden focusable="false">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
