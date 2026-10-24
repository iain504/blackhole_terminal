// Parity probe — backtest decide() vs live evalStrategy() on REAL bars.
//
// 1. DECISION PARITY: replay the same bar set through (a) runBacktest with all
//    gates/brackets off (pure signal capture) and (b) a faithful simulation of
//    the live engine cycle (evalStrategy on the growing window + accumulator
//    feeding, exits-before-entries). Diff the accepted-entry sequences.
// 2. EXECUTION DIVERGENCE: re-price every trade under a live-faithful fill
//    model (market order at the SIGNAL bar's close, seconds after the close —
//    not the next bar's open) ± slippage/fees, and report the P&L delta vs the
//    backtest model.
import { getBars } from '@/lib/alpaca'
import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { evalStrategy } from '@/lib/algo-engine'
import { normalizeAlgoParams } from '@/lib/algo-strategies'
import { sessionOf, etDateKey, etMinutesOfDay } from '@/lib/sessions'
import type { Bar } from '@/lib/market-types'

const SYMBOL = process.env.PSYM ?? 'BTC/USD'
const TF = (process.env.PTF ?? '5m') as '1m' | '5m' | '15m'
const DAYS = Number(process.env.PDAYS ?? 30)
const TF_SEC = TF === '1m' ? 60 : TF === '5m' ? 300 : 900

interface St {
  day?: string
  vwapNum?: number
  vwapDen?: number
  orHigh?: number
  orLow?: number
  orDone?: boolean
  firedLong?: boolean
  firedShort?: boolean
}
const RTH_START_MIN = 9 * 60 + 30

function feed(strategy: string, orMinutes: number, bar: Bar, st: St, dayKey: string) {
  if (etDateKey(bar.time) !== dayKey) return
  if (sessionOf(bar.time) !== 'regular') return
  const typ = (bar.high + bar.low + bar.close) / 3
  if (strategy === 'vwap-fade') {
    st.vwapNum = (st.vwapNum ?? 0) + typ * bar.volume
    st.vwapDen = (st.vwapDen ?? 0) + bar.volume
  }
  if (strategy === 'orb15' && !st.orDone) {
    const m = etMinutesOfDay(bar.time)
    if (m >= RTH_START_MIN && m < RTH_START_MIN + orMinutes) {
      st.orHigh = st.orHigh == null ? bar.high : Math.max(st.orHigh, bar.high)
      st.orLow = st.orLow == null ? bar.low : Math.min(st.orLow, bar.low)
    } else if (m >= RTH_START_MIN + orMinutes && st.orHigh != null && st.orLow != null) {
      st.orDone = true
    }
  }
}

interface Sig { t: number; side: 'buy' | 'sell' }

function liveSim(strategy: string, params: Record<string, number>, bars: Bar[]): Sig[] {
  const st: St = {}
  const sigs: Sig[] = []
  const orMinutes = Math.max(5, Math.round(params.orMinutes ?? 15))
  let curDay = ''
  let pos: 'buy' | 'sell' | null = null
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    const dk = etDateKey(bar.time)
    if (dk !== curDay) {
      curDay = dk
      // full day-reset — mirrors the engine + backtest (accumulators AND memory)
      st.vwapNum = 0
      st.vwapDen = 0
      st.orHigh = undefined
      st.orLow = undefined
      st.orDone = false
      st.firedLong = false
      st.firedShort = false
    }
    feed(strategy, orMinutes, bar, st, dk)
    const res = evalStrategy(strategy as never, params, bars.slice(0, i + 1) as never, st as never)
    if (res.exit && pos) pos = null
    if (res.entry && !pos) {
      // orb one-per-side memory is enforced INSIDE evalStrategy via st.fired*;
      // the engine marks fired AFTER the order is placed — mirror that
      sigs.push({ t: bar.time, side: res.entry.side })
      pos = res.entry.side
      if (strategy === 'orb15') {
        if (res.entry.side === 'buy') st.firedLong = true
        else st.firedShort = true
      }
    }
  }
  return sigs
}

const baseCfg = (strategy: string, params: Record<string, number>): BacktestConfig => ({
  strategy: strategy as never,
  params,
  qty: 1,
  sizingMode: 'fixed',
  riskMoney: null,
  isCrypto: true,
  tpMode: 'none',
  tpValue: null,
  slMode: 'none',
  slValue: null,
  maxTradesDay: 999999,
  rthOnly: false,
  flattenEod: false,
  cooldownMin: 0,
  requireNewSignal: false,
  capital: 10000,
})

