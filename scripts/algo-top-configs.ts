// Algo tab FULL-FEATURE config sweep — answers "make use of all functions in
// the Algo tab, pick symbols from the US stock market, backtest, and list the
// top config for 10 symbols with explanation."
//
// Everything runs through the app's OWN backtest engine (src/lib/backtest.ts —
// the exact bar-replay the Algo tab's Backtest panel uses, incl. parity with
// the live algo engine), exercising EVERY Algo function in one pass:
//   • all 4 strategies (bb-reversion, rsi2-connors, orb15, vwap-fade) with
//     per-strategy parameter grids through optimizeBacktest();
//   • BOTH regime presets (v1.94 function): Research/Discovery (gates off —
//     raw rule edge) AND Live Candidate (soft trend + ADX + half-life gates);
//   • TP/SL as ATR(14) multiples (v1.96.0) + a TP-mode bake-off (ATR brackets
//     vs strategy-managed 'none');
//   • longs-only vs shorts-allowed bake-off for the fade strategies;
//   • the trailing exit (v1.97.0): off vs 5 volatility-scaled arm/give
//     settings (arm = k × mean ATR%, give = 0.5 × arm);
//   • re-entry controls (cooldown 60min / require-new-signal edge);
//   • the cost model: frictionless for the Research track, Alpaca-realistic
//     (spread 2bps + slippage 2bps vol-scaled + fee 0.35bps) for evaluation;
//   • EOD flatten 15:45 ET, RTH-only gating, max 4 trades/day, fixed $5k
//     notional sizing on $25k capital.
//
// SELECTION HONESTY: when NO config is net-positive after realistic costs (a
// real outcome on hostile tape), the winner is the Research-track raw-edge
// config — NOT the least-bad dormant combo a cost-aware optimizer collapses
// to. Live-track candidates only win when their edge actually survives costs
// (score > 0).
//
// Data: Yahoo Finance chart API, RTH 5m/15m bars (~55 calendar days, keyless —
// the same source the v1.98.0 trailing proof used; Yahoo caps intraday at 60d).
//
// Usage: bun scripts/algo-top-configs.ts

import {
  prepareSeries,
  runBacktest,
  optimizeBacktest,
  backtestScore,
  type BacktestConfig,
  type OptimizeRange,
  type BacktestMetrics,
  type BacktestResult,
} from '@/lib/backtest'
import {
  ALGO_STRATEGIES,
  normalizeAlgoParams,
  applyRegimePreset,
  type AlgoStrategyId,
  type AlgoTimeframe,
} from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const MIN_TRADES = 10
const CAPITAL = 25_000
const NOTIONAL = 5_000
const DAYS = 55

// 10 US liquid names spanning the volatility spectrum the Algo tab targets:
// high-vol momentum (NVDA/TSLA/AMD/NFLX), mega-cap drift (META/AAPL/MSFT/AMZN),
// index beta (SPY/QQQ).
const SYMBOLS = ['NVDA', 'TSLA', 'AMD', 'META', 'AAPL', 'MSFT', 'AMZN', 'NFLX', 'SPY', 'QQQ']
const TFS: AlgoTimeframe[] = ['15m', '5m']

