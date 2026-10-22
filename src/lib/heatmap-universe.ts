/**
 * Heat-map universe: static US large-cap list (sizing only — live/demo quotes
 * come from /api/snapshots) + the squarified treemap layout algorithm.
 * Dependency-free, shared by the full-page Heat Map tab.
 *
 * Market caps / prices are rough real-world guides: they only drive tile
 * sizing and labels, never trading data.
 */

export interface HeatmapEntry {
  symbol: string;
  name: string;
  sector: string;
  /** approximate USD market cap, drives tile area */
  mcap: number;
}

export const US_UNIVERSE: readonly HeatmapEntry[] = [
  { symbol: "AAPL", name: "Apple", sector: "Technology", mcap: 3.4e12 },
  { symbol: "MSFT", name: "Microsoft", sector: "Technology", mcap: 3.1e12 },
  { symbol: "NVDA", name: "NVIDIA", sector: "Technology", mcap: 3.3e12 },
  { symbol: "GOOGL", name: "Alphabet", sector: "Communication Services", mcap: 2.3e12 },
  { symbol: "AMZN", name: "Amazon", sector: "Consumer Discretionary", mcap: 2.3e12 },
  { symbol: "META", name: "Meta Platforms", sector: "Communication Services", mcap: 1.5e12 },
  { symbol: "TSLA", name: "Tesla", sector: "Consumer Discretionary", mcap: 1.1e12 },
  { symbol: "AVGO", name: "Broadcom", sector: "Technology", mcap: 8e11 },
  { symbol: "LLY", name: "Eli Lilly", sector: "Healthcare", mcap: 7.5e11 },
  { symbol: "JPM", name: "JPMorgan Chase", sector: "Financials", mcap: 6.8e11 },
  { symbol: "WMT", name: "Walmart", sector: "Consumer Staples", mcap: 6.9e11 },
  { symbol: "V", name: "Visa", sector: "Financials", mcap: 6.3e11 },
  { symbol: "XOM", name: "Exxon Mobil", sector: "Energy", mcap: 5.2e11 },
  { symbol: "UNH", name: "UnitedHealth", sector: "Healthcare", mcap: 5e11 },
  { symbol: "MA", name: "Mastercard", sector: "Financials", mcap: 4.6e11 },
  { symbol: "ORCL", name: "Oracle", sector: "Technology", mcap: 4.6e11 },
  { symbol: "COST", name: "Costco", sector: "Consumer Staples", mcap: 4e11 },
  { symbol: "HD", name: "Home Depot", sector: "Consumer Discretionary", mcap: 3.8e11 },
  { symbol: "NFLX", name: "Netflix", sector: "Communication Services", mcap: 3.8e11 },
  { symbol: "JNJ", name: "Johnson & Johnson", sector: "Healthcare", mcap: 3.7e11 },
  { symbol: "CRM", name: "Salesforce", sector: "Technology", mcap: 3.3e11 },
  { symbol: "BAC", name: "Bank of America", sector: "Financials", mcap: 3.1e11 },
  { symbol: "KO", name: "Coca-Cola", sector: "Consumer Staples", mcap: 2.7e11 },
  { symbol: "PEP", name: "PepsiCo", sector: "Consumer Staples", mcap: 2.3e11 },
  { symbol: "CSCO", name: "Cisco", sector: "Technology", mcap: 2.4e11 },
  { symbol: "ADBE", name: "Adobe", sector: "Technology", mcap: 2.2e11 },
  { symbol: "MCD", name: "McDonald's", sector: "Consumer Discretionary", mcap: 2.1e11 },
  { symbol: "IBM", name: "IBM", sector: "Technology", mcap: 2.1e11 },
  { symbol: "AMD", name: "Advanced Micro Devices", sector: "Technology", mcap: 2e11 },
  { symbol: "GE", name: "GE Aerospace", sector: "Industrials", mcap: 1.9e11 },
  { symbol: "DIS", name: "Walt Disney", sector: "Communication Services", mcap: 1.8e11 },
  { symbol: "CAT", name: "Caterpillar", sector: "Industrials", mcap: 1.7e11 },
  { symbol: "PLTR", name: "Palantir", sector: "Technology", mcap: 1.7e11 },
  { symbol: "APP", name: "AppLovin", sector: "Technology", mcap: 1.9e11 },
  { symbol: "PFE", name: "Pfizer", sector: "Healthcare", mcap: 1.6e11 },
  { symbol: "BA", name: "Boeing", sector: "Industrials", mcap: 1.3e11 },
  { symbol: "MU", name: "Micron", sector: "Technology", mcap: 1.2e11 },
  { symbol: "NKE", name: "Nike", sector: "Consumer Discretionary", mcap: 1.2e11 },
  { symbol: "LOW", name: "Lowe's", sector: "Consumer Discretionary", mcap: 1.4e11 },
  { symbol: "UBER", name: "Uber", sector: "Industrials", mcap: 1.4e11 },
  { symbol: "ARM", name: "Arm Holdings", sector: "Technology", mcap: 1.4e11 },
  { symbol: "SBUX", name: "Starbucks", sector: "Consumer Discretionary", mcap: 1.1e11 },
  { symbol: "SHOP", name: "Shopify", sector: "Technology", mcap: 1e11 },
  { symbol: "INTC", name: "Intel", sector: "Technology", mcap: 9.5e10 },
  { symbol: "ABNB", name: "Airbnb", sector: "Consumer Discretionary", mcap: 8.3e10 },
  { symbol: "TGT", name: "Target", sector: "Consumer Discretionary", mcap: 6e10 },
  { symbol: "COIN", name: "Coinbase", sector: "Financials", mcap: 6.6e10 },
  { symbol: "PYPL", name: "PayPal", sector: "Financials", mcap: 7e10 },
  { symbol: "SQ", name: "Block", sector: "Financials", mcap: 6.4e10 },
  { symbol: "SNOW", name: "Snowflake", sector: "Technology", mcap: 5.5e10 },
  { symbol: "NET", name: "Cloudflare", sector: "Technology", mcap: 3.3e10 },
  { symbol: "SMCI", name: "Super Micro", sector: "Technology", mcap: 2.4e10 },
  { symbol: "AFRM", name: "Affirm", sector: "Financials", mcap: 1.7e10 },
  { symbol: "ROKU", name: "Roku", sector: "Communication Services", mcap: 1e10 },
  { symbol: "GME", name: "GameStop", sector: "Consumer Discretionary", mcap: 1e10 },
  { symbol: "RIVN", name: "Rivian", sector: "Consumer Discretionary", mcap: 1.2e10 },
  { symbol: "TWLO", name: "Twilio", sector: "Technology", mcap: 1.1e10 },
  { symbol: "ZM", name: "Zoom", sector: "Technology", mcap: 1.2e10 },
  { symbol: "DKNG", name: "DraftKings", sector: "Consumer Discretionary", mcap: 8e9 },
  { symbol: "LCID", name: "Lucid Group", sector: "Consumer Discretionary", mcap: 7e9 },
];

