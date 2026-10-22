/**
 * Deterministic synthetic market data generator (DEMO mode).
 * Produces realistic-looking OHLCV series so the terminal is fully
 * explorable before Alpaca API keys are connected.
 */
import type { Bar, EconEvent, EventImpact, MoversData, NewsItem, SearchItem, Snapshot, Timeframe } from "./types";
import { cryptoDirectory, cryptoPair, isCryptoSymbol } from "./symbols";

// ---------------- seeded randomness ----------------

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Price rounding that survives sub-dollar crypto (SHIB ≈ 0.0000215, DOGE 0.32):
 *  2dp for |x| ≥ 1, 4dp below $1, 8dp below a cent. Stocks keep r2 so existing
 *  series stay byte-identical. Monotone, so it never flips high/low vs open/close. */
export function roundPx(x: number): number {
  const a = Math.abs(x);
  if (a >= 1) return Math.round(x * 100) / 100;
  if (a >= 0.01) return Math.round(x * 10000) / 10000;
  return Math.round(x * 1e8) / 1e8;
}

// ---------------- ET market time helpers ----------------

const TZ = "America/New_York";
const OPEN_MIN = 9 * 60 + 30; // 9:30 ET
const CLOSE_MIN = 16 * 60; // 16:00 ET

function tzOffsetSec(dateStr: string): number {
  const utc = Date.parse(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utc));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return ((h % 24) * 60 + m - 720) * 60;
}

export interface EtNow {
  dateStr: string;
  minutes: number; // minutes since midnight ET
  seconds: number; // seconds within the current ET minute
  weekday: number; // 0=Sun .. 6=Sat
}

export function etNow(): EtNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
    seconds: Number(get("second")),
    weekday: wdMap[get("weekday")] ?? 1,
  };
}

export type MarketPhase = "pre" | "open" | "post" | "closed";

export function marketPhase(): MarketPhase {
  const { minutes, weekday } = etNow();
  if (weekday === 0 || weekday === 6) return "closed";
  if (minutes >= 4 * 60 && minutes < OPEN_MIN) return "pre";
  if (minutes >= OPEN_MIN && minutes < CLOSE_MIN) return "open";
  if (minutes >= CLOSE_MIN && minutes < 20 * 60) return "post";
  return "closed";
}

function isWeekdayDate(dateStr: string): boolean {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function prevWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function prevCalendarDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Last `count` CALENDAR days ascending, ending today — crypto trades 24/7,
 *  so weekends and holidays are regular sessions. */
function calendarDates(count: number): string[] {
  const { dateStr } = etNow();
  const out: string[] = [];
  let cur = dateStr;
  for (let i = 0; i < count; i++) {
    out.push(cur);
    cur = prevCalendarDay(cur);
  }
  return out.reverse();
}

/** ET wall-clock `openMin` of `dateStr` as a UTC epoch second. */
function openUTCFor(dateStr: string, openMin: number): number {
  const hh = String(Math.floor(openMin / 60)).padStart(2, "0");
  const mm = String(openMin % 60).padStart(2, "0");
  return Date.parse(`${dateStr}T${hh}:${mm}:00Z`) / 1000 - tzOffsetSec(dateStr);
}

/** Last `count` market sessions (ascending). Today is the last date whenever it is
 *  a weekday — today's partial session data is layered on per request from the
 *  live minute path, so charts always reach "now" during a session. */
function sessionDates(count: number): string[] {
  const { dateStr, weekday } = etNow();
  const todayIsTradingDay = weekday >= 1 && weekday <= 5;
  let cur = todayIsTradingDay ? dateStr : prevWeekday(dateStr);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(cur);
    cur = prevWeekday(cur);
  }
  return out.reverse();
}

// ---------------- symbol characteristics ----------------

const BASE_PRICES: Record<string, number> = {
  AAPL: 228, MSFT: 424, NVDA: 134, TSLA: 341, AMZN: 221, GOOGL: 190, META: 597,
  AMD: 120, NFLX: 890, AVGO: 1700, TSM: 180, SPY: 597, QQQ: 518, IWM: 225,
  DIA: 440, JPM: 243, V: 275, MA: 465, BAC: 42, COST: 900, WMT: 85, XOM: 118,
  LLY: 780, PFE: 27, BA: 155, GE: 180, CAT: 350, UBER: 68, ABNB: 130, COIN: 260,
  PLTR: 40, SNOW: 165, SHOP: 78, SQ: 68, PYPL: 65, DIS: 100, NKE: 78, INTC: 22,
  MU: 110, SMCI: 40, ARM: 130, APP: 220, AFRM: 55, DKNG: 38, RIVN: 12, LCID: 3,
  GME: 22, AMC: 4, ZM: 80, NET: 100, TWLO: 90, ROKU: 70, SBUX: 95, TGT: 130,
  HD: 380, LOW: 230, KO: 62, PEP: 170, JNJ: 150, UNH: 520, CRM: 280, ORCL: 140,
  ADBE: 500, CSCO: 58, IBM: 200, MCD: 290, F: 11, GM: 48,
};

