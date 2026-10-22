import { NextRequest, NextResponse } from "next/server";
import { fetchBarsLive, getCreds, hasLive } from "@/lib/alpaca";
import { demoBars } from "@/lib/demo-data";
import { sessionUser } from "@/lib/auth";
import { jsonError, parseSymbol } from "@/lib/route-utils";
import type { Bar, DataMode, Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

const TFS = new Set<string>(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"]);

export async function GET(req: NextRequest) {
  try {
    const symbol = parseSymbol(req.nextUrl.searchParams.get("symbol"));
    const tf = req.nextUrl.searchParams.get("tf") ?? "1D";
    if (!symbol) return jsonError("Invalid or missing symbol");
    if (!TFS.has(tf)) return jsonError("Invalid timeframe");

    const user = await sessionUser(req).catch(() => null);
    const creds = await getCreds(user?.id ?? null);
    let bars: Bar[];
    let mode: DataMode;
    if (hasLive(creds)) {
      bars = await fetchBarsLive(creds, symbol, tf as Timeframe);
      mode = "live";
    } else {
      bars = demoBars(symbol, tf as Timeframe);
      mode = "demo";
    }
    return NextResponse.json({ bars, mode });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load bars", 502);
  }
}
