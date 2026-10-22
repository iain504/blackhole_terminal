// Task 72 — seed ONE safe stopped AlgoRun for the settings-dialog E2E.
// ZZTEST = fake symbol, no live bars → engine logs "no live bar data" and can
// never place an order. Status STOPPED → supervisor never evaluates it.
import { db } from '../src/lib/db.ts'

const u = await db.user.findUnique({ where: { username: 'trader' } })
if (!u) throw new Error('no trader user')

const run = await db.algoRun.create({
  data: {
    userId: u.id,
    symbol: 'ZZTEST',
    timeframe: '5m',
    strategy: 'vwap-fade',
    params: { devPct: 1, allowShort: 1 },
    qty: 1,
    tpMode: 'none',
    tpValue: null,
    slMode: 'none',
    slValue: null,
    maxTradesDay: 3,
    rthOnly: true,
    flattenEod: true,
    cooldownMin: 0,
    requireNewSignal: false,
    status: 'stopped',
  },
})
console.log('seeded run', run.id, run.status)

const n = await db.algoRun.count({ where: { userId: u.id } })
console.log('total runs for trader:', n)
process.exit(0)
