import { db } from "@/lib/db";

const DEFAULT_LIST_NAME = "Watchlist";
const DEFAULT_LIST_COLOR = "#26a69a";
const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD", "NFLX", "SPY", "QQQ", "JPM"];

export const LIST_COLORS = ["#26a69a", "#ef5350", "#ff9800", "#f0b90b", "#66bb6a", "#42a5f5", "#ab47bc", "#ec407a"];
const COLOR_SET = new Set(LIST_COLORS);

export interface ListRow {
  id: string;
  name: string;
  color: string;
  symbols: string[];
}

/**
 * The user's lists (creating the seeded default on first use), symbols
 * included. Legacy anonymous rows (userId null) are served when no account
 * system is in play yet.
 */
export async function listWatchlists(userId: string | null): Promise<ListRow[]> {
  const scope = userId ? { userId } : { userId: null };
  let lists = await db.watchlist.findMany({
    where: scope,
    orderBy: { createdAt: "asc" },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (lists.length === 0) {
    await db.watchlist.create({ data: { name: DEFAULT_LIST_NAME, color: DEFAULT_LIST_COLOR, userId } });
    const created = await db.watchlist.findFirst({ where: { ...scope, name: DEFAULT_LIST_NAME } });
    if (created) {
      // Prisma createMany on SQLite has no skipDuplicates — upsert per symbol
      for (const symbol of DEFAULT_WATCHLIST) {
        await db.watchlistItem.upsert({
          where: { listId_symbol: { listId: created.id, symbol } },
          update: {},
          create: { listId: created.id, symbol },
        });
      }
    }
    lists = await db.watchlist.findMany({
      where: scope,
      orderBy: { createdAt: "asc" },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
  }
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
    symbols: l.items.map((i) => i.symbol),
  }));
}

export function validateColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toLowerCase();
  return COLOR_SET.has(c) ? c : null;
}

export function validateName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.trim().slice(0, 24);
  return n.length >= 1 ? n : null;
}

export { DEFAULT_LIST_COLOR };
