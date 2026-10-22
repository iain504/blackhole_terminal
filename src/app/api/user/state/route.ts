import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/route-utils";
import { authGate, sessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_BYTES = 3_000_000; // 3MB safety cap on the serialized state blob

/** GET /api/user/state — the stored UI-state blob (or null). */
export async function GET(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    if (!user) return NextResponse.json({ state: null });
    const row = await db.userState.findUnique({ where: { userId: user.id } });
    return NextResponse.json({ state: row?.data ?? null });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to load state", 500);
  }
}

/** POST /api/user/state — store { data } (the serialized prefs + drawings blob). */
export async function POST(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    if (!user) return jsonError("Sign in required", 401);
    const body = (await req.json()) as { data?: string };
    const data = typeof body.data === "string" ? body.data : "";
    if (!data || data.length > MAX_BYTES) return jsonError("State payload missing or too large");

    await db.userState.upsert({
      where: { userId: user.id },
      update: { data },
      create: { userId: user.id, data },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to save state", 500);
  }
}
