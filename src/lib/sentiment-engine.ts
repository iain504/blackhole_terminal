// v2.5.0 — Market Sentiment Engine · orchestration.
//
// scan pipeline (per symbol, small concurrency pool):
//   ingest RSS headlines → score unscored rows (LLM, lexicon fallback) →
//   aggregate an hourly SentimentScore bucket (recency×confidence weighted,
//   momentum vs the previous bucket)
//
// read paths used by the rest of the app:
//   sentimentForSymbol()  — latest snapshot (algo engine sentiment gate)
//   getSentimentSummary() — leaderboard for the Chart sidebar / autopilot
//   getSentimentHistory() — sparkline series
//   computeSentimentIc()  — sentiment vs forward 1-day returns: cross-sectional
//                           IC (Pearson) + Rank-IC (Spearman) + per-symbol rows
import { db } from '@/lib/db'
import { getBars } from '@/lib/alpaca'
import { agentUniverse } from '@/lib/agent-universe'
import { isCryptoSymbol } from '@/lib/market-types'
import { ingestSymbolNews } from './sentiment-news'
import { scoreHeadlines } from './sentiment-score'
import type {
  SentimentHeadlineDto,
  SentimentIcResult,
  SentimentScanState,
  SentimentSymbolSummary,
} from './sentiment-types'

// recency half-life (hours) — a 18h-old headline carries half the weight of a
// fresh one; fits the 1-5 day horizon the gates and ranking care about
const HALF_LIFE_H = 18
// a snapshot older than this is "stale" — gates pass through, UI flags it
export const STALE_MS = 12 * 60 * 60 * 1000
// aggregation window: only headlines published within this horizon feed the bucket
const AGG_WINDOW_H = 72

// ---------------------------------------------------------------------------
// Scan job (single-flight, in-process)
// ---------------------------------------------------------------------------

const scanState: SentimentScanState = {
  running: false, done: 0, total: 0, current: null,
  headlines: 0, scored: 0, startedAt: null, finishedAt: null, error: null,
}

export function getScanState(): SentimentScanState {
  return { ...scanState }
}

/** Default universe = the autopilot's (AGENT_US_100 + crypto majors). */
export function sentimentUniverse(): { symbol: string; isCrypto: boolean }[] {
  return agentUniverse(true)
}

/** Kick off a background scan. `symbols` filters/limits the universe; a small
 *  list (≤3, e.g. the Chart sidebar's per-symbol rescan) runs inline so the
 *  caller gets fresh data on the same request. Returns false when busy. */
export async function startSentimentScan(
  symbols?: string[],
): Promise<{ started: boolean; inline: boolean; state: SentimentScanState }> {
  const list = resolveUniverse(symbols)
  if (list.length === 0) {
    return { started: false, inline: false, state: getScanState() }
  }
  if (list.length <= 3) {
    // inline path — small enough to hold the request
    try {
      await runScan(list)
    } catch { /* state carries the error */ }
    return { started: true, inline: true, state: getScanState() }
  }
  if (scanState.running) {
    return { started: false, inline: false, state: getScanState() }
  }
  // background path — the UI polls /api/sentiment/state
  void runScan(list).catch(() => { /* state carries the error */ })
  return { started: true, inline: false, state: getScanState() }
}

function resolveUniverse(symbols?: string[]): { symbol: string; isCrypto: boolean }[] {
  if (!symbols || symbols.length === 0) return sentimentUniverse()
  const wanted = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
  return wanted.map((s) => ({ symbol: s, isCrypto: isCryptoSymbol(s) }))
}

