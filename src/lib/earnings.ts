/**
 * Deterministic synthetic earnings calendar.
 *
 * Alpaca's data API has NO earnings-calendar endpoint (its corporate-actions
 * API covers dividends/splits only), so earnings are generated — flagged
 * `synthetic: true` in the API response — for BOTH demo and live modes.
 *
 * Every event's content is derived from hash(symbol + year + month), so a
 * given quarter's date/when/EPS never shifts as time passes (the window and
 * the past/future actual-EPS split simply move with "today").
 */

// ---------------- tiny seeded helpers (local copies — do NOT import demo-data) ----------------

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

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Today's date in US/Eastern as "YYYY-MM-DD" (en-CA formats as ISO). */
function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ---------------- model ----------------

export interface EarningsEvent {
  id: string;
  /** report date, "YYYY-MM-DD" in US/Eastern */
  date: string;
  /** before market open / after market close */
  when: "bmo" | "amc";
  epsEstimate: number | null;
  /** filled only for past reports (date < today ET) */
  epsActual: number | null;
  synthetic: true;
}

// ~5y of history + ~4 months of forward schedule per symbol
const QUARTER_MONTHS = [2, 5, 8, 11]; // Feb / May / Aug / Nov (±0-1 month jitter)

const cache = new Map<string, { today: string; events: EarningsEvent[] }>();

function genEarnings(symbol: string): EarningsEvent[] {
  const today = etToday();
  const hit = cache.get(symbol);
  if (hit && hit.today === today) return hit.events;

  // which 4-month reporting cycle this symbol uses (Feb/May/Aug/Nov ± 1 month)
  const sr = mulberry32(hashStr(`earn-start:${symbol}`));
  const base = QUARTER_MONTHS[Math.floor(sr() * 4)];
  const startMonth = Math.min(12, Math.max(1, base + Math.floor(sr() * 3) - 1));

  // stable per-symbol EPS magnitude (≈ plausible for large caps: 0.5–3.5)
  const epsBase = 0.5 + ((hashStr(`earn-scale:${symbol}`) % 1000) / 1000) * 3.0;

  const [ty, tm] = today.split("-").map(Number);
  const events: EarningsEvent[] = [];
  // linear month index anchored at year 0 so arithmetic stays positive
  for (let M = (ty - 6) * 12 + 1; M <= ty * 12 + tm + 4; M++) {
    const y = Math.floor((M - 1) / 12);
    const m = ((M - 1) % 12) + 1;
    if ((m - startMonth + 12) % 3 !== 0) continue; // not a report month

    // per-quarter seeded draws — keyed by symbol+year+month, immutable over time
    const rr = mulberry32(hashStr(`earn:${symbol}:${y}:${m}`));
    let day = 15 + Math.floor(rr() * 11); // mid-month 15..25
    const wd = new Date(`${y}-${pad2(m)}-${pad2(day)}T12:00:00Z`).getUTCDay();
    if (wd === 6) day += 2; // Sat → Mon
    else if (wd === 0) day += 1; // Sun → Mon
    const when: "bmo" | "amc" = rr() < 0.45 ? "bmo" : "amc";
    const epsEstimate = Math.round(epsBase * (0.8 + rr() * 0.4) * 100) / 100;
    const beat = rr() * 0.6 + 0.7; // actual = 0.7x–1.3x of estimate
    const date = `${y}-${pad2(m)}-${pad2(day)}`;
    const past = date < today;
    events.push({
      id: `${symbol}:${date}`,
      date,
      when,
      epsEstimate,
      epsActual: past ? Math.round(epsEstimate * beat * 100) / 100 : null,
      synthetic: true,
    });
  }

  if (cache.size > 512) cache.clear();
  cache.set(symbol, { today, events });
  return events;
}

/** Full generated schedule for a symbol — past events carry epsActual, future ones don't. */
export function demoEarnings(symbol: string): EarningsEvent[] {
  return genEarnings(symbol);
}

/** The soonest future (or today) earnings event, or null. */
export function nextEarnings(symbol: string): EarningsEvent | null {
  const today = etToday();
  for (const e of genEarnings(symbol)) {
    if (e.date >= today) return e; // ascending by construction
  }
  return null;
}

/** Events whose report date falls in [fromDate, toDate] (inclusive, YYYY-MM-DD). */
export function getEarningsBetween(symbol: string, fromDate: string, toDate: string): EarningsEvent[] {
  return genEarnings(symbol).filter((e) => e.date >= fromDate && e.date <= toDate);
}
