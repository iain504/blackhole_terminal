process.env.QUIET = '1'
const { db } = await import('../src/lib/db.ts')
const runs = await db.algoRun.findMany({ orderBy: { createdAt: 'desc' }, take: 6 })
for (const r of runs) console.log('RUN', JSON.stringify({ id: r.id.slice(-8), symbol: r.symbol, strategy: r.strategy, qty: r.qty, tpMode: r.tpMode, tpValue: r.tpValue, slMode: r.slMode, slValue: r.slValue, status: r.status }))
const logs = await db.algoLog.findMany({ orderBy: { createdAt: 'desc' }, take: 30 })
for (const l of logs) console.log('LOG', l.createdAt.toISOString(), l.level.padEnd(6), l.message.slice(0, 160))
process.exit(0)
