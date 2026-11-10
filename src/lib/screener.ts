// v2.12.34 — AUTO WATCHLIST: screen the whole US-listed equity universe into
// the AI auto-trader's candidate pool.
//
// Why: the auto-trader used to scan ONLY the user's hand-picked watchlist —
// the pool quality caps the win rate no matter how good the model is. This
// screener ranks the ENTIRE active universe by tradeable opportunity
// (volatility the engine can actually monetize + liquidity that survives
// slippage) and hands the top 50 to the scanner as an alternative pool.
//
// Pipeline (real keys):
//   0. universe — GET /v2/assets?status=active&asset_class=us_equity
//      (api.alpaca.markets, paper host as auth fallback): keep plain-letter
//      tickers, drop warrants/units/rights/preferred by name; ETFs are KEPT
//      and labelled (SPY/QQQ are the most liquid, most-tradeable names).
//   1. snapshots — /v2/stocks/snapshots in 100-symbol chunks (6 workers):
//      last price, today's H/L/C/V + the previous session's. Feed probe once
//      per run: sip when the plan allows it (FULL tape volume — IEX is ~2%
//      of market volume and would misrank liquidity), else iex.
//      Filters: price ≥ $5 (penny noise), dollar volume ≥ floor (feed-aware:
//      iex tape is a small slice of the real tape). Shortlist = 120 best by
//      ½ percentile(dollarVol) + ½ percentile(today range%) — this stage
//      keeps stage 2 at two bulk bar calls instead of thousands.
//   2. daily bars — ONE multi-symbol /v2/stocks/bars call (~40 sessions,
//      paginated): ATR14%, yesterday-vs-20d volume ratio, 20-session return.
//      Today's forming bar is dropped — every metric must be full-session.
//   3. score — cross-sectional percentile ranks:
//      40% ATR14% (volatility) + 30% dollarVol (liquidity)
//      + 15% relVol (unusual activity) + 15% range% (live amplitude)
//      → top 50, rank 1 = best.
//
// No keys → STATIC sim universe (liquid mega/high-beta names), metrics
// unknown, source 'sim' — the demo flow stays alive and the label keeps the
// engine/UI honest (a simulated universe must never masquerade as a real
// screen).
//
// Everything is market-wide data, so the RESULT is shared across accounts:
// the route caches it 15 min (single-flight). Per-user persistence
// (ScreenerPick) happens in the route, best-effort — a failed write must
// never fail the screen.

export interface ScreenerPickRow {
  symbol: string
  name: string | null
  rank: number
  score: number
  price: number | null
  atrPct: number | null
  rangePct: number | null
  dollarVol: number | null
  relVol: number | null
  chgPct: number | null
  ret20: number | null
  kind: 'stock' | 'etf' | null
}

export interface ScreenerResult {
  source: 'real' | 'sim'
  feed: 'sip' | 'iex' | null
  computedAt: string
  universeSize: number
  filteredSize: number
  stage2Size: number
  picks: ScreenerPickRow[]
  note?: string
}

import type { AlpacaKeys } from './alpaca'
import { resolveAnyAlpacaKeys } from './alpaca'

const DATA_BASE = 'https://data.alpaca.markets'
const TRADE_BASES = ['https://api.alpaca.markets', 'https://paper-api.alpaca.markets']

const TOP_N = 50
const SHORTLIST = 120
const MIN_PRICE = 5
/** Liquidity floor, feed-aware: the IEX tape is a small slice of the real
 *  tape, so its dollar-volume floor must be proportionally lower. */
const DOLLAR_FLOOR: Record<'sip' | 'iex', number> = { sip: 3_000_000, iex: 400_000 }
const SNAP_CHUNK = 100
const SNAP_WORKERS = 6
const BARS_DAYS = 40 // sessions requested (calendar window padded below)
const BARS_MIN = 16 // fewer completed sessions → no ATR/relVol for the name

// ---- low-level fetch (data + broker hosts) ---------------------------------

