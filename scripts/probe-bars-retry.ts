// v1.99.2 probe — reproduce the user's dev.log error:
//   "Alpaca /v2/stocks/bars?symbols=TSLA&timeframe=5Min&start=2026-04-13…&limit=10000
//    … failed: The operation was aborted."
// That was a 200-day 5m deep fetch (30–50 paginated pages) where ONE page
// overran the old hard 9s timeout and killed the whole window. This probe
// replays the same request shape through the app's own getBars pipeline and
// reports: bar count, truncation flag, wall time, and whether the new retry
// logging (attempt i/N — retrying) shows up. Run: bun scripts/probe-bars-retry.ts [days]
import { getBars } from '../src/lib/alpaca'
import { db } from '../src/lib/db'
import { resolveAppSecret } from '../src/lib/app-secret'

async function main() {
  const days = parseInt(process.argv[2] ?? '200', 10)
  // boot parity with the Next server: instrumentation awaits this before any
  // route is served; a standalone probe must do the same or decrypt() fails
  await resolveAppSecret()
  // find a user with saved Alpaca keys (the app refuses demo data for backtests)
  const users = await db.user.findMany({ take: 20 })
  let used = 0
  for (const u of users) {
    const s = (u.settings as { alpacaPaperKeyIdEnc?: string; alpacaKeyIdEnc?: string } | null) || null
    if (!s?.alpacaPaperKeyIdEnc && !s?.alpacaKeyIdEnc) continue
    used++
    console.log(`probe: user ${u.username} has Alpaca keys — fetching TSLA 5m ${days}d …`)
    const t0 = Date.now()
    const res = await getBars('TSLA', '5m', u.id, { lookbackDays: days })
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    const oldest = new Date(res.bars[0].time * 1000).toISOString().slice(0, 16)
    const newest = new Date(res.bars[res.bars.length - 1].time * 1000).toISOString().slice(0, 16)
    console.log(
      `probe: ${res.bars.length} bars in ${dt}s | demo=${res.demo} truncated=${res.truncated ?? false} ` +
        `source=${res.source ?? res.reason ?? '-'} | window ${oldest} → ${newest}`,
    )
    const staleDays = (Date.now() / 1000 - res.bars[res.bars.length - 1].time) / 86400
    console.log(`probe: newest bar is ${staleDays.toFixed(2)}d old ${staleDays > 7 ? '⚠️ WINDOW ENDS IN THE PAST' : '✓ fresh tail'}`)
    break
  }
  if (!used) console.log('probe: no user with saved Alpaca keys — nothing to test against the live feed')
}

main()
  .catch((e) => { console.error('probe failed:', e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
