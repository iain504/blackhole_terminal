// Task 67 — inspect trailing_stop orders: what fields does Alpaca return?
// Optionally place a fresh one (PLACE=1) to see the raw JSON.
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const KEY = decrypt(u.settings.alpacaKeyIdEnc)
const SEC = decrypt(u.settings.alpacaSecretEnc)
const HOST = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }

const orders = await fetch(`${HOST}/v2/orders?status=open&limit=100`, { headers: H }).then((r) => r.json())
const trails = orders.filter((o) => o.type === 'trailing_stop')
console.log(`open orders: ${orders.length}, trailing_stop: ${trails.length}`)
for (const t of trails) {
  console.log(JSON.stringify({
    id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, type: t.type, status: t.status,
    stop_price: t.stop_price, limit_price: t.limit_price,
    trail_percent: t.trail_percent, trail_price: t.trail_price,
    h18: t.h18, extended_hours: t.extended_hours, tif: t.time_in_force,
    client_order_id: t.client_order_id,
  }, null, 1))
}
if (trails.length === 0 && process.env.PLACE === '1') {
  // place a 1-share TSLA SELL trailing stop 1% to see the exact JSON shape
  const r = await fetch(`${HOST}/v2/orders`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'TSLA', qty: 1, side: 'sell', type: 'trailing_stop', time_in_force: 'gtc', trail_percent: '1.0' }),
  }).then((x) => x.json())
  console.log('PLACED:', JSON.stringify({ id: r.id, symbol: r.symbol, type: r.type, status: r.status, stop_price: r.stop_price, limit_price: r.limit_price, trail_percent: r.trail_percent, trail_price: r.trail_price }, null, 1))
  if (r.id) {
    const del = await fetch(`${HOST}/v2/orders/${r.id}`, { method: 'DELETE', headers: H })
    console.log('cleanup cancel status:', del.status)
  }
}