async function dataFetch<T>(path: string, keys: AlpacaKeys, timeoutMs = 20_000): Promise<{ data: T | null; status: number }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${DATA_BASE}${path}`, {
        headers: {
          'APCA-API-KEY-ID': keys.keyId,
          'APCA-API-SECRET-KEY': keys.secret,
          accept: 'application/json',
        },
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!res.ok) return { data: null, status: res.status }
      return { data: (await res.json()) as T, status: 200 }
    } catch {
      if (attempt < 2) continue
      return { data: null, status: 0 }
    } finally {
      clearTimeout(timer)
    }
  }
  return { data: null, status: 0 }
}

async function assetsFetch<T>(path: string, keys: AlpacaKeys, timeoutMs = 30_000): Promise<{ data: T | null; status: number }> {
  for (const base of TRADE_BASES) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}${path}`, {
        headers: {
          'APCA-API-KEY-ID': keys.keyId,
          'APCA-API-SECRET-KEY': keys.secret,
          accept: 'application/json',
        },
        signal: controller.signal,
        cache: 'no-store',
      })
      if (res.ok) return { data: (await res.json()) as T, status: 200 }
      // wrong host for this key → try the other one; anything else is fatal
      if (res.status !== 401 && res.status !== 403) return { data: null, status: res.status }
    } catch {
      // network failure on this host → try the next
    } finally {
      clearTimeout(timer)
    }
  }
  return { data: null, status: 0 }
}

// ---- helpers ---------------------------------------------------------------

/** Percentile rank ×100 (0 = smallest, 100 = largest). Ties share the mean. */
export function percentileRanks(values: number[]): number[] {
  const n = values.length
  if (n === 0) return []
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const out = new Array<number>(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && idx[j + 1].v === idx[i].v) j++
    const pct = n === 1 ? 0 : ((i + j) / 2 / (n - 1)) * 100
    for (let k = i; k <= j; k++) out[idx[k].i] = pct
    i = j + 1
  }
  return out
}

interface DailyBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

const usDateOf = (t: string | number): string => {
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t)
  return new Date(d.getTime() - 4 * 3600_000).toISOString().slice(0, 10) // ET date approx (UTC−4)
}

/** Drop the forming bar (today's partial session) — all screener metrics
 *  must come from COMPLETE sessions or the numbers wobble intraday. */
export function completedBars(bars: DailyBar[]): DailyBar[] {
  const today = usDateOf(Date.now() / 1000)
  const out = bars.filter((b) => b && Number.isFinite(b.c) && b.c > 0 && usDateOf(b.t) !== today)
  return out.length > 0 ? out : bars.slice(0, Math.max(0, bars.length - 1))
}

export interface BarMetrics {
  atrPct: number | null
  relVol: number | null
  ret20: number | null
  lastClose: number | null
  lastVol: number | null
}

/** ATR14% / relVol (yesterday ÷ 20-session mean) / 20-session return from
 *  COMPLETED daily bars. Nulls when the history is too thin. */
export function computeBarMetrics(rawBars: DailyBar[]): BarMetrics {
  const bars = completedBars(rawBars)
  if (bars.length === 0) return { atrPct: null, relVol: null, ret20: null, lastClose: null, lastVol: null }
  const last = bars[bars.length - 1]
  const lastClose = last.c
  const lastVol = last.v
  // ATR14 (simple mean of true range over the last 14 completed sessions)
  let atrPct: number | null = null
  if (bars.length >= 15) {
    let sum = 0
    for (let i = bars.length - 14; i < bars.length; i++) {
      const b = bars[i]
      const pc = bars[i - 1].c
      sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))
    }
    atrPct = lastClose > 0 ? (sum / 14 / lastClose) * 100 : null
  }
  // relVol: yesterday's volume ÷ mean of the 20 completed sessions before it
  let relVol: number | null = null
  if (bars.length >= BARS_MIN + 1) {
    const win = bars.slice(-(20 + 1), -1)
    const avg = win.reduce((a, b) => a + (Number.isFinite(b.v) ? b.v : 0), 0) / win.length
    if (avg > 0 && Number.isFinite(last.v)) relVol = last.v / avg
  }
  // 20-session return
  let ret20: number | null = null
  if (bars.length >= 22) {
    const base = bars[bars.length - 22].c
    if (base > 0) ret20 = (last.c / base - 1) * 100
  }
  return { atrPct, relVol, ret20, lastClose, lastVol }
}

