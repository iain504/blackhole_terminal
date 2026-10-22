// Fresh bracket lifecycle (fixed quote): use the app's own getQuotes.
const { db } = await import('../src/lib/db.ts')
const { getQuotes } = await import('../src/lib/alpaca.ts')
const { placeOrderWithExits, getPositions, getOpenOrders, closePositionFull } = await import('../src/lib/trading.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const uid = u.id

const qs = await getQuotes(['F'], uid)
const px = qs.quotes.find(x => x.symbol === 'F')?.price
console.log('F quote:', px)
if (!px) { console.log('no quote'); process.exit(1) }
const r = await placeOrderWithExits(uid, 'paper', { symbol: 'F', side: 'buy', qty: 1, type: 'market', take_profit: px * 1.03, stop_loss: px * 0.99, sourceRef: 't68probe' })
console.log('placed:', r.results.map(x => x.id?.slice(-8)), 'errors:', r.errors)

let held = null
for (let i = 0; i < 15; i++) {
  await new Promise(res => setTimeout(res, 1000))
  const ord = await getOpenOrders(uid, 'paper', undefined, ['F'])
  const rows = Array.isArray(ord.data) ? ord.data : []
  const fStop = rows.find(o => o.symbol === 'F' && o.status === 'held' && (o.type === 'stop' || o.type === 'stop_limit'))
  if (fStop) { held = fStop; break }
}
console.log('held SL leg via getOpenOrders:', held ? `${held.type}@${held.stop_price} qty=${held.qty}` : 'NOT FOUND')
const pos = await getPositions(uid, 'paper')
const prow = (Array.isArray(pos.data) ? pos.data : []).find(p => p.symbol === 'F')
console.log('F position:', prow ? `${prow.side} ${prow.qty} @ ${prow.avg_entry_price}` : 'none')

// full exits-mapping simulation (route logic): held top-level leg + no pending parent
if (held) {
  const ordAll = await getOpenOrders(uid, 'paper', undefined, ['F'])
  const rows = Array.isArray(ordAll.data) ? ordAll.data : []
  const pendingFamilyLegIds = new Set()
  for (const o of rows) { if (o.status === 'filled') continue; for (const l of (o.legs || [])) pendingFamilyLegIds.add(l.id) }
  for (const o of rows) {
    if (o.symbol !== 'F') continue
    if (o.status === 'held' && !pendingFamilyLegIds.has(o.id)) {
      console.log('ROUTE WOULD MAP EXIT:', o.type, o.side, '@', o.stop_price ?? o.limit_price, '-> exits.F.sl')
    }
  }
}
const cl = await closePositionFull(uid, 'paper', 'F')
console.log('cleanup:', cl.close.status, 'canceledExits:', cl.canceledExits)
await db.$disconnect()
process.exit(0)
