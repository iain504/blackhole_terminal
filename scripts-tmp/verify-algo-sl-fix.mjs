const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)
const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC, 'content-type': 'application/json' }
const api = (p) => fetch('https://paper-api.alpaca.markets' + p, { headers: H }).then(r => r.json())

// 1) FIXED path: stock SL-only 1% via placeOrderWithExits (engine's exact call)
const { quotes: fq } = await A.getQuotes(['F'], UID)
const fref = fq.find(q => q.symbol === 'F')?.price
const r1 = await T.placeOrderWithExits(UID, mode, { symbol: 'F', side: 'buy', qty: 1, type: 'market', stop_loss: Math.round(fref * 0.99 * 100) / 100 })
console.log('SL-only entry:', JSON.stringify({ n: r1.results.length, status: r1.results[0]?.status, errors: r1.errors }))
await new Promise(res => setTimeout(res, 2200))
let oo = await api('/v2/orders?status=open&limit=50')
const fStop = oo.filter(o => o.symbol === 'F' && (o.type === 'stop' || o.type === 'stop_limit'))
console.log('F SL leg open:', JSON.stringify(fStop.map(o => ({ t: o.type, st: o.status, stop: o.stop_price }))))

// 2) regression: BOTH legs still uses bracket class
const r2 = await T.placeOrderWithExits(UID, mode, { symbol: 'F', side: 'buy', qty: 1, type: 'market', take_profit: Math.round(fref * 1.02 * 100) / 100, stop_loss: Math.round(fref * 0.99 * 100) / 100 })
console.log('TP+SL entry:', JSON.stringify({ n: r2.results.length, status: r2.results[0]?.status, errors: r2.errors }))
await new Promise(res => setTimeout(res, 2200))
oo = await api('/v2/orders?status=open&limit=50')
const fLegs = oo.filter(o => o.symbol === 'F' && (o.type === 'stop' || o.type === 'stop_limit' || (o.type === 'limit' && o.side === 'sell')))
console.log('F legs after both-legs entry:', JSON.stringify(fLegs.map(o => ({ t: o.type, st: o.status, stop: o.stop_price, lim: o.limit_price }))))

// cleanup: cancel everything on F, close both positions
for (const o of oo.filter(o => o.symbol === 'F')) {
  const c = await fetch('https://paper-api.alpaca.markets/v2/orders/' + o.id, { method: 'DELETE', headers: H })
  console.log('cancel', o.type, o.stop_price || o.limit_price, '->', c.status)
}
await new Promise(res => setTimeout(res, 1200))
for (let i = 0; i < 2; i++) {
  const cf = await T.closePositionFull(UID, mode, 'F')
  console.log('close F pass', i + 1, '->', cf.close.status, (cf.close.error || '').slice(0, 80))
  const p = await api('/v2/positions').catch(() => [])
  if (!Array.isArray(p) || !p.some(x => x.symbol === 'F')) { console.log('F position fully closed'); break }
  await new Promise(res => setTimeout(res, 1500))
}
process.exit(0)