const ETF_NAME = /\bETF\b|\bETN\b|\bFUND\b|\bINDEX\b|\bFOLIO\b/i
const JUNK_NAME = /\bWARRANTS?\b|\bRIGHTS?\b|\bUNITS?\b|\bPREFERRED\b|\bPREF\b|\bDEPOSITARY\b|\bSPAC\b|\bACQUISITION\b|\bCORP\b.*\bACQUISITION\b/i

// ---- static sim universe (no keys — demo flow stays alive) ------------------

const SIM_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX',
  'INTC', 'MU', 'QCOM', 'TXN', 'ADBE', 'CRM', 'ORCL', 'CSCO', 'NOW', 'SNOW',
  'DDOG', 'ZS', 'CRWD', 'NET', 'MDB', 'SHOP', 'PLTR', 'PYPL', 'UBER', 'LYFT',
  'ABNB', 'DASH', 'SNAP', 'PINS', 'SOFI', 'HOOD', 'COIN', 'MARA', 'RIOT', 'RBLX',
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'NKE', 'MCD', 'SBUX', 'DIS', 'CMG',
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'XOM', 'CVX', 'SLB',
  'CAT', 'DE', 'BA', 'GE', 'F', 'GM', 'DAL', 'UAL', 'AAL', 'LUV',
  'PFE', 'MRK', 'JNJ', 'UNH', 'ABBV', 'LLY', 'TMO', 'RIVN', 'LCID', 'NIO',
]

// ---- stage 1: snapshots -----------------------------------------------------

interface Stage1Row {
  symbol: string
  name: string | null
  kind: 'stock' | 'etf' | null
  price: number
  rangePct: number | null
  chgPct: number | null
  dollarVol: number
}

interface StockSnapshot {
  latestTrade?: { p: number }
  dailyBar?: { h: number; l: number; c: number; v: number; t: string }
  prevDailyBar?: { h: number; l: number; c: number; v: number; t: string }
}

/** Pick the feed once per run: sip (full consolidated tape — required for
 *  honest volume ranking) when the subscription allows, else iex. */
async function probeFeed(keys: AlpacaKeys): Promise<'sip' | 'iex'> {
  const r = await dataFetch<Record<string, StockSnapshot>>('/v2/stocks/snapshots?symbols=AAPL,MSFT&feed=sip', keys, 12_000)
  if (r.data && Object.keys(r.data).length > 0) return 'sip'
  return 'iex'
}

async function fetchSnapshotsChunk(
  syms: string[],
  keys: AlpacaKeys,
  feed: 'sip' | 'iex',
): Promise<Record<string, StockSnapshot>> {
  const r = await dataFetch<Record<string, StockSnapshot>>(
    `/v2/stocks/snapshots?symbols=${encodeURIComponent(syms.join(','))}&feed=${feed}`,
    keys,
    25_000,
  )
  return r.data ?? {}
}

function snapshotRow(
  symbol: string,
  meta: { name: string | null; kind: 'stock' | 'etf' | null },
  snap: StockSnapshot | undefined,
  floor: number,
): Stage1Row | null {
  if (!snap) return null
  const d = snap.dailyBar
  const p = snap.prevDailyBar
  const price = snap.latestTrade?.p ?? d?.c ?? p?.c
  if (!price || price < MIN_PRICE) return null
  // Liquidity is measured on the last COMPLETE session (today's tape is
  // partial — before lunch every name looks illiquid).
  const vol = p?.v ?? d?.v
  const base = p?.c ?? d?.c
  if (!vol || !base) return null
  const dollarVol = base * vol
  if (dollarVol < floor) return null
  const rangePct = d && p ? ((d.h - d.l) / p.c) * 100 : null
  const chgPct = d && p ? (d.c / p.c - 1) * 100 : null
  return { symbol, name: meta.name, kind: meta.kind, price, rangePct, chgPct, dollarVol }
}