async function fetchYahoo(symbol: string, tf: AlgoTimeframe): Promise<Bar[]> {
  const interval = tf === '5m' ? '5m' : '15m'
  const end = Date.now()
  const start = end - DAYS * 86400_000
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&period1=${Math.floor(start / 1000)}&period2=${Math.floor(end / 1000)}&includePrePost=false`
  for (let attempt = 0; attempt < 4; attempt++) {
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
    if (!res.ok) throw new Error(`yahoo ${res.status}: ${(await res.text()).slice(0, 120)}`)
    const j = (await res.json()) as {
      chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] } }[] }
    }
    const r = j.chart?.result?.[0]
    const ts = r?.timestamp ?? []
    const q = r?.indicators?.quote?.[0]
    const bars: Bar[] = []
    for (let i = 0; i < ts.length; i++) {
      const o = q?.open?.[i], h = q?.high?.[i], l = q?.low?.[i], c = q?.close?.[i]
      if (o == null || h == null || l == null || c == null || c <= 0) continue
      bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q?.volume?.[i] ?? 0 })
    }
    bars.sort((a, b) => a.time - b.time)
    return bars
  }
  throw new Error(`yahoo: retries exhausted for ${symbol} ${tf}`)
}

// ---- per-strategy curated optimizer grids (defaults guaranteed included) ----

// SL grids NEVER go below 1.5×ATR — a 1×ATR bracket sits inside bar noise
// (15m ATR ≈ 0.1-0.4% ≈ one bar's range): frictionless optimization loves it
// (tighter stop = better Calmar) but the first real fill shift from costs
// stop-outs every trade on the entry bar. Verified empirically in the first
// run: 8/8 'stop loss' exits with 0-minute holds.
const GRIDS: Record<AlgoStrategyId, OptimizeRange[]> = {
  'bb-reversion': [
    { key: 'bbStd', values: [1.6, 2, 2.4, 2.8] },
    { key: 'rsiOversold', values: [20, 25, 30] },
    { key: 'rsiOverbought', values: [70, 75, 80] },
    { key: 'tpValue', values: [2.5, 3.5, 5] },
    { key: 'slValue', values: [2, 3, 4] },
  ],
  'rsi2-connors': [
    { key: 'rsiPeriod', values: [2, 3] },
    { key: 'rsiBuy', values: [5, 10, 15] },
    { key: 'trendSma', values: [50, 100, 150, 200] },
    { key: 'exitSma', values: [3, 5, 10] },
    { key: 'tpValue', values: [2.5, 4, 6] },
    { key: 'slValue', values: [2, 3, 4] },
  ],
  'orb15': [
    { key: 'orMinutes', values: [5, 15, 30, 60] },
    { key: 'orbVolMult', values: [0, 1, 2, 3] },
    { key: 'tpValue', values: [2.5, 4, 6, 8] },
    { key: 'slValue', values: [1.5, 2, 3, 4] },
  ],
  'vwap-fade': [
    { key: 'devPct', values: [0.3, 0.5, 0.8, 1.2, 1.6] },
    { key: 'trendSoftPct', values: [0.5, 1.5, 3] },
    { key: 'tpValue', values: [1.5, 2.5, 3.5] },
    { key: 'slValue', values: [1.5, 2, 3] },
  ],
}

const COSTS = { slippageBps: 2, feeBps: 0.35, spreadBps: 2, dynSlip: true }

function baseCfg(
  strategy: AlgoStrategyId,
  qty: number,
  params: Record<string, number>,
  tpMode: 'atr' | 'none' = 'atr',
  frictionless = false,
): BacktestConfig {
  return {
    strategy,
    params,
    qty,
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: false,
    tpMode,
    tpValue: 2,
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
    capital: CAPITAL,
    slippageBps: frictionless ? 0 : COSTS.slippageBps,
    feeBps: frictionless ? 0 : COSTS.feeBps,
    spreadBps: frictionless ? 0 : COSTS.spreadBps,
    dynSlip: frictionless ? false : COSTS.dynSlip,
    collectEquity: false,
  }
}

interface TrailVariant { label: string; arm: number | null; give: number | null }

function trailVariants(atrBase: number): TrailVariant[] {
  const mk = (k: number): TrailVariant => {
    // arm floor 0.3% — a trail arming inside bar noise + round-trip costs
    // churns stops that can never clear friction
    const arm = +(Math.min(6, Math.max(0.3, k * atrBase))).toFixed(2)
    const give = +(Math.max(0.15, arm * 0.5)).toFixed(2)
    return { label: `arm ${arm}% / give ${give}%`, arm, give }
  }
  const seen = new Set<string>()
  const out: TrailVariant[] = [{ label: 'off', arm: null, give: null }]
  for (const k of [0.75, 1.5, 2.5, 4, 6]) {
    const v = mk(k)
    const key = `${v.arm}/${v.give}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

interface StrategyCandidate {
  track: 'research' | 'live'
  strategy: AlgoStrategyId
  tf: AlgoTimeframe
  params: Record<string, number>
  tpMode: 'atr' | 'none'
  tpValue: number
  slValue: number
  cooldown: number
  reqNew: boolean
  trail: TrailVariant
  trailExitCount: number
  reasons: Record<string, number>
  metrics: BacktestMetrics // under realistic costs
  gross: BacktestMetrics // same config frictionless
  grossExpBps: number
  plateau: { meanNeighborScore: number; ratio: number; ok: boolean } | null
  score: number // under realistic costs
  evaluated: number
}

interface SymbolResult {
  symbol: string
  tf: AlgoTimeframe
  bars: number
  from: string
  to: string
  atrBase: number
  trendPct: number // close vs SMA200 (%)
  qty: number
  winner: StrategyCandidate | null
  all: StrategyCandidate[]
}

function sma(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1]
  let s = 0
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i]
  return s / period
}

