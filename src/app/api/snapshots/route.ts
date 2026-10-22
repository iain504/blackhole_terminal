import { NextRequest, NextResponse } from "next/server";
import { fetchSnapshotsLive, getCreds, hasLive } from "@/lib/alpaca";
import { demoSnapshots } from "@/lib/demo-data";
import { sessionUser } from "@/lib/auth";
import { jsonError, parseSymbols } from "@/lib/route-utils";
import type { DataMode, Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const symbols = parseSymbols(req.nextUrl.searchParams.get("symbols"));
    if (!symbols.length) return NextResponse.json({ snapshots: {}, mode: "demo" });

    const user = await sessionUser(req).catch(() => null);
    const creds = await getCreds(user?.id ?? null);
    let snapshots: Record<string, Snapshot>;
    let mode: DataMode;
    if (hasLive(creds)) {
      snapshots = await fetchSnapshotsLive(creds, symbols);
      mode = "live";
    } else {
      snapshots = demoSnapshots(symbols);
      mode = "demo";
    }
    return NextResponse.json({ snapshots, mode });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load snapshots", 502);
  }
}
