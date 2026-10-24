// Symmetric encryption (AES-256-GCM) for storing private credentials at rest
// (per-user Alpaca API keys, Telegram bot tokens, TOTP secrets). Never expose
// plaintext to client.
import crypto from 'crypto'

const LEGACY_DEFAULT_SECRET = 'zai-tradeterminal-local-dev-secret'

// Fail closed: without a configured secret, credentials would be encrypted
// under a public constant (the old hardcoded default) — equivalent to
// plaintext. APP_ENCRYPTION_SECRET falls back to AUTH_SECRET.
const CONFIGURED_SECRET = process.env.APP_ENCRYPTION_SECRET || process.env.AUTH_SECRET
if (!CONFIGURED_SECRET) {
  throw new Error(
    'APP_ENCRYPTION_SECRET (or AUTH_SECRET) is not set. ' +
      "Generate one with: bun -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      'and put it in .env as APP_ENCRYPTION_SECRET=<hex>.'
  )
}

const KEY = crypto.scryptSync(CONFIGURED_SECRET, 'tradeterminal-salt', 32)

// Backward compatibility ONLY: rows written before the secret was configured
// were encrypted under the old hardcoded default. Used exclusively to decrypt
// legacy payloads (GCM auth-tag failure under the new key triggers the retry).
const LEGACY_KEY =
  CONFIGURED_SECRET === LEGACY_DEFAULT_SECRET
    ? KEY
    : crypto.scryptSync(LEGACY_DEFAULT_SECRET, 'tradeterminal-salt', 32)

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`
}

export function decrypt(payload: string): string | null {
  try {
    const [ivHex, tagHex, dataHex] = payload.split('.')
    if (!ivHex || !tagHex || !dataHex) return null
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const data = Buffer.from(dataHex, 'hex')
    // Try the current key first; on GCM tag failure retry the legacy key so
    // existing encrypted broker keys in the DB keep working until re-saved.
    for (const key of KEY.equals(LEGACY_KEY) ? [KEY] : [KEY, LEGACY_KEY]) {
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