/** Sector chip colors for the filter dropdown / legend (terminal palette). */
export const SECTOR_COLORS: Record<string, string> = {
  Technology: "#26a69a",
  "Communication Services": "#e056fd",
  "Consumer Discretionary": "#ff9800",
  Healthcare: "#66bb6a",
  Financials: "#f0b90b",
  Energy: "#ef5350",
  "Consumer Staples": "#ab47bc",
  Industrials: "#787b86",
  Crypto: "#f0b90b",
};

/** Sectors present in the US universe, ordered by total market cap desc. */
export const UNIVERSE_SECTORS: string[] = Object.entries(
  US_UNIVERSE.reduce<Record<string, number>>((acc, u) => {
    acc[u.sector] = (acc[u.sector] ?? 0) + u.mcap;
    return acc;
  }, {})
)
  .sort((a, b) => b[1] - a[1])
  .map(([s]) => s);

// ---------------- squarified treemap (Bruls, Huizing & van Wijk) ----------------

export interface TreemapDatum<T> {
  item: T;
  /** value that drives the rectangle area (e.g. market cap) */
  value: number;
}

export interface TreemapRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

function rowWorst(row: number[], length: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const min = Math.min(...row);
  const max = Math.max(...row);
  const l2 = length * length;
  const s2 = sum * sum;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

/**
 * Squarified treemap layout. `items` are laid out into the rect
 * (x, y, w, h) with each rectangle's area proportional to `value`.
 * Returns one rect per (positive, finite) input item, sorted by value desc.
 */
export function squarify<T>(
  items: readonly TreemapDatum<T>[],
  x: number,
  y: number,
  w: number,
  h: number
): TreemapRect<T>[] {
  const rects: TreemapRect<T>[] = [];
  if (w <= 0 || h <= 0) return rects;

  const sorted = items
    .filter((d) => Number.isFinite(d.value) && d.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = sorted.reduce((a, d) => a + d.value, 0);
  if (sorted.length === 0 || total <= 0) return rects;

  const areas = sorted.map((d) => (d.value / total) * w * h);
  const laid = sorted.map((d) => d.item);

  // remaining canvas rect + current row being filled
  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;
  let row: number[] = []; // normalized areas in the current row

  const flushRow = () => {
    if (row.length === 0) return;
    const sum = row.reduce((a, b) => a + b, 0);
    if (cw >= ch) {
      // vertical strip: fixed width, items stacked along the height
      const thickness = sum / ch;
      let oy = cy;
      for (const area of row) {
        const ih = area / thickness;
        const item = laid[rects.length];
        rects.push({ item, x: cx, y: oy, w: thickness, h: ih });
        oy += ih;
      }
      cx += thickness;
      cw -= thickness;
    } else {
      // horizontal strip: fixed height, items stacked along the width
      const thickness = sum / cw;
      let ox = cx;
      for (const area of row) {
        const iw = area / thickness;
        const item = laid[rects.length];
        rects.push({ item, x: ox, y: cy, w: iw, h: thickness });
        ox += iw;
      }
      cy += thickness;
      ch -= thickness;
    }
    row = [];
  };

  for (let i = 0; i < areas.length; i++) {
    if (row.length === 0) {
      row.push(areas[i]);
      continue;
    }
    const length = Math.min(cw, ch); // side along which the row is laid out
    const candidate = [...row, areas[i]];
    // would adding item i keep the row's worst aspect ratio at least as good?
    if (rowWorst(candidate, length) <= rowWorst(row, length)) {
      row.push(areas[i]);
    } else {
      flushRow();
      row.push(areas[i]);
    }
  }
  flushRow();

  return rects;
}

// ---------------- number formatting ----------------

/**
 * Local fallback for the shared sub-dollar-aware number formatter
 * (the parallel task 16-c is adding `fmtNum` to @/lib/format; until it
 * exists the heat map uses this identical-behaviour helper).
 * Crypto pairs quote sub-dollar prices (e.g. SHIB 0.0000215) — keep 4
 * significant digits there, plain 2–4 decimals otherwise.
 */
export function fmtVal(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (abs === 0) return "0.00";
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** Compact market-cap label: $3.40T / $940.0B / $21.5M. */
export function fmtMcap(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n)}`;
}
