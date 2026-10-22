/**
 * Chart drawing tools: shapes, localStorage persistence and hit-testing.
 * Anchors are stored in market coordinates (time + price) so drawings stay
 * glued to bars when the user pans / zooms / switches symbols. Points that
 * fall in the empty area right of the last bar are anchored by logical
 * offset instead (`off` = bars beyond the last index).
 */

export type DrawTool = "cursor" | "trend" | "ray" | "hline" | "vline" | "rect" | "brush" | "fib";
export type DrawShape = Exclude<DrawTool, "cursor">;

/** Fibonacci retracement levels (fraction of the A→B swing measured from B). */
export const FIB_LEVELS: readonly { level: number; color: string }[] = [
  { level: 0, color: "#787b86" },
  { level: 0.236, color: "#ef5350" },
  { level: 0.382, color: "#ff9800" },
  { level: 0.5, color: "#26a69a" },
  { level: 0.618, color: "#42a5f5" },
  { level: 0.786, color: "#ab47bc" },
  { level: 1, color: "#787b86" },
];

export interface DrawAnchor {
  /** Market time (unix sec for intraday, "YYYY-MM-DD" for daily+). */
  time?: number | string | null;
  /** Logical index offset from the last bar (used when time is outside the data set). */
  off?: number;
  price: number;
}

export interface Drawing {
  id: string;
  tool: DrawShape;
  color: string;
  points: DrawAnchor[];
}

export const DRAW_COLORS = ["#26a69a", "#ef5350", "#f0b90b", "#e056fd", "#d1d4dc"];

const LS_KEY = "fluxview.drawings.v1";

// module-level singleton lives in chart-panel; this hook lets the account
// state-sync wipe it so the next getDrawingStore() re-reads localStorage.
let onReset: (() => void) | null = null;

/** Register the reset hook used by the per-user state sync (chart-panel wires it). */
export function setDrawingResetHook(fn: () => void): void {
  onReset = fn;
}

/** Drop the cached drawing store so it reloads from localStorage. */
export function resetDrawingStore(): void {
  onReset?.();
}

export function loadDrawingStore(): Record<string, Drawing[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Drawing[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v as Drawing[];
    }
    return out;
  } catch {
    return {};
  }
}

export function persistDrawingStore(store: Record<string, Drawing[]>): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // storage full / unavailable — drawings stay in-memory
  }
}

export function drawingKey(symbol: string, tf: string): string {
  return `${symbol}|${tf}`;
}

// ---------------- hit testing ----------------

export interface Pt {
  x: number;
  y: number;
}

/** Result of a hit test: which drawing, and whether an endpoint handle (`handle`) or the body. */
export interface DrawHit {
  id: string;
  /** Index of the grabbed endpoint (0-based), or null when the body was hit. */
  handle: number | null;
}

export type Projector = (a: DrawAnchor) => Pt | null;

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Returns the topmost drawing under (px, py), or null.
 * Endpoint handles are checked before the shape body so grabbing a handle
 * always wins over grabbing the line itself.
 */
export function hitTestDrawings(
  px: number,
  py: number,
  drawings: Drawing[],
  project: Projector,
  tol = 7,
  handleTol = 9
): DrawHit | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    const pts = d.points.map(project);
    if (pts.some((p) => p === null)) continue;
    const p = pts as Pt[];

    // 1) endpoint handles (brush has no endpoints)
    if (d.tool !== "brush") {
      for (let h = 0; h < p.length; h++) {
        if (Math.hypot(px - p[h].x, py - p[h].y) <= handleTol) return { id: d.id, handle: h };
      }
    }

    // 2) shape body
    switch (d.tool) {
      case "hline":
        if (Math.abs(py - p[0].y) <= tol) return { id: d.id, handle: null };
        break;
      case "vline":
        if (Math.abs(px - p[0].x) <= tol) return { id: d.id, handle: null };
        break;
      case "trend":
        if (distToSeg(px, py, p[0].x, p[0].y, p[1].x, p[1].y) <= tol) return { id: d.id, handle: null };
        break;
      case "ray": {
        const dx = p[1].x - p[0].x;
        const dy = p[1].y - p[0].y;
        const len = Math.hypot(dx, dy) || 1;
        const ex = p[0].x + (dx / len) * 100000;
        const ey = p[0].y + (dy / len) * 100000;
        if (distToSeg(px, py, p[0].x, p[0].y, ex, ey) <= tol) return { id: d.id, handle: null };
        break;
      }
      case "rect": {
        const x1 = Math.min(p[0].x, p[1].x);
        const x2 = Math.max(p[0].x, p[1].x);
        const y1 = Math.min(p[0].y, p[1].y);
        const y2 = Math.max(p[0].y, p[1].y);
        const nearH = py >= y1 - tol && py <= y2 + tol && (Math.abs(px - x1) <= tol || Math.abs(px - x2) <= tol);
        const nearV = px >= x1 - tol && px <= x2 + tol && (Math.abs(py - y1) <= tol || Math.abs(py - y2) <= tol);
        if (nearH || nearV) return { id: d.id, handle: null };
        break;
      }
      case "brush": {
        for (let j = 1; j < p.length; j++) {
          if (distToSeg(px, py, p[j - 1].x, p[j - 1].y, p[j].x, p[j].y) <= tol) return { id: d.id, handle: null };
        }
        break;
      }
      case "fib": {
        if (p.length < 2) break;
        const x1 = Math.min(p[0].x, p[1].x);
        const x2 = Math.max(p[0].x, p[1].x);
        if (px < x1 - tol || px > x2 + tol) break;
        for (const { level } of FIB_LEVELS) {
          const ly = p[1].y + level * (p[0].y - p[1].y);
          if (Math.abs(py - ly) <= tol) return { id: d.id, handle: null };
        }
        break;
      }
    }
  }
  return null;
}
