// Task 68 — inspect TSLA bracket family: parent + leg statuses (esp. stop_loss leg)
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const KEY = decrypt(u.settings.alpacaKeyIdEnc)
const SEC = decrypt(u.settings.alpacaSecretEnc)
const HOST = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }

const orders = await fetch(`${HOST}/v2/orders?status=all&limit=100&direction=desc`, { headers: H }).then(r => r.json())
const tsla = orders.filter(o => o.symbol === 'TSLA' || (o.legs||[]).some(l => l.symbol === 'TSLA')).slice(0, 6)
for (const o of tsla) {
  console.log(JSON.stringify({
    id: o.id.slice(-8), type: o.type, side: o.side, status: o.status, qty: o.qty,
    limit: o.limit_price, stop: o.stop_price, cls: o.order_class, filled: o.filled_qty,
    coid: (o.client_order_id || '').slice(0, 44), created: o.created_at,
    legs: (o.legs || []).map(l => ({ id: l.id.slice(-8), type: l.type, side: l.side, status: l.status, stop: l.stop_price, limit: l.limit_price, coid: (l.client_order_id || '').slice(0, 40) })),
  }))
}
const poss = await fetch(`${HOST}/v2/positions`, { headers: H }).then(r => r.json())
if (Array.isArray(poss)) for (const p of poss) console.log('POS:', p.symbol, p.side, p.qty, '@', p.avg_entry_price)
process.exit(0)
