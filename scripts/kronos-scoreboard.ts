// Per-model Kronos scoreboard — reads the journal and prints realized accuracy
// by lane (mini vs small). Usage: bun scripts/kronos-scoreboard.ts
import { db } from '../src/lib/db'
import { resolveAppSecret } from '../src/lib/app-secret'

await resolveAppSecret()

const rows = await db.kronosForecast.groupBy({
  by: ['model'],
  _count: { _all: true },
  where: { realizedClose: { not: null } },
})
for (const r of rows) {
  const total = r._count._all
  const hits = await db.kronosForecast.count({ where: { model: r.model, hit: true } })
  const err = await db.kronosForecast.aggregate({ where: { model: r.model, absErrPct: { not: null } }, _avg: { absErrPct: true } })
  const lat = await db.kronosForecast.aggregate({ where: { model: r.model, latencyMs: { not: null } }, _avg: { latencyMs: true } })
  const byTf = await db.kronosForecast.groupBy({ by: ['tf'], where: { model: r.model, realizedClose: { not: null } }, _count: { _all: true } })
  console.log(`model=${r.model} realized=${total} hits=${hits} rate=${(hits / Math.max(1, total)).toFixed(3)} avgAbsErr=${err._avg.absErrPct?.toFixed(3) ?? '-'}% avgLatency=${((lat._avg.latencyMs ?? 0) / 1000).toFixed(1)}s tfs=${JSON.stringify(byTf.map(t => [t.tf, t._count._all]))}`)
}
const pending = await db.kronosForecast.count({ where: { realizedClose: null } })
console.log('pending(unrealized)=', pending)
const all = await db.kronosForecast.groupBy({ by: ['model'], _count: { _all: true } })
console.log('all-time by model:', JSON.stringify(all.map(a => [a.model, a._count._all])))
await db.$disconnect()
