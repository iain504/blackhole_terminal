import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/route-utils";
import { sessionUserWithSecret, toSafeUser, verifyTotp } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/2fa/disable — { code } turns 2FA off and clears the secret. */
export async function POST(req: NextRequest) {
  try {
    const auth = await sessionUserWithSecret(req);
    if (!auth) return jsonError("Sign in required", 401);
    if (!auth.user.totpEnabled) return jsonError("2FA is not enabled");
    const body = (await req.json()) as { code?: string };
    if (!auth.user.totpSecret || !verifyTotp(auth.user.totpSecret, body.code ?? "")) {
      return jsonError("Invalid code — check your authenticator app", 400);
    }
    const user = await db.user.update({
      where: { id: auth.user.id },
      data: { totpEnabled: false, totpSecret: null },
    });
    return NextResponse.json({ user: toSafeUser(user) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to disable 2FA", 500);
  }
}
