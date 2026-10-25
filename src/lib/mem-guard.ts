import v8 from 'node:v8'

export interface MemGuardResult {
  ok: boolean
  ratio: number
  heapUsedMb: number
  limitMb: number
  /** Present only when MEM_RSS_CEILING_MB is configured (Render free tier). */
  rssMb: number | null
  rssCeilingMb: number | null
}

/**
 * Memory-pressure probe for the CPU-heavy endpoints (backtest sweep/optimize,
 * recommendations refresh, matrix paths). Two ceilings — whichever is worse
 * wins:
 *
 *   1. HEAP — v8.getHeapStatistics().heap_size_limit vs heapUsed. NOTE: under
 *      Bun this limit is JavaScriptCore's own heuristic (~345MB): the V8-style
 *      NODE_OPTIONS=--max-old-space-size flag is silently ignored by Bun, so
 *      render.yaml also sets BUN_JSC_forceRamSize to steer JSC's GC.
 *
 *   2. RSS — process RSS vs MEM_RSS_CEILING_MB (Render free tier: 460 against
 *      the 512MB container). The kernel OOM-kills on RSS, and a cgroup SIGKILL
 *      is a FATAL, SILENT death — zero log lines, the pod just vanishes and
 *      Render's router answers 502 until the backoff restart lands. Watching
 *      RSS lets these endpoints return the polite, retryable 503 BEFORE the
 *      kernel pulls the trigger (Task 13, Render free-tier hardening).
 *
 * maxRatio: fraction of the applicable ceiling above which new heavy work is
 * refused (0.7 default — leaves the workload headroom to breathe).
 */
export function memoryGuard(maxRatio = 0.7): MemGuardResult {
  const mem = process.memoryUsage()
  const limit = v8.getHeapStatistics().heap_size_limit
  const heapRatio = limit > 0 ? mem.heapUsed / limit : 0

  const ceilingRaw = Number(process.env.MEM_RSS_CEILING_MB || 0)
  const rssCeilingMb =
    Number.isFinite(ceilingRaw) && ceilingRaw > 0 ? ceilingRaw : null
  const rssRatio = rssCeilingMb ? mem.rss / (rssCeilingMb * 1048576) : 0

  const ratio = Math.max(heapRatio, rssRatio)
  return {
    ok: ratio < maxRatio,
    ratio,
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    limitMb: Math.round(limit / 1048576),
    rssMb: rssCeilingMb ? Math.round(mem.rss / 1048576) : null,
    rssCeilingMb,
  }
}

/** Shared 503 shape for guarded endpoints. */
export function memoryGuardResponse(mem: MemGuardResult): {
  error: string
  retryAfterSec: number
} {
  const rss = mem.rssCeilingMb
    ? ` · RSS ${mem.rssMb}MB/${mem.rssCeilingMb}MB`
    : ''
  return {
    error: `Server memory is under pressure (${Math.round(mem.ratio * 100)}% of the ${mem.limitMb}MB heap cap${rss}) — heavy analytics are paused. Try again in a minute.`,
    retryAfterSec: 60,
  }
}
