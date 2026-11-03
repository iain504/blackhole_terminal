import { db } from '@/lib/db'

// Task 9-k — shared registration gate used by POST /api/auth/register (account
// creation) and GET /api/auth/2fa/setup (provisioning UI step). Both call this
// so the user learns "Registration is disabled" at the FIRST step (Continue)
// instead of after completing the QR/TOTP dance.
//
// Policy (v2.11.1 — bootstrap RESTORED; v2.7.4 accidentally dropped it while
// every doc still promised it, so a fresh compose deployment with the default
// ALLOW_REGISTRATION=false could not create even its FIRST account):
//  - ALLOW_REGISTRATION=true  → open registration (rate limits still apply).
//  - ALLOW_REGISTRATION=false → closed, EXCEPT the first-run bootstrap: an
//    install with an EMPTY user table must always be able to create its FIRST
//    account (Task 9-j), or a fresh deployment / sanitized publish reset would
//    lock the operator out permanently. Once one account exists, false wins.
//  - ALLOW_REGISTRATION unset → open in non-production, closed in production
//    (v2.7.4). Rationale: the platform snapshot/publish pipeline sanitizes
//    non-DATABASE_URL lines out of .env (observed 2026-10-24, Task 10-i
//    recovery, 2026-11-02 10:59, and 2026-11-03 19:39), which silently flipped
//    this gate closed after the first account existed and locked the operator
//    out of signup — "Registration is disabled". Production deployments
//    (docker-compose / render.yaml) always pass an explicit value, so they
//    keep the strict closed default; dev/preview self-heals.
//  - The bootstrap window is capped by the register route's IP rate limit
//    (5 attempts / 10 min) and shuts forever once the first account exists.
export async function registrationOpen(): Promise<boolean> {
  const raw = (process.env.ALLOW_REGISTRATION || '').trim().toLowerCase()
  if (raw === 'true') return true
  // First-run bootstrap (Task 9-j): count the users only when the env would
  // otherwise say closed — true exits above, so this DB roundtrip never runs
  // on an already-open install. DB failure must not crash the gate: fall
  // through to the closed default (the register route fails honestly on the
  // next DB call anyway).
  try {
    if ((await db.user.count()) === 0) return true
  } catch {
    /* fall through */
  }
  if (raw) return false // explicit false with a non-empty table
  return process.env.NODE_ENV !== 'production'
}
