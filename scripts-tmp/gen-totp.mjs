// Generates the current TOTP code for the test account (2FA login in E2E).
import crypto from 'node:crypto'

const secret = process.env.TOTP_SECRET || 'P7FT****REDACTED'
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
let bits = ''
for (const c of secret.replace(/=+$/, '')) {
  const idx = alphabet.indexOf(c.toUpperCase())
  if (idx === -1) continue
  bits += idx.toString(2).padStart(5, '0')
}
const bytes = []
for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
const key = Buffer.from(bytes)
const counter = Math.floor(Date.now() / 1000 / 30)
const cbuf = Buffer.alloc(8)
cbuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
cbuf.writeUInt32BE(counter % 2 ** 32, 4)
const hmac = crypto.createHmac('sha1', key).update(cbuf).digest()
const off = hmac[hmac.length - 1] & 0xf
const code = (((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1e6
console.log(code.toString().padStart(6, '0'))