// ---- stage 2: multi-symbol daily bars ---------------------------------------

async function fetchDailyBars(
  syms: string[],
  keys: AlpacaKeys,
  feed: 'sip' | 'iex',
): Promise<Map<string, DailyBar[]>> {
  const start = new Date(Date.now() - Math.ceil(BARS_DAYS * 1.65) * 86_400_000).toISOString().slice(0, 19) + 'Z'
  const end = new Date().toISOString().slice(0, 19) + 'Z'
  const out = new Map<string, DailyBar[]>()
  let token: string | undefined
  for (let page = 0; page < 4; page++) {
    const path =
      `/v2/stocks/bars?symbols=${encodeURIComponent(syms.join(','))}&timeframe=1Day` +
      `&start=${start}&end=${end}&limit=10000&adjustment=split&feed=${feed}` +
      (token ? `&page_token=${encodeURIComponent(token)}` : '')
    const r = await dataFetch<{ bars?: Record<string, DailyBar[]>; next_page_token?: string }>(path, keys, 30_000)
    if (!r.data?.bars) break
    for (const [sym, arr] of Object.entries(r.data.bars)) {
      if (!Array.isArray(arr) || arr.length === 0) continue
      const prev = out.get(sym) ?? []
      out.set(sym, [...prev, ...arr])
    }
    token = r.data.next_page_token
    if (!token) break
  }
  return out
}

// ---- the screen -------------------------------------------------------------

