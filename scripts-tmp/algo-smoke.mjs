// Task 61 smoke test: login → algo run lifecycle via the real API.
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
  try { json = JSON.parse(text) } catch { /* html */ }
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

// ---- login ----
const step1 = await api('PUT', '/api/auth/register', { username: 'trader', password: process.env.TEST_PASS ?? '', // creds via env (scrubbed from repo) })
console.log('step1', step1.status, step1.json?.ticket ? 'ticket ok' : step1.text)
const code = totp(process.env.TOTP_SECRET ?? '')
const step2 = await api('POST', '/api/auth/login/verify', { ticket: step1.json?.ticket, code })
console.log('step2', step2.status, JSON.stringify(step2.json))

// ---- baseline ----
const before = await api('GET', '/api/algo')
console.log('GET /api/algo', before.status, 'runs:', before.json?.runs?.length ?? '?', 'mode:', before.json?.mode, 'configured:', before.json?.configured)

// ---- start a run: aggressive BB reversion likely to fire pre-market ----
const start = await api('POST', '/api/algo', {
  symbol: 'TSLA',
  timeframe: '1m',
  strategy: 'bb-reversion',
  params: { bbPeriod: 20, bbStd: 1, rsiPeriod: 2, rsiOversold: 80, rsiOverbought: 20, allowShort: 0 },
  qty: 1,
  tpMode: 'pct', tpValue: 5,
  slMode: 'pct', slValue: 5,
  maxTradesDay: 2,
  rthOnly: false,
  flattenEod: true,
})
console.log('POST /api/algo', start.status, JSON.stringify(start.json).slice(0, 300))
const runId = start.json?.run?.id
if (!runId) process.exit(1)

// validation checks
const badTf = await api('POST', '/api/algo', { symbol: 'TSLA', timeframe: '1D', strategy: 'bb-reversion', qty: 1 })
console.log('bad tf →', badTf.status, badTf.json?.error)
const badStrat = await api('POST', '/api/algo', { symbol: 'TSLA', timeframe: '5m', strategy: 'nope', qty: 1 })
console.log('bad strategy →', badStrat.status, badStrat.json?.error)
const badQty = await api('POST', '/api/algo', { symbol: 'TSLA', timeframe: '5m', strategy: 'bb-reversion', qty: -3 })
console.log('bad qty →', badQty.status, badQty.json?.error)

// ---- watch the engine for 90s ----
for (const wait of [15, 30, 45]) {
  await new Promise((r) => setTimeout(r, wait === 15 ? 15000 : wait === 30 ? 30000 : 45000))
  const st = await api('GET', '/api/algo')
  const run = st.json?.runs?.find((r) => r.id === runId)
  if (!run) { console.log('RUN MISSING'); process.exit(1) }
  console.log(`\n=== t+${wait}s status=${run.status} tradesToday=${run.tradesToday} logs=${run.logs.length}`)
  for (const l of run.logs.slice(-6)) console.log(`  [${l.level}] ${l.createdAt.slice(11, 19)} ${l.message.slice(0, 130)}`)
}

// ---- stop / restart / delete ----
const stop = await api('POST', `/api/algo/${runId}/stop`, { flatten: false })
console.log('stop', stop.status, JSON.stringify(stop.json))
const restart = await api('POST', `/api/algo/${runId}/start`)
console.log('restart', restart.status, JSON.stringify(restart.json))
const del = await api('DELETE', `/api/algo/${runId}`)
console.log('delete', del.status, JSON.stringify(del.json))
const after = await api('GET', '/api/algo')
console.log('after delete runs:', after.json?.runs?.length ?? '?')