async function runScan(list: { symbol: string; isCrypto: boolean }[]): Promise<void> {
  scanState.running = true
  scanState.done = 0
  scanState.total = list.length
  scanState.headlines = 0
  scanState.scored = 0
  scanState.current = null
  scanState.startedAt = new Date().toISOString()
  scanState.finishedAt = null
  scanState.error = null
  try {
    const CONC = 6
    let cursor = 0
    const worker = async () => {
      while (cursor < list.length) {
        const item = list[cursor++]
        if (!item) return
        scanState.current = item.symbol
        try {
          const n = await processSymbol(item.symbol, item.isCrypto)
          scanState.headlines += n.fetched
          scanState.scored += n.scored
        } catch {
          // single-symbol failure must not kill the sweep
        }
        scanState.done++
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker))
    scanState.finishedAt = new Date().toISOString()
  } catch (e) {
    scanState.error = e instanceof Error ? e.message : 'scan failed'
    scanState.finishedAt = new Date().toISOString()
  } finally {
    scanState.running = false
    scanState.current = null
  }
}

/** One symbol: ingest → score pending → upsert the hourly bucket. */
async function processSymbol(symbol: string, isCryptoOverride?: boolean): Promise<{ fetched: number; scored: number }> {
  const isCrypto = isCryptoOverride ?? isCryptoSymbol(symbol)
  const ingest = await ingestSymbolNews(symbol, isCrypto)

  // score PENDING rows (score == null), oldest first, cap per sweep
  const pending = await db.sentimentHeadline.findMany({
    where: { symbol, score: null },
    orderBy: { fetchedAt: 'desc' },
    take: 40,
  })
  if (pending.length > 0) {
    const results = await scoreHeadlines(pending.map((h) => h.title))
    for (let i = 0; i < pending.length; i++) {
      const r = results[i]
      if (!r) continue
      try {
        await db.sentimentHeadline.update({
          where: { id: pending[i].id },
          data: { label: r.label, score: r.score, confidence: r.confidence, engine: r.engine },
        })
      } catch { /* row deleted mid-scan — fine */ }
    }
  }

  await upsertBucket(symbol)
  return { fetched: ingest.fetched, scored: pending.length }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function hourBucket(d: Date): string {
  return `${d.toISOString().slice(0, 13)}:00`
}

/** Recompute the CURRENT hour's snapshot for a symbol from its scored
 *  headlines (published within the aggregation window). */
async function upsertBucket(symbol: string): Promise<void> {
  const since = new Date(Date.now() - AGG_WINDOW_H * 3600 * 1000)
  const rows = await db.sentimentHeadline.findMany({
    where: { symbol, score: { not: null }, publishedAt: { gte: since } },
    select: { score: true, confidence: true, publishedAt: true, engine: true },
  })
  const now = Date.now()
  let wSum = 0
  let sSum = 0
  let bull = 0
  let bear = 0
  let neutral = 0
  const engineCount = new Map<string, number>()
  for (const r of rows) {
    const score = r.score ?? 0
    if (score > 0.15) bull++
    else if (score < -0.15) bear++
    else neutral++
    if (r.engine) engineCount.set(r.engine, (engineCount.get(r.engine) ?? 0) + 1)
    const ageH = Math.max(0, (now - (r.publishedAt?.getTime() ?? now)) / 3600_000)
    const w = Math.pow(0.5, ageH / HALF_LIFE_H) * (0.5 + 0.5 * (r.confidence ?? 0.6))
    wSum += w
    sSum += w * score
  }
  const score = wSum > 0 ? sSum / wSum : 0
  const asOf = new Date(Math.floor(now / 3600_000) * 3600_000)
  const bucket = hourBucket(asOf)
  // dominant engine across the aggregated headlines
  let engine = 'llm-finance-v1'
  let best = -1
  for (const [e, n] of engineCount) if (n > best) { best = n; engine = e }

  const prev = await db.sentimentScore.findFirst({
    where: { symbol, asOf: { lt: asOf } },
    orderBy: { asOf: 'desc' },
    select: { score: true },
  })

  await db.sentimentScore.upsert({
    where: { symbol_bucket: { symbol, bucket } },
    create: {
      symbol, bucket, asOf, score, bull, bear, neutral,
      headlines: rows.length, momentum: prev ? score - prev.score : null,
      engine,
    },
    update: { score, bull, bear, neutral, headlines: rows.length, asOf },
  })
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/** Latest snapshot for one symbol — the algo engine's sentiment gate and the
 *  autopilot both read through here. Null when never scanned. */
export async function sentimentForSymbol(symbol: string): Promise<SentimentSymbolSummary | null> {
  const row = await db.sentimentScore.findFirst({
    where: { symbol },
    orderBy: { asOf: 'desc' },
  })
  if (!row) return null
  return {
    symbol,
    score: row.score,
    momentum: row.momentum,
    bull: row.bull,
    bear: row.bear,
    neutral: row.neutral,
    headlines: row.headlines,
    engine: row.engine,
    asOf: row.asOf.toISOString(),
    stale: Date.now() - row.asOf.getTime() > STALE_MS,
  }
}

/** Latest snapshot per symbol, strongest first. Defaults to every symbol the
 *  journal has seen in the last 7 days. */
export async function getSentimentSummary(symbols?: string[]): Promise<SentimentSymbolSummary[]> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  const rows = await db.sentimentScore.findMany({
    where: symbols && symbols.length > 0
      ? { symbol: { in: symbols.map((s) => s.toUpperCase()) }, asOf: { gte: since } }
      : { asOf: { gte: since } },
    orderBy: { asOf: 'desc' },
  })
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!latest.has(r.symbol)) latest.set(r.symbol, r)
  const out: SentimentSymbolSummary[] = []
  for (const [symbol, r] of latest) {
    out.push({
      symbol,
      score: r.score,
      momentum: r.momentum,
      bull: r.bull,
      bear: r.bear,
      neutral: r.neutral,
      headlines: r.headlines,
      engine: r.engine,
      asOf: r.asOf.toISOString(),
      stale: Date.now() - r.asOf.getTime() > STALE_MS,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

export async function getSentimentHistory(symbol: string, hours: number): Promise<{ bucket: string; score: number; headlines: number }[]> {
  const since = new Date(Date.now() - Math.min(Math.max(hours, 6), 24 * 30) * 3600 * 1000)
  const rows = await db.sentimentScore.findMany({
    where: { symbol: symbol.toUpperCase(), asOf: { gte: since } },
    orderBy: { asOf: 'asc' },
    select: { bucket: true, score: true, headlines: true },
  })
  return rows.map((r) => ({ bucket: r.bucket, score: r.score, headlines: r.headlines }))
}

export async function getHeadlines(symbol: string | null, limit: number): Promise<SentimentHeadlineDto[]> {
  const rows = await db.sentimentHeadline.findMany({
    where: symbol ? { symbol: symbol.toUpperCase() } : {},
    orderBy: [{ publishedAt: 'desc' }, { fetchedAt: 'desc' }],
    take: Math.min(Math.max(limit, 1), 100),
  })
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, source: r.source, publisher: r.publisher,
    title: r.title, url: r.url, publishedAt: r.publishedAt?.toISOString() ?? null,
    label: (r.label as SentimentHeadlineDto['label']) ?? null,
    score: r.score, confidence: r.confidence, engine: r.engine,
  }))
}

// ---------------------------------------------------------------------------
// Evaluation — sentiment vs forward returns (IC / Rank-IC)
// ---------------------------------------------------------------------------

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 3 || n !== ys.length) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 3 || n !== ys.length) return null
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
    const r = new Array<number>(arr.length).fill(0)
    for (let k = 0; k < idx.length; k++) r[idx[k].i] = k + 1
    return r
  }
  return pearson(rank(xs), rank(ys))
}

