// Node.js boot logic for the instrumentation hook (Task 3-c) — split out of
// instrumentation.ts so the Edge instrumentation bundle never statically
// traces prisma / the algo engine / the trading stack.
//
// Closes two "nobody is watching" gaps from the Task 2 / 1-d audit:
//   1. Algo engines previously resumed only when the first /api/algo route was
//      touched after a restart → a night-time restart left live algo runs
//      DORMANT until someone opened the UI. Here we re-register every
//      status 'running' run for EVERY user straight after boot.
//   2. Alerts (price/RSI/MACD/trend + Telegram) previously ran only while a
//      browser polled /api/alerts/check → closed browser meant no alarms.
//      The supervisor started below evaluates them server-side every 20s.
export async function bootNode(): Promise<void> {
  console.log('[instrumentation] booted')

  try {
    // 0) Resolve the master app secret BEFORE anything that decrypts or signs
    //    (algo engine resume decrypts broker keys; session signing needs it).
    //    env -> DB -> generate-and-persist (Task 9-j, publish-safe).
    const { resolveAppSecret } = await import('@/lib/app-secret')
    await resolveAppSecret()
  } catch (e) {
    console.warn('[instrumentation] app secret resolution failed:', e instanceof Error ? e.message : e)
  }

  try {
    // 1) Resume algo engines for all users with running runs at boot.
    //    ensureAlgoEngines(userId) is idempotent per run (startEngine no-ops
    //    on a run already in the registry), so a race with an early /api/algo
    //    request is harmless.
    const { db } = await import('@/lib/db')
    const { ensureAlgoEngines } = await import('@/lib/algo-engine')
    const owners = await db.algoRun.findMany({
      where: { status: 'running' },
      distinct: ['userId'],
      select: { userId: true },
    })
    for (const o of owners) {
      try {
        await ensureAlgoEngines(o.userId)
        console.log(`[instrumentation] algo engines resumed for user ${o.userId}`)
      } catch (e) {
        console.warn('[instrumentation] algo resume failed for user:', e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.warn('[instrumentation] algo boot-resume skipped:', e instanceof Error ? e.message : e)
  }

  try {
    // 2) Server-side alerts supervisor (browser-independent, 20s cycle).
    const { startAlertsSupervisor } = await import('@/lib/alerts-supervisor')
    startAlertsSupervisor()
  } catch (e) {
    console.warn('[instrumentation] alerts supervisor failed to start:', e instanceof Error ? e.message : e)
  }
}
