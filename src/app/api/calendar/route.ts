import { NextResponse } from "next/server";
import { demoCalendar } from "@/lib/demo-data";
import { jsonError } from "@/lib/route-utils";
import type { CalendarResponse, EconEvent, EventImpact } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Economic calendar. Alpaca does NOT offer a macro-calendar endpoint, so we use
 * the free ForexFactory weekly JSON feed (nfs.faireconomy.media) with an
 * in-memory cache and a synthetic fallback when the feed is unreachable.
 */
const FF_FEEDS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

interface FFEvent {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
}

const IMPACTS = new Set(["high", "medium", "low", "holiday"]);

function parseImpact(raw: string | undefined): EventImpact {
  const v = (raw ?? "").trim().toLowerCase();
  return IMPACTS.has(v) ? (v as EventImpact) : "low";
}

let cache: { at: number; events: EconEvent[] } | null = null;
const CACHE_TTL = 15 * 60e3;

function dayKeyOf(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

async function fetchFF(url: string): Promise<EconEvent[]> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "FluxView/1.0 (market terminal demo)" },
  });
  if (!res.ok) throw new Error(`FF feed HTTP ${res.status}`);
  const raw = (await res.json()) as FFEvent[];
  if (!Array.isArray(raw)) throw new Error("FF feed malformed");
  const out: EconEvent[] = [];
  for (const e of raw) {
    if (!e.title || !e.date || !e.country) continue;
    const t = Math.floor(Date.parse(e.date) / 1000);
    if (!Number.isFinite(t)) continue;
    out.push({
      id: `ff-${e.country}-${t}-${e.title.slice(0, 40).replace(/\W+/g, "-").toLowerCase()}`,
      time: t,
      currency: e.country.toUpperCase().slice(0, 4),
      impact: parseImpact(e.impact),
      title: e.title,
      actual: e.actual?.trim() || null,
      forecast: e.forecast?.trim() || null,
      previous: e.previous?.trim() || null,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL) {
      return NextResponse.json({ events: cache.events, mode: "live" } satisfies CalendarResponse);
    }
    // current week (live ForexFactory feed) + synthetic fill for the days it
    // doesn't cover (the feed no longer publishes a next-week file), so the
    // coming-week calendar page always has upcoming content
    const results = await Promise.allSettled([fetchFF(FF_FEEDS[0]), fetchFF(FF_FEEDS[1])]);
    const fetched = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (fetched.length === 0) throw new Error("FF feeds empty");
    const seen = new Set<string>();
    const events = fetched
      .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
      .sort((a, b) => a.time - b.time);
    const feedMaxDay = events.reduce((m, e) => (dayKeyOf(e.time) > m ? dayKeyOf(e.time) : m), "");
    const fill = demoCalendar().filter((e) => dayKeyOf(e.time) > feedMaxDay);
    const merged = [...events, ...fill].sort((a, b) => a.time - b.time);
    cache = { at: Date.now(), events: merged };
    return NextResponse.json({ events: merged, mode: "live" } satisfies CalendarResponse);
  } catch {
    // feed unreachable (offline sandbox / blocked) — deterministic demo week
    try {
      const events = demoCalendar();
      return NextResponse.json({ events, mode: "demo" } satisfies CalendarResponse);
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : "Failed to load calendar", 502);
    }
  }
}
