// Kronos sidecar client (server-side only) — v2.0.0.
//
// Kronos (shiyu-coder/Kronos, AAAI 2026) is an open-source foundation model
// for financial candlesticks: a tokenizer quantizes OHLCV bars into discrete
// tokens and a decoder-only transformer autoregressively predicts the next
// bars. We run it as a LOCAL Python sidecar (mini-services/kronos-service,
// 127.0.0.1:3030) because it is PyTorch; this module is the terminal's thin
// client over that sidecar.
//
// Design notes:
//  - forecasts take ~8-50s on this CPU → the sidecar is JOB-BASED (submit →
//    poll). Bun clients reset long-held connections (~70s observed), so
//    EVERYTHING (browser chart, algo engine gate, A/B jobs) goes through
//    submit/poll — no long-held requests anywhere.
//  - two lanes: 'mini' (4.1M params, fast, default for interactive) and
//    'small' (24.7M params, quality). The sidecar falls back to small if
//    mini isn't loaded.
//  - honesty: we never fabricate a forecast when the sidecar is down — the
//    caller gets { available: false } and the UI shows an honest state.
//  - every user-visible forecast is journaled (KronosForecast) and later
//    RESOLVED against the bar that actually printed at horizon end, feeding
//    the model's running hit-rate. Predictions with a scoreboard.
import { db } from '@/lib/db'
import { isCryptoSymbol } from '@/lib/market-types'
import type { KronosBar, KronosForecastResult, KronosHealth } from '@/lib/kronos-types'

export type { KronosBar, KronosForecastResult, KronosHealth, KronosHitRate, KronosJournalRow, KronosStatus } from '@/lib/kronos-types'

const KRONOS_URL = process.env.KRONOS_URL || 'http://127.0.0.1:3030'

const POLL_INTERVAL_MS = 1200
const WAIT_DEADLINE_MS = 180_000

async function jfetch<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${KRONOS_URL}${path}`, { ...init, signal: ctl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`kronos ${path} -> HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function kronosHealth(): Promise<KronosHealth | null> {
  try {
    return await jfetch<KronosHealth>('/health')
  } catch {
    return null
  }
}

