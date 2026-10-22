import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/route-utils";
import { sessionUserWithSecret, toSafeUser, verifyTotp } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/2fa/enable — { code } confirms the pending TOTP secret. */
export async function POST(req: NextRequest) {
  try {
    const auth = await sessionUserWithSecret(req);
    if (!auth) return jsonError("Sign in required", 401);
    if (auth.user.totpEnabled) return jsonError("2FA is already enabled");
    if (!auth.user.totpSecret) return jsonError("Run 2FA setup first");
    const body = (await req.json()) as { code?: string };
    if (!verifyTotp(auth.user.totpSecret, body.code ?? "")) {
      return jsonError("Invalid code — check your authenticator app", 400);
    }
    const user = await db.user.update({ where: { id: auth.user.id }, data: { totpEnabled: true } });
    return NextResponse.json({ user: toSafeUser(user) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to enable 2FA", 500);
  }
}
