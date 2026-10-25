// Task 11-b — secret rotation script (the 2026 deep review's Security item:
// "Add secret-rotation script"). Self-contained: mirrors the EXACT crypto of
// src/lib/crypt.ts / app-secret.ts without importing app code.
//
//   bun scripts/rotate-secrets.mjs --auth              # rotate AUTH_SECRET
//   bun scripts/rotate-secrets.mjs --encryption        # rotate the master AES-256-GCM key,
//                                                      # re-encrypting every stored credential
//   bun scripts/rotate-secrets.mjs --all               # both
//   extra flags: --dry-run   decrypt + re-encrypt in memory, write nothing
//                --force     skip rows that fail to decrypt (they stay broken —
//                            you will need to re-enter those credentials)
//                --value <hex>  supply the new secret instead of generating one
//
// What --encryption re-encrypts (the only AES-256-GCM payloads in the DB):
//   · User.totpSecret            — stored as `enc:<base64(payload)>` (or legacy
//                                  plaintext, which is upgraded to encrypted)
//   · User.settings.alpacaKeyIdEnc / alpacaSecretEnc / telegramTokenEnc
//                                 — raw `iv.tag.data` payload strings
// plus the AppSecret 'master' row (the fallback install key) and the
// APP_ENCRYPTION_SECRET line in .env.
//
// What --auth does: rewrites AUTH_SECRET in .env. NOTE the session-cookie
// HMAC key is the RESOLVED app secret (APP_ENCRYPTION_SECRET || AUTH_SECRET
// || master, see app-secret.ts) — so --auth only invalidates sessions when
// APP_ENCRYPTION_SECRET is NOT set (then the resolved secret falls back to
// AUTH_SECRET). Rotating the encryption key (--encryption) is what always
// invalidates sessions.
//
// ⚠ Restart the server after rotation — running processes hold the old key
// in memory and would encrypt new writes under it (mixed-key state).
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const SALT = 'tradeterminal-salt' // must match src/lib/crypt.ts
const LEGACY_DEFAULT_SECRET = 'zai-tradeterminal-local-dev-secret'
const ENV_PATH = path.resolve(process.cwd(), '.env')

const prisma = new PrismaClient()

const argv = process.argv.slice(2)
const flags = {
  auth: argv.includes('--auth'),
  encryption: argv.includes('--encryption'),
  all: argv.includes('--all'),
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  value: (() => {
    const i = argv.indexOf('--value')
    return i >= 0 ? argv[i + 1] : undefined
  })(),
}

