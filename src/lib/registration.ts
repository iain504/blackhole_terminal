import { db } from '@/lib/db'

// Task 9-k — shared registration gate used by POST /api/auth/register (account
// creation) and GET /api/auth/2fa/setup (provisioning UI step). Both call this
// so the user learns "Registration is disabled" at the FIRST step (Continue)
// instead of after completing the QR/TOTP dance.
//
// Policy:
//  - ALLOW_REGISTRATION=true  → open registration (rate limits still apply).
//  - ALLOW_REGISTRATION=false → closed, EXCEPT the first-run bootstrap: a
//    fresh deployment with an empty user table must always be able to create
//    its FIRST account, or a sanitized publish reset would lock the install
//    out permanently (Task 9-j).
//  - ALLOW_REGISTRATION unset → open in non-production, closed in production
//    (v2.7.4). Rationale: the platform snapshot/publish pipeline sanitizes
//    non-DATABASE_URL lines out of .env (observed 2026-10-24, Task 10-i
//    recovery, and again 2026-11-02 10:59), which silently flipped this gate
//    closed after the first account existed and locked the operator out of
//    signup — "Registration is disabled". Production deployments (docker-
//    compose / render.yaml) always pass an explicit value, so they keep the
//    strict closed default; dev/preview self-heals.
export async function registrationOpen(): Promise<boolean> {
  const raw = (process.env.ALLOW_REGISTRATION || '').trim().toLowerCase()
  if (raw) return raw === 'true'
  return process.env.NODE_ENV !== 'production'
}
