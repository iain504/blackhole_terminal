const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)
console.log('mode =', mode)

// --- what the engine does for slMode='pct', slValue=1 (TP none) on a STOCK ---
const { quotes } = await A.getQuotes(['F'], UID)
const ref = quotes.find((q) => q.symbol === 'F')?.price
console.log('quote F =', ref)
if (!ref) { console.log('NO QUOTE — engine would enter without legs'); process.exit(1) }
const sl = Math.round(ref * 0.99 * 100) / 100
console.log('planned SL =', sl)

const r = await T.placeOrderWithExits(UID, mode, {
  symbol: 'F', side: 'buy', qty: 1, type: 'market', stop_loss: sl,
})
console.log('placeOrderWithExits result:', JSON.stringify({ results: r.results.map(o => ({ id: o.id, status: o.status, type: o.type, coid: o.client_order_id, legs: (o.legs||[]).map(l=>({type:l.type,status:l.status,stop:l.stop_price})) })), errors: r.errors, splitNote: r.splitNote }, null, 2))

// inspect live state
await new Promise(res => setTimeout(res, 1500))
const oo = await T.getOpenOrders(UID, mode, 'F')
console.log('open orders F:', JSON.stringify((oo.data||[]).map(o => ({ id: o.id.slice(-8), type: o.type, side: o.side, status: o.status, stop: o.stop_price, coid: (o.client_order_id||'').slice(0,26), legs: (o.legs||[]).map(l=>({type:l.type,status:l.status,stop:l.stop_price})) })), null, 2))
const ps = await T.getPositions(UID, mode)
console.log('positions F:', JSON.stringify((Array.isArray(ps.data)?ps.data:[]).map(p => ({ sym: p.symbol, qty: p.qty, avg: p.avg_entry_price }))))
process.exit(0)
