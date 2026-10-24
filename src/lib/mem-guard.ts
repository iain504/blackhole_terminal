import v8 from 'node:v8'

export interface MemGuardResult {
  ok: boolean
  ratio: number
  heapUsedMb: number
  limitMb: number
}

/**
 * Task 9-l — heap-pressure probe for the CPU-heavy endpoints (backtest
 * sweep/optimize, recommendations refresh). The sandbox runs the dev server
 * with NODE_OPTIONS=--max-old-space-size=1800 and the baseline sits at
 * ~85% of that cap, so a heavy sweep's transient allocations can push the
 * heap past the ceiling — which is a FATAL, uncatchable process death
 * ("server die"), not an exception. These endpoints instead turn a hot heap
 * into a polite, retryable 503 BEFORE starting work they cannot downsize.
 *
 * maxRatio: fraction of the configured heap limit above which new heavy work
 * is refused (0.7 default — leaves the sweep ~30% headroom to breathe).
 */
export function memoryGuard(maxRatio = 0.7): MemGuardResult {
  const limit = v8.getHeapStatistics().heap_size_limit
  const used = process.memoryUsage().heapUsed
  const ratio = limit > 0 ? used / limit : 0
  return {
    ok: ratio < maxRatio,
    ratio,
    heapUsedMb: Math.round(used / 1048576),
    limitMb: Math.round(limit / 1048576),
  }
}

/** Shared 503 shape for guarded endpoints. */
export function memoryGuardResponse(mem: MemGuardResult): {
  error: string
  retryAfterSec: number
} {
  return {
    error: `Server memory is under pressure (${Math.round(mem.ratio * 100)}% of the ${mem.limitMb}MB heap cap) — heavy analytics are paused. Try again in a minute.`,
    retryAfterSec: 60,
  }
}
