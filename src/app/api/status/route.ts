import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { mode, feed } = await getDataMode(null);
    return NextResponse.json({ mode, feed });
  } catch {
    return NextResponse.json({ mode: "demo", feed: null });
  }
}
