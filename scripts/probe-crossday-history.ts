// v2.12.36 probe — 'position opened in previous trade date closed today
// cannot be found in today trade history'.
//
// Reproduces the three window-truncation shapes against the REAL matcher:
//  S1 baseline: entry yesterday + exit today, both inside the tape → the
//     trade must exist with exitAt today (this is what the user expects).
//  S2 truncation, no re-entry: tape misses the entry → phantom lot →
//     ghostLotSymbols must flag the symbol (existing medicine: widen).
//  S3 truncation + same-day RE-ENTRY (the AI auto-trader's normal rhythm):
//     the walk mints a phantom SELL lot from today's exit, the re-entry BUY
//     CONSUMES it → a bogus synthetic short trade appears, the REAL
//     cross-day trade is LOST, and NO ghost is flagged (open lots look
//     consistent with the live position) → the widen never fires and the
//     trade is missing from history forever. THE BUG.
import { matchFifo, ghostLotSymbols, consumedPhantomSymbols, type FifoMatch } from '../src/lib/trade-history'
import type { TradingOrder } from '../src/lib/trading'

const DAY = 86_400_000
const now = Date.parse('2026-02-10T15:00:00Z') // "today"
const yest = now - DAY

let seq = 0
function ord(p: Partial<TradingOrder> & { side: 'buy' | 'sell'; filledAt: string; qty: string; price: string; symbol?: string }): TradingOrder {
  return {
    id: `o${++seq}`,
    symbol: p.symbol ?? 'AAPL',
    side: p.side,
    type: 'limit',
    status: p.status ?? 'filled',
    qty: p.qty,
    filled_qty: p.qty,
    filled_avg_price: p.price,
    filled_at: p.filledAt,
    created_at: p.filledAt,
    client_order_id: p.client_order_id ?? null,
    group_id: p.group_id ?? null,
    replaced_by: null,
    asset_class: 'us_equity',
    legs: null,
  } as unknown as TradingOrder
}

const liveLong = [{ symbol: 'AAPL', side: 'long' }]

// ---- S1: baseline cross-day, both fills inside the tape ----
{
  const orders = [
    ord({ side: 'buy', filledAt: new Date(yest).toISOString(), qty: '10', price: '100' }),
    ord({ side: 'sell', filledAt: new Date(now).toISOString(), qty: '10', price: '105' }),
  ]
  const fm = matchFifo(orders, 1000)
  const ghosts = ghostLotSymbols(fm.openLots, [])
  const t = fm.trades[0]
  console.log(
    `S1 baseline: trades=${fm.trades.length} side=${t?.side} exitAt=${t?.exitAt} pnl=${t?.pnl.toFixed(2)} ghosts=${ghosts.length}`,
  )
  console.log(`S1 PASS=${fm.trades.length === 1 && t.side === 'long' && new Date(t.exitAt).getTime() === now && Math.abs(t.pnl - 50) < 1e-9 && ghosts.length === 0}`)
}

// ---- S2: truncation, NO re-entry → phantom + ghost (existing medicine) ----
{
  const orders = [
    ord({ side: 'sell', filledAt: new Date(now).toISOString(), qty: '10', price: '105' }),
  ]
  const fm = matchFifo(orders, 1000)
  const ghosts = ghostLotSymbols(fm.openLots, [])
  console.log(
    `S2 truncation-no-reentry: trades=${fm.trades.length} openLots=${fm.openLots.size} ghosts=${ghosts.length} (${ghosts.join(',')})`,
  )
  console.log(`S2 PASS=${fm.trades.length === 0 && ghosts.includes('AAPL')}`)
}

// ---- S3: truncation + same-day re-entry → the bug ----
{
  const orders = [
    ord({ side: 'sell', filledAt: new Date(now - 3_600_000).toISOString(), qty: '10', price: '105' }), // today's exit (entry outside tape)
    ord({ side: 'buy', filledAt: new Date(now).toISOString(), qty: '10', price: '106' }), // today's re-entry (AI Trade)
  ]
  const fm = matchFifo(orders, 1000)
  const ghosts = ghostLotSymbols(fm.openLots, liveLong)
  const t = fm.trades[0]
  const suspects = consumedPhantomSymbols(fm.unanchored, liveLong)
  console.log(
    `S3 truncation+re-entry: trades=${fm.trades.length} side=${t?.side} entry=${t?.entryPrice} exit=${t?.exitPrice} exitAt=${t?.exitAt} ghosts=${ghosts.length} unanchored=${JSON.stringify([...fm.unanchored].map(([k, v]) => [k, [...v]]))} suspects=${suspects.join(',')}`,
  )
  // The REAL trade (long 100→105) is gone; a bogus SHORT 105→106 takes its
  // place; the ghost check is blind — but the NEW consumed-phantom check
  // names AAPL, so the route widens the tape and re-walks.
  console.log(
    `S3 BUG-SHAPE=${fm.trades.length === 1 && t.side === 'short' && t.entryPrice === 105 && ghosts.length === 0} DETECTED=${suspects.includes('AAPL')}`,
  )
}

