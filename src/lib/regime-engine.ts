// v2.10.0 — Market Regime Engine · US tape risk-on / risk-off.
//
// The autopilot was purely bottom-up: every symbol stood on its own backtest
// + news sentiment, and a -3% Nasdaq day would not stop it from buying. This
// engine adds the missing TOP-DOWN overlay the user asked for ("check the DOW
// or Nasdaq to see if risk on or risk off") using three liquid gauges read
// through the app's standard 1D bar path:
//
//   QQQ  — the Nasdaq-100 proxy: price vs its 50-DMA and whether that 50-DMA
//          is RISING or FALLING (5 sessions back). This is the spine.
//   SPY  — the S&P 500 proxy: confirms breadth beyond tech.
//   UVXY — the 2× vol ETN as the risk-off accelerant: when UVXY trades ABOVE
//          its own 20-DMA, volatility is being bid and new longs are the
//          wrong fight regardless of where the indexes sit.
//
//   RISK_OFF = vol is hot (UVXY > 20-DMA)
//              OR QQQ below a FALLING 50-DMA (trend broken AND rolling over)
//   RISK_ON  = QQQ above a rising 50-DMA AND SPY above its 50-DMA AND vol calm
//   NEUTRAL  = everything between (mixed tape)
//
// Consumers:
//   • agent-engine — journals the regime before sizing, scales the deployable
//     budget ×0.5 in RISK_OFF, and arms the per-entry regime gate on fleet runs.
//   • algo-engine — regimeEntryOk() blocks NEW LONGS (BUY signals) on non-crypto
//     runs while RISK_OFF; shorts/inverse setups stay live (risk-off is when
//     they earn their keep). Crypto runs are skipped — BTC rides its own 24/7
//     tape, not the Nasdaq's.
//   • /api/agent/regime — the Agent tab's regime chip.
//
// Honesty contract: daily bars come from the same getBars pipeline every
// backtest trusts. A demo feed, a truncated window, a too-short history or a
// stale one yields regime 'UNKNOWN' (or stale: true) — every consumer fails
// OPEN on that (gate passes, budget unscaled) so a bad read can never brick
// trading. The ONE exception: a keyless account gets demo simBars for stocks
// from getBars, so the regime falls back to the YAHOO CHART API first for
// those — the same keyless, real feed the trailing-proof and top-configs
// scripts use. Snapshots are cached per-user for 15 minutes (1D bars move
// slowly; the entry gate must stay cheap on a 15s cycle).
import { getBars, hasAlpacaKeys } from '@/lib/alpaca'
import { TIMEFRAMES, type Bar } from '@/lib/market-types'
import type { RegimeIndexDetail, RegimeSnapshot, RegimeState } from '@/lib/regime-types'

// 320 calendar days ≈ 220 RTH 1D bars — enough for SMA50 + the 5-session
// slope everywhere, and for the SMA200 deep-trend context line when the feed
// cooperates. (SMA200 is decorative context, never a gate input — a short
// window degrades it to null instead of failing the whole read.)
const LOOKBACK_DAYS = 320
// snapshot TTL — the entry gate calls this on every signal; 1D bars change
// once a day, so 15 minutes is effectively live at zero feed cost
const SNAPSHOT_TTL_MS = 15 * 60 * 1000
// newest closed bar older than this → the feed is broken/holiday-stuck and
// the snapshot is untrustworthy (consumers fail open)
const BAR_STALE_MS = 7 * 24 * 60 * 60 * 1000
// minimum closed bars for the spine rules (SMA50 + slope needs ~55)
const MIN_BARS = 60

const DAY_SEC = TIMEFRAMES['1D'].seconds

const cache = new Map<string, { at: number; snap: RegimeSnapshot }>()

function sma(closes: number[], n: number, endOffset = 0): number | null {
  const end = closes.length - endOffset
  if (n <= 0 || end < n) return null
  let sum = 0
  for (let i = end - n; i < end; i++) sum += closes[i]
  return sum / n
}

function pctFrom(last: number | null, ma: number | null): number | null {
  if (last == null || ma == null || !(ma > 0)) return null
  return Math.round(((last - ma) / ma) * 10000) / 100
}

function fmtPct(p: number | null): string {
  return p == null ? '—' : `${p >= 0 ? '+' : ''}${p}%`
}

/**
 * Keyless REAL daily bars from the Yahoo chart API — the same public feed the
 * scripts/trailing-proof + algo-top-configs probes use from this box. The
 * rescue path for accounts WITHOUT Alpaca keys (getBars would serve demo
 * simBars for stocks, and the regime refuses to guess on fake data). Returns
 * null on any failure — callers then fail honestly to UNKNOWN.
 */
