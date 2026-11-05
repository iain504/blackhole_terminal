// v2.8.0 — server storage report + reclaim actions for the FSD tab.
//
// The full scan is the heaviest writer in the app and SQLite NEVER returns
// freed pages to the OS on its own: rows pruned by any housekeeping leave
// free pages inside the file, and the file (plus container stdout logs)
// only ever grows — the user-visible "12 GB after a full scan". This route
// makes the invisible visible and gives one-click fixes:
//
//   GET  /api/agent/storage   → db/wal file sizes, free disk, reclaimable
//                             free pages inside the db, per-table rows
//   POST /api/agent/storage   → { action:
//      'vacuum'        | rebuild the DB file and return freed space to the OS
//      'purge-bars'    | drop the crypto bar cache (rebuilds on demand)
//      'purge-logs'    | drop algo logs > 14d + expired rate-limit buckets
//   }
//
// v2.8.4 — the "shrink freed nothing" report, root-caused and fixed:
//   1. wal_checkpoint(TRUNCATE) is NOT an error when another pooled reader
//      pins the WAL — it returns busy=1 and silently does nothing. The old
//      code ignored the result row, reported success, and a ballooned WAL
//      survived untouched. Now busy-aware + retried, and the wal file is
//      measured before/after alongside the main db.
//   2. VACUUM rebuilds the file into a temporary copy — on a (near-)full
//      volume it died with SQLITE_FULL → generic 500. Now a pre-flight
//      free-disk check answers 507 with the exact numbers + host-side
//      cleanup commands instead of dying mid-rebuild.
//   3. GET exposes the freelist ("reclaimable inside the db"): a multi-GB
//      file with a ~zero freelist proves the space lives OUTSIDE the db —
//      the container stdout log or the host's Docker VM disk image
//      (Docker.raw / ext4.vhdx), which no in-app shrink can ever touch.
//
// All actions are session-gated (single-operator app) and non-fatal: a
// failed purge answers 5xx with the reason, the FSD storage card shows it.
import { statSync } from 'fs'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import {
  db,
  dbDiskStatus,
  checkpointWal,
  checkpointWalDetailed,
  sqlitePageStats,
  isDiskFullError,
  isTransientDbError,
  humanBytes,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

/** VACUUM builds a temp copy of the whole db — require this much slack on top of the file size. */
const VACUUM_HEADROOM_BYTES = 128 * 1024 * 1024

/** Resolve the SQLite main file + WAL paths from DATABASE_URL. */
function dbFilePaths(): { dbPath: string; walPath: string } | null {
  const raw = process.env.DATABASE_URL || ''
  if (!raw.startsWith('file:')) return null
  let p = raw.slice('file:'.length)
  const q = p.indexOf('?')
  if (q >= 0) p = p.slice(0, q)
  if (!p.startsWith('/')) p = `${process.cwd()}/${p}`
  return { dbPath: p, walPath: `${p}-wal` }
}

function fileBytes(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

function bytesOrNull(v: number | null): { bytes: number | null; human: string | null } {
  return { bytes: v, human: v != null ? humanBytes(v) : null }
}

export async function GET() {
  try {
    await requireUser()
    const [bars, algoLogs, agentEvents, agentSessions, rate, sentHead, sentScores, scanCache] =
      await Promise.all([
        db.bar.count(),
        db.algoLog.count(),
        db.agentEvent.count(),
        db.agentSession.count(),
        db.rateLimitBucket.count(),
        db.sentimentHeadline.count(),
        db.sentimentScore.count(),
        db.agentScanCache.count(),
      ])
    const disk = dbDiskStatus()
    const paths = dbFilePaths()
    const pages = await sqlitePageStats()
    return NextResponse.json({
      disk: {
        free: bytesOrNull(disk.freeBytes),
        total: bytesOrNull(disk.totalBytes),
        db: {
          ...bytesOrNull(paths ? fileBytes(paths.dbPath) : null),
          // v2.8.4 — free pages inside the file that VACUUM would release
          reclaimable: bytesOrNull(pages ? pages.freelistBytes : null),
        },
        wal: bytesOrNull(paths ? fileBytes(paths.walPath) : null),
        path: disk.path,
      },
      tables: [
        { key: 'bars', label: 'Crypto bar cache', rows: bars, hint: 'Rebuilds on demand from the exchange feeds' },
        { key: 'algoLogs', label: 'Algo engine logs', rows: algoLogs, hint: '15s-cycle engine history' },
        { key: 'agentEvents', label: 'Autopilot brain feed', rows: agentEvents, hint: 'Bounded to 400 per session' },
        { key: 'agentSessions', label: 'Autopilot sessions', rows: agentSessions, hint: 'Newest 20 kept per user' },
        { key: 'rate', label: 'Rate-limit buckets', rows: rate, hint: 'Expired throttles' },
        { key: 'sentHead', label: 'Sentiment headlines', rows: sentHead, hint: '' },
        { key: 'sentScores', label: 'Sentiment scores', rows: sentScores, hint: '' },
        { key: 'scanCache', label: 'FSD results store', rows: scanCache, hint: 'Speeds up the next scan — keep' },
      ],
    })
  } catch (e) {
    return handleError(e)
  }
}

interface StoragePostBody {
  action?: 'vacuum' | 'purge-bars' | 'purge-logs'
}

export async function POST(req: Request) {
  try {
    await requireUser()
    const body = (await req.json().catch(() => ({}))) as StoragePostBody
    const action = body?.action

    if (action === 'vacuum') {
      const paths = dbFilePaths()
      const before = paths ? fileBytes(paths.dbPath) : null
      const walBefore = paths ? fileBytes(paths.walPath) : null
      // Diagnose BEFORE rebuilding: the freelist says how much the file can
      // actually shrink (≈0 freelist + a multi-GB file ⇒ the space is outside
      // the db and VACUUM cannot help — see the success message below).
      const pages = await sqlitePageStats()

      // 1) Checkpoint first: fold + truncate the WAL. Busy-aware + retried —
      //    the silent busy=1 no-op is what used to keep a ballooned WAL alive.
      const ckpt = await checkpointWalDetailed('truncate')
      const walAfterCkpt = paths ? fileBytes(paths.walPath) : null

      // 2) Pre-flight: VACUUM writes a full temporary copy of the db, so the
      //    volume needs roughly the file size (+ headroom) FREE. On a full
      //    disk this used to die with SQLITE_FULL → generic 500. Refuse with
      //    exact numbers and host-side instructions instead.
      const disk = dbDiskStatus()
      if (disk.freeBytes != null && before != null) {
        const needed = before + VACUUM_HEADROOM_BYTES
        if (disk.freeBytes < needed) {
          const hint =
            pages && pages.freelistBytes > 0
              ? ` The db holds ${humanBytes(pages.freelistBytes)} of reclaimable free pages — once the host has room, VACUUM will return them to the disk.`
              : ''
          return NextResponse.json(
            {
              error:
                `VACUUM needs ~${humanBytes(needed)} free on ${disk.path} to rebuild the ${humanBytes(before)} database — only ${humanBytes(disk.freeBytes)} free. ` +
                'Free space on the DOCKER HOST first (this button only rebuilds the db file, it cannot shrink host files): ' +
                'docker system prune -f · docker builder prune · truncate the container log (/var/lib/docker/containers/*/*-json.log) ' +
                '· on Docker Desktop compact Docker.raw / ext4.vhdx via Troubleshoot → Clean / Purge data.' +
                hint,
            },
            { status: 507 },
          )
        }
      }

      // 3) Rebuild. A concurrent writer holds the exclusive lock — map that
      //    to an actionable 409 instead of the generic 500.
      try {
        await db.$executeRawUnsafe('VACUUM')
      } catch (e) {
        if (isDiskFullError(e)) {
          return NextResponse.json(
            {
              error:
                `VACUUM ran out of disk mid-rebuild (${humanBytes(disk.freeBytes)} free, needed ~${humanBytes((before ?? 0) + VACUUM_HEADROOM_BYTES)}). ` +
                'Free host space first (docker system prune -f, container logs), then retry — the db is intact.',
            },
            { status: 507 },
          )
        }
        if (isTransientDbError(e)) {
          return NextResponse.json(
            {
              error:
                'VACUUM could not get an exclusive lock — the engines are writing (scan, grid, fleet). ' +
                'Stop them, then retry.',
            },
            { status: 409 },
          )
        }
        throw e
      }

      await checkpointWalDetailed('truncate')
      const after = paths ? fileBytes(paths.dbPath) : null
      const walAfter = paths ? fileBytes(paths.walPath) : null
      const freed = before != null && after != null ? Math.max(0, before - after) : null
      const walFreed = walBefore != null && walAfter != null ? Math.max(0, walBefore - walAfter) : null
      const totalFreed = (freed ?? 0) + (walFreed ?? 0)

      const parts: string[] = []
      if (before != null && after != null) parts.push(`db ${humanBytes(before)} → ${humanBytes(after)}`)
      if (walBefore != null && walAfter != null) parts.push(`wal ${humanBytes(walBefore)} → ${humanBytes(walAfter)}`)
      parts.push(`freed ${humanBytes(totalFreed)}`)
      if (ckpt?.busy) parts.push('WAL was pinned by a reader — retry in a moment to release the wal file fully')
      let message = `VACUUM done — ${parts.join(' · ')}`
      const MB = 1024 * 1024
      if (totalFreed < MB && (!pages || pages.freelistPages === 0) && (before ?? 0) > 64 * MB) {
        message +=
          '. The db file is already fully compact — the missing space lives OUTSIDE the database: ' +
          'the container stdout log (/var/lib/docker/containers/*/*-json.log) or the Docker VM disk image ' +
          '(Docker.raw / ext4.vhdx), which keeps its high-water mark until pruned/compacted on the host. ' +
          'The in-app shrink can never touch those files.'
      }
      return NextResponse.json({ ok: true, message, freedBytes: totalFreed || null, walAfterCheckpoint: walAfterCkpt })
    }

    if (action === 'purge-bars') {
      const res = await db.bar.deleteMany({})
      await checkpointWal('truncate')
      return NextResponse.json({ ok: true, message: `Crypto bar cache purged — ${res.count} bar(s) removed. It rebuilds on demand from the feeds.` })
    }

    if (action === 'purge-logs') {
      const cutoff = new Date(Date.now() - 14 * 86_400_000)
      const logs = await db.algoLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
      const buckets = await db.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date() } } })
      await checkpointWal('truncate')
      return NextResponse.json({
        ok: true,
        message: `Purged ${logs.count} algo log(s) older than 14d + ${buckets.count} expired rate-limit bucket(s).`,
      })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    return handleError(e)
  }
}