// ---- S5: unanchored / suspect discrimination matrix ----
{
  const cases: { name: string; orders: TradingOrder[]; live: { symbol: string; side: string }[]; wantSuspect: boolean }[] = [
    {
      // plain long re-open from flat, live long → same side, never a suspect
      name: 'long-open-from-flat + live long',
      orders: [ord({ side: 'buy', filledAt: new Date(now).toISOString(), qty: '10', price: '106' })],
      live: liveLong,
      wantSuspect: false,
    },
    {
      // legit short opened from flat and still held → same side, never a suspect
      name: 'short-open-from-flat + live short',
      orders: [ord({ side: 'sell', filledAt: new Date(now).toISOString(), qty: '5', price: '200' })],
      live: [{ symbol: 'AAPL', side: 'short' }],
      wantSuspect: false,
    },
    {
      // short opened from flat, covered in-tape, now flat → ghost's territory, not ours
      name: 'short opened+covered in tape + flat now',
      orders: [
        ord({ side: 'sell', filledAt: new Date(yest).toISOString(), qty: '5', price: '200' }),
        ord({ side: 'buy', filledAt: new Date(now).toISOString(), qty: '5', price: '190' }),
      ],
      live: [],
      wantSuspect: false,
    },
    {
      // THE BUG: truncated long exit consumed by a re-entry long
      name: 'unanchored sell + live long (consumed phantom)',
      orders: [
        ord({ side: 'sell', filledAt: new Date(now - 3_600_000).toISOString(), qty: '10', price: '105' }),
        ord({ side: 'buy', filledAt: new Date(now).toISOString(), qty: '10', price: '106' }),
      ],
      live: liveLong,
      wantSuspect: true,
    },
    {
      // mirror: unanchored BUY (closed a pre-tape short?) + live short
      name: 'unanchored buy + live short (mirror)',
      orders: [
        ord({ side: 'buy', filledAt: new Date(now - 3_600_000).toISOString(), qty: '5', price: '190' }),
        ord({ side: 'sell', filledAt: new Date(now).toISOString(), qty: '5', price: '185' }),
      ],
      live: [{ symbol: 'AAPL', side: 'short' }],
      wantSuspect: true,
    },
    {
      // crypto slash-spelling: unanchored sell keyed BTCUSD must match live BTC/USD
      name: 'slash spelling normalized',
      orders: [ord({ symbol: 'BTCUSD', side: 'sell', filledAt: new Date(now - 3_600_000).toISOString(), qty: '0.5', price: '50000' })],
      live: [{ symbol: 'BTC/USD', side: 'long' }],
      wantSuspect: true,
    },
  ]
  let pass = 0
  for (const c of cases) {
    const fm = matchFifo(c.orders, 1000)
    const got = consumedPhantomSymbols(fm.unanchored, c.live)
    const ok = got.length > 0 === c.wantSuspect
    if (ok) pass++
    console.log(`S5 ${ok ? 'PASS' : 'FAIL'} — ${c.name}: unanchored=${JSON.stringify([...fm.unanchored].map(([k, v]) => [k, [...v]]))} suspects=[${got}] want=${c.wantSuspect}`)
  }
  console.log(`S5 matrix: ${pass}/${cases.length}`)
}

// ---- S6: the heal — widen brings yesterday's entry in, re-walk restores the real trade ----
{
  const narrow = [
    ord({ side: 'sell', filledAt: new Date(now - 3_600_000).toISOString(), qty: '10', price: '105' }),
    ord({ side: 'buy', filledAt: new Date(now).toISOString(), qty: '10', price: '106' }),
  ]
  const widened = [
    ord({ side: 'buy', filledAt: new Date(yest).toISOString(), qty: '10', price: '100' }), // outside the narrow tape
    ...narrow,
  ]
  const fmNarrow = matchFifo(narrow, 1000)
  const suspectsNarrow = consumedPhantomSymbols(fmNarrow.unanchored, liveLong)
  // route logic: suspects → widen → re-walk over the wider tape
  const fmWide = suspectsNarrow.length > 0 ? matchFifo(widened, 1000) : fmNarrow
  const t = fmWide.trades[0]
  const suspectsWide = consumedPhantomSymbols(fmWide.unanchored, liveLong)
  const ghostsWide = ghostLotSymbols(fmWide.openLots, liveLong)
  console.log(
    `S6 heal: narrow suspects=[${suspectsNarrow}] → widened trades=${fmWide.trades.length} ${t?.side} ${t?.entryPrice}→${t?.exitPrice} exitAt=${t?.exitAt} pnl=${t?.pnl.toFixed(2)} residual suspects=[${suspectsWide}] ghosts=${ghostsWide.length}`,
  )
  console.log(
    `S6 PASS=${suspectsNarrow.includes('AAPL') && fmWide.trades.length === 1 && t.side === 'long' && t.entryPrice === 100 && t.exitPrice === 105 && new Date(t.exitAt).getTime() === now - 3_600_000 && Math.abs(t.pnl - 50) < 1e-9 && suspectsWide.length === 0 && ghostsWide.length === 0}`,
  )
}

// ---- S4: same symbol traded across days, ALL fills in tape (sanity) ----
{
  const orders = [
    ord({ side: 'buy', filledAt: new Date(yest - DAY).toISOString(), qty: '10', price: '90' }),
    ord({ side: 'sell', filledAt: new Date(yest).toISOString(), qty: '10', price: '95' }),
    ord({ side: 'buy', filledAt: new Date(yest).toISOString(), qty: '10', price: '100' }),
    ord({ side: 'sell', filledAt: new Date(now).toISOString(), qty: '10', price: '105' }),
  ]
  const fm = matchFifo(orders, 1000)
  const last = fm.trades[0]
  console.log(
    `S4 two round-trips: trades=${fm.trades.length} last=${last.side} ${last.entryPrice}→${last.exitPrice} exitAt=${new Date(last.exitAt).toISOString()} ghosts=${ghostLotSymbols(fm.openLots, []).length}`,
  )
  console.log(`S4 PASS=${fm.trades.length === 2 && last.entryPrice === 100 && new Date(last.exitAt).getTime() === now}`)
}
