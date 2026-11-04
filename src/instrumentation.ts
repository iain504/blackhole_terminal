// Next.js instrumentation hook (Task 3-c) — runs once per server process at
// boot, BEFORE any route is touched. Stable in Next 15+/16 (src/instrumentation.ts
// is auto-detected; no experimental flag needed).
//
// This shell must stay runtime-agnostic: instrumentation is compiled for BOTH
// the Node.js and the Edge runtime, so all Node-only work (prisma, algo
// engine, timers) is loaded dynamically behind a NEXT_RUNTIME === 'nodejs'
// branch — the edge bundle dead-code-eliminates the import (no crypto/prisma
// edge warnings).
//
// Boot must NEVER crash because of this hook: every step is guarded and any
// failure is a console.warn — the app still serves.

let registered = false

export async function register(): Promise<void> {
  // Guard against double-registration: Next may invoke register() twice in
  // dev/HMR. The module flag covers re-entry within one module instance; the
  // globalThis symbol also covers a re-evaluated module copy after HMR.
  if (registered) return
  registered = true
  const g = globalThis as typeof globalThis & { __ttInstrumented?: boolean }
  if (g.__ttInstrumented) return
  g.__ttInstrumented = true

  if (process.env.NEXT_RUNTIME !== 'nodejs') return // edge: nothing to boot

  // v2.12.1 — `next build` ALSO invokes this hook inside its build workers
  // (Next 15+), where DATABASE_URL does not exist: every boot step (db pragmas,
  // maintenance prunes, engine resume) fail-open and spam ~20 prisma:error
  // "Environment variable not found" blocks into the build log — harmless but
  // they read as fatal deploy errors (twice mistaken for THE deploy failure).
  // Real boots (`next start` / standalone / dev) set no build phase.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  try {
    const { bootNode } = await import('./instrumentation-node')
    await bootNode()
  } catch (e) {
    console.warn('[instrumentation] boot hook failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}
