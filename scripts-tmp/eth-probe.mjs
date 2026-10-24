// Task 76 probe: does /api/market/bars actually return pre-market/after-hours
// bars for TSLA? Classifies every bar by ET session (same rule as sessions.ts)
// and buckets extended bars by hour-of-day so we can see WHERE they live.
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
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
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
  return String((((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1e6).padStart(6, '0')
}

const etMin = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false })
const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

function etMinutes(sec) {
  let h = 0, m = 0
  for (const p of etMin.formatToParts(new Date(sec * 1000))) {
    if (p.type === 'hour') h = Number(p.value) % 24
    else if (p.type === 'minute') m = Number(p.value)
  }
  return h * 60 + m
}

function analyze(label, bars) {
  let regular = 0, pre = 0, post = 0, other = 0
  const byDayHour = new Map()
  let first = null, last = null
  for (const b of bars) {
    const m = etMinutes(b.time)
    const bucket = m >= 570 && m < 960 ? 'regular' : m < 570 && m >= 240 ? 'PRE' : m >= 960 && m < 1200 ? 'POST' : 'OTHER'
    if (bucket === 'regular') regular++
    else if (bucket === 'PRE') pre++
    else if (bucket === 'POST') post++
    else other++
    if (bucket !== 'regular') {
      const key = `${etDay.format(new Date(b.time * 1000))} ET`
      byDayHour.set(key, (byDayHour.get(key) || 0) + 1)
      if (!first) first = key
      last = key
    }
  }
  console.log(`\n== ${label}: ${bars.length} bars | regular=${regular} preMarket(04:00-09:30)=${pre} afterHours(16:00-20:00)=${post} other=${other}`)
  if (byDayHour.size) {
    console.log('   extended bars by day+hour (most recent 25):')
    for (const [k, v] of [...byDayHour.entries()].slice(-25)) console.log(`   ${k}  x${v}`)
  } else {
    console.log('   NO extended-session bars in payload at all')
  }
}

// ---- login ----
const step1 = await api('PUT', '/api/auth/register', { username: 'trader', password: process.env.TEST_PASS || '', })
const step2 = await api('POST', '/api/auth/login/verify', { ticket: step1.json?.ticket, code: totp(process.env.TOTP_SECRET || '') })
console.log('login:', step1.status, step2.status, step2.json?.user ? 'OK' : step2.text)

// ---- TSLA 1h default window (chart barCount) ----
const r1 = await api('GET', '/api/market/bars?symbol=TSLA&tf=1h')
console.log('bars meta:', JSON.stringify(r1.json?.meta))
analyze('TSLA 1h (chart default window)', r1.json?.bars || [])

// ---- TSLA 1h with explicit 30-day lookback ----
const r2 = await api('GET', '/api/market/bars?symbol=TSLA&tf=1h&days=30')
analyze('TSLA 1h (30 calendar days)', r2.json?.bars || [])

// ---- TSLA 15m 10 days (finer view of session edges) ----
const r3 = await api('GET', '/api/market/bars?symbol=TSLA&tf=15m&days=10')
analyze('TSLA 15m (10 calendar days)', r3.json?.bars || [])

// ---- last 5 bar times for orientation ----
const bars = r1.json?.bars || []
console.log('\nlast 6 bars of default window (ET):')
for (const b of bars.slice(-6)) {
  const m = etMinutes(b.time)
  console.log(`  ${etDay.format(new Date(b.time * 1000))} ET  sess=${m >= 570 && m < 960 ? 'RTH' : 'EXT'}  o=${b.open} c=${b.close} v=${b.volume}`)
}
