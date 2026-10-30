'use client'

// BacktestFlowChart — v1.99.1
//
// A production-line flow chart for the backtest pipeline, so the user can SEE
// where a run is instead of parsing a bare "34% · strategy 2/4 · ORB 15m" line:
//
//   [Fetch bars] ── [Prepare] ── [Grid search] ── [Trust verdict] ── 🏆 Result
//
//   • the phase currently executing BLINKS YELLOW
//   • a finished phase turns GREEN (with a check badge)
//   • the next phase starts blinking yellow in turn
//   • when the whole run lands, the final result node turns GOLDEN
//
// The pipeline is mode-aware — every mode shares fetch/prepare but diverges
// after: run replays a single config, optimize grid-searches, sweep tests the
// whole catalog then verifies out-of-sample, walk-forward runs folds then a
// pure hold-out stress test. `activePhase` comes from the job poll
// (GET /api/algo/backtest?job=… → phase, mapped server-side by
// phaseFromStage) so the chart reflects REAL server phases, not guesses.
// The inline 'run' mode has no job poll — the panel feeds a lightweight
// client-side estimate (fetch → prepare → replay) that is finalized by the
// actual response, so a fast run simply sweeps through to golden.
import { BadgeCheck, ChartLine, Check, Database, Grid3x3, Layers, Play, Repeat, ShieldCheck, Target, Trophy, type LucideIcon } from 'lucide-react'
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
  fetch: { id: 'fetch', label: 'Fetch bars', icon: Database, hint: 'Download historical bars from the data feed (cached after the first run)' },
  prepare: { id: 'prepare', label: 'Prepare', icon: ChartLine, hint: 'Build the price + indicator series the strategy replays over' },
  replay: { id: 'replay', label: 'Replay', icon: Play, hint: 'Replay the strategy bar-by-bar with the documented fill model' },
  grid: { id: 'grid', label: 'Grid search', icon: Grid3x3, hint: 'Score every parameter combination on the full period' },
  sweep: { id: 'sweep', label: 'Sweep', icon: Layers, hint: 'Backtest every strategy in the catalog at defaults + its auto grid' },
  folds: { id: 'folds', label: 'WF folds', icon: Repeat, hint: 'Re-optimize on each fold\'s in-sample window, verify out-of-sample' },
  oos: { id: 'oos', label: 'OOS verify', icon: ShieldCheck, hint: 'Re-run the winners untouched on the out-of-sample tail' },
  holdout: { id: 'holdout', label: 'Hold-out', icon: Target, hint: 'Stress the surviving config on pure unseen data' },
  verdict: { id: 'verdict', label: 'Trust verdict', icon: BadgeCheck, hint: 'Per-trade significance, bootstrap confidence interval, plain-language verdict' },
}

/** Per-mode pipeline (the golden result node is appended automatically). */
const PIPELINES: Record<BtFlowMode, string[]> = {
  run: ['fetch', 'prepare', 'replay', 'verdict'],
  optimize: ['fetch', 'prepare', 'grid', 'verdict'],
  sweep: ['fetch', 'prepare', 'sweep', 'oos'],
  walkforward: ['fetch', 'prepare', 'folds', 'holdout'],
}

const MODE_LABEL: Record<BtFlowMode, string> = {
  run: 'Run backtest',
  optimize: 'Optimizer',
  sweep: 'Strategy sweep',
  walkforward: 'Walk-forward',
}

interface BacktestFlowChartProps {
  mode: BtFlowMode
  /** id of the phase currently executing — it blinks yellow */
  activePhase?: string | null
  /** whole pipeline finished → every node green + the golden result node */
  finished?: boolean
  /** the run failed → the active node turns red */
  failed?: boolean
  /** overall 0..1 progress (thin bar under the chart) */
  frac?: number
  /** live stage text from the engine, shown under the chart */
  stage?: string
  elapsedSec?: number
}

