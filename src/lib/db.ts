import { PrismaClient } from '@prisma/client'
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  // Per-query logging floods dev.log — enable explicitly with DEBUG_DB=1.
  const client = new PrismaClient({
    log: process.env.DEBUG_DB === '1' ? ['query'] : ['error', 'warn'],
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
 * WAL checkpoint (TRUNCATE) — folds the write-ahead log back into the main db
 * file and truncates it to zero. During heavy scan bursts the WAL can balloon;
 * a periodic checkpoint keeps the on-disk footprint tight (the db itself is
 * tiny — it's the WAL + logs that eat a small volume).
 */
export async function checkpointWal(mode: 'passive' | 'truncate' = 'truncate'): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`PRAGMA wal_checkpoint(${mode.toUpperCase()});`)
    return true
  } catch {
    return false
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
