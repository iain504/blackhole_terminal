import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/route-utils";
import { attachSessionCookie, createSession, toSafeUser, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login — { username, password }.
 * Without 2FA: sets the session cookie and returns { user }.
 * With 2FA enabled: returns { twofa: true, ticket } — the client must POST
 * /api/auth/2fa/verify { ticket, code } to obtain the session cookie.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { username?: string; password?: string };
    const username = (body.username ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    if (!username || !password) return jsonError("Username and password are required");

    const user = await db.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return jsonError("Invalid username or password", 401);
    }

    if (user.totpEnabled && user.totpSecret) {
      const { token } = await createSession(user.id, true);
      return NextResponse.json({ twofa: true, ticket: token, username: user.username });
    }

    const { token } = await createSession(user.id, false);
    const res = NextResponse.json({ user: toSafeUser(user) });
    return attachSessionCookie(res, token, 30 * 24 * 3600);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Login failed", 500);
  }
}

