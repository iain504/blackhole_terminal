import { NextRequest, NextResponse } from "next/server";
import { fetchMoversLive, getCreds, hasLive } from "@/lib/alpaca";
import { demoMovers, UNIVERSE } from "@/lib/demo-data";
import { sessionUser } from "@/lib/auth";
import { jsonError } from "@/lib/route-utils";
import type { DataMode, MoversData } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await sessionUser(req).catch(() => null);
    const creds = await getCreds(user?.id ?? null);
    let data: MoversData;
    let mode: DataMode;
    if (hasLive(creds)) {
      data = await fetchMoversLive(creds, UNIVERSE);
      mode = "live";
    } else {
      data = demoMovers();
      mode = "demo";
    }
    return NextResponse.json({ ...data, mode });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load movers", 502);
  }
}
