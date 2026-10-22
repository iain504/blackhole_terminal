import { NextRequest, NextResponse } from "next/server";
import { getCreds, hasLive, searchLive } from "@/lib/alpaca";
import { demoSearch } from "@/lib/demo-data";
import { sessionUser } from "@/lib/auth";
import { jsonError } from "@/lib/route-utils";
import type { DataMode, SearchItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 30);
    const user = await sessionUser(req).catch(() => null);
    const creds = await getCreds(user?.id ?? null);
    let results: SearchItem[];
    let mode: DataMode;
    if (hasLive(creds)) {
      results = await searchLive(creds, q);
      mode = "live";
    } else {
      results = demoSearch(q);
      mode = "demo";
    }
    return NextResponse.json({ results, mode });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Search failed", 502);
  }
}
