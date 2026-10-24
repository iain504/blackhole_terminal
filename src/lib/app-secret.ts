// Master app secret resolution: env -> DB -> generate & persist (Task 9-j).
//
// Why this exists: the platform publish pipeline sanitizes secret lines out of
// .env (observed 2026-10-24: .env reduced to DATABASE_URL only). The Task 91
// fail-closed change correctly refused to boot on a missing secret — which
// made every publish fail. This resolver keeps the security guarantee that
// matters (the secret is NEVER a publicly-known constant) while remaining
// bootable in sanitized environments:
//   1. env (APP_ENCRYPTION_SECRET || AUTH_SECRET) wins and is MIRRORED into
//      the DB, so a later sanitized boot resolves the SAME key and broker
//      credentials encrypted under it stay decryptable;
//   2. otherwise the DB row is used;
//   3. otherwise a fresh random key is generated and persisted.
// Threat-model note: the key lives in the same local trust domain as the
// ciphertext it protects (equivalent exposure to an on-disk .env). The
// eliminated risk is the original one: a hardcoded, git-published default.
// Caveat: changing APP_ENCRYPTION_SECRET after credentials were stored under
// a different key makes those rows undecryptable (GCM tag failure) — set it
// once and keep it stable.
import crypto from 'crypto'
import { db } from '@/lib/db'

const KNOWN_PUBLIC_DEFAULT = 'zai-tradeterminal-local-dev-secret'

// Memo lives on globalThis: Next.js compiles this lib into MULTIPLE module
// instances (instrumentation bundle, per-route server chunks), each with its
// own module scope. A module-level memo would be set in one instance and
// invisible to the others. globalThis is shared across every instance in the
// process (same pattern as instrumentation.ts's __ttInstrumented guard).
const g = globalThis as typeof globalThis & { __ttAppSecret?: string }

async function persist(value: string): Promise<void> {
  try {
    await db.appSecret.upsert({
      where: { key: 'master' },
      update: { value },
      create: { key: 'master', value },
    })
  } catch {
    // DB unavailable (e.g. exotic build context) — env-only operation is fine;
    // a later boot will persist it.
  }
}

export async function resolveAppSecret(): Promise<string> {
  if (g.__ttAppSecret) return g.__ttAppSecret
  const env = process.env.APP_ENCRYPTION_SECRET || process.env.AUTH_SECRET
  if (env && env !== KNOWN_PUBLIC_DEFAULT && env.length >= 32) {
    await persist(env)
    g.__ttAppSecret = env
    return env
  }
  try {
    const row = await db.appSecret.findUnique({ where: { key: 'master' } })
    if (row?.value) {
      g.__ttAppSecret = row.value
      return row.value
    }
  } catch {
    // fall through to generate
  }
  const generated = crypto.randomBytes(32).toString('hex')
  await persist(generated)
  g.__ttAppSecret = generated
  return generated
}

/**
 * Sync accessor for module-level consumers (HMAC session signing, AES key
 * derivation). Valid once resolveAppSecret() has completed — boot
 * instrumentation awaits it before any route is served; request paths that
 * somehow run earlier must `await resolveAppSecret()` first.
 */
export function appSecretSync(): string {
  const v = g.__ttAppSecret
  if (!v) {
    throw new Error(
      'App secret not initialized yet — resolveAppSecret() must run first (boot instrumentation does this).'
    )
  }
  return v
}
