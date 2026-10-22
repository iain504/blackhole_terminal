// Task 76: does feed=sip (consolidated) include FULL pre-market (04:00-09:30)
// bars for TSLA, vs feed=iex (IEX-only, 08:00-09:30)? Uses the user's keys
// from the DB (same as keys.mjs pattern) — read-only Market Data GET.
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')

const u = await db.user.findUnique({ where: { username: 'trader' } })
const kid = decrypt(u.settings.alpacaKeyIdEnc)
const ksec = decrypt(u.settings.alpacaSecretEnc)
console.log('keys present:', Boolean(kid && ksec))

const end = new Date()
const start = new Date(end.getTime() - 3 * 86400 * 1000) // 3 calendar days
const s = start.toISOString().slice(0, 19) + 'Z'
const e = end.toISOString().slice(0, 19) + 'Z'

const etMin = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false })
const etStamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
function etMinutes(sec) {
  let h = 0, m = 0
  for (const p of etMin.formatToParts(new Date(sec * 1000))) {
    if (p.type === 'hour') h = Number(p.value) % 24
    else if (p.type === 'minute') m = Number(p.value)
  }
  return h * 60 + m
}

for (const feed of ['iex', 'sip']) {
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=TSLA&timeframe=15Min&start=${s}&end=${e}&limit=10000&adjustment=split&feed=${feed}`
  const res = await fetch(url, {
    headers: { 'APCA-API-KEY-ID': kid, 'APCA-API-SECRET-KEY': ksec },
  })
  const text = await res.text()
  if (!res.ok) {
    console.log(`\nfeed=${feed}: HTTP ${res.status} — ${text.slice(0, 220)}`)
    continue
  }
  const json = JSON.parse(text)
  const bars = json.bars?.TSLA || []
  let pre = 0, post = 0, reg = 0
  const preTimes = []
  for (const b of bars) {
    const sec = Math.floor(new Date(b.t).getTime() / 1000)
    const m = etMinutes(sec)
    if (m >= 570 && m < 960) reg++
    else if (m < 570 && m >= 240) { pre++; if (preTimes.length < 8) preTimes.push(etStamp.format(new Date(sec * 1000))) }
    else post++
  }
  console.log(`\nfeed=${feed}: ${bars.length} bars | RTH=${reg} preMarket=${pre} post=${post}`)
  if (preTimes.length) console.log('  earliest pre-market stamps (ET):', preTimes.join(', '))
}