async function yahooDaily(symbol: string): Promise<Bar[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; blackhole-terminal)' },
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      })
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      if (!res.ok) return null
      const j = (await res.json()) as {
        chart?: { result?: Array<{ timestamp?: number[]; indicators?: { adjclose?: Array<{ adjclose?: (number | null)[] }>; quote?: Array<{ close?: (number | null)[] }> } }> }
      }
      const r0 = j.chart?.result?.[0]
      const ts = r0?.timestamp
      const closes = r0?.indicators?.adjclose?.[0]?.adjclose ?? r0?.indicators?.quote?.[0]?.close
      if (!Array.isArray(ts) || !Array.isArray(closes) || ts.length !== closes.length) return null
      const bars: Bar[] = []
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i]
        if (c == null || !Number.isFinite(c) || c <= 0) continue // null holiday rows
        bars.push({ time: ts[i], open: c, high: c, low: c, close: c, volume: 0 })
      }
      return bars.length > 0 ? bars : null
    } catch {
      if (attempt === 1) return null
    }
  }
  return null
}

interface Gauge {
  detail: RegimeIndexDetail
  closes: number[]
  sma: number | null
  lastBarTime: number // unix seconds of the newest CLOSED bar used
}

/** Fetch + validate one gauge. `{ fail }` = untrustworthy data (honest fail). */
async function readGauge(symbol: string, userId: string | undefined, smaLabel: string, smaLen: number): Promise<Gauge | { fail: string }> {
  let bars: Bar[] = []
  let fail: string | null = null
  // Keyless accounts: skip straight to the keyless REAL feed — getBars would
  // return demo simBars for stocks, which the regime refuses to judge on.
  const keys = await hasAlpacaKeys(userId).catch(() => false)
  if (!keys) {
    const y = await yahooDaily(symbol)
    if (!y) return { fail: `${symbol} unavailable (no broker keys and the keyless feed failed)` }
    bars = y
  } else {
    const res = await getBars(symbol, '1D', userId, { lookbackDays: LOOKBACK_DAYS }).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    }))
    if ('error' in res) {
      fail = `${symbol} bars unavailable (${res.error})`
    } else if (res.demo) {
      fail = `${symbol} served the demo feed — the regime refuses to guess on fake data`
    } else if (res.truncated) {
      fail = `${symbol} window came back truncated — the regime refuses a partial history`
    } else {
      bars = Array.isArray(res.bars) ? [...res.bars] : []
    }
  }
  if (fail) return { fail }
  // drop the FORMING bar — the regime judges closed sessions only, exactly
  // like every live engine decision bar
  const nowSec = Math.floor(Date.now() / 1000)
  while (bars.length > 0 && bars[bars.length - 1].time + DAY_SEC > nowSec) bars = bars.slice(0, -1)
  if (bars.length < MIN_BARS) return { fail: `${symbol} history too short (${bars.length} closed bars < ${MIN_BARS})` }
  const closes = bars.map((b) => b.close)
  const last = closes[closes.length - 1]
  const ma = sma(closes, smaLen)
  const detail: RegimeIndexDetail = {
    symbol,
    last: Math.round(last * 100) / 100,
    sma: ma != null ? Math.round(ma * 100) / 100 : null,
    smaLabel,
    pctFromSma: pctFrom(last, ma),
    above: ma != null ? last > ma : null,
  }
  return { detail, closes, sma: ma, lastBarTime: bars[bars.length - 1].time }
}

/**
 * Compute the current US-tape regime. `userId` selects the bar source (the
 * user's own broker keys when present); `force` bypasses the 15-min cache.
 * NEVER throws — every failure path degrades to an honest UNKNOWN snapshot.
 */
export async function getRegimeSnapshot(userId?: string, force = false): Promise<RegimeSnapshot> {
  const key = userId ?? 'anon'
  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.snap
  }
  const snap = await computeSnapshot(userId)
  cache.set(key, { at: Date.now(), snap })
  return snap
}

