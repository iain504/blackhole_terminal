import { PrismaClient } from '@prisma/client'
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { bustApiCache } from '@/lib/api-cache'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * v2.7.2 — append engine-level tuning params to the SQLite URL.
 *
 * The production entrypoint rewrites DATABASE_URL to a bare `file:…` URL, so
 * Prisma's defaults applied — including socket_timeout ≈5s. That clashed with
 * the WAL pragma below: busy_timeout=5000 makes SQLite legitimately WAIT up
 * to 5s for the write lock (grid engine, alerts supervisor, fill-notifier and
 * API traffic all share one file), and the engine socket timeout fired FIRST
 * → "Socket timeout (the database failed to respond to a query within the
 * configured timeout)" on the full server. socket_timeout=15 gives the
 * 5s busy wait headroom instead of racing it.
 */
function tunedDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw || !raw.startsWith('file:')) return raw
  const [base, existingQuery] = raw.split('?')
  const params = new URLSearchParams(existingQuery ?? '')
  if (!params.has('socket_timeout')) params.set('socket_timeout', '15')
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

function createClient(): PrismaClient {
  // Per-query logging floods dev.log — enable explicitly with DEBUG_DB=1.
  const url = tunedDatabaseUrl(process.env.DATABASE_URL)
  const client = new PrismaClient({
    log: process.env.DEBUG_DB === '1' ? ['query'] : ['error', 'warn'],
    ...(url ? { datasourceUrl: url } : {}),
  })
  // SQLite tuning (once per client): WAL = concurrent readers don't block the
  // writer; busy_timeout avoids spurious "database is locked" errors under the
  // multi-tab terminal. Non-fatal: if the pragma fails (e.g. locked file at
  // boot) we continue with SQLite defaults. Uses $queryRawUnsafe because
  // PRAGMA journal_mode returns a result row ($executeRawUnsafe rejects it).
  try {
    client.$queryRawUnsafe('PRAGMA journal_mode=WAL;').catch(() => {})
    client.$queryRawUnsafe('PRAGMA busy_timeout=5000;').catch(() => {})
  } catch {
    // ignore — pragmas are best-effort
  }
  // v2.11.3 — auto-invalidate the /api/grid + /api/algo response caches on ANY
  // write to the tables those endpoints read. One middleware covers every
  // writer (mutation routes, grid/algo engines, maintenance prunes, scripts) —
  // engine fills and state rewrites included — so a cached GET can never serve
  // data older than the 3s TTL after a mutation. The check is a Set.has on a
  // string per query: negligible against SQLite round-trips. Never throws.
  try {
    const CACHED_WRITE_MODELS = new Set(['GridTrade', 'GridFill', 'AlgoRun', 'AlgoLog', 'StrategyRule'])
    client.$use(async (params, next) => {
      const result = await next(params)
      try {
        if (params.model && CACHED_WRITE_MODELS.has(params.model)) {
          const a = params.action
          if (
            a === 'create' || a === 'createMany' || a === 'update' || a === 'updateMany' ||
            a === 'upsert' || a === 'delete' || a === 'deleteMany'
          ) {
            bustApiCache('grid:')
            bustApiCache('algo:')
          }
        }
      } catch {
        // cache hygiene must never break a query result
      }
      return result
    })
  } catch {
    // middleware is best-effort — the TTL is the ultimate bound anyway
  }
  return client
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ---------------------------------------------------------------------------
// v2.5.1 — disk-pressure helpers (SQLite error 13: "database or disk is full")
//
// The FSD full scan writes hard (progress touches + AgentEvents + grid state
// per symbol) and every failed write also spams stdout → docker's json-file
// log, which on an unbounded log driver can itself eat the last gigabytes.
// These helpers let engines (a) measure free space BEFORE a write storm,
// (b) keep the WAL small, and (c) recognise the disk-full error so they can
// stop gracefully instead of parking grids / spamming logs.
// ---------------------------------------------------------------------------

/** Resolve the SQLite file path out of DATABASE_URL (mirrors docker-entrypoint). */
function sqliteFilePath(): string {
  let p = process.env.DATABASE_URL || 'file:./db/custom.db'
  if (p.startsWith('file:')) p = p.slice('file:'.length)
  p = p.split('?')[0]
  return p
}

export interface DiskStatus {
  /** bytes free on the filesystem holding the database — null if unknown */
  freeBytes: number | null
  /** total filesystem size in bytes — null if unknown */
  totalBytes: number | null
  path: string
}

/**
 * Free space on the volume that holds the SQLite file. statfsSync is sync +
 * cheap (~µs) so the scan loop can afford it every few symbols.
 */
export function dbDiskStatus(): DiskStatus {
  const path = sqliteFilePath()
  try {
    const dir = dirname(path)
    const fs = statfsSync(dir)
    return {
      freeBytes: fs.bsize * fs.bavail,
      totalBytes: fs.bsize * fs.blocks,
      path: dir,
    }
  } catch {
    return { freeBytes: null, totalBytes: null, path }
  }
}

/** Hard floor: below this the autopilot refuses to start / aborts mid-scan. */
export const DISK_MIN_FREE_BYTES = 256 * 1024 * 1024 // 256 MB
/** Soft floor: below this a scan checkpoints + warns but keeps going. */
export const DISK_WARN_FREE_BYTES = 512 * 1024 * 1024 // 512 MB

export function humanBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`
}

/**
 * True when the error is SQLite "database or disk is full" (extended code 13)
 * or its Prisma wrapper — matching on the message is deliberate: the connector
 * surfaces it as a raw ConnectorError, not a typed Prisma error.
 */
export function isDiskFullError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}` : typeof e === 'string' ? e : ''
  if (!msg) return false
  const m = msg.toLowerCase()
  return (
    m.includes('database or disk is full') ||
    m.includes('database is full') ||
    m.includes('disk is full') ||
    m.includes('insertion failed because database is full') ||
    (m.includes('error code 13') && m.includes('full'))
  )
}

