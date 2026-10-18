// TOTP generator (RFC 6238, base32 secret, SHA1, 30s window, 6 digits)
import crypto from 'crypto'

const SECRET = 'P7FT****REDACTED'
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(s) {
  s = s.toUpperCase().replace(/=+$/, '')
  let bits = 0, value = 0, out = []
  for (const c of s) {
    const idx = B32.indexOf(c)
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

const key = decodeBase32(SECRET)
const counter = Math.floor(Date.now() / 1000 / 30)
const buf = Buffer.alloc(8)
buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
buf.writeUInt32BE(counter >>> 0, 4)
const hmac = crypto.createHmac('sha1', key).update(buf).digest()
const offset = hmac[hmac.length - 1] & 0xf
const code =
  ((hmac[offset] & 0x7f) << 24) |
  ((hmac[offset + 1] & 0xff) << 16) |
  ((hmac[offset + 2] & 0xff) << 8) |
  (hmac[offset + 3] & 0xff)
console.log(String(code % 1e6).padStart(6, '0'))
