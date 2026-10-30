// PROBE: why do ATR-bracket trades stop out instantly under costs?
import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { normalizeAlgoParams } from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
async function fetchYahoo(symbol: string): Promise<Bar[]> {
  const end = Date.now()
  const start = end - 55 * 86400_000
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=15m&period1=${Math.floor(start / 1000)}&period2=${Math.floor(end / 1000)}&includePrePost=false`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  const j = await res.json() as any
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

async function main() {
  const bars = await fetchYahoo('NVDA')
  const series = prepareSeries(bars)
  console.log('bars', bars.length, 'atrBase', series.atrBase, 'atrPct[300]', series.atrPct[300], 'atrPct[600]', series.atrPct[600])

  const params = normalizeAlgoParams('bb-reversion', { bbStd: 2.4, rsiOversold: 20, rsiOverbought: 80, regimeTrend: 0, regimeAdx: 0, hlGate: 0, trendSoftPct: 0 })
  const mk = (costs: boolean): BacktestConfig => ({
    strategy: 'bb-reversion',
    params,
    qty: 27,
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: false,
    tpMode: 'none',
    tpValue: null as unknown as number,
    slMode: 'atr',
    slValue: 2,
    trailMode: 'off',
    trailArmPct: null,
    trailGivePct: null,
    maxTradesDay: 4,
    rthOnly: true,
    flattenEod: true,
    cooldownMin: 0,
    requireNewSignal: false,
    capital: 25000,
    slippageBps: costs ? 2 : 0,
    feeBps: costs ? 0.35 : 0,
    spreadBps: costs ? 2 : 0,
    dynSlip: costs,
    collectEquity: false,
  })
  for (const [label, cfg] of [['COSTED', mk(true)], ['GROSS', mk(false)]] as const) {
    const res = runBacktest(series, cfg)
    console.log(`\n${label}: trades=${res.metrics.trades} net=${res.metrics.netPct.toFixed(3)}% hold=${res.metrics.avgHoldMin.toFixed(1)}min`)
    for (const t of res.trades.slice(0, 6)) {
      console.log(`  ${new Date(t.entryTime * 1000).toISOString().slice(5, 16)} ${t.side} entry ${t.entryPx.toFixed(2)} exit ${t.exitPx.toFixed(2)} pnl ${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(3)}%) ${t.exitReason} hold ${t.holdMin}m`)
    }
  }
}
void main()
