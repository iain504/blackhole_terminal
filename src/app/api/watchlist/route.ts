import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonError, parseSymbol } from "@/lib/route-utils";
import { authGate, sessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Resolve a list within the caller's scope (explicit id, else the first). */
async function resolveListId(userId: string | null, raw: string | null): Promise<string | null> {
  const scope = userId ? { userId } : { userId: null };
  if (raw) {
    const found = await db.watchlist.findFirst({ where: { id: raw, ...scope } });
    return found?.id ?? null;
  }
  const lists = await db.watchlist.findMany({ where: scope, orderBy: { createdAt: "asc" }, take: 1 });
  return lists[0]?.id ?? null;
}

export async function GET(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    const listId = await resolveListId(user?.id ?? null, req.nextUrl.searchParams.get("listId"));
    if (!listId) return jsonError("No watchlist found");
    const rows = await db.watchlistItem.findMany({ where: { listId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ symbols: rows.map((r) => r.symbol) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load watchlist", 500);
  }
}

export async function POST(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    const body = (await req.json()) as { symbol?: string; listId?: string };
    const symbol = parseSymbol(body.symbol ?? null);
    if (!symbol) return jsonError("Invalid symbol");
    const listId = await resolveListId(user?.id ?? null, body.listId ?? null);
    if (!listId) return jsonError("Watchlist not found");
    const count = await db.watchlistItem.count({ where: { listId } });
    if (count >= 40) return jsonError("Watchlist is limited to 40 symbols");
    await db.watchlistItem.upsert({
      where: { listId_symbol: { listId, symbol } },
      update: {},
      create: { listId, symbol },
    });
    const rows = await db.watchlistItem.findMany({ where: { listId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ symbols: rows.map((r) => r.symbol) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to add symbol", 500);
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    const symbol = parseSymbol(req.nextUrl.searchParams.get("symbol"));
    if (!symbol) return jsonError("Invalid symbol");
    const listId = await resolveListId(user?.id ?? null, req.nextUrl.searchParams.get("listId"));
    if (!listId) return jsonError("Watchlist not found");
    await db.watchlistItem.deleteMany({ where: { listId, symbol } });
    const rows = await db.watchlistItem.findMany({ where: { listId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ symbols: rows.map((r) => r.symbol) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to remove symbol", 500);
  }
}
