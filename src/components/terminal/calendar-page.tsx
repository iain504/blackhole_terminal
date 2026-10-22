"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Loader2, RefreshCw } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { fetchCalendar } from "@/lib/client-api";
import { useTerminal } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { EconEvent, EventImpact } from "@/lib/types";

const TZ = "America/New_York";

const IMPACT_COLOR: Record<string, string> = {
  high: "#ef5350",
  medium: "#f0b90b",
  low: "#787b86",
  holiday: "#ab47bc",
};

const COUNTRY_NAMES: Record<string, string> = {
  USD: "United States",
  EUR: "Euro Area",
  GBP: "United Kingdom",
  JPY: "Japan",
  CAD: "Canada",
  AUD: "Australia",
  NZD: "New Zealand",
  CNY: "China",
  CHF: "Switzerland",
};

const dayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "long",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function dayKey(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSec * 1000));
}

function relLabel(key: string, todayKey: string): string | null {
  const a = Date.parse(`${key}T12:00:00Z`);
  const b = Date.parse(`${todayKey}T12:00:00Z`);
  const diff = Math.round((a - b) / 86400e3);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return null;
}

/** First number in a macro value like "+235K", "3.2%", "-0.1" — for beat/miss coloring. */
function numericPart(v: string | null): number | null {
  if (!v) return null;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function Impact({ impact }: { impact: EventImpact }) {
  if (impact === "holiday") {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: IMPACT_COLOR.holiday }}
        title="Holiday"
      />
    );
  }
  const filled = impact === "high" ? 3 : impact === "medium" ? 2 : 1;
  const color = IMPACT_COLOR[impact];
  return (
    <span className="flex items-end gap-0.5" title={`${impact} impact`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-sm"
          style={{
            height: 5 + i * 2,
            background: i <= filled ? color : "#2a2e39",
          }}
        />
      ))}
    </span>
  );
}

const GRID =
  "grid grid-cols-[64px_68px_72px_minmax(0,1fr)_84px_84px_84px] items-center gap-2 px-3";