async function computeSnapshot(userId?: string): Promise<RegimeSnapshot> {
  const asOf = new Date().toISOString()
  // QQQ is the spine — without it there is no regime, full stop
  const qqqRes = await readGauge('QQQ', userId, '50-DMA', 50)
  if ('fail' in qqqRes) {
    return {
      regime: 'UNKNOWN', asOf, barsAsOf: null, stale: false,
      reasons: [qqqRes.fail], tape: null,
      error: 'regime spine (QQQ) unreadable',
    }
  }
  const [spyRes, uvxyRes] = await Promise.all([
    readGauge('SPY', userId, '50-DMA', 50),
    readGauge('UVXY', userId, '20-DMA', 20),
  ])
  const spy = 'fail' in spyRes ? null : spyRes
  const uvxy = 'fail' in uvxyRes ? null : uvxyRes

  const qqqCloses = qqqRes.closes
  const qqqSma = qqqRes.sma
  // the 50-DMA five sessions back — the slope that separates "dip in an
  // uptrend" (buyable) from "trend rolling over" (risk-off)
  const qqqSmaPrev = sma(qqqCloses, 50, 5)
  const trendAbove = qqqSma != null ? (qqqRes.detail.last ?? 0) > qqqSma : false
  const trendRising = qqqSma != null && qqqSmaPrev != null ? qqqSma >= qqqSmaPrev : false
  const spyAbove = spy?.detail.above ?? null
  const volHot = uvxy?.detail.above ?? null

  const reasons: string[] = []
  // deep-trend context first when we have the bars for it
  const qqqSma200 = qqqCloses.length >= 200 ? sma(qqqCloses, 200) : null
  if (qqqSma200 != null) {
    const p = pctFrom(qqqRes.detail.last, qqqSma200)
    reasons.push(`QQQ ${fmtPct(p)} vs its 200-DMA — deep trend ${p != null && p >= 0 ? 'intact' : 'broken'}`)
  }
  reasons.push(`QQQ ${qqqRes.detail.last} is ${fmtPct(qqqRes.detail.pctFromSma)} vs its 50-DMA, which is ${trendRising ? 'rising' : 'falling'}`)
  if (spy) {
    reasons.push(`SPY ${spy.detail.last} is ${fmtPct(spy.detail.pctFromSma)} vs its 50-DMA`)
  } else {
    reasons.push(`SPY gauge unavailable — breadth confirmation skipped (${('fail' in spyRes && spyRes.fail) || 'read error'})`)
  }
  if (uvxy) {
    reasons.push(`UVXY ${uvxy.detail.last} is ${fmtPct(uvxy.detail.pctFromSma)} vs its 20-DMA — vol ${volHot ? 'being BID' : 'contained'}`)
  } else {
    reasons.push(`UVXY gauge unavailable — vol confirmation skipped (${('fail' in uvxyRes && uvxyRes.fail) || 'read error'})`)
  }

  // ---- the regime verdict ----
  let regime: RegimeState
  if (volHot === true) {
    regime = 'RISK_OFF'
    reasons.push('RISK OFF — volatility is being bid (UVXY above its 20-DMA); new longs are the wrong fight')
  } else if (!trendAbove && !trendRising) {
    regime = 'RISK_OFF'
    reasons.push('RISK OFF — QQQ below its 50-DMA AND the 50-DMA is falling: trend broken and rolling over')
  } else if (trendAbove && trendRising && spyAbove !== false && volHot === false) {
    regime = 'RISK_ON'
    reasons.push('RISK ON — QQQ above a rising 50-DMA, SPY above its 50-DMA, vol contained')
  } else {
    regime = 'NEUTRAL'
    reasons.push('NEUTRAL — mixed tape: the regime gate stands down, the sentiment gate still guards entries')
  }

  // staleness — a feed stuck a week in the past would otherwise whisper last
  // month's regime into this week's entries; the spine's newest closed bar
  // decides (SPY/UVXY ride the same feed and calendar)
  const barsAsOfMs = qqqRes.lastBarTime * 1000
  const stale = Date.now() - barsAsOfMs > BAR_STALE_MS
  if (stale) {
    reasons.push(`Bars are stale (newest closed session ${new Date(barsAsOfMs).toISOString().slice(0, 10)}) — snapshot untrustworthy, gates fail open`)
  }

  return {
    regime,
    asOf,
    barsAsOf: new Date(barsAsOfMs).toISOString().slice(0, 10),
    stale,
    reasons,
    tape: {
      spy: spy?.detail ?? emptyDetail('SPY', '50-DMA'),
      qqq: qqqRes.detail,
      uvxy: uvxy?.detail ?? emptyDetail('UVXY', '20-DMA'),
    },
    error: null,
  }
}

function emptyDetail(symbol: string, smaLabel: string): RegimeIndexDetail {
  return { symbol, last: null, sma: null, smaLabel, pctFromSma: null, above: null }
}
