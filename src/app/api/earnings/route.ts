import { NextRequest, NextResponse } from "next/server";
import { getCreds, hasLive } from "@/lib/alpaca";
import { sessionUser } from "@/lib/auth";
import { demoEarnings } from "@/lib/earnings";
import { isCryptoSymbol } from "@/lib/symbols";
import { jsonError, parseSymbol } from "@/lib/route-utils";
import type { DataMode } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Earnings calendar. Alpaca has no earnings endpoint, so the deterministic
 * demo generator serves BOTH modes and the response is flagged `synthetic`.
 * Crypto pairs have no earnings → an empty events list (still flagged).
 */
export async function GET(req: NextRequest) {
  try {
    const symbol = parseSymbol(req.nextUrl.searchParams.get("symbol"));
    if (!symbol) return jsonError("Invalid or missing symbol");

    const user = await sessionUser(req).catch(() => null);
    const creds = await getCreds(user?.id ?? null);
    const mode: DataMode = hasLive(creds) ? "live" : "demo";
    const events = isCryptoSymbol(symbol) ? [] : demoEarnings(symbol);
    return NextResponse.json({ events, mode, synthetic: true });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load earnings", 502);
  }
}
