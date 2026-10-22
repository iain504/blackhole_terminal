export const UP_COLOR = "#26a69a";
export const DOWN_COLOR = "#ef5350";
export const FLAT_COLOR = "#787b86";

export function upDownClass(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n === 0) return "text-[#787b86]";
  return n > 0 ? "text-[#26a69a]" : "text-[#ef5350]";
}

export function fmtPrice(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Smart-precision number format: handles sub-dollar crypto (SHIB, DOGE) that a
 *  fixed 2dp format would destroy. |n| >= 1 → 2dp grouped; >= 0.01 → 4dp;
 *  below → up to 6 significant digits (trailing zeros trimmed, ≥ 2 decimals). */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1) return fmtPrice(n, 2);
  if (a >= 0.01) return n.toFixed(4);
  if (a === 0) return "0.00";
  let s = n.toPrecision(6);
  if (s.includes("e")) s = n.toFixed(10);
  // trim trailing zeros but always keep at least 2 decimal places
  const dot = s.indexOf(".");
  if (dot >= 0) {
    let end = s.length;
    while (end > dot + 3 && s[end - 1] === "0") end--;
    s = s.slice(0, end);
  }
  return s;
}

/** lightweight-charts priceFormat for a symbol trading around `price`. */
export function priceFormatFor(price: number | null | undefined): {
  type: "price";
  precision: number;
  minMove: number;
} {
  const p = Math.abs(Number(price));
  const precision = !isFinite(p) || p >= 1 ? 2 : p >= 0.01 ? 4 : 8;
  return { type: "price", precision, minMove: Math.pow(10, -precision) };
}

export function fmtSigned(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${fmtPrice(n, digits)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function fmtVolume(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtTimeAgo(unixSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - unixSec);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtClockET(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

export function fmtBarTime(time: number | string): string {
  if (typeof time === "string") {
    return new Date(`${time}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return fmtDateTime(time);
}
