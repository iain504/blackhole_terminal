// Probe #2: verify deep-history fixes at the critical windows only
import { db } from '../src/lib/db.ts'
import { getBars } from '../src/lib/alpaca.ts'

const user = await db.user.findFirst({ select: { id: true, username: true } })
const fmt = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)

async function probe(symbol, tf, days) {
  const t0 = Date.now()
  const res = await getBars(symbol, tf, user.id, { lookbackDays: days })
  const bars = res.bars || []
  const times = bars.map((b) => b.time)
  let gaps = 0
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= 0) gaps++
  console.log(
    `${symbol.padEnd(8)} ${tf.padEnd(4)} days=${String(days).padStart(3)} -> ${String(bars.length).padStart(6)} bars` +
    `  ${bars.length ? fmt(bars[0].time) + ' -> ' + fmt(bars[bars.length - 1].time) : '(none)'}` +
    `  demo=${res.demo ?? false} src=${res.source ?? 'alpaca'} nonMono=${gaps} ${Date.now() - t0}ms`,
  )
}

await probe('BTC/USD', '15m', 730)
await probe('BTC/USD', '5m', 360)
await probe('TSLA', '5m', 730)
process.exit(0)
