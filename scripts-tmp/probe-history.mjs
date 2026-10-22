// Probe: how deep does real history go per symbol/timeframe? (backtest data floor)
import { db } from '../src/lib/db.ts'
import { getBars } from '../src/lib/alpaca.ts'

const user = await db.user.findFirst({ select: { id: true, username: true } })
console.log('user:', user.username, user.id)

const fmt = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)

async function probe(symbol, tf, days) {
  const t0 = Date.now()
  const res = await getBars(symbol, tf, user.id, { lookbackDays: days })
  const bars = res.bars || []
  console.log(
    `${symbol.padEnd(8)} ${tf.padEnd(4)} days=${String(days).padStart(3)} -> ${String(bars.length).padStart(6)} bars` +
    `  ${bars.length ? fmt(bars[0].time) + ' -> ' + fmt(bars[bars.length - 1].time) : '(none)'}` +
    `  demo=${res.demo ?? false} src=${res.source ?? 'alpaca'} ${Date.now() - t0}ms`,
  )
}

await probe('TSLA', '5m', 30)
await probe('TSLA', '5m', 360)
await probe('TSLA', '5m', 730)
await probe('TSLA', '15m', 360)
await probe('TSLA', '15m', 730)
await probe('TSLA', '1m', 120)
await probe('BTC/USD', '15m', 360)
await probe('BTC/USD', '15m', 730)
await probe('BTC/USD', '5m', 360)
process.exit(0)