function reasonCounts(trades: BacktestTradeList): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of trades) out[t.exitReason] = (out[t.exitReason] ?? 0) + 1
  return out
}
type BacktestTradeList = BacktestResult['trades']

async function sweepSymbol(symbol: string): Promise<SymbolResult[]> {
  const out: SymbolResult[] = []
  for (const tf of TFS) {
    const bars = await fetchYahoo(symbol, tf)
    if (bars.length < 260) {
      out.push({ symbol, tf, bars: bars.length, from: '-', to: '-', atrBase: NaN, trendPct: NaN, qty: 0, winner: null, all: [] })
      continue
    }
    const series = prepareSeries(bars)
    const lastClose = bars[bars.length - 1].close
    const qty = Math.max(1, Math.round(NOTIONAL / lastClose))
    const trendPct = ((lastClose / sma(series.closes, 200)) - 1) * 100
    const variants = trailVariants(series.atrBase * 100)
    const all: StrategyCandidate[] = []

    for (const strategy of Object.keys(ALGO_STRATEGIES) as AlgoStrategyId[]) {
      const fadeStrat = strategy === 'bb-reversion' || strategy === 'vwap-fade'
      // ---- Track R: Research/Discovery — gates OFF, frictionless optimization
      const researchParams = normalizeAlgoParams(strategy, applyRegimePreset('research', strategy, tf, {}))
      // ---- Track L: Live Candidate — gates ON, cost-aware optimization
      const liveBases: Record<string, number>[] = [normalizeAlgoParams(strategy, applyRegimePreset('live', strategy, tf, {}))]
      if (fadeStrat) liveBases.push(normalizeAlgoParams(strategy, { ...liveBases[0], allowShort: 0 }))

      type OptOut = Awaited<ReturnType<typeof optimizeBacktest>>
      let optR: OptOut | null = null
      let optL: OptOut | null = null
      let optLParams: Record<string, number> = liveBases[0]
      try {
        optR = await optimizeBacktest(series, baseCfg(strategy, qty, researchParams, 'atr', true), GRIDS[strategy], { minTrades: MIN_TRADES })
      } catch (e) {
        console.log(`  [${symbol} ${tf}] ${strategy}: research optimize ERROR ${String(e).slice(0, 120)}`)
      }
      for (const pb of liveBases) {
        try {
          const opt = await optimizeBacktest(series, baseCfg(strategy, qty, pb), GRIDS[strategy], { minTrades: MIN_TRADES })
          if (opt.best && Number.isFinite(opt.best.score) && (!optL?.best || opt.best.score > optL.best.score)) {
            optL = opt
            optLParams = pb
          }
        } catch (e) {
          console.log(`  [${symbol} ${tf}] ${strategy}: live optimize ERROR ${String(e).slice(0, 120)}`)
        }
      }
      if (!optR?.best || !Number.isFinite(optR.best.score)) {
        console.log(`  [${symbol} ${tf}] ${strategy}: no research combo reached ${MIN_TRADES}+ trades`)
        continue
      }

      // ---- exit-shape + re-entry + trail bake-off UNDER REALISTIC COSTS,
      //      run for BOTH tracks' winning entry params
      const buildCand = (
        track: 'research' | 'live',
        winParams: Record<string, number>,
        tpV: number,
        slV: number,
        plateau: StrategyCandidate['plateau'],
        evaluated: number,
        frictionlessBake: boolean,
      ): StrategyCandidate | null => {
        type Row = { tpMode: 'atr' | 'none'; v: TrailVariant; cooldown: number; reqNew: boolean; res: BacktestResult; score: number }
        const scored: Row[] = []
        for (const tpMode of ['atr', 'none'] as const) {
          for (const re of [
            { cooldown: 0, reqNew: false },
            { cooldown: 60, reqNew: false },
            { cooldown: 0, reqNew: true },
          ]) {
            for (const v of variants) {
              const cfg: BacktestConfig = {
                ...baseCfg(strategy, qty, winParams, tpMode, frictionlessBake),
                tpValue: tpV,
                slValue: slV,
                cooldownMin: re.cooldown,
                requireNewSignal: re.reqNew,
                trailMode: v.arm != null && v.give != null ? 'pct' : 'off',
                trailArmPct: v.arm,
                trailGivePct: v.give,
              }
              const res = runBacktest(series, cfg)
              scored.push({ tpMode, v, cooldown: re.cooldown, reqNew: re.reqNew, res, score: backtestScore(res.metrics, MIN_TRADES) })
            }
          }
        }
        scored.sort((a, b) => b.score - a.score)
        let chosen = scored[0]
        if (!Number.isFinite(chosen.score)) return null
        // simplicity preference: trail-off + no re-entry gates win near-ties (≤3%) on positive scores
        const plainRow = scored.find((s) => s.v.label === 'off' && s.cooldown === 0 && !s.reqNew)!
        if (chosen.score > 0 && Number.isFinite(plainRow.score) && plainRow.score >= chosen.score * 0.97) chosen = plainRow
        // costed evaluation of the SAME chosen config (the report's truth)
        const costedCfg: BacktestConfig = {
          ...baseCfg(strategy, qty, winParams, chosen.tpMode),
          tpValue: tpV,
          slValue: slV,
          cooldownMin: chosen.cooldown,
          requireNewSignal: chosen.reqNew,
          trailMode: chosen.v.arm != null && chosen.v.give != null ? 'pct' : 'off',
          trailArmPct: chosen.v.arm,
          trailGivePct: chosen.v.give,
        }
        const costed = frictionlessBake ? runBacktest(series, costedCfg) : chosen.res
        // frictionless probe of the chosen config (raw edge)
        const gross = frictionlessBake
          ? chosen.res
          : runBacktest(series, { ...costedCfg, slippageBps: 0, feeBps: 0, spreadBps: 0, dynSlip: false })
        return {
          track,
          strategy,
          tf,
          params: winParams,
          tpMode: chosen.tpMode,
          tpValue: tpV,
          slValue: slV,
          cooldown: chosen.cooldown,
          reqNew: chosen.reqNew,
          trail: chosen.v,
          trailExitCount: costed.trades.filter((t) => t.exitReason === 'trailing stop').length,
          reasons: reasonCounts(costed.trades),
          metrics: costed.metrics,
          gross: gross.metrics,
          grossExpBps: gross.metrics.trades > 0 ? +((gross.metrics.expectancy / NOTIONAL) * 10_000).toFixed(1) : 0,
          plateau,
          score: backtestScore(costed.metrics, MIN_TRADES),
          evaluated,
        }
      }

      const candR = buildCand(
        'research',
        normalizeAlgoParams(strategy, { ...researchParams, ...optR.best.params }),
        optR.best.params.tpValue ?? 2,
        optR.best.params.slValue ?? 2,
        optR.plateau ?? null,
        optR.evaluated,
        true,
      )
      let candL: StrategyCandidate | null = null
      if (optL?.best && Number.isFinite(optL.best.score)) {
        candL = buildCand(
          'live',
          normalizeAlgoParams(strategy, { ...optLParams, ...optL.best.params }),
          optL.best.params.tpValue ?? 2,
          optL.best.params.slValue ?? 2,
          optL.plateau ?? null,
          optL.evaluated,
          false,
        )
      }

      // SELECTION: a live-track candidate must EARN the win (score > 0);
      // otherwise the research raw-edge config represents the symbol honestly.
      // When BOTH are negative, the research config with the HIGHEST GROSS
      // edge is the more informative pick (the cost-aware one collapses to a
      // near-dormant combo that just loses slowly).
      let pick: StrategyCandidate | null = null
      if (candL && candL.score > 0) pick = !candR || candL.score >= candR.score ? candL : candR
      else if (candL && candR && candR.score <= 0) pick = candR.grossExpBps >= candL.grossExpBps ? candR : candL
      else pick = candR ?? candL
      if (!pick) continue

      for (const c of [candR, candL]) {
        if (!c) continue
        console.log(
          `  [${symbol} ${tf}] ${c.track}/${strategy}: score ${c.score.toFixed(2)} · net ${c.metrics.netPct.toFixed(2)}% · ${c.metrics.trades} trd · TP ${c.tpMode} · cd${c.cooldown}${c.reqNew ? '+new' : ''} · trail ${c.trail.arm != null ? c.trail.label : 'off'} · gross ${c.grossExpBps} bps/trd`,
        )
      }
      all.push(pick)
    }

    all.sort((a, b) => b.score - a.score)
    out.push({
      symbol,
      tf,
      bars: bars.length,
      from: new Date(bars[0].time * 1000).toISOString().slice(0, 10),
      to: new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10),
      atrBase: +(series.atrBase * 100).toFixed(2),
      trendPct: +trendPct.toFixed(1),
      qty,
      winner: all[0] ?? null,
      all,
    })
  }
  return out
}

