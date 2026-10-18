// Symmetric encryption (AES-256-GCM) for storing private credentials at rest
// (per-user Alpaca API keys, Telegram bot tokens). Never expose plaintext to client.
import crypto from 'crypto'

const SECRET =
  process.env.APP_ENCRYPTION_SECRET ||
  process.env.AUTH_SECRET ||
  'zai-tradeterminal-local-dev-secret'

const KEY = crypto.scryptSync(SECRET, 'tradeterminal-salt', 32)

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
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function maskKey(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
