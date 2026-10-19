// Probe: why does PATCHing a queued (market-closed) bracket parent reply
// "order parameters are not changed" when a leg value clearly differs?
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

const req = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* empty */ }
  return { status: r.status, j }
}

const run = async () => {
  // 1) place a queued bracket (AAPL limit 300 far below market ~343; market closed)
  const place = await req('/v2/orders', 'POST', {
    symbol: 'AAPL', qty: 1, side: 'buy', type: 'limit', limit_price: '300.00',
    time_in_force: 'gtc', order_class: 'bracket',
    take_profit: { limit_price: '340.00' }, stop_loss: { stop_price: '260.00' },
  })
  const o = place.j
  console.log('place:', place.status, o.id, o.status, 'legs=', (o.legs || []).map(l => [l.type, l.side, l.limit_price, l.stop_price]))
  if (!o.id) return

  // 2) GET the single order — are legs nested?
  const one = await req(`/v2/orders/${o.id}`)
  console.log('single GET legs=', (one.j?.legs || []).map(l => [l.type, l.side, l.limit_price, l.stop_price]), 'status=', one.j?.status)

  // 3) PATCH bisect
  const tries = [
    ['SL only (260->270)', { stop_loss: { stop_price: '270.00' } }],
    ['TP+SL (340, 280)', { take_profit: { limit_price: '340.00' }, stop_loss: { stop_price: '280.00' } }],
    ['SL only with decimals (280->285)', { stop_loss: { stop_price: '285.00' } }],
    ['qty only (qty 1)', { qty: 1 }],
    ['limit+legs (301, 341, 290)', { limit_price: '301.00', take_profit: { limit_price: '341.00' }, stop_loss: { stop_price: '290.00' } }],
  ]
  for (const [label, body] of tries) {
    const r = await req(`/v2/orders/${o.id}`, 'PATCH', body)
    console.log(`PATCH ${label}:`, r.status, r.j?.status || r.j?.message || JSON.stringify(r.j), r.j?.id ? `newid=${r.j.id}` : '')
    if (r.status === 200) {
      // check the legs after a successful replace
      const after = await req(`/v2/orders/${r.j.id}`)
      console.log('   after legs=', (after.j?.legs || []).map(l => [l.type, l.side, l.limit_price, l.stop_price]))
      break // further patches target the new id — keep it simple
    }
  }

  // 4) cleanup: cancel everything on the account
  await req('/v2/orders?status=open', 'GET').then(async (l) => {
    for (const oo of l.j || []) await req(`/v2/orders/${oo.id}`, 'DELETE')
  })
  console.log('cleanup done')
}
run().catch((e) => { console.error(e); process.exit(1) })
