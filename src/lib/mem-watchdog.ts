// Process memory watchdog (Task 13 — Render free-tier hardening).
//
// The 512MB free container is killed by the KERNEL when RSS crosses the
// cgroup limit — a silent SIGKILL with zero log lines: the pod vanishes,
// Render's router answers bare 502s (`x-render-origin-server: Render`,
// content-length 0) and the service log ends without a word. Exactly the
// signature blackhole-terminal.onrender.com produced. This watchdog makes
// the process watch itself:
//
//   • telemetry — one compact `[mem] rss … · heap …` line per tick so the
//     growth curve is visible in the service log (prod only, or MEM_LOG=1);
//   • pressure — past 90% of MEM_RSS_CEILING_MB it forces a hard GC
//     (Bun.gc(true) — Bun runs JavaScriptCore, there is no global gc()) and
//     warns;
//   • the wall — at 100% of the ceiling it logs the reason and exits(1):
//     a CLEAN restart with an explanation in the log beats a silent kernel
//     kill (Render restarts the service either way).
//
// Without MEM_RSS_CEILING_MB it NEVER exits — telemetry only, so local dev
// is unaffected.
import v8 from 'node:v8'

const readCeiling = (): number | null => {
  const raw = Number(process.env.MEM_RSS_CEILING_MB || 0)
  return Number.isFinite(raw) && raw > 0 ? raw : null
}

/** Bun's hard GC (JavaScriptCore) — no-op under Node (nothing to force). */
function bunHardGc(): boolean {
  const bun = (globalThis as { Bun?: { gc?: (hard?: boolean) => void } }).Bun
  if (typeof bun?.gc === 'function') {
    try {
      bun.gc(true)
      return true
    } catch {
      return false
    }
  }
  return false
}

export interface MemSnapshot {
  rssMb: number
  heapUsedMb: number
  heapLimitMb: number
  ceilingMb: number | null
}

export function memSnapshot(): MemSnapshot {
  const mem = process.memoryUsage()
  const heapLimit = v8.getHeapStatistics().heap_size_limit
  return {
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    heapLimitMb: Math.round(heapLimit / 1048576),
    ceilingMb: readCeiling(),
  }
}

/**
 * One watchdog tick: log telemetry (when verbose), hard-GC on pressure,
 * exit(1) at the ceiling. Called from the alerts supervisor every ~30s and
 * once at boot for the baseline line. Never throws.
 */
export function memWatchdogTick(): MemSnapshot {
  try {
    const snap = memSnapshot()
    const verbose =
      snap.ceilingMb !== null ||
      process.env.NODE_ENV === 'production' ||
      process.env.MEM_LOG === '1'
    if (!verbose) return snap

    console.log(
      `[mem] rss ${snap.rssMb}MB · heap ${snap.heapUsedMb}/${snap.heapLimitMb}MB` +
        (snap.ceilingMb ? ` · ceiling ${snap.ceilingMb}MB` : ''),
    )

    if (snap.ceilingMb !== null) {
      if (snap.rssMb >= snap.ceilingMb) {
        console.error(
          `[mem] RSS ${snap.rssMb}MB reached the ${snap.ceilingMb}MB ceiling — exiting for a clean restart ` +
            `(a cgroup OOM-kill would be silent). If this repeats, the instance needs more RAM ` +
            `(Render: paid plan) or less concurrent load.`,
        )
        process.exit(1)
      }
      if (snap.rssMb >= Math.round(snap.ceilingMb * 0.9)) {
        const gc = bunHardGc()
        console.warn(
          `[mem] RSS ${snap.rssMb}MB ≥ 90% of ${snap.ceilingMb}MB ceiling` +
            (gc ? ' — hard GC forced' : ''),
        )
      }
    }
    return snap
  } catch {
    // watchdog must never take the supervisor (or the process) down
    return { rssMb: -1, heapUsedMb: -1, heapLimitMb: -1, ceilingMb: null }
  }
}
