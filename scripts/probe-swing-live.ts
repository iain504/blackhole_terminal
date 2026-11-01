// PROBE (v2.3.0) — "Swing trade are not allowed in Live trade. only allowed in
// Backtest only. Make it allow to start in Live." — verifies the LIVE swing
// path end-to-end at the engine level, against the app's own data pipeline:
//   1. REAL bars through getBars with the LIVE swing depth budget
//      (swingLookbackDays — the exact call the engine cycle makes)
//   2. the LIVE evaluator (swingSetup + swingDecide, the exact evalStrategy
//      swing branch) replayed bar-by-bar over the window
//   3. PARITY vs the backtest engine (prepareSeries + runBacktest, the
//      verified v2.2.2 code path): every steady-state live entry must have a
//      backtest entry with the same side within one bar (pending-order fill
//      offset) — RSI window-seeding makes the first ~3×period bars a grace
//      zone by design (the same convergence the day lane accepts).
//   4. the depth budget table for every lane entry-tf combo
// Run: bun scripts/probe-swing-live.ts
import { writeFileSync } from 'node:fs'
import { getBars } from '../src/lib/alpaca'
import { db } from '../src/lib/db'
import { resolveAppSecret } from '../src/lib/app-secret'
import { prepareSeries, runBacktest, type BacktestConfig } from '../src/lib/backtest'
import { normalizeAlgoParams, SWING_TFS } from '../src/lib/algo-strategies'
import { swingLookbackDays, swingSetup, swingDecide, type SwingStrategyId } from '../src/lib/swing-eval'
import type { Timeframe } from '../src/lib/market-types'

await resolveAppSecret()

const out: string[] = []
const say = (s: string) => { out.push(s); console.log(s) }

function buildCfg(strategy: SwingStrategyId, symbol: string): BacktestConfig {
  return {
    strategy,
    // allowShort 0 — Alpaca crypto is long-only; aligning BOTH engines on
    // longs-only makes the parity diff apples-to-apples (the live engine's
    // book can't hold a crypto short either)
    params: { ...normalizeAlgoParams(strategy, {}), allowShort: 0 },
    qty: 0.01, // ~$1.1k notional — inside the default capital, no dust drops
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: symbol.includes('/'),
    capital: 10000,
    slippageBps: 2,
    feeBps: 1,
    spreadBps: 2,
    dynSlip: true,
    collectEquity: false,
    tpMode: 'none',
    tpValue: null,
    slMode: 'none',
    slValue: null,
    trailMode: 'off',
    trailArmPct: null,
    trailGivePct: null,
    maxTradesDay: 0,
    rthOnly: false,
    flattenEod: false,
    cooldownMin: 0,
    requireNewSignal: false,
  }
}

// ---- depth budget table (every entry-tf × strategy, crypto + equity) ----
say('== swingLookbackDays (calendar days of entry-tf history the live engine fetches) ==')
for (const strat of ['swing-pullback', 'htf-level-bounce'] as SwingStrategyId[]) {
  for (const tf of SWING_TFS) {
    const dC = swingLookbackDays(tf as never, strat, normalizeAlgoParams(strat, {}), true)
    const dE = swingLookbackDays(tf as never, strat, normalizeAlgoParams(strat, {}), false)
    say(`  ${strat.padEnd(18)} ${tf.padEnd(3)} crypto=${String(dC).padStart(4)}d equity=${String(dE).padStart(4)}d`)
  }
}

// ---- live replay vs backtest on real BTC/USDT 1h bars ----
const symbol = 'BTC/USDT'
const entryTf: Timeframe = '1h'
const strat = (process.argv[2] === 'htf' ? 'htf-level-bounce' : 'swing-pullback') as SwingStrategyId
const params = { ...normalizeAlgoParams(strat, {}), allowShort: 0 } // longs-only, same as the backtest cfg
const days = swingLookbackDays(entryTf, strat, params, true)
say(`\n== fetching ${symbol} ${entryTf} · ${days}d (the engine's live swing fetch) ==`)
const { bars } = await getBars(symbol, entryTf, undefined, { lookbackDays: days })
say(`  bars=${bars.length} span=${new Date(bars[0].time * 1000).toISOString()} → ${new Date(bars[bars.length - 1].time * 1000).toISOString()}`)

// LIVE path — swingSetup/swingDecide exactly as evalStrategy calls them
interface LiveSig { i: number; side: 'buy' | 'sell'; reason: string }
const live: LiveSig[] = []
let warmupNote = ''
for (let i = 30; i < bars.length; i++) {
  const win = bars.slice(0, i + 1)
  const setup = swingSetup(win, strat, params)
  if (setup == null) continue
  const d = swingDecide(setup, win, win.length - 1, params, null)
  if (d.note && !warmupNote) warmupNote = d.note
  if (d.entry) live.push({ i: win.length - 1, side: d.entry.side, reason: d.entry.reason })
}
say(`  live replay: ${live.length} entry signals · warmup note: ${warmupNote || '(none — ladder fully armed from bar 30)'}`)
say(`  first live signal: ${live[0] ? `bar ${live[0].i} (${new Date(bars[live[0].i].time * 1000).toISOString()}) ${live[0].side} — ${live[0].reason}` : '(none)'}`)

