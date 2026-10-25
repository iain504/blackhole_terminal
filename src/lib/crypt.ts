// Symmetric encryption (AES-256-GCM) for storing private credentials at rest
// (per-user Alpaca API keys, Telegram bot tokens, TOTP secrets). Never expose
// plaintext to client.
import crypto from 'crypto'
import { appSecretSync } from '@/lib/app-secret'

const LEGACY_DEFAULT_SECRET = 'zai-tradeterminal-local-dev-secret'

// Fail closed, lazily (Task 9-j): the master secret resolves via
// env -> DB -> generate-and-persist (see app-secret.ts). Key derivation is
// deferred to first use — module evaluation must stay side-effect-free so a
// sanitized-env BUILD (platform publish) cannot crash on import.
let keyCache: { src: string; buf: Buffer } | null = null
function currentKey(): Buffer {
  const src = appSecretSync()
  if (!keyCache || keyCache.src !== src) {
    keyCache = { src, buf: crypto.scryptSync(src, 'tradeterminal-salt', 32) }
  }
  return keyCache.buf
}

// Backward compatibility ONLY: rows written before the secret was configured
// were encrypted under the old hardcoded default. Used exclusively to decrypt
// legacy payloads (GCM auth-tag failure under the new key triggers the retry).
let legacyKeyCache: Buffer | null = null
function legacyKey(): Buffer {
  if (!legacyKeyCache) legacyKeyCache = crypto.scryptSync(LEGACY_DEFAULT_SECRET, 'tradeterminal-salt', 32)
  return legacyKeyCache
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', currentKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`
}

export function decrypt(payload: string): string | null {
  try {
    const [ivHex, tagHex, dataHex] = payload.split('.')
    // dataHex may be '' (empty plaintext is legal — GCM handles it, Task 11-a);
    // only genuinely MISSING segments are malformed.
    if (ivHex == null || tagHex == null || dataHex == null) return null
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const data = Buffer.from(dataHex, 'hex')
    // Try the current key first; on GCM tag failure retry the legacy key so
    // existing encrypted broker keys in the DB keep working until re-saved.
    const cur = currentKey()
    const leg = legacyKey()
    for (const key of cur.equals(leg) ? [cur] : [cur, leg]) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      } catch {
        // wrong key — try next
      }
    }
    return null
  } catch {
    return null
  }
}

export function maskKey(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
