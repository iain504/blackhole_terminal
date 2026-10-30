// Probe for the v1.99.0 trust layer — verifies on REAL Yahoo bars that:
//   1. significanceStats + trustVerdict produce sane numbers/verdicts on a
//      plain costed run;
//   2. walkForward now returns fold oosBps, a POOLED aggregate.oosSig and a
//      holdout.sig — each with a plain-language out-of-sample verdict;
//   3. the in-sample verdict is capped at 'suggestive' (winner's curse).
// Usage: bun scripts/probe-trust.ts [SYMBOL] [tf]
import { prepareSeries, runBacktest, walkForward, type BacktestConfig, type OptimizeRange } from '@/lib/backtest'
import { significanceStats, trustVerdict, roundTripCostBps } from '@/lib/backtest-stats'
import { normalizeAlgoParams, type AlgoTimeframe } from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const SYMBOL = (process.argv[2] ?? 'SPY').toUpperCase()
const TF = ((process.argv[3] ?? '15m') as AlgoTimeframe)

async function fetchYahoo(symbol: string, tf: AlgoTimeframe): Promise<Bar[]> {
  const end = Date.now()
  const start = end - 55 * 86400_000
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${tf === '5m' ? '5m' : '15m'}&period1=${Math.floor(start / 1000)}&period2=${Math.floor(end / 1000)}&includePrePost=false`
  for (let a = 0; a < 4; a++) {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    } catch {
      await sleep(1500)
      continue
    }
    if (res.status === 429) {
      await sleep(2500)
      continue
    }
    if (!res.ok) throw new Error(`yahoo ${res.status}`)
    const j = (await res.json()) as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] } }[] } }
    const r = j.chart?.result?.[0]
    const ts = r?.timestamp ?? []
    const q = r?.indicators?.quote?.[0]
    const bars: Bar[] = []
    for (let i = 0; i < ts.length; i++) {
      const o = q?.open?.[i], h = q?.high?.[i], l = q?.low?.[i], c = q?.close?.[i]
      if (o == null || h == null || l == null || c == null || c <= 0) continue
      bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q?.volume?.[i] ?? 0 })
    }
    return bars.sort((a, b) => a.time - b.time)
  }
  throw new Error('yahoo retries exhausted')
}

async function main() {
  const bars = await fetchYahoo(SYMBOL, TF)
  console.log(`${SYMBOL} ${TF}: ${bars.length} bars`)
  const series = prepareSeries(bars)
  const qty = Math.max(1, Math.round(5000 / bars[bars.length - 1].close))
  const costs = { slippageBps: 2, feeBps: 0.35, spreadBps: 2 }
  const params = normalizeAlgoParams('orb15', {})
  const cfg: BacktestConfig = {
    strategy: 'orb15',
    params,
    qty,
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: false,
    tpMode: 'atr',
    tpValue: 4,
    slMode: 'atr',
    slValue: 3,
    trailMode: 'off',
    trailArmPct: null,
    trailGivePct: null,
    maxTradesDay: 4,
    rthOnly: true,
    flattenEod: true,
    cooldownMin: 0,
    requireNewSignal: false,
    capital: 25_000,
    slippageBps: costs.slippageBps,
    feeBps: costs.feeBps,
    spreadBps: costs.spreadBps,
    dynSlip: true,
    collectEquity: false,
  }

  // 1) plain run verdict
  const run = runBacktest(series, cfg)
  const sig = significanceStats(run.trades, roundTripCostBps(cfg))
  const v = trustVerdict(sig, 'plain')
  console.log(`\n[1] PLAIN RUN — ${run.metrics.trades} trades, net ${run.metrics.netPct.toFixed(2)}%`)
  console.log(`    sig: n=${sig?.n} mean=${sig?.meanBps.toFixed(1)}bps σ=${sig?.sdBps.toFixed(0)} t=${sig?.t.toFixed(2)} p=${sig?.p.toFixed(4)} CI=[${sig?.ciLo.toFixed(1)}, ${sig?.ciHi.toFixed(1)}] need=${sig?.tradesNeeded}`)
  console.log(`    verdict [${v.level}] ${v.title}`)
  console.log(`    ${v.detail}`)

  // 2) frictionless run — verdict must call it out
  const sigF = significanceStats(runBacktest(series, { ...cfg, slippageBps: 0, feeBps: 0, spreadBps: 0, dynSlip: false }).trades, 0)
  const vF = trustVerdict(sigF, 'plain')
  console.log(`\n[2] FRICTIONLESS RUN — verdict [${vF.level}] ${vF.title}`)
  console.log(`    costNote present: ${vF.detail.includes('FRICTIONLESS') ? 'YES' : 'NO'}`)

  // 3) walk-forward pooled OOS + holdout verdicts
  const ranges: OptimizeRange[] = [
    { key: 'orMinutes', min: 15, max: 60, step: 15 },
    { key: 'tpValue', min: 2.5, max: 8, step: 2.75 },
    { key: 'slValue', min: 2, max: 4, step: 1 },
  ]
  const wf = await walkForward(series, cfg, { ranges, folds: 3, isFraction: 0.7, anchored: false, holdoutFraction: 0.2, minTrades: 6 })
  console.log(`\n[3] WALK-FORWARD — ${wf.folds.length} folds · aggregate.oosSig:`)
  const ov = wf.aggregate.oosSig ? trustVerdict(wf.aggregate.oosSig, 'oos') : null
  console.log(`    pooled OOS n=${wf.aggregate.oosSig?.n ?? 0} mean=${wf.aggregate.oosSig ? wf.aggregate.oosSig.meanBps.toFixed(1) : '—'}bps verdict [${ov?.level}] ${ov?.title ?? '—'}`)
  console.log(`    fold oosBps lens: ${wf.folds.map((f) => f.oosBps.length).join('/')} (oosTrades: ${wf.folds.map((f) => f.oosTrades).join('/')})`)
  if (wf.holdout?.sig) {
    const hv = trustVerdict(wf.holdout.sig, 'oos')
    console.log(`    hold-out: n=${wf.holdout.sig.n} mean=${wf.holdout.sig.meanBps.toFixed(1)}bps net ${wf.holdout.netPct.toFixed(2)}% verdict [${hv.level}] ${hv.title}`)
  } else {
    console.log(`    hold-out: none (${wf.holdoutDisabled ?? 'disabled'})`)
  }

  // 4) in-sample cap — a strong in-sample result must stay 'suggestive'
  if (sig && sig.meanBps > 0 && sig.p < 0.05) {
    const vIn = trustVerdict(sig, 'in-sample', 1234)
    console.log(`\n[4] IN-SAMPLE CAP — significant plain result capped: [${vIn.level}] ${vIn.level === 'suggestive' ? 'OK' : 'FAIL'} (winner's-curse note: ${vIn.detail.includes("winner's curse") ? 'YES' : 'NO'})`)
  } else {
    const vIn = trustVerdict(sig, 'in-sample', 1234)
    console.log(`\n[4] IN-SAMPLE CAP — plain result was [${v.level}] so cap not exercised; in-sample verdict [${vIn.level}]`)
  }
  console.log('\nprobe done.')
}

void main()