// BACKTEST path — the verified v2.2.2 engine on the same bars
const series = prepareSeries(bars as never)
const bt = runBacktest(series, buildCfg(strat, symbol))
say(`  backtest: ${bt.trades.length} trades · warmupBars=${bt.warmupBars}`)
say(`  bt attribution: zeroTrade=${JSON.stringify(bt.metrics.zeroTrade)} suppressed=${bt.metrics.suppressed} regime=${JSON.stringify(bt.metrics.regime)}`)
say(bt.trades.slice(0, 3).map(t => `    bt ${new Date(t.entryTime * 1000).toISOString().slice(5, 16)} ${t.side} @${t.entryPx.toPrecision(6)} exit "${t.exitReason}" mtf=${t.mtf ? `trend ${t.mtf.trend}` : '-'}`).join('\n'))

// PARITY — two layers, all driven by the SAME bars:
//   1. RAW DECISIONS: the live replay passes pos=null (pure signal stream) —
//      it must equal the backtest's regime.signals count exactly (both
//      engines' decide() over the same bars).
//   2. TRADE SEQUENCE: replay the live decisions through the same flat-book
//      rule the executor uses (enter only when flat, side-aware RSI exit
//      while held, fill at NEXT bar open like the backtest pending order) —
//      the resulting trade list must equal the backtest's trades 1:1 (same
//      entry bars, same sides, same exit reasons).
const rawOk = live.length === (bt.metrics.regime?.signals ?? -1)
say(`  decision parity: live signals=${live.length} · backtest rawSignals=${bt.metrics.regime?.signals} -> ${rawOk ? 'EXACT' : 'DIFF'}`)

// live mini-executor: pending order model (signal bar i -> fill bar i+1 open),
// flat-book entries, side-aware RSI exits while held. SL/TP off in the cfg.
interface LiveTrade { entryIdx: number; side: 'long' | 'short'; exitIdx: number; why: string }
const liveTrades: LiveTrade[] = []
let held: { side: 'long' | 'short'; entryPx: number; entryIdx: number } | null = null
let pendingSide: 'buy' | 'sell' | null = null
for (let i = 42; i < bars.length; i++) {
  const win = bars.slice(0, i + 1)
  const setup = swingSetup(win, strat, params)
  if (setup == null) continue
  const d = swingDecide(setup, win, win.length - 1, params, held)
  // fill the pending order at THIS bar's open (it was armed on bar i-1)
  if (pendingSide && !held) {
    held = { side: pendingSide === 'buy' ? 'long' : 'short', entryPx: win[win.length - 1].open, entryIdx: i }
    pendingSide = null
  }
  if (d.exit && held) {
    liveTrades.push({ entryIdx: held.entryIdx, side: held.side, exitIdx: i, why: d.exit })
    held = null
    continue
  }
  if (d.entry && !held && !pendingSide) pendingSide = d.entry.side
}
// map backtest trades onto the same bar indices for the diff
const idxByTime = new Map<number, number>(bars.map((b, i) => [b.time, i]))
// 'open at end of data (marked)' is a data-tail artifact, not an engine
// decision — the live engine simply holds; exclude from the sequence diff
const btSeq = bt.trades.filter(t => !t.exitReason.includes('open at end')).map(t => ({
  entryIdx: idxByTime.get(t.entryTime) ?? -1,
  side: t.side,
  why: t.exitReason,
}))
const seqOk = btSeq.length === liveTrades.length
  && btSeq.every((t, k) => t.side === liveTrades[k].side && t.entryIdx === liveTrades[k].entryIdx && t.why === liveTrades[k].why)
say(`  trade-sequence parity: backtest=${btSeq.length} · live=${liveTrades.length} -> ${seqOk ? 'IDENTICAL' : 'DIFF'}`)
if (!seqOk) {
  const n = Math.max(btSeq.length, liveTrades.length)
  for (let k = 0; k < Math.min(n, 6); k++) {
    const a = btSeq[k]
    const b = liveTrades[k]
    say(`    ${k}: bt=${a ? `${a.side} bar${a.entryIdx} "${a.why}"` : '-'} | live=${b ? `${b.side} bar${b.entryIdx} "${b.why}"` : '-'}`)
  }
}
const verdict = rawOk && seqOk && live.length > 0 ? 'PARITY OK' : 'PARITY FAIL'
say(`\n== VERDICT: ${verdict} — live signals=${live.length}, backtest rawSignals=${bt.metrics.regime?.signals}, trades bt=${btSeq.length}/live=${liveTrades.length} ==`)

await db.$disconnect()
writeFileSync('/tmp/probe-swing-live.txt', out.join('\n'))
process.exit(0)
