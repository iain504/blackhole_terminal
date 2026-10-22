import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/route-utils";
import { attachSessionCookie, completePendingLogin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/2fa/verify — { ticket, code } completes a 2FA login. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { ticket?: string; code?: string };
    if (!body.ticket) return jsonError("Missing login ticket");
    const result = await completePendingLogin(body.ticket, body.code ?? "");
    if (!result.ok || !result.user) return jsonError(result.error ?? "Invalid code", 401);
    // find the session token (the ticket itself) to set as the cookie
    const res = NextResponse.json({ user: result.user });
    return attachSessionCookie(res, body.ticket, 30 * 24 * 3600);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "2FA verification failed", 500);
  }
}
