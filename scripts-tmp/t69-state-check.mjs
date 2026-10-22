// Task 69 — current-state check: user's exit legs on Alpaca (statuses incl. held) vs what the terminal's fixed route maps
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const KEY = decrypt(u.settings.alpacaKeyIdEnc)
const SEC = decrypt(u.settings.alpacaSecretEnc)
const HOST = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }

const poss = await fetch(`${HOST}/v2/positions`, { headers: H }).then(r => r.json())
const symbols = poss.map(p => p.symbol)
console.log('OPEN POSITIONS:', symbols.join(', ') || '(none)')

// what the terminal's FIXED getOpenOrders sweep now sees: status=all scoped to position symbols
const all = await fetch(`${HOST}/v2/orders?status=all&limit=500&direction=desc&symbols=${encodeURIComponent(symbols.join(','))}`, { headers: H }).then(r => r.json())
const WORKING = ['new', 'accepted', 'pending_new', 'accepted_for_bidding', 'pending_replace', 'held', 'done_for_day']
const working = all.filter(o => WORKING.includes(o.status) && !(o.legs || []).length)

// OLD behavior (pre-fix): status=open only — prove held legs are invisible there
const oldOpen = await fetch(`${HOST}/v2/orders?status=open&limit=500&direction=desc&symbols=${encodeURIComponent(symbols.join(','))}`, { headers: H }).then(r => r.json())
const oldIds = new Set(oldOpen.map(o => o.id))

for (const p of poss) {
  const legs = working.filter(o => o.symbol === p.symbol)
  const exits = legs.filter(o => (o.client_order_id || '').includes('-tp') || (o.client_order_id || '').includes('-sl') || o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop' || (o.type === 'limit' && o.side !== p.side))
  console.log(`\n${p.symbol} ${p.side} ${p.qty} @ avg ${p.avg_entry_price}`)
  for (const o of legs) {
    console.log(`   ${o.type.padEnd(13)} ${o.side.padEnd(4)} ${o.status.padEnd(7)} stop=${o.stop_price || '-'} limit=${o.limit_price || '-'} trail=${o.trail_percent || '-'} visibleToOldQuery=${oldIds.has(o.id)} coid=${(o.client_order_id || '').slice(0, 40)}`)
  }
}
process.exit(0)
