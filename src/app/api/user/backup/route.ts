import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import {
  BACKUP_APP, BACKUP_VERSION, MAX_ROWS_PER_TABLE, parseBackupEnvelope, restoreBackupData,
} from '@/lib/backup'

// ---------------------------------------------------------------------------
// Task 9-r — FULL account backup / restore (supersedes the scope of
// /api/user/config, which carries configuration only, no algo/grid history
// and no account record).
//
// GET  — export: one JSON envelope with the user record (username,
//        passwordHash, totpSecret AS STORED, settings AS STORED) and every
//        data row they own, keyed exactly like the Prisma models. Nothing is
//        decrypted: broker/telegram blobs and the TOTP secret ride the file
//        encrypted-at-rest, so they restore 1:1 when the install resolves the
//        same encryption secret and degrade gracefully (decrypt → null, user
//        re-enters keys) when it changed. Plaintext secrets never ship.
//        Response is an attachment (Content-Disposition) — the client ALSO
//        shows the JSON in a copyable textarea because sandboxed preview
//        iframes silently block downloads (see AlgoConfigIO.tsx, Task 9-n).
//
// POST — restore into the CURRENT account (session required): in ONE
//        transaction, delete the user's rows per table present in the file
//        and recreate them with userId rewritten to the current user (layout
//        upserts by userId; the per-user reco-cache row is re-keyed). Tables
//        absent from the file are untouched. The backup's passwordHash /
//        totpSecret / username are NOT applied — the caller is already logged
//        in with known-good credentials; only `settings` (as stored) is
//        adopted so Alpaca/Telegram/trade defaults survive a redeploy.
// ---------------------------------------------------------------------------

function backupFilename(username: string): string {
  const safe = username.replace(/[^A-Za-z0-9._-]/g, '') || 'user'
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  return `blackhole-backup-${safe}-${stamp}.json`
}

// ---- GET: assemble + download the backup envelope ----
export async function GET() {
  try {
    const session = await requireUser()
    const user = await db.user.findUnique({ where: { id: session.id } })
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [layout, watchlists, drawings, alerts, strategyRules, algoRuns, algoLogs, calendarAlarms, gridTrades, gridFills, algoRecoCache] =
      await Promise.all([
        db.layout.findUnique({ where: { userId: user.id } }),
        db.watchlist.findMany({ where: { userId: user.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
        db.drawing.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
        db.alert.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
        db.strategyRule.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
        db.algoRun.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
        // append-only journals can grow unbounded — cap at the most recent
        // MAX_ROWS_PER_TABLE so a backup is ALWAYS importable (the import
        // side refuses any table over the cap)
        db.algoLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: MAX_ROWS_PER_TABLE }),
        db.calendarAlarm.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
        db.gridTrade.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
        db.gridFill.findMany({ where: { userId: user.id }, orderBy: { ts: 'desc' }, take: MAX_ROWS_PER_TABLE }),
        // per-user sweep cache row (Task 9-m ids: algo-reco:<userId>) — NOT
        // the global baked row
        db.algoRecoCache.findUnique({ where: { id: `algo-reco:${user.id}` } }),
      ])

    const envelope = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      user: {
        username: user.username,
        // scrypt `salt:hash` — restoring as-is keeps the old password working
        passwordHash: user.passwordHash,
        // encrypted at rest (never plaintext) — see header note
        totpSecret: user.totpSecret,
        // AS STORED — may contain encrypted broker/telegram blobs
        settings: user.settings ?? null,
      },
      data: {
        layout,
        watchlists,
        drawings,
        alerts,
        strategyRules,
        algoRuns,
        algoLogs: algoLogs.reverse(), // back to chronological
        calendarAlarms,
        gridTrades,
        gridFills: gridFills.reverse(),
        algoRecoCache,
      },
    }

    return new NextResponse(JSON.stringify(envelope, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${backupFilename(user.username)}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

// ---- POST: restore into the CURRENT (logged-in) account ----
export async function POST(req: Request) {
  try {
    const session = await requireUser()
    const body: unknown = await req.json().catch(() => null)
    const parsed = parseBackupEnvelope(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const { user: backupUser, data } = parsed.file

    // adopt the backup's settings blob (as stored) when present — encrypted
    // secrets it contains only keep working if this install resolves the
    // same encryption secret; otherwise they decrypt to null and the user
    // re-enters keys (warned in the UI). Credentials (passwordHash /
    // totpSecret / username) are intentionally NOT touched here.
    const settings = backupUser.settings && typeof backupUser.settings === 'object' && !Array.isArray(backupUser.settings)
      ? (backupUser.settings as Prisma.InputJsonValue)
      : null

    const restored = await db.$transaction(async (tx) => {
      const counts = await restoreBackupData(tx, session.id, data)
      if (settings) {
        await tx.user.update({ where: { id: session.id }, data: { settings } })
        counts.settings = 1
      }
      return counts
    })

    return NextResponse.json({ ok: true, settings: Boolean(settings), restored })
  } catch (e) {
    // surface sanitizer errors (invalid layout/reco sections) as 400s
    if (e instanceof Error && /section/.test(e.message)) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    return handleError(e)
  }
}
