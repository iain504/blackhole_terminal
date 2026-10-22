// Task 61 smoke #2: BTC/USD (24/7 Binance bars) — entry-path verification.
import crypto from 'node:crypto'
const BASE = 'http://localhost:3000'
let cookie = ''
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setC = res.headers.get('set-cookie')
  if (setC) cookie = setC.split(';')[0]
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text: text.slice(0, 200) }
}
function totp(secret) {
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
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]
  return String(code % 1e6).padStart(6, '0')
}
const step1 = await api('PUT', '/api/auth/register', { username: 'trader', password: 'S****99' })
const step2 = await api('POST', '/api/auth/login/verify', { ticket: step1.json?.ticket, code: totp('P7FT****REDACTED') })
console.log('login', step2.status)

const start = await api('POST', '/api/algo', {
  symbol: 'BTC/USD',
  timeframe: '1m',
  strategy: 'bb-reversion',
  params: { bbPeriod: 20, bbStd: 1, rsiPeriod: 2, rsiOversold: 85, rsiOverbought: 20, allowShort: 0 },
  qty: 0.001,
  tpMode: 'pct', tpValue: 2,
  slMode: 'pct', slValue: 2,
  maxTradesDay: 1,
  rthOnly: false,
  flattenEod: false,
})
console.log('start', start.status, JSON.stringify(start.json).slice(0, 160))
const runId = start.json?.run?.id
if (!runId) process.exit(1)

let fired = false
for (let i = 0; i < 10 && !fired; i++) {
  await new Promise((r) => setTimeout(r, 30000))
  const st = await api('GET', '/api/algo')
  const run = st.json?.runs?.find((r) => r.id === runId)
  if (!run) { console.log('RUN MISSING'); break }
  const tail = run.logs.slice(-5)
  console.log(`--- t+${(i + 1) * 30}s trades=${run.tradesToday}`)
  for (const l of tail) console.log(`  [${l.level}] ${l.createdAt.slice(11, 19)} ${l.message.slice(0, 140)}`)
  if (run.logs.some((l) => l.level === 'trade' || (l.level === 'error' && !l.message.includes('bar fetch')))) fired = true
}
console.log('FIRED_OR_ERRORED:', fired)
console.log('RUN_ID=' + runId)
