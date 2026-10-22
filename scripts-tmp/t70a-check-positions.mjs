// Task 70-a — cross-check the positions route's FIFO open-lot attribution
// against the broker: real open positions + their oldest entry fill per symbol.
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const KEY = decrypt(u.settings.alpacaKeyIdEnc)
const SEC = decrypt(u.settings.alpacaSecretEnc)
const HOST = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }

const poss = await fetch(`${HOST}/v2/positions`, { headers: H }).then(r => r.json())
console.log('OPEN POSITIONS:', Array.isArray(poss) ? poss.map(p => `${p.symbol} ${p.side} ${p.qty}`).join(' | ') : poss)

// closed orders stream (same window the route uses) → oldest open lot per symbol
const closed = await fetch(`${HOST}/v2/orders?status=closed&limit=500&direction=desc`, { headers: H }).then(r => r.json())
const filled = closed.filter(o => o.status === 'filled' && o.filled_at && o.filled_avg_price)
  .sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at))
const EPS = 1e-9
const lots = new Map()
for (const o of filled) {
  let rem = parseFloat(o.filled_qty)
  const q = lots.get(o.symbol) ?? []
  while (rem > EPS && q.length && q[0].side !== o.side) {
    const take = Math.min(q[0].qty, rem)
    q[0].qty -= take; rem -= take
    if (q[0].qty <= EPS) q.shift()
  }
  if (rem > EPS) q.push({ side: o.side, qty: rem, time: o.filled_at, coid: o.client_order_id || '' })
  if (q.length) lots.set(o.symbol, q); else lots.delete(o.symbol)
}
for (const p of poss) {
  const lot = (lots.get(p.symbol) || [])[0]
  console.log(`${p.symbol}: oldest open lot = ${lot ? `${lot.side} ${lot.qty.toFixed(4)} @ ${lot.time} coid=${lot.coid.slice(0, 28)}` : 'NONE'}`)
}
process.exit(0)
