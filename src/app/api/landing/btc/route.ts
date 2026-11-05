// v2.9.0 — public landing-page BTC feed (NO auth — the landing page is
// pre-login). Binance spot is free/keyless, so the hero chart shows REAL
// BTC/USDT candles; every other market route is session-gated and useless
// here.
//
//   GET /api/landing/btc?tf=1h|4h|1d|1w[&limit=300]
//     → { candles: {time,open,high,low,close,volume}[], price, changePct,
//         source: 'binance' | 'cache' | 'fallback', stale: boolean, ts }
//
// Resilience: the sandbox/host can hit Binance 429s (shared IP). Responses
// are cached in local memory (60s TTL per tf); on upstream failure the last
// good snapshot is served stale (up to 30 min, source 'cache'); with no
// snapshot ever, a DETERMINISTIC synthetic walk (seeded, so SSR/CSR and
// reloads agree) keeps the chart renderable — clearly marked 'fallback' so
// the UI can badge it. Never throws to the client.
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SYMBOL = 'BTCUSDT'
const TTL_MS = 60_000
const STALE_MAX_MS = 30 * 60_000

const TFS = new Set(['1h', '4h', '1d', '1w'])

export interface LandingCandle {
  time: number // UTC seconds — lightweight-charts UTCTimestamp
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Snapshot {
  candles: LandingCandle[]
  price: number
  changePct: number
  source: 'binance' | 'cache' | 'fallback'
  stale: boolean
  ts: number
}

const cache = new Map<string, { at: number; snap: Snapshot }>()

function stepSecOf(tf: string): number {
  return tf === '1h' ? 3600 : tf === '4h' ? 4 * 3600 : tf === '1d' ? 86_400 : 7 * 86_400
}

function parseKlines(raw: unknown): LandingCandle[] {
  if (!Array.isArray(raw)) return []
  const out: LandingCandle[] = []
  for (const k of raw) {
    if (!Array.isArray(k) || k.length < 6) continue
    const row: LandingCandle = {
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }
    if (Number.isFinite(row.time) && Number.isFinite(row.close)) out.push(row)
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/** Deterministic seeded walk — same shape every load, anchored to real time. */
function synthetic(tf: string, limit: number): LandingCandle[] {
  const stepSec = stepSecOf(tf)
  const bucket = Math.floor(Date.now() / 1000 / stepSec) * stepSec
  let seed = 0x9e3779b9
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }
  const out: LandingCandle[] = []
  let price = 61500
  for (let i = limit - 1; i >= 0; i--) {
    const drift = 8 + 6 * Math.sin(i / 9) // gentle waves + upward bias
    const o = price
    const c = Math.max(1000, o + (rnd() - 0.44) * 900 + drift)
    const h = Math.max(o, c) + rnd() * 350
    const l = Math.min(o, c) - rnd() * 350
    out.push({ time: bucket - i * stepSec, open: o, high: h, low: l, close: c, volume: 800 + rnd() * 2200 })
    price = c
  }
  return out
}

// v2.12.7 — two-host failover: api.binance.com is geo-blocked (HTTP 451) from
// US-hosted servers like Render ("Unavailable For Legal Reasons"), while the
// data-api.binance.vision mirror serves the same public market-data paths.
// Without the mirror the landing chart silently degraded to the synthetic walk.
const BINANCE_BASES = ['https://api.binance.com', 'https://data-api.binance.vision']

async function fetchBinance(path: string, timeoutMs = 6000): Promise<unknown> {
  for (const base of BINANCE_BASES) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}${path}`, { signal: ctl.signal, cache: 'no-store' })
      if (!res.ok) {
        // host-level geo/WAF block — the mirror serves the same public path
        if (res.status === 451 || res.status === 403) continue
        throw new Error(`binance ${res.status}`)
      }
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('binance unreachable from this host')
}

async function buildSnapshot(tf: string, limit: number): Promise<Snapshot> {
  const now = Date.now()
  const hit = cache.get(tf)
  if (hit && now - hit.at < TTL_MS) return { ...hit.snap, stale: false }

  try {
    const [klRaw, tkRaw] = await Promise.all([
      fetchBinance(`/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${limit}`),
      fetchBinance(`/api/v3/ticker/24hr?symbol=${SYMBOL}`),
    ])
    const candles = parseKlines(klRaw)
    if (candles.length < 10) throw new Error('klines too short')
    const tk = (tkRaw ?? {}) as { lastPrice?: string; priceChangePercent?: string }
    const snap: Snapshot = {
      candles,
      price: Number(tk.lastPrice) || candles[candles.length - 1].close,
      changePct: Number(tk.priceChangePercent) || 0,
      source: 'binance',
      stale: false,
      ts: now,
    }
    cache.set(tf, { at: now, snap })
    return snap
  } catch {
    if (hit && now - hit.at < STALE_MAX_MS) return { ...hit.snap, source: 'cache', stale: true }
    const candles = synthetic(tf, limit)
    const last = candles[candles.length - 1]
    const back = Math.max(0, candles.length - Math.floor(86_400 / stepSecOf(tf)))
    const dayAgo = candles[back]
    const snap: Snapshot = {
      candles,
      price: last.close,
      changePct: dayAgo ? ((last.close - dayAgo.close) / dayAgo.close) * 100 : 0,
      source: 'fallback',
      stale: false,
      ts: now,
    }
    return snap
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const tfParam = searchParams.get('tf') ?? ''
  const tf = TFS.has(tfParam) ? tfParam : '1h'
  const limitRaw = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw) ? Math.max(50, Math.min(500, Math.floor(limitRaw))) : 300
  try {
    const snap = await buildSnapshot(tf, limit)
    return NextResponse.json(snap, { headers: { 'cache-control': 'no-store' } })
  } catch {
    // buildSnapshot never throws, but belt-and-braces: the landing page must render
    return NextResponse.json(
      { candles: synthetic(tf, limit), price: 0, changePct: 0, source: 'fallback', stale: false, ts: Date.now() },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
}
