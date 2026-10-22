// Probe: Alpaca crypto v1beta3 — how deep can 15m bars go with pagination?
import { db } from '../src/lib/db.ts'
import { getAlpacaKeys } from '../src/lib/alpaca.ts'

const user = await db.user.findFirst({ select: { id: true, username: true } })
const keys = await getAlpacaKeys(user.id)
if (!keys) { console.log('no alpaca keys'); process.exit(0) }

const fmt = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)

async function alpacaGet(path) {
  const res = await fetch(`https://data.alpaca.markets${path}`, {
    headers: { 'APCA-API-KEY-ID': keys.keyId, 'APCA-API-SECRET-KEY': keys.secret },
  })
  const json = await res.json().catch(() => null)
  return json
}

// BTC/USD 15m, 730-day window, follow next_page_token up to 25 pages
const end = new Date()
const start = new Date(end.getTime() - 730 * 86400 * 1000)
let token
let all = []
let pages = 0
const t0 = Date.now()
for (let p = 0; p < 25; p++) {
  const path =
    `/v1beta3/crypto/us/bars?symbols=BTC%2FUSD&timeframe=15Min` +
    `&start=${start.toISOString().slice(0, 19)}Z&end=${end.toISOString().slice(0, 19)}Z&limit=10000` +
    (token ? `&page_token=${encodeURIComponent(token)}` : '')
  const data = await alpacaGet(path)
  if (!data?.bars) { console.log('page', p, 'failed:', JSON.stringify(data).slice(0, 200)); break }
  const chunk = data.bars['BTC/USD'] || []
  all = all.concat(chunk)
  pages = p + 1
  token = data.next_page_token
  if (!token) break
}
console.log(`alpaca crypto BTC/USD 15m: pages=${pages} bars=${all.length} ${Date.now() - t0}ms`)
if (all.length) console.log('first raw:', JSON.stringify(all[0]), 'last raw:', JSON.stringify(all[all.length - 1]))
process.exit(0)