export async function kronosSubmitForecast(payload: {
  bars: KronosBar[]
  horizon: number
  samples?: number
  market: 'stock' | 'crypto'
  tfSec: number
  model?: 'mini' | 'small'
  context?: number
  temperature?: number
  topP?: number
}): Promise<string | null> {
  try {
    const r = await jfetch<{ ok: boolean; jobId?: string; error?: string }>('/forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, 15_000)
    return r.jobId ?? null
  } catch {
    return null
  }
}

export async function kronosPollJob(jobId: string): Promise<{ done: boolean; result: KronosForecastResult | null; error?: string }> {
  try {
    const r = await jfetch<{ ok: boolean; done: boolean; result?: KronosForecastResult | null; error?: string }>(
      `/forecast?job=${encodeURIComponent(jobId)}`,
    )
    if (!r.done) return { done: false, result: null }
    if (r.result && !r.result.ok) return { done: true, result: null, error: r.result.error as string | undefined }
    return { done: true, result: r.result ?? null, error: r.result ? undefined : 'empty result' }
  } catch (e) {
    // transient poll failure — report not-done unless it keeps failing (caller deadline handles it)
    if (e instanceof Error && e.message.includes('HTTP 404')) return { done: true, result: null, error: 'forecast job lost (sidecar restarted?)' }
    return { done: false, result: null }
  }
}

/** Submit + wait (server-side callers: algo engine gate, A/B jobs). */
export async function kronosForecastWait(
  payload: Parameters<typeof kronosSubmitForecast>[0],
  deadlineMs = WAIT_DEADLINE_MS,
): Promise<KronosForecastResult | null> {
  const jobId = await kronosSubmitForecast(payload)
  if (!jobId) return null
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    const st = await kronosPollJob(jobId)
    if (st.done) return st.result
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return null
}

// ---------------------------------------------------------------------------
// Live gate cache — the algo engine evaluates entries every cycle; a forecast
// costs ~8s of CPU, so the gate reuses ONE forecast per (symbol, tf, bar).
// Keyed by the LAST context bar time: a new bar ⇒ a fresh forecast, everything
// else is a cache hit. Entries are gated on the model's horizon-end P(up).
// ---------------------------------------------------------------------------
interface GateEntry {
  jobId: string
  startedAt: number
  barTime: number
  result?: KronosForecastResult | null
  failed?: boolean
}
const gateCache = new Map<string, GateEntry>()
const GATE_TTL_MS = 10 * 60_000

function gcGate(): void {
  const now = Date.now()
  for (const [k, v] of gateCache) if (now - v.startedAt > GATE_TTL_MS) gateCache.delete(k)
}

export interface KronosGateVerdict {
  available: boolean
  pending?: boolean
  upProb?: number
  /** allow long / short entries under the gate thresholds */
  allowLong?: boolean
  allowShort?: boolean
  detail: string
}

export const KRONOS_GATE_THRESHOLD = 0.55

/**
 * Non-blocking gate check: returns the cached verdict, or kicks off a forecast
 * and reports { pending } — the engine retries next cycle (15s later) and by
 * then the forecast is usually ready. Never blocks the engine loop.
 */
export async function kronosGateCheck(
  symbol: string,
  tf: string,
  tfSec: number,
  bars: KronosBar[],
): Promise<KronosGateVerdict> {
  gcGate()
  if (bars.length < 64) return { available: false, detail: 'not enough bars for a Kronos context' }
  const ctx = bars.slice(-512)
  const key = `${symbol}|${tf}|${ctx[ctx.length - 1]!.t}`
  const hit = gateCache.get(key)
  if (hit?.result?.ok) {
    const up = hit.result.upProb ?? 0.5
    return {
      available: true,
      upProb: up,
      allowLong: up >= KRONOS_GATE_THRESHOLD,
      allowShort: up <= 1 - KRONOS_GATE_THRESHOLD,
      detail: `P(up)=${up.toFixed(2)} · ${hit.result.model} · ${hit.result.contextBars} bars`,
    }
  }
  if (hit?.failed) return { available: false, detail: 'Kronos forecast failed this bar' }
  if (hit) return { available: true, pending: true, detail: `Kronos forecasting… ${Math.round((Date.now() - hit.startedAt) / 1000)}s` }
  const jobId = await kronosSubmitForecast({
    bars: ctx, horizon: 12, samples: 6, market: isCryptoSymbol(symbol) ? 'crypto' : 'stock',
    tfSec, model: 'mini',
  })
  if (!jobId) return { available: false, detail: 'Kronos sidecar unreachable' }
  gateCache.set(key, { jobId, startedAt: Date.now(), barTime: ctx[ctx.length - 1]!.t })
  // resolve async so a later call finds the result
  void (async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < WAIT_DEADLINE_MS) {
      const st = await kronosPollJob(jobId)
      if (st.done) {
        const e = gateCache.get(key)
        if (e) {
          e.result = st.result
          if (!st.result) e.failed = true
        }
        return
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    const e = gateCache.get(key)
    if (e) e.failed = true
  })()
  return { available: true, pending: true, detail: 'Kronos forecast started for this bar' }
}

// ---------------------------------------------------------------------------
// Journal + realization (the accountability loop)
// ---------------------------------------------------------------------------
export interface JournalInput {
  userId?: string
  symbol: string
  tf: string
  market: string
  result: KronosForecastResult
}

/** Persist a completed forecast (deduped per symbol|tf|barTime|horizon). */
export async function journalForecast(input: JournalInput): Promise<void> {
  const { result } = input
  if (!result?.ok || result.closeP50.length === 0) return
  try {
    await db.kronosForecast.upsert({
      where: {
        symbol_tf_barTime_horizonBars: {
          symbol: input.symbol, tf: input.tf, barTime: result.lastTime, horizonBars: result.horizon,
        },
      },
      update: { endP50: result.closeP50[result.closeP50.length - 1] ?? 0, upProb: result.upProb },
      create: {
        userId: input.userId ?? null,
        symbol: input.symbol,
        tf: input.tf,
        market: input.market,
        model: result.model,
        barTime: result.lastTime,
        tfSec: result.tfSec,
        horizonBars: result.horizon,
        lastClose: result.lastClose,
        endP50: result.closeP50[result.closeP50.length - 1] ?? 0,
        upProb: result.upProb,
        bandPct: result.bandPct,
        contextBars: result.contextBars,
        latencyMs: result.latencyMs,
        realizedAt: result.lastTime + result.tfSec * result.horizon,
      },
    })
  } catch {
    // journaling must never break forecasting
  }
}

export interface HitRate {
  n: number
  hits: number
  rate: number | null
  avgAbsErrPct: number | null
  pending: number
}

/** Aggregate realized accuracy across ALL journaled forecasts. */
export async function kronosHitRate(): Promise<HitRate> {
  try {
    const [agg, pending] = await Promise.all([
      db.kronosForecast.groupBy({
        by: ['hit'],
        _count: { _all: true },
        _avg: { absErrPct: true },
        where: { realizedClose: { not: null } },
      }),
      db.kronosForecast.count({ where: { realizedClose: null } }),
    ])
    let hits = 0
    let n = 0
    let errSum = 0
    let errN = 0
    for (const g of agg) {
      if (g.hit === true) hits += g._count._all
      if (g.hit != null) n += g._count._all
      if (g._avg.absErrPct != null && g.hit != null) { errSum += g._avg.absErrPct * g._count._all; errN += g._count._all }
    }
    return {
      n,
      hits,
      rate: n > 0 ? hits / n : null,
      avgAbsErrPct: errN > 0 ? errSum / errN : null,
      pending,
    }
  } catch {
    return { n: 0, hits: 0, rate: null, avgAbsErrPct: null, pending: 0 }
  }
}

/**
 * Resolve pending forecasts whose horizon-end bar now exists. Called from the
 * status route (cheap): fetches the horizon-end close per due forecast via a
 * targeted bars window and records hit + abs error.
 */
export async function realizePendingForecasts(symbol?: string): Promise<number> {
  try {
    const due = await db.kronosForecast.findMany({
      where: {
        realizedClose: null,
        realizedAt: { lte: Math.floor(Date.now() / 1000) },
        ...(symbol ? { symbol } : {}),
      },
      orderBy: { madeAt: 'desc' },
      take: 4,
    })
    let resolved = 0
    for (const f of due) {
      // fetch a small window ENDING just after the horizon-end bar
      const { getBars } = await import('@/lib/alpaca')
      const res = await getBars(f.symbol, f.tf as Parameters<typeof getBars>[1], undefined, {
        before: (f.realizedAt ?? 0) + f.tfSec,
        lookbackDays: Math.max(3, Math.ceil((f.horizonBars * f.tfSec) / 86400) + 2),
      })
      const bar = res.bars.find((b) => b.time === f.realizedAt) ?? res.bars[res.bars.length - 1]
      if (!bar || bar.time < (f.realizedAt ?? 0) - f.tfSec * 3) continue // market closed — try later
      const hit = f.upProb >= 0.5 ? bar.close > f.lastClose : bar.close < f.lastClose
      const absErrPct = Math.abs(f.endP50 - bar.close) / Math.max(f.lastClose, 1e-9) * 100
      await db.kronosForecast.update({
        where: { id: f.id },
        data: { realizedClose: bar.close, hit, absErrPct },
      })
      resolved++
    }
    return resolved
  } catch {
    return 0
  }
}