// live-faithful re-pricing of a backtest trade list: entry fills at the SIGNAL
// bar's close (market seconds later), exits at the deciding bar's close.
// slippageBps: adverse half-turn applied to every fill. feeBps: per fill.
function reprice(
  bars: Bar[],
  trades: { entryTime: number; exitTime: number; side: string; qty: number; entryPx: number; exitPx: number }[],
  slippageBps: number,
  feeBps: number,
) {
  const byT = new Map<number, Bar>()
  for (const b of bars) byT.set(b.time, b)
  let cash = 0
  let slipSum = 0
  let feeSum = 0
  let n = 0
  for (const t of trades) {
    const sigBar = byT.get(t.entryTime - TF_SEC) // signal bar = one bar before the next-open fill
    if (!sigBar) continue
    const dir = t.side === 'long' ? 1 : -1
    const slip = slippageBps / 1e4
    const entryPx = dir === 1 ? sigBar.close * (1 + slip) : sigBar.close * (1 - slip)
    const exitPx = dir === 1 ? t.exitPx * (1 - slip) : t.exitPx * (1 + slip)
    const pnl = (exitPx - entryPx) * t.qty * dir
    const fee = ((entryPx + exitPx) * t.qty * feeBps) / 1e4
    cash += pnl - fee
    slipSum += Math.abs(entryPx - t.entryPx) * t.qty + Math.abs(t.exitPx - exitPx) * t.qty
    feeSum += fee
    n++
  }
  return { pnl: cash, slipSum, feeSum, n }
}

const STRATS: { id: string; params: Record<string, number> }[] = [
  { id: 'bb-reversion', params: {} },
  { id: 'rsi2-connors', params: {} },
  { id: 'vwap-fade', params: {} },
  { id: 'orb15', params: {} },
]

console.log(`== PARITY PROBE ${SYMBOL} ${TF} ${DAYS}d ==`)
const { bars } = await getBars(SYMBOL, TF, 'parity-probe')
let all = Array.isArray(bars) ? bars.slice() : []
const nowSec = Math.floor(Date.now() / 1000)
while (all.length > 0 && all[all.length - 1].time + TF_SEC > nowSec) all = all.slice(0, -1)
console.log(`bars: ${all.length}  (${new Date(all[0].time * 1000).toISOString()} → ${new Date(all[all.length - 1].time * 1000).toISOString()})`)

for (const s of STRATS) {
  const params = normalizeAlgoParams(s.id as never, s.params)
  const series = prepareSeries(all)
  const res = runBacktest(series, baseCfg(s.id, params))
  // backtest signal sequence: fill at next bar open → signal bar = entryTime - tf
  // (include the marked open-at-end trade — its entry signal is a real signal)
  const btSigs: Sig[] = res.trades
    .map((t) => ({ t: t.entryTime - TF_SEC, side: t.side === 'long' ? 'buy' : 'sell' }))
  const liveSigs = liveSim(s.id, params, all)
  const max = Math.max(btSigs.length, liveSigs.length)
  let diffs = 0
  for (let i = 0; i < max; i++) {
    const a = btSigs[i]
    const b = liveSigs[i]
    if (!a || !b || a.t !== b.t || a.side !== b.side) {
      diffs++
      if (diffs <= 5) console.log(`  DIFF #${i}: bt=${a ? `${a.t} ${a.side}` : '∅'} live=${b ? `${b.t} ${b.side}` : '∅'}`)
    }
  }
  console.log(`[${s.id}] bt signals=${btSigs.length} live signals=${liveSigs.length} diffs=${diffs} → ${diffs === 0 ? 'PARITY ✓' : 'MISMATCH ✗'}`)

  // ---- execution-model divergence on the same trades ----
  const trades = res.trades.filter((t) => t.exitReason !== 'open at end of data (marked)')
  if (trades.length > 0) {
    const btPnl = trades.reduce((a, t) => a + t.pnl, 0)
    const timing = reprice(all, trades, 0, 0) // live fill timing only
    const slip2 = reprice(all, trades, 2, 0) // + 2bps slippage per fill
    const slip2fee10 = reprice(all, trades, 2, 10) // + fees (10bps — live crypto-ish)
    const d = (x: number) => ((x - btPnl) / 10000 * 100).toFixed(2) // % of 10k capital
    console.log(`   trades=${trades.length} btPnl=$${btPnl.toFixed(2)} (${((btPnl / 10000) * 100).toFixed(2)}%)`)
    console.log(`   live-timing only : $${timing.pnl.toFixed(2)} (${d(timing.pnl)}% vs bt)  fill-drift $${timing.slipSum.toFixed(0)}`)
    console.log(`   +2bps slip       : $${slip2.pnl.toFixed(2)} (${d(slip2.pnl)}% vs bt)`)
    console.log(`   +2bps slip+10bps fee: $${slip2fee10.pnl.toFixed(2)} (${d(slip2fee10.pnl)}% vs bt)`)
  }
}
console.log('done')
