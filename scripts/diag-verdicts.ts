import { db } from '../src/lib/db'
async function main() {
  const ops = await db.aiOpsState.findMany()
  for (const o of ops) console.log(`kind=${o.kind} enabled=${o.enabled} runner=${o.runnerId} hb=${o.heartbeatAt?.toISOString() ?? null}`)
}
main().finally(() => db.$disconnect())
