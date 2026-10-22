// Task 70-c evidence probe — demonstrates the repeat-signal problem WITHOUT
// re-entry gates vs WITH each gate (cooldownMin / requireNewSignal) on the
// deterministic ORB repeat scenario (onePerSide=0 + tight SL → the position
// closes while price stays beyond the OR high, re-firing the same signal).
// Run: bun scripts-tmp/t70-gates-evidence.ts
import { prepareSeries, runBacktest, type BacktestConfig } from '../src/lib/backtest'
import type { Bar } from '../src/lib/market-types'

const base = Date.UTC(2026, 0, 5, 14, 30) / 1000 // Mon Jan 5 2026 09:30 ET
const rnd = (() => { let s = 777; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()

function buildOrbBars(days: number): Bar[] {
  const bars: Bar[] = []
  let price = 100
  for (let d = 0; d < days; d++) {
    const dayStart = base + d * 86400
    const dow = new Date(dayStart * 1000).getUTCDay()
    if (dow === 0 || dow === 6) continue
    for (let k = 0; k < 78; k++) {
      const t = dayStart + k * 300
      let close: number
      if (k < 3) close = 100 + (rnd() - 0.5) * 0.06 // OR window 09:30–09:45
      else {
        const phase = (k - 3) % 3
        close = price + (phase === 2 ? -0.55 : 0.85) + (rnd() - 0.5) * 0.08
        price = close
      }
      const open = k === 0 ? close : bars[bars.length - 1].close
      const hi = Math.max(open, close) + rnd() * 0.05
      const lo = Math.min(open, close) - rnd() * 0.05
      bars.push({ time: t, open, high: hi, low: lo, close, volume: 1000 })
    }
  }
  return bars
}

const series = prepareSeries(buildOrbBars(20))
const fmt = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ')
const hhmm = (min: number) => `${Math.floor(min)}m ${Math.round((min % 1) * 60)}s`

function run(label: string, over: Partial<BacktestConfig>) {
  const cfg: BacktestConfig = {
    strategy: 'orb15',
    params: { orMinutes: 15, onePerSide: 0 },
    qty: 10,
    sizingMode: 'fixed', riskMoney: null, isCrypto: false,
    tpMode: 'pct', tpValue: 1,
    slMode: 'pct', slValue: 0.5,
    maxTradesDay: 50, rthOnly: true, flattenEod: true,
    cooldownMin: 0, requireNewSignal: false,
    capital: 10000,
    ...over,
  }
  const r = runBacktest(series, cfg)
  const trades = r.trades
  // re-entry gap: minutes between a close and the NEXT entry on the same side-flow
  const gaps: number[] = []
  for (let i = 1; i < trades.length; i++) {
    gaps.push((trades[i].entryTime - trades[i - 1].exitTime) / 60)
  }
  const zeroGap = gaps.filter((g) => g <= 5.01).length // same-or-next 5m bar re-entry
  console.log(`\n== ${label}`)
  console.log(`   trades=${r.metrics.trades} · wins=${r.metrics.wins} · netPnl=${r.metrics.netPnl.toFixed(2)} · suppressed=${r.metrics.suppressed}`)
  console.log(`   immediate re-entries (≤5min after a close): ${zeroGap}/${gaps.length}`)
  console.log(`   first 8 trades:`)
  for (const t of trades.slice(0, 8)) {
    console.log(`     ${fmt(t.entryTime)} → ${fmt(t.exitTime)} · ${t.side} · pnl ${t.pnl.toFixed(2)} · ${t.exitReason}`)
  }
  return { trades: r.metrics.trades, netPnl: r.metrics.netPnl, zeroGap, gaps }
}

const off = run('GATES OFF (current behavior — level-triggered, cooldown 0)', {})
const fresh = run('requireNewSignal=true (edge-triggered — wait for a new cross)', { requireNewSignal: true })
const cd = run('cooldownMin=30 (no entries within 30min after a close)', { cooldownMin: 30 })
const both = run('both gates (cooldown 30m + fresh signal)', { cooldownMin: 30, requireNewSignal: true })

console.log('\n== SUMMARY')
console.log(`gates off:        ${off.trades} trades · ${off.zeroGap} immediate re-entries · net ${off.netPnl.toFixed(2)}`)
console.log(`fresh-signal:     ${fresh.trades} trades · ${fresh.zeroGap} immediate re-entries · net ${fresh.netPnl.toFixed(2)}`)
console.log(`cooldown 30m:     ${cd.trades} trades · ${cd.zeroGap} immediate re-entries · net ${cd.netPnl.toFixed(2)} · min gap ${Math.min(...cd.gaps).toFixed(0)}m`)
console.log(`both:             ${both.trades} trades · ${both.zeroGap} immediate re-entries · net ${both.netPnl.toFixed(2)} · min gap ${Math.min(...both.gaps).toFixed(0)}m`)
console.log(`\ncooldown spacing check: every re-entry gap ≥ 30min → ${cd.gaps.every((g) => g >= 29.99)}`)
