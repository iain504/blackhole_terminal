// Alerts supervisor (Task 3-c) — server-side 20s evaluation cycle so price /
// RSI / MACD / trend alarms and Telegram delivery work with NO browser open.
// Mirrors the strategy bot's in-process supervisor pattern (strategy.ts).
//
// Cost control: each cycle first runs a cheap `count({status:'active'})` and
// skips everything when there is nothing to watch; a busy flag prevents
// overlapping cycles if an evaluation (bars fetches) overruns 20s; per-user
// evaluation and the trigger claim live in alerts-eval.ts (race-safe against
// a concurrently polling browser tab).
import { db } from '@/lib/db'
import { evaluateAlerts } from '@/lib/alerts-eval'
import { memWatchdogTick } from '@/lib/mem-watchdog'

const SUPERVISOR_MS = 15000 // < barsFor TTL (20s) — supervisor keeps the cache warm for client polls
const MEM_TICK_CYCLES = 2 // watchdog every 30s

type GlobalWithAlerts = typeof globalThis & {
  __ttAlertsSupervisor?: { timer: ReturnType<typeof setInterval>; busy: boolean; tick: number }
}

async function cycle(): Promise<void> {
  const g = globalThis as GlobalWithAlerts
  const state = g.__ttAlertsSupervisor
  if (!state || state.busy) return // previous cycle still running — skip
  state.busy = true
  try {
    // memory watchdog (Task 13): telemetry + clean exit at the RSS ceiling
    state.tick = (state.tick || 0) + 1
    if (state.tick % MEM_TICK_CYCLES === 0) memWatchdogTick()

    // cheap gate: the vast majority of cycles have nothing to watch
    const active = await db.alert.count({ where: { status: 'active' } })
    if (active === 0) return
    const owners = await db.alert.findMany({
      where: { status: 'active' },
      distinct: ['userId'],
      select: { userId: true },
    })
    for (const o of owners) {
      try {
        await evaluateAlerts(o.userId)
      } catch (e) {
        // one user's data failure must not starve the others
        console.warn('[alerts] supervisor eval failed for user:', e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.warn('[alerts] supervisor cycle failed:', e instanceof Error ? e.message : e)
  } finally {
    const g2 = globalThis as GlobalWithAlerts
    if (g2.__ttAlertsSupervisor) g2.__ttAlertsSupervisor.busy = false
  }
}

/**
 * Start (once per process) the 20s server-side alert evaluation cycle.
 * Idempotent: the interval handle lives on a globalThis symbol, so HMR /
 * re-imports never duplicate it. The timer is unref'd — it never keeps the
 * process alive on its own.
 */
export function startAlertsSupervisor(): void {
  const g = globalThis as GlobalWithAlerts
  if (g.__ttAlertsSupervisor) return
  const timer = setInterval(() => void cycle(), SUPERVISOR_MS)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  g.__ttAlertsSupervisor = { timer, busy: false, tick: 0 }
  console.log(`[alerts] supervisor started (every ${SUPERVISOR_MS / 1000}s)`)
  // baseline memory line (Task 13) — the RSS curve starts here
  memWatchdogTick()
  // first pass right away — catch anything that fired while the process was
  // down (busy flag + claims make this safe even if the poll races it)
  void cycle()
}

/** Stop the supervisor (tests / hot-reload / graceful shutdown). */
export function stopAlertsSupervisor(): void {
  const g = globalThis as GlobalWithAlerts
  const state = g.__ttAlertsSupervisor
  if (!state) return
  clearInterval(state.timer)
  g.__ttAlertsSupervisor = undefined
  console.log('[alerts] supervisor stopped')
}
