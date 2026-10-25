import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientIp } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { parseBackupEnvelope, restoreBackupData } from '@/lib/backup'

// ---------------------------------------------------------------------------
// Task 9-r — restore a backup into an EMPTY system (the login screen path).
//
// STRICT GATE: allowed ONLY while the user table is empty — exactly the
// first-run bootstrap trust level the registration route uses (Task 9-j: a
// sanitized publish reset must always be recoverable). Once ANY account
// exists the answer is 409 and the supported path is Settings → Backup &
// Restore (session-authenticated).
//
// The User row is created with the backup's username / passwordHash (kept
// AS-IS so the previous password keeps working — it is a scrypt `salt:hash`,
// never plaintext) / totpSecret and settings, all AS STORED. Nothing is
// decrypted here: the TOTP secret and any broker/telegram blobs inside
// settings are encrypted-at-rest payloads that restore 1:1 when this install
// resolves the same encryption secret (app-secret.ts: env → DB mirror), and
// fail to decrypt gracefully when it changed.
// ---------------------------------------------------------------------------

class RestoreConflictError extends Error {
  constructor() {
    super('System already has accounts — log in and use Settings → Backup & Restore instead.')
  }
}

// GET → { available: boolean } — true iff the system still has no accounts,
// so the auth screen can decide whether to offer the restore affordance.
export async function GET() {
  try {
    const count = await db.user.count()
    return NextResponse.json({ available: count === 0 })
  } catch (e) {
    return handleError(e)
  }
}

// scrypt passwordHash produced by hashPassword(): "<32-hex salt>:<128-hex hash>"
const PASSWORD_HASH_RE = /^[0-9a-fA-F]{16,}:[0-9a-fA-F]{64,}$/

export async function POST(req: Request) {
  try {
    const ip = clientIp(req)
    // stricter than register: a successful call CREATES a fully-formed
    // account, so the budget is smaller
    const rl = await rateLimit(`restore:${ip}`, 3, 10 * 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many attempts — try again later' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } }
      )
    }
    // Gate BEFORE parsing (cheap rejection once accounts exist).
    if ((await db.user.count()) > 0) {
      return NextResponse.json(
        { error: 'System already has accounts — log in and use Settings → Backup & Restore instead.' },
        { status: 409 }
      )
    }

    const body: unknown = await req.json().catch(() => null)
    const parsed = parseBackupEnvelope(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const { user: backupUser, data } = parsed.file

    // Validate the account fields like registration does (register/route.ts):
    // username 3-40 chars; the password material arrives pre-hashed so there
    // is no plaintext password to length-check.
    const username = typeof backupUser.username === 'string' ? backupUser.username.trim() : ''
    if (username.length < 3 || username.length > 40) {
      return NextResponse.json(
        { error: 'Backup username is invalid (must be 3-40 characters)' },
        { status: 400 }
      )
    }
    const passwordHash = typeof backupUser.passwordHash === 'string' ? backupUser.passwordHash.trim() : ''
    if (!PASSWORD_HASH_RE.test(passwordHash)) {
      return NextResponse.json(
        { error: 'Backup has no usable password hash — export a fresh backup on the original install' },
        { status: 400 }
      )
    }
    const totpSecret = typeof backupUser.totpSecret === 'string' ? backupUser.totpSecret.trim() : ''
    if (!totpSecret || totpSecret.length > 500) {
      return NextResponse.json(
        { error: 'Backup has no 2FA secret — the restored account could never log in' },
        { status: 400 }
      )
    }
    const settings =
      backupUser.settings && typeof backupUser.settings === 'object' && !Array.isArray(backupUser.settings)
        ? (backupUser.settings as Prisma.InputJsonValue)
        : null

    let counts: Record<string, number> = {}
    try {
      await db.$transaction(async (tx) => {
        // Re-check INSIDE the transaction (SQLite serializes writes): a
        // concurrent register/restore slipping between the gate above and
        // this point must not sneak a second account into a "fresh install".
        if ((await tx.user.count()) > 0) throw new RestoreConflictError()
        const user = await tx.user.create({
          data: {
            username,
            // kept AS-IS — the old password must keep working
            passwordHash,
            // encrypted at rest, kept AS-IS (same install secret ⇒ same TOTP)
            totpSecret,
            ...(settings ? { settings } : {}),
          },
        })
        counts = await restoreBackupData(tx, user.id, data)
        // First-run parity with register/route.ts: when the backup carries no
        // watchlists at all, seed the same default list so the terminal is
        // not empty on first login.
        if (!Array.isArray(data.watchlists)) {
          await tx.watchlist.create({
            data: { userId: user.id, name: 'My Watchlist', color: '#22c55e', sortOrder: 0, items: ['AAPL', 'MSFT', 'NVDA', 'TSLA'] },
          })
          counts.watchlists = (counts.watchlists ?? 0) + 1
        }
      })
    } catch (e) {
      if (e instanceof RestoreConflictError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      // unique-constraint race on username (registration won the race)
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ error: 'Cannot restore — an account with that username already exists' }, { status: 409 })
      }
      if (e instanceof Error && /section/.test(e.message)) {
        return NextResponse.json({ error: e.message }, { status: 400 })
      }
      throw e
    }

    // No session is issued — the user is sent back to the login form with
    // their previous username + password + TOTP (the auth screen pre-fills
    // the username).
    return NextResponse.json({ ok: true, username, counts })
  } catch (e) {
    return handleError(e)
  }
}
