// Task 89 research sweep (Task 3-d honesty pass) — run the full strategy
// catalog (defaults + auto optimizer grid) across a symbol × timeframe matrix
// at MAX history per TF (ALGO_MAX_DAYS), with per-market execution costs.
// Results JSON v2: { version: 2, rows: [...] } — each row = one combo with
// 70/30 IS/OOS walk-forward verification (`oos`), grid-boundary flags, the
// leverage-honest maxNotionalX=1 sizing and the crypto long-only skip count.
// Version mismatch (or the legacy bare-array format) recomputes ALL combos.
// The matrix cfg / row shaping / constants are imported from src/lib/algo-reco.ts
// so the lib and this script can never drift. Output feeds gen-reco.ts.
// Usage: bun scripts-tmp/reco-sweep.ts   · subset: RECO_ONLY="BTC/USD|5m" bun scripts-tmp/reco-sweep.ts
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { getBars } from '@/lib/alpaca'
import { TIMEFRAMES } from '@/lib/market-types'
import { prepareSeries, sweepStrategies } from '@/lib/backtest'
import { ALGO_MAX_DAYS, ALGO_TIMEFRAMES, type AlgoTimeframe } from '@/lib/algo-strategies'
import {
  RECO_SYMBOLS, RECO_MIN_TRADES, RECO_TOPX, RECO_POOL_TAKE, RECO_OOS_FRACTION,
  buildRecoBacktestCfg, sweepTopRows,
  type RecoComboRow,
} from '@/lib/algo-reco'
import { db } from '@/lib/db'

const MAX_BARS = 120_000 // same hard cap the API route enforces
const RESULTS = 'scripts-tmp/reco-sweep-results.json'

interface ResultEntry {
  symbol: string
  tf: string
  bars: number
  from: number
  to: number
  coveredDays: number
  source: string
  costs: { slip: number; fee: number; spread: number }
  sweepMs: number
  totalMs: number
  oosFraction: number
  skippedShorts: number
  rows: RecoComboRow[]
  perStrategy: { s: string; scorable: number; best: number | null }[]
  error?: string
}

function emptyEntry(symbol: string, tf: string): Omit<ResultEntry, 'error'> {
  return {
    symbol,
    tf,
    bars: 0,
    from: 0,
    to: 0,
    coveredDays: 0,
    source: '',
    costs: { slip: 0, fee: 0, spread: 0 },
    sweepMs: 0,
    totalMs: 0,
    oosFraction: RECO_OOS_FRACTION,
    skippedShorts: 0,
    rows: [],
    perStrategy: [],
  }
}

async function main() {
  const user = await db.user.findUnique({ where: { username: 'trader' } })
  if (!user) throw new Error('trader user not found')
  // resumable (v2) — combos already recorded WITH rows are skipped (the run
  // can get killed mid-matrix; rerunning picks up where it left off). Anything
  // that is not { version: 2, rows: [...] } — including the legacy bare-array
  // format from Task 89 — recomputes ALL combos.
  let prior: ResultEntry[] = []
  if (existsSync(RESULTS)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(RESULTS, 'utf8'))
      const obj = parsed as { version?: unknown; rows?: unknown } | null
      if (obj && typeof obj === 'object' && !Array.isArray(parsed) && obj.version === 2 && Array.isArray(obj.rows)) {
        prior = obj.rows as ResultEntry[]
      } else {
        console.log('results file is not v2 (legacy format or wrong version) — recomputing ALL combos')
      }
    } catch {
      console.log('results file unreadable — recomputing ALL combos')
    }
  }
  // error entries are not kept: a failed combo is retried on the next run
  const out: ResultEntry[] = prior.filter((o) => o && !o.error && Array.isArray(o.rows))
  const done = new Set(out.map((o) => `${o.symbol}|${o.tf}`))
  const persist = () => writeFileSync(RESULTS, JSON.stringify({ version: 2, rows: out }, null, 1))
  for (const tf of ALGO_TIMEFRAMES as readonly AlgoTimeframe[]) {
    for (const symbol of RECO_SYMBOLS) {
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
          out.push({ ...emptyEntry(symbol, tf), error: res.demo ? 'no live historical data (demo feed)' : `insufficient history (${bars.length} bars)` })
          console.log(`SKIP ${symbol} ${tf}`)
          persist()
          continue
        }
        // drop the forming bar + hard cap (exact route semantics)
        const tfSec = TIMEFRAMES[tf].seconds
        const nowSec = Math.floor(Date.now() / 1000)
        while (bars.length > 0 && bars[bars.length - 1].time + tfSec > nowSec) bars = bars.slice(0, -1)
        if (bars.length > MAX_BARS) bars = bars.slice(bars.length - MAX_BARS)
        // shared matrix cfg — maxNotionalX 1 + per-market costs (see algo-reco.ts)
        const cfg = buildRecoBacktestCfg(symbol)
        const series = prepareSeries(bars)
        // Task 3-d — 70/30 IS/OOS walk-forward
        const sweep = sweepStrategies(series, cfg, {
          minTrades: RECO_MIN_TRADES,
          topX: RECO_TOPX,
          oosFraction: RECO_OOS_FRACTION,
        })
        const rows = sweepTopRows(sweep, RECO_POOL_TAKE, cfg.isCrypto)
        const entry: ResultEntry = {
          symbol,
          tf,
          bars: series.n,
          from: bars[0].time,
          to: bars[bars.length - 1].time,
          coveredDays: Math.max(1, Math.round((nowSec - bars[0].time) / 86400)),
          source: res.source ?? 'alpaca',
          costs: cfg.slippageBps != null && cfg.feeBps != null && cfg.spreadBps != null
            ? { slip: cfg.slippageBps, fee: cfg.feeBps, spread: cfg.spreadBps }
            : { slip: 0, fee: 0, spread: 0 },
          sweepMs: sweep.elapsedMs,
          totalMs: Date.now() - t0,
          oosFraction: sweep.oosFraction ?? RECO_OOS_FRACTION,
          skippedShorts: sweep.skippedShorts ?? 0,
          rows,
          perStrategy: sweep.perStrategy.map((p) => ({ s: p.strategy, scorable: p.scorable, best: p.bestScore })),
        }
        const idx = out.findIndex((o) => o.symbol === symbol && o.tf === tf)
        if (idx >= 0) out.splice(idx, 1)
        out.push(entry)
        const top = rows[0]
        const oosTxt = top ? (top.oos ? `oos ${top.oos.netPct >= 0 ? '+' : ''}${top.oos.netPct}%/${top.oos.trades}t` : 'oos null') : ''
        const bnd = top?.boundary ? ' BOUNDARY' : ''
        console.log(`done ${symbol} ${tf}: ${series.n} bars · top=${top ? `${top.strategy} score ${top.score.toFixed(2)} net ${top.netPct.toFixed(1)}% ${oosTxt}${bnd} · skipShort ${entry.skippedShorts}` : '—'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        out.push({ ...emptyEntry(symbol, tf), error: msg })
        console.log(`ERR ${symbol} ${tf}: ${msg}`)
      }
      persist()
    }
  }
  console.log(`ALL DONE ${out.length} combos`)
}

await main()
