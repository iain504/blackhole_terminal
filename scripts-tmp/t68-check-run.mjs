import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const runs = await db.algoRun.findMany({ orderBy: { createdAt: 'desc' }, take: 5 });
for (const r of runs) {
  console.log(JSON.stringify({ id: r.id, strategy: r.strategy, symbol: r.symbol, tf: r.timeframe, status: r.status, qty: r.qty, tpMode: r.tpMode, tpValue: r.tpValue, slMode: r.slMode, slValue: r.slValue, sourceRef: r.sourceRef, createdAt: r.createdAt, meta: r.meta }, null, 1));
}
const logs = await db.algoLog.findMany({ where: { runId: runs[0]?.id }, orderBy: { ts: 'asc' }, take: 40 });
console.log('--- LOGS for', runs[0]?.id);
for (const l of logs) console.log(new Date(l.ts).toISOString().slice(11,19), l.level, l.message);
await db.$disconnect();
