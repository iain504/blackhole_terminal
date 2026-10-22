import { NextRequest, NextResponse } from "next/server";
import { fetchNewsLive, getCreds, hasLive } from "@/lib/alpaca";
import { demoNews } from "@/lib/demo-data";
import { sessionUser } from "@/lib/auth";
import { jsonError, parseSymbol } from "@/lib/route-utils";
import type { DataMode, NewsItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const symbol = parseSymbol(req.nextUrl.searchParams.get("symbol"));
    if (!symbol) return jsonError("Invalid or missing symbol");

    const user = await sessionUser(req).catch(() => null);
    const creds = await getCreds(user?.id ?? null);
    let news: NewsItem[];
    let mode: DataMode;
    if (hasLive(creds)) {
      news = await fetchNewsLive(creds, symbol);
      mode = "live";
    } else {
      news = demoNews(symbol);
      mode = "demo";
    }
    return NextResponse.json({ news, mode });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load news", 502);
  }
}
