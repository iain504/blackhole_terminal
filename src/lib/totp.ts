// TOTP (RFC 6238) implementation — zero dependency, uses node:crypto.
import crypto from 'crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateTotpSecret(length = 20): string {
  const bytes = crypto.randomBytes(length)
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totpCode(secret: string, timeStep = 30, offset = 0): string {
  const counter = Math.floor(Date.now() / 1000 / timeStep) + offset
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const idx = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[idx] & 0x7f) << 24) |
    ((hmac[idx + 1] & 0xff) << 16) |
    ((hmac[idx + 2] & 0xff) << 8) |
    (hmac[idx + 3] & 0xff)
  return String(code % 1000000).padStart(6, '0')
}

/** Verify a 6-digit TOTP code allowing ±1 step clock drift. */
export function verifyTotp(secret: string, code: string): boolean {
  const clean = (code || '').replace(/\D/g, '')
  if (clean.length !== 6) return false
  for (const off of [-1, 0, 1]) {
    if (totpCode(secret, 30, off) === clean) return true
  }
  return false
}

export function otpauthUri(username: string, secret: string): string {
  return `otpauth://totp/TradeTerminal:${encodeURIComponent(username)}?secret=${secret}&issuer=TradeTerminal&algorithm=SHA1&digits=6&period=30`
}
