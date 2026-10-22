/**
 * Server-side price-alert evaluation + Telegram notifications.
 * The terminal client polls snapshots and POSTs the latest prices to
 * /api/alerts/evaluate; this module compares them against stored alerts,
 * marks triggered ones and (optionally) pushes a Telegram message.
 */
import { db } from "@/lib/db";
import type { PriceAlert } from "@prisma/client";

export type AlertDirection = "above" | "below" | "cross";

const DIRECTIONS: AlertDirection[] = ["above", "below", "cross"];

export function validateDirection(v: unknown): AlertDirection | null {
  return typeof v === "string" && (DIRECTIONS as string[]).includes(v) ? (v as AlertDirection) : null;
}

export function validatePrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A serialized alert safe to send to the client. */
export interface AlertDTO {
  id: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  note: string | null;
  color: string | null;
  active: boolean;
  triggeredAt: number | null;
  createdAt: number;
}

export function toDTO(a: PriceAlert): AlertDTO {
  return {
    id: a.id,
    symbol: a.symbol,
    price: a.price,
    direction: (a.direction as AlertDirection) ?? "above",
    note: a.note,
    color: a.color ?? null,
    active: a.active,
    triggeredAt: a.triggeredAt ? a.triggeredAt.getTime() : null,
    createdAt: a.createdAt.getTime(),
  };
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Validate an alert line color (#rrggbb), or null when absent/invalid. */
export function validateColor(v: unknown): string | null {
  return typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null;
}

// ---------------- telegram ----------------

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** User's Telegram config, falling back to the legacy server-wide row. */
export async function getTelegramConfig(userId?: string | null): Promise<TelegramConfig | null> {
  const rows = await db.settings.findMany({
    where: { OR: userId ? [{ userId }, { userId: null }] : [{ userId: null }] },
  });
  const own = userId ? rows.find((r) => r.userId === userId) : undefined;
  const legacy = rows.find((r) => r.userId === null);
  const row = own ?? legacy;
  if (!row?.telegramBotToken || !row?.telegramChatId) return null;
  return { botToken: row.telegramBotToken, chatId: row.telegramChatId };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Send a message through the Telegram Bot API. Returns error text on failure. */
export async function sendTelegram(cfg: TelegramConfig, text: string, timeoutMs = 8000): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: ac.signal,
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !json?.ok) {
      return json?.description ?? `Telegram API error (${res.status})`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? (e.name === "AbortError" ? "Telegram request timed out" : e.message) : "Telegram request failed";
  } finally {
    clearTimeout(timer);
  }
}

export function maskToken(token: string): string {
  if (token.length <= 10) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// ---------------- evaluation ----------------

export interface TriggeredAlert {
  alert: AlertDTO;
  price: number;
  notified: boolean;
  notifyError: string | null;
}

/**
 * Evaluate the USER's active alerts against the given prices (symbol → last
 * price). Marks matching alerts inactive in the DB and returns them. Telegram
 * is fired for each trigger when configured (best-effort, never blocks marking).
 */
export async function evaluateAlerts(
  userId: string | null,
  prices: Record<string, number>
): Promise<TriggeredAlert[]> {
  const entries = Object.entries(prices)
    .map(([k, v]) => [k.toUpperCase(), validatePrice(v)] as const)
    .filter(([, v]) => v != null) as [string, number][];

  if (entries.length === 0) return [];
  const priceMap = new Map(entries);
  const symbols = Array.from(priceMap.keys());

  const active = await db.priceAlert.findMany({
    where: { active: true, symbol: { in: symbols }, ...(userId ? { userId } : {}) },
  });
  if (active.length === 0) return [];

  const fired: { alert: PriceAlert; price: number; newSide: number }[] = [];
  const updates: Promise<unknown>[] = [];

  for (const alert of active) {
    const price = priceMap.get(alert.symbol);
    if (price == null) continue;
    const dir = (alert.direction as AlertDirection) ?? "above";
    const side = price >= alert.price ? 1 : -1; // side of the alert line

    let hit = false;
    let newSide = alert.lastSide ?? 0;
    if (dir === "above") {
      hit = side === 1;
    } else if (dir === "below") {
      hit = side === -1;
    } else {
      // cross: fires when observed side flips to the opposite of the last known side
      const last = alert.lastSide ?? 0;
      if (last !== 0 && side !== last) hit = true;
      newSide = side;
    }

    if (!hit) {
      if (newSide !== alert.lastSide) {
        updates.push(
          db.priceAlert.update({ where: { id: alert.id }, data: { lastSide: newSide } }).catch(() => null)
        );
      }
      continue;
    }
    fired.push({ alert, price, newSide });
    updates.push(
      db.priceAlert
        .update({
          where: { id: alert.id },
          data: { active: false, triggeredAt: new Date(), lastSide: newSide },
        })
        .catch(() => null)
    );
  }

  await Promise.all(updates);
  if (fired.length === 0) return [];

  // best-effort telegram push
  const cfg = await getTelegramConfig(userId).catch(() => null);
  const out: TriggeredAlert[] = [];
  for (const f of fired) {
    let notified = false;
    let notifyError: string | null = null;
    if (cfg) {
      const dirWord = f.alert.direction === "cross" ? "crossed" : f.alert.direction === "above" ? "above" : "below";
      notifyError = await sendTelegram(
        cfg,
        [
          `<b>🔔 FluxView price alert</b>`,
          ``,
          `<b>${escapeHtml(f.alert.symbol)}</b> ${dirWord} <b>$${f.alert.price}</b>`,
          `Current price: <b>$${f.price}</b>`,
          f.alert.note ? `Note: ${escapeHtml(f.alert.note)}` : "",
          ``,
          `<i>${new Date().toUTCString()}</i>`,
        ]
          .filter(Boolean)
          .join("\n")
      );
      notified = notifyError == null;
    }
    out.push({ alert: toDTO(f.alert), price: f.price, notified, notifyError });
  }
  return out;
}
