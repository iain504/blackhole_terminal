// Task 71-1 probe — verify the PATCHed run config + journal + engine pickup
import { db } from '../src/lib/db.ts'

const run = await db.algoRun.findFirst({ where: { symbol: 'ZZTEST' } })
console.log('run:', run.id, 'status:', run.status)
console.log('qty:', run.qty, '| cooldownMin:', run.cooldownMin, '| requireNewSignal:', run.requireNewSignal)
console.log('tpMode:', run.tpMode, run.tpValue, '| slMode:', run.slMode, run.slValue)
console.log('params:', JSON.stringify(run.params))
const logs = await db.algoLog.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } })
for (const l of logs) console.log(`[log ${l.level}] ${l.message}`)
process.exit(0)