function overridesOf(w: StrategyCandidate): string {
  return (
    Object.entries(w.params)
      .filter(([k, v]) => ALGO_STRATEGIES[w.strategy].defaults[k] !== v)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || 'defaults'
  )
}

function fmtWinnerRow(r: SymbolResult): string {
  const w = r.winner!
  const m = w.metrics
  return [
    r.symbol.padEnd(5),
    r.tf.padEnd(4),
    w.track.padEnd(8),
    w.strategy.padEnd(13),
    overridesOf(w).padEnd(52).slice(0, 52),
    (w.tpMode === 'none' ? 'TP none' : `TP ${w.tpValue}×ATR`) + ` / SL ${w.slValue}×ATR`,
    (w.trail.arm != null ? w.trail.label : 'trail off').padEnd(22),
    String(m.trades).padStart(4),
    m.winRate.toFixed(0).padStart(4),
    m.netPct.toFixed(1).padStart(6),
    (Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '999').padStart(5),
    m.maxDrawdownPct.toFixed(1).padStart(6),
    w.grossExpBps.toFixed(0).padStart(6),
    w.score.toFixed(2).padStart(6),
  ].join(' | ')
}

function explain(r: SymbolResult): string {
  const w = r.winner!
  const m = w.metrics
  const volBucket = r.atrBase < 0.22 ? 'low-vol' : r.atrBase < 0.45 ? 'mid-vol' : 'high-vol'
  const trendWord = Math.abs(r.trendPct) < 1.5 ? 'range-bound around its 200-SMA' : r.trendPct > 0 ? `in an uptrend (+${r.trendPct}% vs its 200-SMA)` : `in a downtrend (${r.trendPct}% vs its 200-SMA)`
  const reEntry = w.cooldown > 0 ? '60-min re-entry cooldown' : w.reqNew ? 'fresh-signal re-entry gate' : ''
  const parts: string[] = []
  parts.push(
    `${w.strategy === 'orb15' ? 'Breakout' : w.strategy === 'rsi2-connors' ? 'Pullback-buying' : 'Mean-reversion'} won on this ${volBucket} name (${r.atrBase}% mean ${r.tf} ATR) that spent the window ${trendWord}.`,
  )
  parts.push(
    w.track === 'research'
      ? `Config comes from the Research/Discovery pass (regime gates off, frictionless optimization) — i.e. the parameter set with this symbol's strongest RAW rule edge; the Live-Candidate pass (gates on, cost-aware) produced nothing that survived costs, so the raw-edge config is the honest top pick.`
      : `Config comes from the Live-Candidate pass (soft trend + ADX + half-life gates, cost-aware optimization) — its edge SURVIVED realistic costs (score > 0).`,
  )
  parts.push(
    w.tpMode === 'none'
      ? `TP brackets OFF — exits are strategy-managed (${Object.entries(w.reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'n/a'}) + a ${w.slValue}×ATR(14) disaster stop${reEntry ? `, ${reEntry}` : ''}.`
      : `TP = ${w.tpValue}×ATR(14), disaster stop = ${w.slValue}×ATR(14) (${Object.entries(w.reasons).map(([k, n]) => `${k} ${n}`).join(', ')}${reEntry ? `; ${reEntry}` : ''}).`,
  )
  if (w.trail.arm != null) {
    parts.push(
      `Trailing exit armed at +${w.trail.arm}% and gave back ${w.trail.label.split('give ')[1]} — ${w.trailExitCount} of ${m.trades} exits were trail stops, locking winners once in profit instead of waiting on the TP.`,
    )
  } else {
    parts.push(`Trailing stayed OFF — the bake-off showed it gave back more than it locked on this tape.`)
  }
  parts.push(
    w.grossExpBps > 9
      ? `Frictionless edge ≈ ${w.grossExpBps} bps/trade vs ≈ ${((2 + 2 + 0.35) * 2).toFixed(1)} bps round-trip friction — the net ${(m.netPct >= 0 ? '+' : '')}${m.netPct.toFixed(1)}% (${m.trades} trades, WR ${m.winRate.toFixed(0)}%, PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}, maxDD ${m.maxDrawdownPct.toFixed(1)}%) is edge surviving costs.`
      : `Frictionless edge ≈ ${w.grossExpBps} bps/trade vs ≈ ${((2 + 2 + 0.35) * 2).toFixed(1)} bps round-trip friction — this window's raw edge does NOT clear real-world costs (net ${(m.netPct >= 0 ? '+' : '')}${m.netPct.toFixed(1)}%, WR ${m.winRate.toFixed(0)}%, maxDD ${m.maxDrawdownPct.toFixed(1)}%). It is the most edge-rich starting point of ${w.evaluated} evaluated combos, not a money-printer.`,
  )
  if (w.plateau) {
    parts.push(w.plateau.ok ? `Parameter plateau is robust (neighbours keep ${Math.round(w.plateau.ratio * 100)}% of the winner's score).` : `Parameter plateau is fragile (neighbours keep only ${Math.round(w.plateau.ratio * 100)}%) — treat the exact numbers as a starting point, re-verify before going live.`)
  }
  return parts.join(' ')
}

