import { NextResponse } from "next/server";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// Symbols: stock tickers (AAPL, BRK.B) and crypto pairs (BTC/USD) — slashes,
// digits and dashes are allowed; everything is uppercased and length-capped.
const SYMBOL_RE = /^[A-Z0-9./-]{1,12}$/;

export function parseSymbols(raw: string | null, max = 40): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => SYMBOL_RE.test(x))
    .slice(0, max);
}

export function parseSymbol(raw: string | null): string | null {
  const s = (raw ?? "").trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}
