// TOTP (RFC 6238) implementation — zero dependency, uses node:crypto.
// SERVER-ONLY: pulls in the at-rest crypto (node:crypto AES-GCM) — never
// import from client components.
import crypto from 'crypto'
import { encrypt as aesEncrypt, decrypt as aesDecrypt } from './crypt'

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

/** HOTP/TOTP core over an ABSOLUTE unix second — the pure, deterministic
 * function the RFC 6238 test vectors drive (Task 11-a). Kept separate from
 * the wall-clock wrapper so tests never sleep or mock timers. */
export function totpCodeAt(secret: string, timeStep: number, unixSec: number): string {
  const counter = Math.floor(unixSec / timeStep)
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

/** Code for the CURRENT window (`offset` = whole steps of clock drift). */
export function totpCode(secret: string, timeStep = 30, offset = 0): string {
  return totpCodeAt(secret, timeStep, Math.floor(Date.now() / 1000) + offset * timeStep)
}

/** Constant-time string compare: SHA-256 both sides first so every input is
 * the same 32-byte length (no length leak), then timingSafeEqual. */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/** Verify a 6-digit TOTP code allowing ±1 step clock drift. */
export function verifyTotp(secret: string, code: string): boolean {
  const clean = (code || '').replace(/\D/g, '')
  if (clean.length !== 6) return false
  for (const off of [-1, 0, 1]) {
    if (constantTimeEqual(totpCode(secret, 30, off), clean)) return true
  }
  return false
}

// ---- at-rest encryption for TOTP secrets ----
// Stored format: `enc:<base64 of crypt.ts AES-256-GCM payload>`.
// Legacy rows hold the raw base32 plaintext (no prefix) and are decrypted
// transparently; callers re-encrypt after successful verification.
const TOTP_ENC_PREFIX = 'enc:'

export function encryptTotpSecret(plain: string): string {
  return TOTP_ENC_PREFIX + Buffer.from(aesEncrypt(plain), 'utf8').toString('base64')
}

/** Returns the plaintext TOTP secret for `enc:`-prefixed (decrypted) or legacy
 * plaintext (passthrough) stored values; null when undecryptable. */
export function decryptTotpSecret(stored: string): string | null {
  if (!stored) return null
  if (!stored.startsWith(TOTP_ENC_PREFIX)) return stored // legacy plaintext
  try {
    const payload = Buffer.from(stored.slice(TOTP_ENC_PREFIX.length), 'base64').toString('utf8')
    return aesDecrypt(payload)
  } catch {
    return null
  }
}

export function otpauthUri(username: string, secret: string): string {
  return `otpauth://totp/TradeTerminal:${encodeURIComponent(username)}?secret=${secret}&issuer=TradeTerminal&algorithm=SHA1&digits=6&period=30`
}