function EventRow({ ev, nextId, nowMs }: { ev: EconEvent; nextId: string | null; nowMs: number }) {
  const isNext = ev.id === nextId;
  const passed = ev.time * 1000 < nowMs && !isNext;
  const actualNum = numericPart(ev.actual);
  const forecastNum = numericPart(ev.forecast);
  const beat = actualNum !== null && forecastNum !== null && actualNum > forecastNum;
  const miss = actualNum !== null && forecastNum !== null && actualNum < forecastNum;

  return (
    <div
      className={cn(
        GRID,
        "min-w-[720px] border-b border-[#1c202b]/60 py-1.5 text-xs transition-colors hover:bg-[#1a1f2c]",
        isNext && "bg-[#26a69a]/[0.07]",
        passed && "opacity-55"
      )}
    >
      <span className="font-mono text-[11px] text-[#b2b5be]">{timeFmt.format(ev.time * 1000)}</span>
      <span
        className="w-fit rounded bg-[#2a2e39] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#b2b5be]"
        title={COUNTRY_NAMES[ev.currency] ?? ev.currency}
      >
        {ev.currency}
      </span>
      <span>
        <Impact impact={ev.impact} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[#d1d4dc]" title={ev.title}>
          {ev.title}
        </span>
        {isNext && (
          <span className="shrink-0 rounded bg-[#26a69a] px-1 py-px text-[8px] font-bold tracking-wider text-[#0d1017]">
            NEXT
          </span>
        )}
      </span>
      <span
        className={cn(
          "font-mono text-[11px]",
          ev.actual === null || ev.actual === "" ? "text-[#565b6b]" : beat ? "text-[#26a69a]" : miss ? "text-[#ef5350]" : "text-[#d1d4dc]"
        )}
      >
        {ev.actual || "—"}
      </span>
      <span className="font-mono text-[11px] text-[#b2b5be]">{ev.forecast || "—"}</span>
      <span className="font-mono text-[11px] text-[#787b86]">{ev.previous || "—"}</span>
    </div>
  );
}

type ImpactFilter = "all" | EventImpact;

const FILTERS: { id: ImpactFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
];

/** Full-page economic calendar (bottom tab): the coming week grouped by date. */
export function CalendarPage() {
  const mode = useTerminal((s) => s.mode);
  const { data, error, loading, refresh } = usePoll(() => fetchCalendar(), 5 * 60e3, []);
  const [filter, setFilter] = useState<ImpactFilter>("all");

  const events = data?.events ?? [];
  const feedMode = data?.mode;

  const nowMs = Date.now();
  const todayKey = dayKey(Math.floor(nowMs / 1000));
  const horizonKey = dayKey(Math.floor(nowMs / 1000) + 8 * 86400);

  const visible = useMemo(
    () =>
      events.filter((e) => {
        const k = dayKey(e.time);
        if (k < todayKey || k > horizonKey) return false;
        if (filter !== "all" && e.impact !== filter) return false;
        return true;
      }),
    [events, filter, todayKey, horizonKey]
  );

  const nextEvent = visible.find((e) => e.time * 1000 >= nowMs) ?? null;

  const groups: { key: string; items: EconEvent[] }[] = [];
  for (const ev of visible) {
    const k = dayKey(ev.time);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(ev);
    else groups.push({ key: k, items: [ev] });
  }

  const rangeLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
    return `${fmt.format(new Date(`${todayKey}T12:00:00Z`))} – ${fmt.format(new Date(`${horizonKey}T12:00:00Z`))}`;
  }, [todayKey, horizonKey]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#131722]">
      {/* header */}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#1c202b] px-3 py-1.5">
        <CalendarDays className="h-4 w-4 text-[#26a69a]" />
        <span className="text-sm font-semibold text-white">Economic Calendar</span>
        <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 font-mono text-[10px] text-[#b2b5be]">
          {rangeLabel}
        </span>
        {feedMode === "demo" && (
          <span
            className="rounded bg-[#f0b90b]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#f0b90b]"
            title="Live calendar feed unreachable — showing synthetic demo events"
          >
            DEMO
          </span>
        )}
        {mode === "live" && feedMode === "live" && (
          <span className="rounded bg-[#26a69a]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#26a69a]">
            LIVE
          </span>
        )}

        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Filter by importance">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors",
                filter === f.id ? "bg-[#2a2e39] text-white" : "text-[#787b86] hover:text-[#b2b5be]"
              )}
            >
              {f.id !== "all" && (
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: IMPACT_COLOR[f.id] }} />
              )}
              {f.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh calendar"
            className="ml-1 cursor-pointer rounded p-1 text-[#787b86] hover:bg-[#1c202b] hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* table */}
      <div className="term-scroll min-h-0 flex-1 overflow-auto">
        <div className="min-w-[720px]">
          <div
            className={cn(
              GRID,
              "sticky top-0 z-10 border-b border-[#2a2e39] bg-[#131722] py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#787b86]"
            )}
          >
            <span>Time (ET)</span>
            <span>Country</span>
            <span>Importance</span>
            <span>Event</span>
            <span>Actual</span>
            <span>Forecast</span>
            <span>Prior</span>
          </div>

          {loading && !data ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-6 animate-pulse rounded bg-[#1a1f2c]" />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-10 text-xs text-[#787b86]">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="cursor-pointer rounded border border-[#2a2e39] px-2 py-1 text-[11px] text-[#b2b5be] hover:bg-[#1c202b]"
              >
                Retry
              </button>
            </div>
          ) : groups.length === 0 ? (
            <p className="py-10 text-center text-xs text-[#787b86]">No events in the coming week</p>
          ) : (
            groups.map((g) => {
              const rel = relLabel(g.key, todayKey);
              return (
                <div key={g.key}>
                  <div className="flex items-baseline gap-2 border-b border-[#1c202b] bg-[#161a26] px-3 py-1.5">
                    {rel && (
                      <span
                        className={cn(
                          "text-[10px] font-bold uppercase tracking-wider",
                          rel === "Today" ? "text-[#26a69a]" : "text-[#b2b5be]"
                        )}
                      >
                        {rel}
                      </span>
                    )}
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#787b86]">
                      {dayFmt.format(new Date(`${g.key}T12:00:00Z`))}
                    </span>
                    <span className="text-[10px] text-[#565b6b]">{g.items.length} events</span>
                    {g.items.every((e) => e.synthetic) && (
                      <span
                        className="rounded bg-[#f0b90b]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#f0b90b]"
                        title="The live calendar feed does not cover this week yet — showing synthetic demo events"
                      >
                        DEMO
                      </span>
                    )}
                  </div>
                  {g.items.map((ev) => (
                    <EventRow key={ev.id} ev={ev} nextId={nextEvent?.id ?? null} nowMs={nowMs} />
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {loading && data && (
        <div className="flex h-6 shrink-0 items-center justify-center gap-1.5 border-t border-[#1c202b] text-[10px] text-[#787b86]">
          <Loader2 className="h-3 w-3 animate-spin" /> updating…
        </div>
      )}
    </div>
  );
}