/**
 * Information-coefficient evaluation, mirroring the reference dashboard:
 *   • per-symbol   — daily sentiment (last bucket of each UTC day) vs the
 *                    NEXT day's return, Pearson + Spearman over the window
 *   • cross-sectional — the classic IC: for every day with ≥5 symbols,
 *                    corr(day-D sentiment, D→D+1 returns) across symbols,
 *                    averaged over days (Pearson = IC, Spearman = Rank-IC)
 * Price history rides the app's own getBars (Alpaca/Binance/demo fallback).
 */
export async function computeSentimentIc(userId: string | undefined, windowDays = 30): Promise<SentimentIcResult> {
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000)
  const scores = await db.sentimentScore.findMany({
    where: { asOf: { gte: since } },
    orderBy: { asOf: 'asc' },
    select: { symbol: true, asOf: true, score: true },
  })
  // daily signal = last bucket of each UTC day per symbol
  const bySymbolDay = new Map<string, Map<string, number>>()
  for (const s of scores) {
    const day = s.asOf.toISOString().slice(0, 10)
    let m = bySymbolDay.get(s.symbol)
    if (!m) { m = new Map(); bySymbolDay.set(s.symbol, m) }
    m.set(day, s.score) // ordered asc → last write wins = last bucket of day
  }

  const universe = [...bySymbolDay.keys()]
  const rows: SentimentIcResult['rows'] = []
  // cross-section accumulator: day → [{sent, fwd}]
  const dayPairs = new Map<string, { sent: number; fwd: number }[]>()

  for (const symbol of universe) {
    const dayMap = bySymbolDay.get(symbol)!
    let bars: { time: number; close: number }[] = []
    try {
      const res = await getBars(symbol, '1D', userId, { lookbackDays: windowDays + 14 })
      bars = res.bars.map((b) => ({ time: b.time, close: b.close }))
    } catch { /* no price history — symbol drops out of the eval */ }
    if (bars.length < 5) continue

    // close-of-day map (bars are ASC by time; time = bar open, day of open
    // works for both equities and 24/7 crypto at daily cadence)
    const closeByDay = new Map<string, number>()
    for (const b of bars) closeByDay.set(new Date(b.time * 1000).toISOString().slice(0, 10), b.close)

    const sent: number[] = []
    const fwd: number[] = []
    for (const [day, s] of dayMap) {
      const d0 = closeByDay.get(day)
      // forward return: the NEXT day that has a close (skip weekends/holidays)
      let d1: number | null = null
      let day1: string | null = null
      const dt = new Date(`${day}T00:00:00Z`).getTime()
      for (let k = 1; k <= 4; k++) {
        const cand = new Date(dt + k * 86400_000).toISOString().slice(0, 10)
        const c = closeByDay.get(cand)
        if (c != null) { d1 = c; day1 = cand; break }
      }
      if (d0 == null || d1 == null || day1 == null) continue
      const ret = (d1 - d0) / d0
      if (!Number.isFinite(ret)) continue
      sent.push(s)
      fwd.push(ret)
      let arr = dayPairs.get(day)
      if (!arr) { arr = []; dayPairs.set(day, arr) }
      arr.push({ sent: s, fwd: ret })
    }
    rows.push({
      symbol,
      score: [...dayMap.values()].at(-1) ?? 0,
      fwd1dPct: fwd.length > 0 ? fwd[fwd.length - 1] * 100 : null,
      pairs: sent.length,
      corr: pearson(sent, fwd.map((r) => r * 100)),
      rankCorr: spearman(sent, fwd.map((r) => r * 100)),
    })
  }

  // cross-sectional IC: mean over days of corr_across_symbols(sent, fwd)
  const ics: number[] = []
  const rics: number[] = []
  for (const [, arr] of dayPairs) {
    if (arr.length < 5) continue // need a real cross-section
    const ic = pearson(arr.map((p) => p.sent), arr.map((p) => p.fwd))
    const ric = spearman(arr.map((p) => p.sent), arr.map((p) => p.fwd))
    if (ic != null) ics.push(ic)
    if (ric != null) rics.push(ric)
  }
  const mean = (a: number[]) => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : null)

  return {
    ic: mean(ics),
    rankIc: mean(rics),
    symbols: rows.length,
    pairs: rows.reduce((a, r) => a + r.pairs, 0),
    windowDays,
    note:
      rows.length < 5
        ? 'Journal too young for a meaningful cross-section — keep scanning; IC populates as daily snapshots accumulate.'
        : `Cross-sectional IC averaged over ${ics.length} day(s) with ≥5 symbols. |IC| > 0.05 is worth watching; |IC| > 0.10 is strong.`,
    rows: rows.sort((a, b) => b.score - a.score),
  }
}
