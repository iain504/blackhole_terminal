// Task 89 research sweep — run the full strategy catalog (defaults + auto
// optimizer grid) across a symbol × timeframe matrix at MAX history per TF
// (ALGO_MAX_DAYS), with per-market execution costs (Task 88 suggestion values
// + measured-typical spreads). Output: scripts-tmp/reco-sweep-results.json —
// the feed for the baked-in "Recommended setups" list on the Backtest page.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { getBars } from '@/lib/alpaca'
import { TIMEFRAMES } from '@/lib/market-types'
import { prepareSeries, sweepStrategies, type BacktestConfig } from '@/lib/backtest'
import { ALGO_MAX_DAYS, ALGO_TIMEFRAMES, type AlgoTimeframe } from '@/lib/algo-strategies'
import { db } from '@/lib/db'

const SYMBOLS = ['TSLA', 'AAPL', 'NVDA', 'SPY', 'BTC/USD', 'ETH/USD', 'SOL/USD']
const MAX_BARS = 120_000 // same hard cap the API route enforces
const MIN_TRADES = 10
const TOPX = 10

// Task 88 suggestions + realistic spreads (majors ~3 bps live, alts wider)
const costsFor = (symbol: string): { slip: number; fee: number; spread: number } => {
  if (symbol.includes('/')) {
    const base = symbol.split('/')[0] ?? ''
    return base === 'BTC' || base === 'ETH' ? { slip: 3, fee: 10, spread: 3 } : { slip: 10, fee: 10, spread: 5 }
  }
  return { slip: 2, fee: 0, spread: 2 }
}

interface RecoRow {
  strategy: string
  params: Record<string, number>
  score: number
  netPct: number
  pf: number
  winPct: number
  maxDDPct: number
  trades: number
}

async function main() {
  const user = await db.user.findUnique({ where: { username: 'trader' } })
  if (!user) throw new Error('trader user not found')
  // resumable — skip combos already recorded with rows (the background run can
  // get killed mid-matrix; rerunning picks up where it left off)
  const RESULTS = 'scripts-tmp/reco-sweep-results.json'
  const out: Record<string, unknown>[] = existsSync(RESULTS)
    ? (JSON.parse(readFileSync(RESULTS, 'utf8')) as Record<string, unknown>[])
    : []
  const done = new Set(out.filter((o) => !o.error && Array.isArray(o.rows)).map((o) => `${o.symbol}|${o.tf}`))
  const failed = out.filter((o) => typeof o.error === 'string')
  for (const f of failed) out.splice(out.indexOf(f), 1) // retry previous failures
  for (const tf of ALGO_TIMEFRAMES as readonly AlgoTimeframe[]) {
    for (const symbol of SYMBOLS) {
      // RECO_ONLY="SYM|TF,SYM|TF" — run a subset (foreground chunking)
      const only = (process.env.RECO_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (only.length > 0 && !only.includes(`${symbol}|${tf}`)) continue
      if (done.has(`${symbol}|${tf}`)) {
        console.log(`skip ${symbol} ${tf} (already done)`)
        continue
      }
      const t0 = Date.now()
      try {
        const days = ALGO_MAX_DAYS[tf]
        const res = await getBars(symbol, tf, user.id, { lookbackDays: days })
        let bars = Array.isArray(res.bars) ? res.bars : []
        if (res.demo || bars.length < 80) {
          out.push({ symbol, tf, error: res.demo ? 'no live historical data (demo feed)' : `insufficient history (${bars.length} bars)` })
          console.log(`SKIP ${symbol} ${tf}`)
          continue
        }
        // drop the forming bar + hard cap (exact route semantics)
        const tfSec = TIMEFRAMES[tf].seconds
        const nowSec = Math.floor(Date.now() / 1000)
        while (bars.length > 0 && bars[bars.length - 1].time + tfSec > nowSec) bars = bars.slice(0, -1)
        if (bars.length > MAX_BARS) bars = bars.slice(bars.length - MAX_BARS)
        const c = costsFor(symbol)
        const cfg: BacktestConfig = {
          strategy: 'bb-reversion', // placeholder — sweep overrides per strategy
          params: {},
          qty: 10,
          sizingMode: 'fixed',
          riskBasis: 'usd',
          riskMoney: null,
          isCrypto: symbol.includes('/'),
          // the terminal's default bracket — recommendations apply this as-is
          tpMode: 'pct',
          tpValue: 1.5,
          slMode: 'pct',
          slValue: 1,
          maxTradesDay: 3,
          rthOnly: true,
          flattenEod: true,
          cooldownMin: 0,
          requireNewSignal: false,
          slippageBps: c.slip,
          feeBps: c.fee,
          spreadBps: c.spread,
          capital: 10000,
        }
        const series = prepareSeries(bars)
        const sweep = sweepStrategies(series, cfg, { minTrades: MIN_TRADES, topX: TOPX })
        const rows: RecoRow[] = sweep.rows.slice(0, 3).map((r) => ({
          strategy: r.strategy,
          params: r.params,
          score: Number(r.score.toFixed(3)),
          netPct: Number(r.metrics.netPct.toFixed(2)),
          pf: Number(r.metrics.profitFactor.toFixed(2)),
          winPct: Number(r.metrics.winRate.toFixed(1)),
          maxDDPct: Number(r.metrics.maxDrawdownPct.toFixed(2)),
          trades: r.metrics.trades,
        }))
        out.push({
          symbol,
          tf,
          bars: series.n,
          from: bars[0].time,
          to: bars[bars.length - 1].time,
          coveredDays: Math.max(1, Math.round((nowSec - bars[0].time) / 86400)),
          source: res.source ?? 'alpaca',
          costs: c,
          sweepMs: sweep.elapsedMs,
          totalMs: Date.now() - t0,
          rows,
          perStrategy: sweep.perStrategy.map((p) => ({ s: p.strategy, scorable: p.scorable, best: p.bestScore })),
        })
        const top = sweep.rows[0]
        console.log(`done ${symbol} ${tf}: ${series.n} bars · top=${top ? `${top.strategy} score ${top.score.toFixed(2)} net ${top.metrics.netPct.toFixed(1)}%` : '—'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        out.push({ symbol, tf, error: msg })
        console.log(`ERR ${symbol} ${tf}: ${msg}`)
      }
      writeFileSync('scripts-tmp/reco-sweep-results.json', JSON.stringify(out, null, 1))
    }
  }
  console.log(`ALL DONE ${out.length} combos`)
}

await main()
