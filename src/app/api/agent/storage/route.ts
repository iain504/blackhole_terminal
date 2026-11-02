// v2.8.0 — server storage report + reclaim actions for the FSD tab.
//
// The full scan is the heaviest writer in the app and SQLite NEVER returns
// freed pages to the OS on its own: rows pruned by any housekeeping leave
// free pages inside the file, and the file (plus container stdout logs)
// only ever grows — the user-visible "12 GB after a full scan". This route
// makes the invisible visible and gives one-click fixes:
//
//   GET  /api/agent/storage   → db/wal file sizes, free disk, per-table rows
//   POST /api/agent/storage   → { action:
//      'vacuum'        | rebuild the DB file and return freed space to the OS
//      'purge-bars'    | drop the crypto bar cache (rebuilds on demand)
//      'purge-logs'    | drop algo logs > 14d + expired rate-limit buckets
//      'purge-kronos'  | drop Kronos forecasts > 30d (journal keeps 30d)
//   }
//
// All actions are session-gated (single-operator app) and non-fatal: a
// failed purge answers 500 with the reason, the FSD storage card shows it.
import { statSync } from 'fs'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { db, dbDiskStatus, checkpointWal, humanBytes } from '@/lib/db'

export const dynamic = 'force-dynamic'

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
    const [bars, algoLogs, agentEvents, agentSessions, kronos, rate, sentHead, sentScores, scanCache] =
      await Promise.all([
        db.bar.count(),
        db.algoLog.count(),
        db.agentEvent.count(),
        db.agentSession.count(),
        db.kronosForecast.count(),
        db.rateLimitBucket.count(),
        db.sentimentHeadline.count(),
        db.sentimentScore.count(),
        db.agentScanCache.count(),
      ])
    const disk = dbDiskStatus()
    const paths = dbFilePaths()
    return NextResponse.json({
      disk: {
        free: bytesOrNull(disk.freeBytes),
        total: bytesOrNull(disk.totalBytes),
        db: bytesOrNull(paths ? fileBytes(paths.dbPath) : null),
        wal: bytesOrNull(paths ? fileBytes(paths.walPath) : null),
        path: disk.path,
      },
      tables: [
        { key: 'bars', label: 'Crypto bar cache', rows: bars, hint: 'Rebuilds on demand from the exchange feeds' },
        { key: 'algoLogs', label: 'Algo engine logs', rows: algoLogs, hint: '15s-cycle engine history' },
        { key: 'agentEvents', label: 'Autopilot brain feed', rows: agentEvents, hint: 'Bounded to 400 per session' },
        { key: 'agentSessions', label: 'Autopilot sessions', rows: agentSessions, hint: 'Newest 20 kept per user' },
        { key: 'kronos', label: 'Kronos forecasts', rows: kronos, hint: 'Forecast journal' },
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
  action?: 'vacuum' | 'purge-bars' | 'purge-logs' | 'purge-kronos'
}

export async function POST(req: Request) {
  try {
    await requireUser()
    const body = (await req.json().catch(() => ({}))) as StoragePostBody
    const action = body?.action

    if (action === 'vacuum') {
      const paths = dbFilePaths()
      const before = paths ? fileBytes(paths.dbPath) : null
      await checkpointWal('truncate')
      // VACUUM rebuilds the database file into a temporary copy first — on a
      // large, long-grown file this can take a while and needs free disk of
      // roughly the file size. The pre-flight disk guards elsewhere keep the
      // volume from being full enough to break it.
      await db.$executeRawUnsafe('VACUUM')
      const after = paths ? fileBytes(paths.dbPath) : null
      const freed = before != null && after != null ? Math.max(0, before - after) : null
      return NextResponse.json({
        ok: true,
        message:
          freed != null
            ? `VACUUM done — ${humanBytes(before ?? 0)} → ${humanBytes(after ?? 0)} (freed ${humanBytes(freed)})`
            : 'VACUUM done',
      })
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

    if (action === 'purge-kronos') {
      const res = await db.kronosForecast.deleteMany({ where: { madeAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } })
      await checkpointWal('truncate')
      return NextResponse.json({ ok: true, message: `Purged ${res.count} Kronos forecast(s) older than 30d.` })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    return handleError(e)
  }
}
