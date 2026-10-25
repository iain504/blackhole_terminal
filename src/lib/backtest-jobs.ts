// Task 15 — in-process background-job registry for the HEAVY backtest modes
// (optimize / sweep / walkforward).
//
// WHY: those modes run as ONE synchronous HTTP request that can take minutes
// (a sweep is up to ~21 strategies × ~300 grid sims). On a proxied host that
// is fatal by construction:
//   • Render's edge router kills long requests (~100s) → the browser gets a
//     bare HTTP 502 with NO result — deterministically, every single time
//     ("Optimizer: always 502, no result");
//   • the long request is also the OOM window: whatever kills the pod
//     mid-request (cgroup RSS on a 512MB box, heap cap) discards the whole
//     run silently.
// The job model returns `202 { jobId }` immediately, runs the work DETACHED
// in this process, and the client polls `GET /api/algo/backtest?job=ID` for
// progress → final payload. No request lives long enough to be killed; the
// result survives as long as the process does; live progress (frac + stage)
// streams to the UI.
//
// Scope (same trust level as the session store): single-process, in-memory.
// Jobs die with the process; the poll surfaces that honestly as
// "job not found — the server may have restarted". The single-flight guard
// (one heavy backtest per user) lives here too so the inline 'run' mode and
// background jobs can never stack.
import { randomUUID } from 'crypto'

export interface BacktestJob {
  id: string
  userId: string
  status: 'running' | 'done' | 'error'
  /** 0..1 progress of the whole operation (Task 15 progress plumbing) */
  frac: number
  /** short human-readable stage label for the UI */
  stage: string
  createdAt: number
  finishedAt: number | null
  /** done → the exact JSON the inline POST would have returned */
  result: Record<string, unknown> | null
  /** error → the user-facing message (validation, mem-gate 503, heap abort) */
  error: string | null
}

const jobs = new Map<string, BacktestJob>()
const JOB_TTL_MS = 10 * 60_000 // finished jobs are kept 10min for the client to pick up
const JOB_MAX = 40 // hard cap — oldest FINISHED jobs evicted first (running jobs never)

// one heavy backtest at a time per user (each holds the bars + a full sim;
// parallel runs OOM the box) — shared by inline runs and background jobs
const runningBacktests = new Set<string>()

export function tryAcquireBacktestSlot(userId: string): boolean {
  if (runningBacktests.has(userId)) return false
  runningBacktests.add(userId)
  return true
}

export function releaseBacktestSlot(userId: string): void {
  runningBacktests.delete(userId)
}

/** Is this user's heavy backtest currently executing (inline or as a job)? */
export function backtestSlotBusy(userId: string): boolean {
  return runningBacktests.has(userId)
}

function pruneJobs(): void {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.finishedAt != null && now - j.finishedAt > JOB_TTL_MS) {
      jobs.delete(id)
    }
  }
  if (jobs.size <= JOB_MAX) return
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
  for (let i = 0; i < finished.length && jobs.size > JOB_MAX; i++) {
    jobs.delete(finished[i].id)
  }
}

/**
 * Register a new running job for `userId`. Returns null when the user already
 * has a heavy backtest in flight (the caller maps that to the existing 429).
 * The slot is acquired HERE and released by failJob/completeJob — the runner
 * must always end in one of those two.
 */
export function createBacktestJob(userId: string): BacktestJob | null {
  if (runningBacktests.has(userId)) return null
  runningBacktests.add(userId)
  pruneJobs()
  const job: BacktestJob = {
    id: randomUUID(),
    userId,
    status: 'running',
    frac: 0,
    stage: 'queued',
    createdAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  }
  jobs.set(job.id, job)
  return job
}

/** Ownership-checked lookup — a user can never read another user's job. */
export function getBacktestJob(userId: string, id: string): BacktestJob | null {
  const job = jobs.get(id)
  if (!job || job.userId !== userId) return null
  return job
}

/** Progress sink for the engines' onProgress callbacks — O(1), always safe. */
export function jobProgress(job: BacktestJob): (frac: number, stage?: string) => void {
  return (frac, stage) => {
    if (job.status !== 'running') return
    if (Number.isFinite(frac)) job.frac = Math.max(0, Math.min(1, frac))
    if (stage) job.stage = stage
  }
}

export function completeJob(job: BacktestJob, result: Record<string, unknown>): void {
  job.result = result
  job.status = 'done'
  job.frac = 1
  job.finishedAt = Date.now()
  releaseBacktestSlot(job.userId)
}

export function failJob(job: BacktestJob, error: string): void {
  job.error = error
  job.status = 'error'
  job.finishedAt = Date.now()
  releaseBacktestSlot(job.userId)
}