function basePrice(symbol: string): number {
  const pair = isCryptoSymbol(symbol) ? cryptoPair(symbol) : null;
  if (pair) return pair.base; // registry base price (BTC ≈ 97300, SHIB ≈ 0.0000215 …)
  const known = BASE_PRICES[symbol];
  if (known) return known;
  const r = mulberry32(hashStr(`base:${symbol}`));
  return r2(15 + r() * 385);
}

// ---------------- daily series ----------------

interface DailyBar extends Bar {
  date: string;
}

interface DailyWalk {
  hist: DailyBar[]; // completed sessions — today is EXCLUDED even on a trading day
  today: DailyBar | null; // today's FULL-session reference bar (weekday only)
}

const walkCache = new Map<string, { dateStr: string; walk: DailyWalk }>();

const CANONICAL_SESSIONS = 7560; // 30y × 252

/** Deterministic ~30y walk per symbol for the current ET day, generated at FULL
 *  session length. Today's partial bar is layered on per request from the minute
 *  path (see minutePath) so the newest bar always reaches "now" without ever
 *  re-randomizing or shifting history. This replaces the old cache that baked the
 *  build-time market state into the whole series and left charts stale all day.
 *  Cached per (symbol, ET-date); stocks and crypto share the cache shape. */
function genDailyCore(symbol: string): DailyWalk {
  const { dateStr } = etNow();
  const hit = walkCache.get(symbol);
  if (hit && hit.dateStr === dateStr) return hit.walk;
  const walk = isCryptoSymbol(symbol) ? genCryptoWalk(symbol, dateStr) : genStockWalk(symbol, dateStr);
  if (walkCache.size > 256) walkCache.clear();
  walkCache.set(symbol, { dateStr, walk });
  return walk;
}

/** Stock walk — weekday sessions only. Keep byte-identical: charts rendered
 *  before the crypto update must never shift. */
function genStockWalk(symbol: string, dateStr: string): DailyWalk {
  const dates = sessionDates(CANONICAL_SESSIONS);
  const r = mulberry32(hashStr(`daily:${symbol}`));
  const drift = (r() * 0.35 - 0.08) / 252; // per-session log drift
  const vol = 0.16 + r() * 0.3; // annualized vol
  const base = basePrice(symbol);
  const totalYears = dates.length / 252;
  let c = Math.max(1, base / Math.exp((drift * 252) * totalYears));

  const bars: DailyBar[] = [];
  for (let i = 0; i < dates.length; i++) {
    const dayVol = vol / Math.sqrt(252);
    const prevC = i === 0 ? c : bars[i - 1].close;
    const o = prevC * (1 + dayVol * 0.35 * gauss(r));
    const ret = drift + dayVol * gauss(r);
    c = o * Math.exp(ret);
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * dayVol * 0.55);
    const lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * dayVol * 0.55);
    const vBase = 4e6 + r() * 3e7;
    const v = Math.round(vBase * (0.55 + (Math.abs(ret) / (dayVol + 1e-9)) * 0.35));
    bars.push({ date: dates[i], time: dates[i], open: o, high: hi, low: lo, close: c, volume: v });
  }

  // Rescale so the walk ends exactly at the symbol's base price — long walks
  // otherwise drift to absurd levels (e.g. MSFT at $68k after 30y of noise).
  const factor = base / bars[bars.length - 1].close;
  for (const b of bars) {
    b.open = r2(b.open * factor);
    b.high = r2(b.high * factor);
    b.low = r2(b.low * factor);
    b.close = r2(b.close * factor);
  }

  const lastBar = bars[bars.length - 1];
  const todayInSeries = lastBar.date === dateStr;
  return {
    hist: todayInSeries ? bars.slice(0, -1) : bars,
    today: todayInSeries ? lastBar : null,
  };
}

/** Crypto walk — same machinery, but sessions are CALENDAR days (24/7 market)
 *  and prices round with roundPx so sub-dollar pairs survive. */