function hex(n) {
  return crypto.randomBytes(n).toString('hex')
}
function keyFor(secret) {
  return crypto.scryptSync(secret, SALT, 32)
}
function encryptWith(plain, secret) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${enc.toString('hex')}`
}
function decryptWith(payload, secret) {
  try {
    const [ivHex, tagHex, dataHex] = String(payload).split('.')
    if (ivHex == null || tagHex == null || dataHex == null) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
/** Try the effective secret, then the pre-9-j hardcoded default. */
function tryDecrypt(payload, oldSecret) {
  return decryptWith(payload, oldSecret) ?? decryptWith(payload, LEGACY_DEFAULT_SECRET)
}

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// ---- .env line surgery (everything else is preserved verbatim) -------------
function upsertEnvLine(name, value) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : ''
  const re = new RegExp(`^${name}=.*$`, 'm')
  if (re.test(text)) text = text.replace(re, `${name}=${value}`)
  else text = `${text.replace(/\n*$/, '\n')}${name}=${value}\n`
  fs.writeFileSync(ENV_PATH, text)
}

// ---- resolve the CURRENT effective master secret (env wins, as at runtime) --
async function resolveOldSecret() {
  const envSecret = process.env.APP_ENCRYPTION_SECRET || process.env.AUTH_SECRET
  if (envSecret) return { secret: envSecret, src: 'env' }
  const row = await prisma.appSecret.findUnique({ where: { key: 'master' } })
  if (row?.value) return { secret: row.value, src: 'db' }
  die('no master secret found (no APP_ENCRYPTION_SECRET/AUTH_SECRET in env, no AppSecret master row) — nothing to rotate from')
}

async function rotateEncryption() {
  const { secret: oldSecret, src } = await resolveOldSecret()
  const newSecret = flags.value || process.env.NEW_APP_ENCRYPTION_SECRET || hex(32)
  if (newSecret === oldSecret) die('new secret equals the current one — nothing to do')
  console.log(`• resolving current master secret from: ${src}`)
  console.log(`• new APP_ENCRYPTION_SECRET: ${newSecret.slice(0, 8)}…${newSecret.slice(-4)} ${flags.dryRun ? '(dry run)' : ''}`)

  const stats = { users: 0, totp: 0, totpUpgraded: 0, settings: 0, fields: 0, skipped: [] }
  const users = await prisma.user.findMany({ select: { id: true, username: true, totpSecret: true, settings: true } })

  const updates = []
  for (const u of users) {
    const patch = {}
    // 1) TOTP secret — `enc:` prefixed (re-encrypt) or legacy plaintext (upgrade).
    if (u.totpSecret) {
      if (u.totpSecret.startsWith('enc:')) {
        const plain = tryDecrypt(Buffer.from(u.totpSecret.slice(4), 'base64').toString('utf8'), oldSecret)
        if (plain == null) {
          stats.skipped.push(`${u.username}: totpSecret undecryptable`)
          if (!flags.force) die(`aborting: ${u.username}.totpSecret does not decrypt under the current master (use --force to skip — that user must re-enroll 2FA)`)
        } else {
          patch.totpSecret = 'enc:' + Buffer.from(encryptWith(plain, newSecret), 'utf8').toString('base64')
          stats.totp++
        }
      } else {
        patch.totpSecret = 'enc:' + Buffer.from(encryptWith(u.totpSecret, newSecret), 'utf8').toString('base64')
        stats.totpUpgraded++
      }
    }
    // 2) settings JSON — every *Enc field holds a raw crypt.encrypt payload.
    if (u.settings && typeof u.settings === 'object' && !Array.isArray(u.settings)) {
      const next = { ...u.settings }
      let touched = false
      for (const [k, v] of Object.entries(next)) {
        if (!k.endsWith('Enc') || typeof v !== 'string' || v.length === 0) continue
        const plain = tryDecrypt(v, oldSecret)
        if (plain == null) {
          stats.skipped.push(`${u.username}.settings.${k} undecryptable`)
          if (!flags.force) die(`aborting: ${u.username}.settings.${k} does not decrypt under the current master (use --force to skip — re-enter that credential in Settings)`)
          continue
        }
        next[k] = encryptWith(plain, newSecret)
        stats.fields++
        touched = true
      }
      if (touched) patch.settings = next
    }
    if (Object.keys(patch).length > 0) updates.push({ id: u.id, patch })
  }
  stats.users = updates.length

  if (flags.dryRun) {
    console.log('• dry run — writing nothing. Would update:', stats)
    return
  }
  for (const { id, patch } of updates) {
    await prisma.user.update({ where: { id }, data: patch })
  }
  await prisma.appSecret.upsert({
    where: { key: 'master' },
    update: { value: newSecret },
    create: { key: 'master', value: newSecret },
  })
  upsertEnvLine('APP_ENCRYPTION_SECRET', newSecret)
  console.log(`✓ re-encrypted ${stats.totp} TOTP secrets (${stats.totpUpgraded} legacy plaintexts upgraded) + ${stats.fields} settings.*Enc fields across ${stats.users} user(s)`)
  if (stats.skipped.length) console.warn(`⚠ skipped (undecryptable, --force): ${stats.skipped.join('; ')}`)
  console.log('✓ AppSecret master row + .env updated')
}

function rotateAuth() {
  const newSecret = flags.value || hex(32)
  if (flags.dryRun) {
    console.log('• dry run — would replace AUTH_SECRET in .env')
    return
  }
  upsertEnvLine('AUTH_SECRET', newSecret)
  console.log('✓ .env AUTH_SECRET updated')
  const caveat = process.env.APP_ENCRYPTION_SECRET
    ? 'sessions are NOT invalidated: the cookie HMAC uses the resolved app secret, and APP_ENCRYPTION_SECRET is set (it wins). Rotate the encryption key to force re-login.'
    : 'all sessions are invalidated (the resolved secret was AUTH_SECRET) — every user must sign in again.'
  console.log(`• ${caveat}`)
}

async function main() {
  if (!flags.auth && !flags.encryption && !flags.all) {
    console.log('usage: bun scripts/rotate-secrets.mjs --auth | --encryption | --all [--dry-run] [--force] [--value <hex>]\nsee the header comment for what each mode touches.')
    return
  }
  try {
    if (flags.all || flags.encryption) await rotateEncryption()
    if (flags.all || flags.auth) rotateAuth()
    if (!flags.dryRun) console.log('✓ done — RESTART the server now (bun run dev / systemctl restart / docker compose up -d) so every process holds the new key.')
  } finally {
    await prisma.$disconnect()
  }
}

await main()
