import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/route-utils";
import { authGate, sessionUser } from "@/lib/auth";
import { evaluateAlerts } from "@/lib/alerts-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts/evaluate — body { prices: Record<symbol, number> }.
 * The terminal sends its latest polled prices; the caller's active alerts that
 * condition fire are marked triggered (DB) and pushed to Telegram when
 * configured. Returns the newly triggered alerts.
 */
export async function POST(req: NextRequest) {
  const gate = await authGate(req);
  if (gate) return gate;
  try {
    const user = await sessionUser(req);
    const body = (await req.json()) as { prices?: Record<string, unknown> };
    if (!body.prices || typeof body.prices !== "object") return jsonError("prices object is required");
    const triggered = await evaluateAlerts(user?.id ?? null, body.prices as Record<string, number>);
    return NextResponse.json({ triggered });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to evaluate alerts", 500);
  }
}