function genCryptoWalk(symbol: string, dateStr: string): DailyWalk {
  const dates = calendarDates(CANONICAL_SESSIONS);
  const r = mulberry32(hashStr(`daily:${symbol}`));
  const drift = (r() * 0.35 - 0.08) / 252;
  const vol = 0.16 + r() * 0.3;
  const base = basePrice(symbol);
  const totalYears = dates.length / 365;
  let c = Math.max(1e-8, base / Math.exp(drift * 365 * totalYears));

  const bars: DailyBar[] = [];
  for (let i = 0; i < dates.length; i++) {
    const dayVol = vol / Math.sqrt(252);
    const prevC = i === 0 ? c : bars[i - 1].close;
    const o = prevC * (1 + dayVol * 0.35 * gauss(r));
    const ret = drift + dayVol * gauss(r);
    c = o * Math.exp(ret);
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * dayVol * 0.55);
    const lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * dayVol * 0.55);
    const vBase = 4e6 + r() * 3e7;
    const v = Math.round(vBase * (0.55 + (Math.abs(ret) / (dayVol + 1e-9)) * 0.35));
    bars.push({ date: dates[i], time: dates[i], open: o, high: hi, low: lo, close: c, volume: v });
  }

  const factor = base / bars[bars.length - 1].close;
  for (const b of bars) {
    b.open = roundPx(b.open * factor);
    b.high = roundPx(b.high * factor);
    b.low = roundPx(b.low * factor);
    b.close = roundPx(b.close * factor);
  }

  // calendar days always include today — the last bar is today's full-session
  // reference and every prior day (Sat/Sun included) is completed history
  const lastBar = bars[bars.length - 1];
  return { hist: bars.slice(0, -1), today: lastBar.date === dateStr ? lastBar : null };
}