async function screenReal(keys: AlpacaKeys): Promise<ScreenerResult> {
  const feed = await probeFeed(keys)
  const floor = DOLLAR_FLOOR[feed]

  // universe — plain-letter active US equities, junk share classes out
  const uni = await assetsFetch<{ symbol?: string; name?: string; tradable?: boolean; class?: string }[]>(
    '/v2/assets?status=active&asset_class=us_equity',
    keys,
  )
  const universe = (Array.isArray(uni.data) ? uni.data : [])
    .filter((a) => a && typeof a.symbol === 'string' && a.tradable !== false)
    .map((a) => ({
      symbol: a.symbol as string,
      name: typeof a.name === 'string' ? a.name.slice(0, 60) : null,
      kind: (typeof a.name === 'string' && ETF_NAME.test(a.name) ? 'etf' : 'stock') as 'etf' | 'stock',
    }))
    .filter((a) => /^[A-Z]{1,5}$/.test(a.symbol) && !JUNK_NAME.test(a.name ?? ''))

  if (universe.length === 0) throw new Error(`universe fetch failed (HTTP ${uni.status})`)

  // stage 1 — snapshots in chunks, 6 workers
  const rows = new Map<string, Stage1Row>()
  let i = 0
  const worker = async () => {
    while (i < universe.length) {
      const chunk = universe.slice(i, i + SNAP_CHUNK)
      i += SNAP_CHUNK
      const snaps = await fetchSnapshotsChunk(chunk.map((a) => a.symbol), keys, feed)
      for (const a of chunk) {
        const row = snapshotRow(a.symbol, { name: a.name, kind: a.kind }, snaps[a.symbol], floor)
        if (row) rows.set(a.symbol, row)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SNAP_WORKERS, Math.ceil(universe.length / SNAP_CHUNK)) }, worker))

  if (rows.size === 0) throw new Error('no snapshot data — feed or keys unusable')
  const filtered = [...rows.values()]

  // stage-1 shortlist: ½ percentile(dollarVol) + ½ percentile(today range%)
  const dvRanks = percentileRanks(filtered.map((r) => r.dollarVol))
  const rgRanks = percentileRanks(filtered.map((r) => r.rangePct ?? 0))
  const shortlist = filtered
    .map((r, k) => ({ r, s1: 0.5 * dvRanks[k] + 0.5 * rgRanks[k] }))
    .sort((a, b) => b.s1 - a.s1)
    .slice(0, SHORTLIST)

  // stage 2 — one bulk daily-bars call for the shortlist
  const barSyms = shortlist.map(({ r }) => r.symbol)
  const barsBy = await fetchDailyBars(barSyms, keys, feed)

  const enriched = shortlist.map(({ r }) => {
    const bars = barsBy.get(r.symbol) ?? []
    const m = computeBarMetrics(bars)
    return { ...r, atrPct: m.atrPct, relVol: m.relVol, ret20: m.ret20 }
  })

  // score — ATR% 40 / dollarVol 30 / relVol 15 / range% 15 (percentile ranks;
  // nulls fall to the neutral 50 so a thin-history name neither wins nor dies)
  const atr = percentileRanks(enriched.map((r) => r.atrPct ?? 0))
  const dv = percentileRanks(enriched.map((r) => r.dollarVol))
  const rv = percentileRanks(enriched.map((r) => r.relVol ?? 1))
  const rg = percentileRanks(enriched.map((r) => r.rangePct ?? 0))
  const scored = enriched
    .map((r, k) => ({
      row: {
        symbol: r.symbol,
        name: r.name,
        rank: 0,
        score: Math.round((0.4 * atr[k] + 0.3 * dv[k] + 0.15 * rv[k] + 0.15 * rg[k]) * 10) / 10,
        price: round2(r.price),
        atrPct: round2(r.atrPct),
        rangePct: round2(r.rangePct),
        dollarVol: Math.round(r.dollarVol),
        relVol: r.relVol != null ? Math.round(r.relVol * 100) / 100 : null,
        chgPct: round2(r.chgPct),
        ret20: round2(r.ret20),
        kind: r.kind,
      } satisfies ScreenerPickRow,
    }))
    .sort((a, b) => b.row.score - a.row.score)
    .slice(0, TOP_N)
    .map(({ row }, k) => ({ ...row, rank: k + 1 }))

  return {
    source: 'real',
    feed,
    computedAt: new Date().toISOString(),
    universeSize: universe.length,
    filteredSize: filtered.length,
    stage2Size: barSyms.length,
    picks: scored,
  }
}

function screenSim(): ScreenerResult {
  const picks: ScreenerPickRow[] = SIM_UNIVERSE.slice(0, TOP_N).map((symbol, k) => ({
    symbol,
    name: null,
    rank: k + 1,
    score: Math.round((100 - k * (100 / TOP_N)) * 10) / 10,
    price: null,
    atrPct: null,
    rangePct: null,
    dollarVol: null,
    relVol: null,
    chgPct: null,
    ret20: null,
    kind: null,
  }))
  return {
    source: 'sim',
    feed: null,
    computedAt: new Date().toISOString(),
    universeSize: SIM_UNIVERSE.length,
    filteredSize: SIM_UNIVERSE.length,
    stage2Size: 0,
    picks,
    note: '無 Alpaca keys — 靜態模擬宇宙（流動性大型/高波動股），未經真實篩選',
  }
}

function round2(v: number | null): number | null {
  return v != null && Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}

/** Run the full screen. Real keys → two-stage universe screen; else the
 *  static sim universe. Throws only on real-path infrastructure failure —
 *  the route converts that into the sim fallback + honest note. */
export async function runUniverseScreen(userId: string | undefined): Promise<ScreenerResult> {
  const keys = await resolveAnyAlpacaKeys(userId)
  if (!keys) return screenSim()
  try {
    return await screenReal(keys)
  } catch (e) {
    const sim = screenSim()
    sim.note = `即時篩選失敗（${e instanceof Error ? e.message : 'unknown'}）— 退回靜態模擬宇宙`
    return sim
  }
}
