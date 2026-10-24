import { db } from '@/lib/db'

// Task 9-k — shared registration gate used by POST /api/auth/register (account
// creation) and GET /api/auth/2fa/setup (provisioning UI step). Both call this
// so the user learns "Registration is disabled" at the FIRST step (Continue)
// instead of after completing the QR/TOTP dance.
//
// Policy:
//  - ALLOW_REGISTRATION=true  → open registration (rate limits still apply).
//  - Otherwise closed, EXCEPT the first-run bootstrap: a fresh deployment with
//    an empty user table must always be able to create its FIRST account, or a
//    sanitized publish reset would lock the install out permanently (Task 9-j).
export async function registrationOpen(): Promise<boolean> {
  const enabled = (process.env.ALLOW_REGISTRATION || '').trim().toLowerCase() === 'true'
  if (enabled) return true
  return (await db.user.count()) === 0
}