function aggregate(bars: DailyBar[], mode: "week" | "month"): Bar[] {
  const keyOf = (d: string): string => {
    if (mode === "month") return d.slice(0, 7);
    const dt = new Date(`${d}T12:00:00Z`);
    const monday = new Date(dt);
    monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = "";
  for (const b of bars) {
    const k = keyOf(b.date);
    if (!cur || k !== curKey) {
      if (cur) out.push(cur);
      cur = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      curKey = k;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------- intraday series (completed sessions) ----------------

function intradayHist(symbol: string, days: DailyBar[], tfMin: number, crypto = false): Bar[] {
  const round = crypto ? roundPx : r2;
  const sessionMin = crypto ? 1440 : 390; // crypto sessions run 00:00→24:00 ET
  const openMin = crypto ? 0 : OPEN_MIN;
  const out: Bar[] = [];
  for (const d of days) {
    const n = Math.ceil(sessionMin / tfMin);

    const rng = mulberry32(hashStr(`intra:${symbol}:${d.date}`));
    const dayVol = 0.02 + rng() * 0.025;
    const perBar = dayVol / Math.sqrt(n);
    const w: number[] = [0];
    for (let i = 1; i <= n; i++) w.push(w[i - 1] + gauss(rng) * perBar);

    const o = d.open;
    const c = d.close;
    const prices: number[] = [];
    for (let i = 0; i <= n; i++) {
      const bridge = w[i] - (w[n] * i) / n;
      prices.push(o + (c - o) * (i / n) + o * bridge);
    }

    const openUTC = openUTCFor(d.date, openMin);
    for (let j = 0; j < n; j++) {
      const p0 = prices[j];
      const p1 = prices[j + 1];
      const hi = Math.max(p0, p1) * (1 + Math.abs(gauss(rng)) * perBar * 0.6);
      const lo = crypto
        ? Math.max(1e-8, Math.min(p0, p1) * (1 - Math.abs(gauss(rng)) * perBar * 0.6))
        : Math.max(0.01, Math.min(p0, p1) * (1 - Math.abs(gauss(rng)) * perBar * 0.6));
      const x = j / n;
      const u = 1 + 2.2 * Math.exp(-x * 7) + 1.6 * Math.exp(-(1 - x) * 6) + 0.4 * Math.abs(gauss(rng));
      const v = Math.max(1, Math.round((d.volume * u) / (n * 3.2)));
      out.push({
        time: openUTC + j * tfMin * 60,
        open: round(p0),
        high: round(Math.max(hi, p0, p1)),
        low: round(lo),
        close: round(p1),
        volume: v,
      });
    }
  }
  return out;
}

// ---------------- today's live session path ----------------

const STEP_SEC = 10; // path resolution
const STEPS_PER_MIN = 6;
const STEPS_PER_DAY = 390 * STEPS_PER_MIN; // stocks: 9:30–16:00 ET
const CRYPTO_STEPS_PER_DAY = 1440 * STEPS_PER_MIN; // crypto: continuous 00:00–24:00 ET

interface MinutePath {
  C: number[]; // price after step k — C[0] = session open, length stepsPerDay + 1
  V: number[]; // volume traded during step k — length stepsPerDay, sums to the full-day volume
}

const pathCache = new Map<string, { dateStr: string; path: MinutePath }>();

/** 10-second Brownian bridge for today's session: starts at today's open, ends at
 *  today's full-session close. The daily partial bar, today's intraday bars and
 *  the snapshot price all read the same path, so every timeframe and the quote
 *  advance together every 10 seconds without the history ever shifting.
 *  Parameterized by session length: stocks 9:30–16:00 (2340 steps), crypto a
 *  continuous 24h (8640 steps). Cache is keyed by symbol, so both shapes coexist. */
function minutePath(symbol: string, today: DailyBar): MinutePath {
  const { dateStr } = etNow();
  const hit = pathCache.get(symbol);
  if (hit && hit.dateStr === dateStr) return hit.path;

  const stepsPerDay = isCryptoSymbol(symbol) ? CRYPTO_STEPS_PER_DAY : STEPS_PER_DAY;
  const r = mulberry32(hashStr(`mpath:${symbol}:${dateStr}`));
  const dayVol = 0.02 + r() * 0.025; // same distribution as intradayHist days
  const perStep = dayVol / Math.sqrt(stepsPerDay);
  const w: number[] = [0];
  for (let i = 1; i <= stepsPerDay; i++) w.push(w[i - 1] + gauss(r) * perStep);

  const C: number[] = [];
  for (let i = 0; i <= stepsPerDay; i++) {
    const bridge = w[i] - (w[stepsPerDay] * i) / stepsPerDay;
    C.push(today.open + (today.close - today.open) * (i / stepsPerDay) + today.open * bridge);
  }

  const u: number[] = [];
  let uSum = 0;
  for (let i = 0; i < stepsPerDay; i++) {
    const x = i / stepsPerDay;
    const ui = 1 + 2.2 * Math.exp(-x * 7) + 1.6 * Math.exp(-(1 - x) * 6) + 0.4 * Math.abs(gauss(r));
    u.push(ui);
    uSum += ui;
  }
  const V = u.map((ui) => Math.max(1, Math.round((today.volume * ui) / uSum)));

  const path: MinutePath = { C, V };
  if (pathCache.size > 256) pathCache.clear();
  pathCache.set(symbol, { dateStr, path });
  return path;
}

/** 10-second steps elapsed since today's 9:30 ET open.
 *  0 → pre-open or weekend; capped at the session end after the close. */
function elapsedSteps(): number {
  const { minutes, seconds, weekday } = etNow();
  if (weekday < 1 || weekday > 5 || minutes < OPEN_MIN) return 0;
  const elapsedSec = (minutes - OPEN_MIN) * 60 + seconds;
  return Math.min(STEPS_PER_DAY, Math.floor(elapsedSec / STEP_SEC));
}

/** Crypto trades 24/7: 10-second steps elapsed since today's 00:00 ET — never
 *  gated on weekday or market phase. 0 only in the exact midnight ET second. */
function elapsedCryptoSteps(): number {
  const { minutes, seconds } = etNow();
  const elapsedSec = minutes * 60 + seconds;
  return Math.min(CRYPTO_STEPS_PER_DAY, Math.floor(elapsedSec / STEP_SEC));
}

/** Today's partial daily bar after `s` steps (high/low = path extremes so far). */
function partialDaily(today: DailyBar, path: MinutePath, s: number, round: (x: number) => number): DailyBar {
  let hi = -Infinity;
  let lo = Infinity;
  let v = 0;
  for (let k = 0; k <= s; k++) {
    if (path.C[k] > hi) hi = path.C[k];
    if (path.C[k] < lo) lo = path.C[k];
  }
  for (let k = 0; k < s; k++) v += path.V[k];
  return {
    date: today.date,
    time: today.date,
    open: round(path.C[0]),
    high: round(hi),
    low: round(lo),
    close: round(path.C[s]),
    volume: v,
  };
}

/** Today's intraday bars for `tfMin`-minute windows — the last one is still forming. */
function todayIntraday(
  today: DailyBar,
  path: MinutePath,
  tfMin: number,
  s: number,
  openMin: number,
  round: (x: number) => number
): Bar[] {
  if (s <= 0) return [];
  const win = tfMin * STEPS_PER_MIN;
  const n = Math.ceil(s / win);
  const openUTC = openUTCFor(today.date, openMin);
  const out: Bar[] = [];
  for (let j = 0; j < n; j++) {
    const from = j * win;
    const to = Math.min((j + 1) * win, s);
    let hi = -Infinity;
    let lo = Infinity;
    let v = 0;
    for (let k = from; k <= to; k++) {
      if (path.C[k] > hi) hi = path.C[k];
      if (path.C[k] < lo) lo = path.C[k];
    }
    for (let k = from; k < to; k++) v += path.V[k];
    out.push({
      time: openUTC + j * tfMin * 60,
      open: round(path.C[from]),
      high: round(hi),
      low: round(lo),
      close: round(path.C[to]),
      volume: v,
    });
  }
  return out;
}

// ---------------- public demo API ----------------

export function demoBars(symbol: string, tf: Timeframe): Bar[] {
  const upper = symbol.toUpperCase();
  const crypto = isCryptoSymbol(upper);
  const { hist, today } = genDailyCore(upper);
  const s = crypto ? elapsedCryptoSteps() : elapsedSteps();
  const live = today !== null && s > 0;
  const path = live && today ? minutePath(upper, today) : null;
  const partial = live && today && path ? partialDaily(today, path, s, crypto ? roundPx : r2) : null;
  const daily = partial ? [...hist, partial] : hist;

  const intradayCase = (tfMin: number, maxDays: number): Bar[] => {
    const days = hist.slice(partial ? -(maxDays - 1) : -maxDays);
    const past = intradayHist(upper, days, tfMin, crypto);
    const liveBars =
      today && path ? todayIntraday(today, path, tfMin, s, crypto ? 0 : OPEN_MIN, crypto ? roundPx : r2) : [];
    return [...past, ...liveBars];
  };

  switch (tf) {
    case "1D":
      return daily.slice(-2016);
    case "1W":
      return aggregate(daily, "week");
    case "1M":
      return aggregate(daily, "month");
    case "1m":
      return intradayCase(1, 5);
    case "3m":
      return intradayCase(3, 10);
    case "5m":
      return intradayCase(5, 25);
    case "15m":
      return intradayCase(15, 60);
    case "30m":
      return intradayCase(30, 120);
    case "1h":
      return intradayCase(60, 250);
    case "4h":
      return intradayCase(240, 730);
  }
}

export function demoSnapshot(symbol: string, nowMs = Date.now()): Snapshot {
  const upper = symbol.toUpperCase();
  const crypto = isCryptoSymbol(upper);
  const round = crypto ? roundPx : r2;
  const { hist, today } = genDailyCore(upper);
  // crypto is ALWAYS live (24/7): no weekday / marketPhase gating, s is 0 only
  // in the exact midnight ET second → fall back to the last completed day
  const s = crypto ? elapsedCryptoSteps() : elapsedSteps();
  const live = today !== null && s > 0;

  let price: number;
  let open: number;
  let high: number;
  let low: number;
  let volume: number;
  let prevClose: number;

  if (live && today) {
    // session underway: the quote IS the live path value, identical to the
    // chart's last (forming) bar close on every timeframe
    const path = minutePath(upper, today);
    price = path.C[s];
    const part = partialDaily(today, path, s, round);
    open = part.open;
    high = part.high;
    low = part.low;
    volume = part.volume;
    prevClose = hist.length > 0 ? hist[hist.length - 1].close : part.open;
  } else {
    // pre-market / post-close / weekend: last completed session
    const last = hist[hist.length - 1];
    const prev = hist.length > 1 ? hist[hist.length - 2] : last;
    price = last.close;
    open = last.open;
    high = last.high;
    low = last.low;
    volume = last.volume;
    prevClose = prev.close;
  }

  price = round(price);
  const change = round(price - prevClose);
  // crypto tick sizes are a function of price (10 bps); the stock 1-cent floor
  // would be ~460× SHIB's price
  const spread = crypto ? Math.max(1e-8, price * 0.001) : Math.max(0.01, price * 0.0004);

  return {
    symbol: upper,
    price,
    prevClose: round(prevClose),
    change,
    changePct: r2(prevClose ? (change / prevClose) * 100 : 0),
    open,
    high,
    low,
    volume,
    bid: round(price - spread / 2),
    ask: round(price + spread / 2),
    tradeTime: Math.floor(nowMs / 1000),
  };
}

export function demoSnapshots(symbols: string[]): Record<string, Snapshot> {
  const out: Record<string, Snapshot> = {};
  for (const s of symbols) out[s.toUpperCase()] = demoSnapshot(s);
  return out;
}

export const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD", "NFLX", "AVGO",
  "TSM", "JPM", "V", "MA", "COST", "WMT", "XOM", "LLY", "PFE", "BA", "GE", "CAT",
  "UBER", "ABNB", "COIN", "PLTR", "SNOW", "SHOP", "SQ", "PYPL", "DIS", "NKE",
  "INTC", "MU", "SMCI", "ARM", "APP", "AFRM", "DKNG", "RIVN",
];

export function demoMovers(): MoversData {
  const snaps = UNIVERSE.map((s) => demoSnapshot(s));
  const sorted = [...snaps].sort((a, b) => b.changePct - a.changePct);
  return {
    gainers: sorted.slice(0, 10).map((s) => ({
      symbol: s.symbol, price: s.price, change: s.change, changePct: s.changePct, volume: s.volume,
    })),
    losers: sorted.slice(-10).reverse().map((s) => ({
      symbol: s.symbol, price: s.price, change: s.change, changePct: s.changePct, volume: s.volume,
    })),
  };
}

const NEWS_TEMPLATES: ((s: string) => string)[] = [
  (s) => `${s} shares move as traders weigh fresh guidance`,
  (s) => `Analysts raise ${s} price target on stronger-than-expected demand`,
  (s) => `${s} unveils new product roadmap at annual investor day`,
  (s) => `Institutional flows into ${s} hit a multi-month high`,
  (s) => `${s} earnings preview: what to watch this quarter`,
  (s) => `Sector rotation lifts ${s} as volatility subsides`,
  (s) => `${s} announces expanded buyback program`,
  (s) => `Options activity in ${s} spikes ahead of key macro print`,
  (s) => `Supply-chain checks point to steady order momentum for ${s}`,
  (s) => `Why ${s} could outperform in the second half`,
];

const NEWS_SOURCES = ["MarketPulse", "StreetWire", "FinDaily", "MacroMonitor", "EquityInsider", "TradeDispatch"];

export function demoNews(symbol: string): NewsItem[] {
  const upper = symbol.toUpperCase();
  const r = mulberry32(hashStr(`news:${upper}`));
  const count = 6 + Math.floor(r() * 3);
  const items: NewsItem[] = [];
  for (let i = 0; i < count; i++) {
    const headline = NEWS_TEMPLATES[Math.floor(r() * NEWS_TEMPLATES.length)](upper);
    items.push({
      id: `${upper}-demo-${i}`,
      headline,
      summary: `DEMO DATA — synthetic headline for ${upper}. Connect your Alpaca API keys in Settings to stream real market news for this symbol.`,
      source: NEWS_SOURCES[Math.floor(r() * NEWS_SOURCES.length)],
      url: "#",
      publishedAt: Math.floor((Date.now() - (i * 8 + r() * 14) * 3600e3) / 1000),
    });
  }
  return items;
}

const SYMBOL_DIRECTORY: SearchItem[] = (
  [
    ["AAPL", "Apple Inc.", "NASDAQ"], ["MSFT", "Microsoft Corporation", "NASDAQ"],
    ["NVDA", "NVIDIA Corporation", "NASDAQ"], ["TSLA", "Tesla, Inc.", "NASDAQ"],
    ["AMZN", "Amazon.com, Inc.", "NASDAQ"], ["GOOGL", "Alphabet Inc.", "NASDAQ"],
    ["META", "Meta Platforms, Inc.", "NASDAQ"], ["AMD", "Advanced Micro Devices, Inc.", "NASDAQ"],
    ["NFLX", "Netflix, Inc.", "NASDAQ"], ["AVGO", "Broadcom Inc.", "NASDAQ"],
    ["TSM", "Taiwan Semiconductor ADR", "NYSE"], ["JPM", "JPMorgan Chase & Co.", "NYSE"],
    ["V", "Visa Inc.", "NYSE"], ["MA", "Mastercard Incorporated", "NYSE"],
    ["BAC", "Bank of America Corporation", "NYSE"], ["COST", "Costco Wholesale Corporation", "NASDAQ"],
    ["WMT", "Walmart Inc.", "NYSE"], ["XOM", "Exxon Mobil Corporation", "NYSE"],
    ["LLY", "Eli Lilly and Company", "NYSE"], ["PFE", "Pfizer Inc.", "NYSE"],
    ["BA", "The Boeing Company", "NYSE"], ["GE", "GE Aerospace", "NYSE"],
    ["CAT", "Caterpillar Inc.", "NYSE"], ["UBER", "Uber Technologies, Inc.", "NYSE"],
    ["ABNB", "Airbnb, Inc.", "NASDAQ"], ["COIN", "Coinbase Global, Inc.", "NASDAQ"],
    ["PLTR", "Palantir Technologies Inc.", "NASDAQ"], ["SNOW", "Snowflake Inc.", "NYSE"],
    ["SHOP", "Shopify Inc.", "NYSE"], ["SQ", "Block, Inc.", "NYSE"],
    ["PYPL", "PayPal Holdings, Inc.", "NASDAQ"], ["DIS", "The Walt Disney Company", "NYSE"],
    ["NKE", "NIKE, Inc.", "NYSE"], ["INTC", "Intel Corporation", "NASDAQ"],
    ["MU", "Micron Technology, Inc.", "NASDAQ"], ["SMCI", "Super Micro Computer, Inc.", "NASDAQ"],
    ["ARM", "Arm Holdings plc ADR", "NASDAQ"], ["APP", "AppLovin Corporation", "NASDAQ"],
    ["AFRM", "Affirm Holdings, Inc.", "NASDAQ"], ["DKNG", "DraftKings Inc.", "NASDAQ"],
    ["RIVN", "Rivian Automotive, Inc.", "NASDAQ"], ["LCID", "Lucid Group, Inc.", "NASDAQ"],
    ["GME", "GameStop Corporation", "NYSE"], ["AMC", "AMC Entertainment Holdings, Inc.", "NYSE"],
    ["NET", "Cloudflare, Inc.", "NYSE"], ["TWLO", "Twilio Inc.", "NYSE"],
    ["ROKU", "Roku, Inc.", "NASDAQ"], ["SBUX", "Starbucks Corporation", "NASDAQ"],
    ["TGT", "Target Corporation", "NYSE"], ["HD", "The Home Depot, Inc.", "NYSE"],
    ["LOW", "Lowe's Companies, Inc.", "NYSE"], ["KO", "The Coca-Cola Company", "NYSE"],
    ["PEP", "PepsiCo, Inc.", "NASDAQ"], ["JNJ", "Johnson & Johnson", "NYSE"],
    ["UNH", "UnitedHealth Group Incorporated", "NYSE"], ["CRM", "Salesforce, Inc.", "NYSE"],
    ["ORCL", "Oracle Corporation", "NYSE"], ["ADBE", "Adobe Inc.", "NASDAQ"],
    ["CSCO", "Cisco Systems, Inc.", "NASDAQ"], ["IBM", "International Business Machines", "NYSE"],
    ["MCD", "McDonald's Corporation", "NYSE"], ["F", "Ford Motor Company", "NYSE"],
    ["GM", "General Motors Company", "NYSE"], ["SPY", "SPDR S&P 500 ETF Trust", "NYSE ARCA"],
    ["QQQ", "Invesco QQQ Trust", "NASDAQ"], ["IWM", "iShares Russell 2000 ETF", "NYSE ARCA"],
    ["DIA", "SPDR Dow Jones Industrial Average ETF", "NYSE ARCA"],
  ] as const
).map(([symbol, name, exchange]) => ({ symbol, name, exchange }));

const ALL_DIRECTORY: SearchItem[] = [...SYMBOL_DIRECTORY, ...cryptoDirectory()];

export function demoSearch(q: string): SearchItem[] {
  const query = q.trim().toUpperCase();
  if (!query) {
    // mirror live search: popular stocks plus the flagship crypto pairs
    return [
      ...SYMBOL_DIRECTORY.slice(0, 12),
      ...ALL_DIRECTORY.filter((s) => s.symbol === "BTC/USD" || s.symbol === "ETH/USD"),
    ];
  }
  const starts = ALL_DIRECTORY.filter((s) => s.symbol.startsWith(query));
  const contains = ALL_DIRECTORY.filter(
    (s) => !s.symbol.startsWith(query) && (s.symbol.includes(query) || s.name.toUpperCase().includes(query))
  );
  return [...starts, ...contains].slice(0, 20);
}

// ---------------- demo economic calendar ----------------

interface DemoEventSpec {
  weekday: number; // 1=Mon .. 5=Fri
  etHour: number;
  etMin: number;
  title: string;
  impact: EventImpact;
  currency: string;
}

const DEMO_EVENT_SPECS: DemoEventSpec[] = [
  { weekday: 1, etHour: 10, etMin: 0, title: "ISM Manufacturing PMI", impact: "high", currency: "USD" },
  { weekday: 1, etHour: 10, etMin: 30, title: "ISM Manufacturing Prices", impact: "low", currency: "USD" },
  { weekday: 2, etHour: 8, etMin: 30, title: "Core CPI m/m", impact: "high", currency: "USD" },
  { weekday: 2, etHour: 8, etMin: 30, title: "CPI y/y", impact: "high", currency: "USD" },
  { weekday: 2, etHour: 9, etMin: 45, title: "Flash Services PMI", impact: "medium", currency: "USD" },
  { weekday: 3, etHour: 8, etMin: 30, title: "Core PPI m/m", impact: "medium", currency: "USD" },
  { weekday: 3, etHour: 10, etMin: 30, title: "Crude Oil Inventories", impact: "medium", currency: "USD" },
  { weekday: 3, etHour: 14, etMin: 0, title: "FOMC Statement and Rate Decision", impact: "high", currency: "USD" },
  { weekday: 3, etHour: 14, etMin: 30, title: "FOMC Press Conference", impact: "high", currency: "USD" },
  { weekday: 4, etHour: 8, etMin: 30, title: "Unemployment Claims", impact: "medium", currency: "USD" },
  { weekday: 4, etHour: 8, etMin: 30, title: "Retail Sales m/m", impact: "high", currency: "USD" },
  { weekday: 4, etHour: 10, etMin: 0, title: "Existing Home Sales", impact: "low", currency: "USD" },
  { weekday: 5, etHour: 8, etMin: 30, title: "Non-Farm Employment Change", impact: "high", currency: "USD" },
  { weekday: 5, etHour: 8, etMin: 30, title: "Average Hourly Earnings m/m", impact: "medium", currency: "USD" },
  { weekday: 5, etHour: 8, etMin: 30, title: "Unemployment Rate", impact: "high", currency: "USD" },
  { weekday: 1, etHour: 5, etMin: 0, title: "German ifo Business Climate", impact: "medium", currency: "EUR" },
  { weekday: 2, etHour: 2, etMin: 0, title: "BOE Gov Bailey Speaks", impact: "medium", currency: "GBP" },
  { weekday: 4, etHour: 20, etMin: 50, title: "BOJ Policy Statement", impact: "high", currency: "JPY" },
  { weekday: 1, etHour: 4, etMin: 30, title: "German Manufacturing PMI Flash", impact: "medium", currency: "EUR" },
  { weekday: 1, etHour: 8, etMin: 0, title: "Canadian IPPI m/m", impact: "low", currency: "CAD" },
  { weekday: 2, etHour: 5, etMin: 0, title: "German ZEW Economic Sentiment", impact: "medium", currency: "EUR" },
  { weekday: 2, etHour: 8, etMin: 30, title: "Building Permits", impact: "medium", currency: "USD" },
  { weekday: 2, etHour: 10, etMin: 0, title: "Prelim UoM Consumer Sentiment", impact: "medium", currency: "USD" },
  { weekday: 3, etHour: 8, etMin: 30, title: "Durable Goods Orders m/m", impact: "medium", currency: "USD" },
  { weekday: 3, etHour: 8, etMin: 30, title: "GDP q/q (Prelim)", impact: "high", currency: "USD" },
  { weekday: 3, etHour: 5, etMin: 0, title: "French Consumer Spending m/m", impact: "low", currency: "EUR" },
  { weekday: 3, etHour: 21, etMin: 30, title: "AUD RBA Governor Speaks", impact: "medium", currency: "AUD" },
  { weekday: 4, etHour: 8, etMin: 30, title: "Core PCE Price Index m/m", impact: "high", currency: "USD" },
  { weekday: 4, etHour: 8, etMin: 30, title: "Trade Balance", impact: "low", currency: "USD" },
  { weekday: 4, etHour: 10, etMin: 0, title: "Natural Gas Storage", impact: "low", currency: "USD" },
  { weekday: 4, etHour: 4, etMin: 0, title: "UK Retail Sales m/m", impact: "medium", currency: "GBP" },
  { weekday: 5, etHour: 9, etMin: 45, title: "Chicago PMI", impact: "low", currency: "USD" },
  { weekday: 5, etHour: 8, etMin: 30, title: "Employment Cost Index q/q", impact: "medium", currency: "USD" },
  { weekday: 5, etHour: 4, etMin: 30, title: "German Retail Sales m/m", impact: "low", currency: "EUR" },
  { weekday: 5, etHour: 19, etMin: 30, title: "CFTC Speculative Positioning", impact: "low", currency: "USD" },
];

function isoMonday(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Synthetic economic events for the current and next Mon–Fri weeks (deterministic
 *  per week). Events that are already past carry a deterministic `actual` near the
 *  forecast so the calendar page can show Actual vs Forecast vs Prior. */
export function demoCalendar(): EconEvent[] {
  const { dateStr } = etNow();
  const nowSec = Math.floor(Date.now() / 1000);
  const thisMonday = isoMonday(dateStr);
  const events: EconEvent[] = [];
  for (const weekOffset of [0, 1]) {
    const monday = new Date(`${thisMonday}T12:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() + weekOffset * 7);
    const mondayStr = monday.toISOString().slice(0, 10);
    const r = mulberry32(hashStr(`cal:${mondayStr}`));
    for (const spec of DEMO_EVENT_SPECS) {
      const day = new Date(`${mondayStr}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() + (spec.weekday - 1));
      const dateStr2 = day.toISOString().slice(0, 10);
      // ET wall-clock -> UTC epoch (mirror tzOffsetSec logic)
      const openUTC = Date.parse(`${dateStr2}T${String(spec.etHour).padStart(2, "0")}:${String(spec.etMin).padStart(2, "0")}:00Z`) / 1000 - tzOffsetSec(dateStr2);
      const forecast = spec.impact === "holiday" ? null : (0.1 + r() * 0.6).toFixed(1);
      const previous = spec.impact === "holiday" ? null : (0.1 + r() * 0.6).toFixed(1);
      const actual =
        spec.impact !== "holiday" && forecast !== null && openUTC < nowSec
          ? Math.max(0, Number(forecast) + (r() - 0.5) * 0.3).toFixed(1)
          : null;
      events.push({
        id: `demo-${spec.title.replace(/\W+/g, "-").toLowerCase()}-${dateStr2}`,
        time: openUTC,
        currency: spec.currency,
        impact: spec.impact,
        title: spec.title,
        actual,
        forecast,
        previous,
        synthetic: true,
      });
    }
  }
  return events.sort((a, b) => a.time - b.time);
}