export function BacktestFlowChart({ mode, activePhase, finished = false, failed = false, frac, stage, elapsedSec }: BacktestFlowChartProps) {
  const pipeline = PIPELINES[mode]
  const nodeState = (id: string): 'done' | 'active' | 'pending' | 'error' => {
    if (failed && id === activePhase) return 'error'
    if (finished) return 'done'
    if (id === activePhase) return 'active'
    const idx = pipeline.indexOf(id)
    const actIdx = activePhase ? pipeline.indexOf(activePhase) : -1
    return idx < actIdx ? 'done' : 'pending'
  }
  const pct = frac != null ? Math.max(0, Math.min(100, Math.round(frac * 100))) : null

  return (
    <div
      className="mt-2 rounded-md border border-zinc-800/80 bg-zinc-950/70 px-3 py-2.5"
      aria-label={`Backtest pipeline — ${finished ? 'finished' : failed ? 'failed' : `running: ${activePhase ?? 'starting'}`}`}
    >
      {/* header: title + legend */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Pipeline · {MODE_LABEL[mode]}
        </p>
        <div className="flex items-center gap-2.5 text-[9px] text-zinc-500" aria-hidden>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> running</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> done</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-yellow-500" /> result</span>
        </div>
      </div>

      {/* the flow chart itself */}
      <div className="mt-1.5 overflow-x-auto pb-0.5">
        <ol className="flex min-w-[330px] items-start" aria-hidden>
          {pipeline.map((id) => {
            const node = NODES[id]
            const st = nodeState(id)
            return (
              <li key={id} className="contents">
                {/* node */}
                <div className="flex w-14 shrink-0 flex-col items-center gap-1" title={node.hint}>
                  <span
                    className={cn(
                      'relative grid h-9 w-9 place-items-center rounded-full border-2 transition-colors duration-300',
                      st === 'done' && 'border-emerald-500 bg-emerald-500/15 text-emerald-400',
                      st === 'active' && 'bt-blink border-amber-400 bg-amber-400/10 text-amber-300 shadow-[0_0_12px_2px_rgb(251_191_36/0.35)]',
                      st === 'pending' && 'border-zinc-700 bg-zinc-900 text-zinc-600',
                      st === 'error' && 'border-rose-500 bg-rose-500/10 text-rose-400',
                    )}
                  >
                    <node.icon className="h-4 w-4" />
                    {st === 'done' && (
                      <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-emerald-500">
                        <Check className="h-2 w-2 text-zinc-950" strokeWidth={4} />
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'text-center text-[9px] leading-tight',
                      st === 'done' && 'text-emerald-400',
                      st === 'active' && 'text-amber-300',
                      st === 'pending' && 'text-zinc-600',
                      st === 'error' && 'text-rose-400',
                    )}
                  >
                    {node.label}
                  </span>
                </div>
                {/* connector into the next node (every node has one — the
                    last pipeline step connects into the golden result node) */}
                <span
                  className={cn(
                    'mt-[17px] h-0.5 flex-1 rounded-full transition-colors duration-300',
                    st === 'done' && 'bg-emerald-500/60',
                    st === 'active' && 'bt-blink-fast bg-amber-400/70',
                    (st === 'pending' || st === 'error') && 'bg-zinc-800',
                  )}
                />
              </li>
            )
          })}
          {/* final GOLDEN result node */}
          <div className="flex w-16 shrink-0 flex-col items-center gap-1" title="The backtest result is ready">
            <span
              className={cn(
                'grid h-9 w-9 place-items-center rounded-full border-2 transition-all duration-500',
                finished
                  ? 'bt-gold border-yellow-500 bg-gradient-to-br from-amber-300 to-yellow-600 text-zinc-950'
                  : failed
                    ? 'border-zinc-700 bg-zinc-900 text-zinc-700'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-600',
              )}
            >
              <Trophy className="h-4 w-4" />
            </span>
            <span className={cn('text-center text-[9px] font-semibold leading-tight', finished ? 'text-yellow-400' : 'text-zinc-600')}>
              Result
            </span>
          </div>
        </ol>
      </div>

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