/**
 * v2.7.2 — true for TRANSIENT SQLite contention errors that a short retry can
 * clear: the engine socket timeout (a >busy_timeout write-lock wait that used
 * to surface as "Socket timeout …") and the classic SQLITE_BUSY lock errors.
 * Deliberately message-based like isDiskFullError: the connector surfaces
 * these as raw connector errors, not typed Prisma errors.
 */
export function isTransientDbError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}` : typeof e === 'string' ? e : ''
  if (!msg) return false
  const m = msg.toLowerCase()
  return (
    m.includes('socket timeout') ||
    m.includes('timed out') ||
    (m.includes('database') && m.includes('locked')) ||
    m.includes('sqlite_busy')
  )
}

/**
 * v2.8.4 — result row of `PRAGMA wal_checkpoint(...)`. SQLite does NOT raise
 * an error when the checkpoint cannot take the lock: it returns busy=1 and
 * silently does nothing. The old boolean helper (which ignored the row) used
 * to report success while a ballooned WAL survived the "truncate" untouched —
 * one of the reasons the storage card's shrink seemed to free no space.
 */
export interface WalCheckpointResult {
  /** 1 = checkpoint was a no-op (another pooled connection pins the WAL) */
  busy: number
  /** WAL pages before the checkpoint */
  log: number
  /** pages actually folded back into the main db */
  checkpointed: number
}

/**
 * v2.8.4 — busy-aware checkpoint with bounded retries. Other Prisma pool
 * connections (grid engine, agent engine, API readers) pin the WAL with read
 * snapshots; a single TRUNCATE attempt usually comes back busy=1, so retry a
 * few times on a short delay before giving up. Returns null only when the
 * pragma itself fails.
 */
export async function checkpointWalDetailed(
  mode: 'passive' | 'truncate' = 'truncate',
  attempts = 3,
  delayMs = 400,
): Promise<WalCheckpointResult | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const rows = (await db.$queryRawUnsafe(`PRAGMA wal_checkpoint(${mode.toUpperCase()});`)) as Array<
        Partial<WalCheckpointResult>
      >
      const row = rows?.[0]
      if (!row) return null
      const res: WalCheckpointResult = {
        busy: Number(row.busy ?? 0),
        log: Number(row.log ?? 0),
        checkpointed: Number(row.checkpointed ?? 0),
      }
      if (!res.busy || i === attempts - 1) return res
      await new Promise((r) => setTimeout(r, delayMs))
    } catch {
      return null
    }
  }
  return null
}

/**
 * WAL checkpoint (TRUNCATE) — folds the write-ahead log back into the main db
 * file and truncates it to zero. During heavy scan bursts the WAL can balloon;
 * a periodic checkpoint keeps the on-disk footprint tight (the db itself is
 * tiny — it's the WAL + logs that eat a small volume).
 */
export async function checkpointWal(mode: 'passive' | 'truncate' = 'truncate'): Promise<boolean> {
  const r = await checkpointWalDetailed(mode)
  return r != null && !r.busy
}

export interface SqlitePageStats {
  pageSize: number
  pageCount: number
  /** pages that hold deleted rows, waiting for VACUUM to release them */
  freelistPages: number
  /** freelistPages × pageSize — the bytes VACUUM can actually reclaim */
  freelistBytes: number
}

/**
 * v2.8.4 — how many bytes INSIDE the main db file are free pages. Zero
 * freelist on a multi-GB file proves the space is NOT in the database — it is
 * the container stdout log or the host's Docker VM disk image, which no
 * in-app shrink can touch. This turns "Reclaim space did nothing" into a
 * diagnosable answer instead of a blind button.
 */
export async function sqlitePageStats(): Promise<SqlitePageStats | null> {
  try {
    const [ps, pc, fl] = await Promise.all([
      db.$queryRawUnsafe<Array<{ page_size: number }>>('PRAGMA page_size;'),
      db.$queryRawUnsafe<Array<{ page_count: number }>>('PRAGMA page_count;'),
      db.$queryRawUnsafe<Array<{ freelist_count: number }>>('PRAGMA freelist_count;'),
    ])
    const pageSize = Number(ps?.[0]?.page_size ?? 0)
    const pageCount = Number(pc?.[0]?.page_count ?? 0)
    const freelistPages = Number(fl?.[0]?.freelist_count ?? 0)
    if (!pageSize || !pageCount) return null
    return { pageSize, pageCount, freelistPages, freelistBytes: pageSize * freelistPages }
  } catch {
    return null
  }
}

/**
 * Standardised user-facing disk-full error text. Thrown by the engines so the
 * session/event feed shows exactly what to do instead of a prisma stack dump.
 */
export function diskFullError(status: DiskStatus): Error {
  return new Error(
    `DISK FULL — the volume holding the database (${status.path}) has only ${humanBytes(status.freeBytes)} free. ` +
      'The scan was stopped to protect your data. Free space on the docker host (docker system prune -f, ' +
      'old images/containers, container logs) and launch the scan again.',
  )
}