async function main() {
  console.log(`Algo tab full-feature sweep — ${SYMBOLS.length} US symbols × ${TFS.join('/')} · Yahoo RTH ${DAYS}d · research+live regime passes · ATR/none TP + ATR SL · trailing + re-entry bake-off · Alpaca-realistic cost evaluation`)
  const results: SymbolResult[][] = []
  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym}: fetching…\n`)
    try {
      const res = await sweepSymbol(sym)
      results.push(res)
    } catch (e) {
      console.log(`${sym}: FAILED ${String(e).slice(0, 160)}`)
      results.push([])
    }
    await sleep(400)
  }

  console.log('\n================ TOP CONFIG PER SYMBOL ================')
  console.log('SYMBOL | TF  | TRACK    | STRATEGY     | KEY PARAM OVERRIDES                                 | EXIT SHAPE                    | TRAIL                 |  TRD |  WR% |  NET% |   PF |   DD% |  GROSS | SCORE')
  const flat: SymbolResult[] = []
  for (const perSym of results) {
    const withWinner = perSym.filter((r) => r.winner)
    if (withWinner.length === 0) continue
    withWinner.sort((a, b) => b.winner!.score - a.winner!.score)
    flat.push(withWinner[0])
  }
  for (const r of flat) console.log(fmtWinnerRow(r))

  console.log('\n================ EXPLANATIONS ============')
  for (const r of flat) {
    console.log(`\n■ ${r.symbol} (${r.bars} bars ${r.from}→${r.to}, ${r.qty} sh/trd ≈ $${NOTIONAL})`)
    console.log('  ' + explain(r))
  }

  try {
    const { writeFileSync } = await import('fs')
    writeFileSync('/tmp/algo-top-configs.json', JSON.stringify(results, null, 1))
    console.log('\nfull JSON → /tmp/algo-top-configs.json')
  } catch { /* non-fatal */ }
}

void main()
