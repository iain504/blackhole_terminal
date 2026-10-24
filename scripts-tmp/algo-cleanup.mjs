import crypto from 'node:crypto'
const BASE = 'http://localhost:3000'
let cookie = ''
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const setC = res.headers.get('set-cookie'); if (setC) cookie = setC.split(';')[0]
  const t = await res.text(); let j = null; try { j = JSON.parse(t) } catch {}
  return { status: res.status, json: j, text: t.slice(0, 300) }
}
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''
  for (const c of secret.replace(/=+$/, '')) { const i = alphabet.indexOf(c.toUpperCase()); if (i === -1) continue; bits += i.toString(2).padStart(5, '0') }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  const key = Buffer.from(bytes); const counter = Math.floor(Date.now() / 1000 / 30)
  const cbuf = Buffer.alloc(8); cbuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0); cbuf.writeUInt32BE(counter % 2 ** 32, 4)
  const hmac = crypto.createHmac('sha1', key).update(cbuf).digest(); const off = hmac[hmac.length - 1] & 0xf
  return String((((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1e6).padStart(6, '0')
}
await api('PUT', '/api/auth/register', { username: 'trader', password: process.env.TEST_PASS ?? '', // creds via env (scrubbed from repo) })
await api('POST', '/api/auth/login/verify', { ticket: (await api('PUT', '/api/auth/register', { username: 'trader', password: process.env.TEST_PASS ?? '', // creds via env (scrubbed from repo) })).json?.ticket, code: totp(process.env.TOTP_SECRET ?? '') })
const runId = process.argv[2]
const stop = await api('POST', `/api/algo/${runId}/stop`, { flatten: true })
console.log('stop+flatten', stop.status, JSON.stringify(stop.json))
await new Promise((r) => setTimeout(r, 4000))
const st = await api('GET', '/api/algo')
const run = st.json?.runs?.find((r) => r.id === runId)
console.log('status:', run?.status)
for (const l of (run?.logs ?? []).slice(-4)) console.log(`  [${l.level}] ${l.createdAt.slice(11, 19)} ${l.message.slice(0, 140)}`)
const del = await api('DELETE', `/api/algo/${runId}`)
console.log('delete', del.status, JSON.stringify(del.json))
const after = await api('GET', '/api/algo')
console.log('remaining runs:', after.json?.runs?.length)
