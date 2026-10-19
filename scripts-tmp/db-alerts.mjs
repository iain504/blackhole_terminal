import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.alert.findMany({ orderBy: { createdAt: 'desc' }, take: 4 })
for (const a of rows) console.log(JSON.stringify({ kind: a.kind, sym: a.symbol, tf: a.timeframe, params: a.params, st: a.status, lastSide: a.lastSide, dir: a.direction }))
await db.$disconnect()
