// Task 71-1 probe — seed a SAFE stopped algo run for the settings-dialog E2E.
// Symbol 'ZZTEST' has no real bars → the engine logs 'no live bar data' and
// never trades, so restarting it during the test cannot place orders.
// Usage: bun scripts-tmp/t71-seed.mjs
import { db } from '../src/lib/db.ts'
import { decrypt } from '../src/lib/crypt.ts'

const user = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
if (!user) { console.error('user not found'); process.exit(1) }
const keyId = user.settings && typeof user.settings === 'object' ? user.settings.alpacaKeyIdEnc : null
console.log('user:', user.username, '| alpaca keys present:', !!keyId)

// cleanup any leftover t71 test runs first
const stale = await db.algoRun.findMany({ where: { userId: user.id, symbol: 'ZZTEST' } })
for (const r of stale) {
  await db.algoLog.deleteMany({ where: { runId: r.id } })
  await db.algoRun.delete({ where: { id: r.id } })
}

const run = await db.algoRun.create({
  data: {
    userId: user.id,
    symbol: 'ZZTEST',
    timeframe: '5m',
    strategy: 'bb-reversion',
    params: { period: 20, dev: 2, rsiPeriod: 14, os: 30, ob: 70, allowShort: 1 },
    qty: 10,
    tpMode: 'pct',
    tpValue: 1.5,
    slMode: 'pct',
    slValue: 1,
    maxTradesDay: 3,
    rthOnly: true,
    flattenEod: true,
    cooldownMin: 0,
    requireNewSignal: false,
    status: 'stopped',
    state: {},
  },
})
console.log('seeded stopped run:', run.id, run.symbol, run.strategy, 'qty', run.qty, 'cooldown', run.cooldownMin)

// baseline counts
console.log('algoRun rows for user:', await db.algoRun.count({ where: { userId: user.id } }))
process.exit(0)
