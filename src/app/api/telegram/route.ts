import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/route-utils";
import { authGate, sessionUser } from "@/lib/auth";
import { maskToken, sendTelegram } from "@/lib/alerts-server";

export const dynamic = "force-dynamic";

function maskChat(chatId: string): string {
  return chatId.length <= 4 ? chatId : `…${chatId.slice(-4)}`;
}

/** Find the caller's settings row (or legacy singleton when anonymous). */
async function findSettingsRow(userId: string | null) {
  if (userId) {
    const own = await db.settings.findUnique({ where: { userId } });
    if (own) return own;
  }
  return db.settings.findUnique({ where: { id: "singleton" } });
}

async function upsertTelegram(userId: string | null, botToken: string | null, chatId: string | null) {
  if (userId) {
    const existing = await db.settings.findUnique({ where: { userId } });
    if (existing) {
      await db.settings.update({ where: { id: existing.id }, data: { telegramBotToken: botToken, telegramChatId: chatId } });
      return;
    }
    await db.settings.create({ data: { userId, telegramBotToken: botToken, telegramChatId: chatId } });
    return;
  }
  await db.settings.upsert({
    where: { id: "singleton" },
    update: { telegramBotToken: botToken, telegramChatId: chatId },
    create: { id: "singleton", telegramBotToken: botToken, telegramChatId: chatId },
  });
}

/** GET /api/telegram — whether notifications are configured (masked values). */
export async function GET(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    const s = await findSettingsRow(user?.id ?? null);
    const configured = Boolean(s?.telegramBotToken && s?.telegramChatId);
    return NextResponse.json({
      configured,
      tokenMasked: s?.telegramBotToken ? maskToken(s.telegramBotToken) : null,
      chatMasked: s?.telegramChatId ? maskChat(s.telegramChatId) : null,
    });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load telegram settings", 500);
  }
}

/**
 * POST /api/telegram — save { botToken, chatId } and optionally send a test
 * message first ({ ..., test: true }). When test fails the credentials are
 * NOT saved so typos don't silently disable notifications.
 */
export async function POST(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    const body = (await req.json()) as { botToken?: string; chatId?: string; test?: boolean };
    const botToken = (body.botToken ?? "").trim();
    const chatId = (body.chatId ?? "").trim();
    if (!botToken || !chatId) return jsonError("Bot token and chat ID are both required");

    if (body.test) {
      const err = await sendTelegram(
        { botToken, chatId },
        [
          "<b>🔔 FluxView</b>",
          "",
          "Telegram notifications are connected. Price alerts will arrive here.",
        ].join("\n")
      );
      if (err) return jsonError(`Telegram test failed: ${err}`, 400);
    }

    await upsertTelegram(user?.id ?? null, botToken, chatId);
    return NextResponse.json({ ok: true, tokenMasked: maskToken(botToken), chatMasked: maskChat(chatId) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to save telegram settings", 500);
  }
}

/** DELETE /api/telegram — disconnect notifications. */
export async function DELETE(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    await upsertTelegram(user?.id ?? null, null, null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to clear telegram settings", 500);
  }
}
