// v2.11.3 — scheduled DB maintenance: retention prunes + WAL checkpoint.
//
// Before this, several append-only tables grew FOREVER on a single-file
// SQLite deployment:
//   - SentimentScore: hourly buckets × symbol, no prune anywhere (24 rows/
//     day/symbol since v2.4.0)
//   - KronosForecast: one row per forecasted bar, only the MANUAL storage
//     purge could remove rows
//   - AlgoRun rows (incl. their `state` JSON) of stopped runs: never pruned
//   - AlgoLog: capped per-run WHILE a run is active, but stopped runs keep
//     their 300-row tail forever
//   - StrategyFireLog / GridAutoRun: pruned only while their supervising
//     timer happened to be alive (armed rules / auto-grid POSTs) — orphans
//     lingered forever
//
// runDbMaintenance() is idempotent, fail-soft (every prune is independent —
// one failing table never blocks the rest) and runs at boot+45s then every
// 6h via startDbMaintenance(). Each prune is index-backed where it matters
// (SentimentScore.asOf, KronosForecast.madeAt, StrategyFireLog.createdAt,
// GridAutoRun.createdAt — indexes added in v2.11.3).
//
// Retention windows are deliberately GENEROUS vs the existing live prunes
// (strategy supervisor already prunes fire-logs at 7d while armed; the auto-
// grid route prunes scans at 14d on POST) — maintenance only mops up what
// those idle-path gaps left behind, it never cuts live history shorter than
// the product already promised. The manual storage purge (/api/agent/storage)
// remains the user-driven "delete everything" path.
import { db, checkpointWal } from '@/lib/db'

const DAY_MS = 86_400_000

const cut = (days: number): Date => new Date(Date.now() - days * DAY_MS)

export async function runDbMaintenance(): Promise<void> {
  const t0 = Date.now()
  // each prune independent + fail-soft (null on error)
  const sent = await db.sentimentScore
    .deleteMany({ where: { asOf: { lt: cut(90) } } })
    .then((r) => r.count)
    .catch(() => -1)
  const kronos = await db.kronosForecast
    .deleteMany({ where: { madeAt: { lt: cut(30) } } })
    .then((r) => r.count)
    .catch(() => -1)
  const logs = await db.algoLog
    .deleteMany({ where: { createdAt: { lt: cut(30) } } })
    .then((r) => r.count)
    .catch(() => -1)

  // stopped algo runs older than 30d + their journal rows (AlgoLog has no FK
  // cascade — runId is a plain string)
  let runs = -1
  try {
    const stale = await db.algoRun.findMany({
      where: { status: { not: 'running' }, stoppedAt: { lt: cut(30) } },
      select: { id: true },
    })
    if (stale.length > 0) {
      const ids = stale.map((r) => r.id)
      await db.algoLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => null)
      runs = await db.algoRun
        .deleteMany({ where: { id: { in: ids } } })
        .then((r) => r.count)
        .catch(() => -1)
    } else {
      runs = 0
    }
  } catch {
    runs = -1
  }

  const fires = await db.strategyFireLog
    .deleteMany({ where: { createdAt: { lt: cut(30) } } })
    .then((r) => r.count)
    .catch(() => -1)
  const autos = await db.gridAutoRun
    .deleteMany({ where: { createdAt: { lt: cut(30) } } })
    .then((r) => r.count)
    .catch(() => -1)

  // fold the WAL back into the main file so deleted pages actually shrink the
  // footprint (TRUNCATE retries internally via checkpointWalDetailed)
  const wal = await checkpointWal('truncate').catch(() => false)

  const fmt = (n: number): string => (n < 0 ? 'skip' : String(n))
  console.log(
    `[maintenance] db prune in ${Date.now() - t0}ms — ` +
      `sentiment=${fmt(sent)} kronos=${fmt(kronos)} algoLogs=${fmt(logs)} algoRuns=${fmt(runs)} ` +
      `fireLogs=${fmt(fires)} gridAutoRuns=${fmt(autos)} walTruncated=${wal ? 'yes' : 'no'}`,
  )
}

/** Boot +45s, then every 6h. Idempotent across HMR via globalThis. Unref'd. */
export function startDbMaintenance(): void {
  const g = globalThis as { __ttDbMaintenance?: boolean }
  if (g.__ttDbMaintenance) return
  g.__ttDbMaintenance = true

  const first = setTimeout(() => {
    void runDbMaintenance().catch((e) =>
      console.warn('[maintenance] run failed:', e instanceof Error ? e.message : e),
    )
  }, 45_000)
  const iv = setInterval(() => {
    void runDbMaintenance().catch((e) =>
      console.warn('[maintenance] run failed:', e instanceof Error ? e.message : e),
    )
  }, 6 * 60 * 60 * 1000)
  // never keep the process alive just for maintenance
  if (typeof first === 'object' && first !== null && 'unref' in first) (first as { unref: () => void }).unref()
  if (typeof iv === 'object' && iv !== null && 'unref' in iv) (iv as { unref: () => void }).unref()
}
