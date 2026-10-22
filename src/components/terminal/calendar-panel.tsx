"use client";

import { CalendarClock, Loader2 } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { fetchCalendar } from "@/lib/client-api";
import { useTerminal } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { EconEvent } from "@/lib/types";

const TZ = "America/New_York";

const IMPACT_COLOR: Record<string, string> = {
  high: "#ef5350",
  medium: "#f0b90b",
  low: "#787b86",
  holiday: "#ab47bc",
};

const dayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
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

function dayLabel(key: string): string {
  return dayFmt.format(new Date(`${key}T12:00:00Z`));
}

function relLabel(key: string, todayKey: string): string | null {
  const a = Date.parse(`${key}T12:00:00Z`);
  const b = Date.parse(`${todayKey}T12:00:00Z`);
  const diff = Math.round((a - b) / 86400e3);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return null;
}

function EventRow({ ev, nextId }: { ev: EconEvent; nextId: string | null }) {
  const passed = nextId !== null && ev.id !== nextId && ev.time * 1000 < Date.now();
  const isNext = ev.id === nextId;
  return (
    <div
      className={cn(
        "rounded-md px-2 py-1.5 transition-colors",
        isNext ? "border border-[#26a69a]/40 bg-[#26a69a]/[0.07]" : "hover:bg-[#1a1f2c]",
        passed && !isNext && "opacity-55"
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: IMPACT_COLOR[ev.impact] ?? IMPACT_COLOR.low }}
          title={`${ev.impact} impact`}
        />
        <span className="w-[58px] shrink-0 font-mono text-[10px] text-[#787b86]">{timeFmt.format(ev.time * 1000)}</span>
        <span className="shrink-0 rounded bg-[#2a2e39] px-1 py-px font-mono text-[9px] font-bold text-[#b2b5be]">
          {ev.currency}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[11px] leading-tight", isNext ? "text-white" : "text-[#d1d4dc]")}>
          {ev.title}
        </span>
        {isNext && (
          <span className="shrink-0 rounded bg-[#26a69a] px-1 py-px text-[8px] font-bold tracking-wider text-[#0d1017]">
            NEXT
          </span>
        )}
      </div>
      {(ev.forecast || ev.previous) && (
        <div className="mt-0.5 flex items-center gap-3 pl-[74px] font-mono text-[9px] text-[#787b86]">
          {ev.forecast && <span>f {ev.forecast}</span>}
          {ev.previous && <span>p {ev.previous}</span>}
        </div>
      )}
    </div>
  );
}

export function CalendarPanel({ controls }: { controls?: React.ReactNode }) {
  const { data, loading } = usePoll(() => fetchCalendar(), 15 * 60e3, []);
  const events = data?.events ?? [];
  const mode = data?.mode;

  const nowSec = Date.now();
  const todayKey = dayKey(Math.floor(nowSec / 1000));
  const nextEvent = events.find((e) => e.time * 1000 >= nowSec) ?? null;

  // group by ET day, ascending
  const groups: { key: string; items: EconEvent[] }[] = [];
  for (const ev of events) {
    const k = dayKey(ev.time);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(ev);
    else groups.push({ key: k, items: [ev] });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#131722]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[#1c202b] px-3">
        <CalendarClock className="h-3.5 w-3.5 text-[#787b86]" />
        <span className="text-xs font-semibold text-[#d1d4dc]">Calendar</span>
        <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 font-mono text-[10px] text-[#b2b5be]">This week</span>
        {mode === "demo" && (
          <span
            className="rounded bg-[#f0b90b]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#f0b90b]"
            title="Live calendar feed unreachable — showing synthetic demo events"
          >
            DEMO
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">{controls}</div>
      </div>

      <div className="term-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !data ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-[#787b86]" />
          </div>
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-xs text-[#787b86]">No events scheduled this week</p>
        ) : (
          groups.map((g) => {
            const rel = relLabel(g.key, todayKey);
            return (
              <div key={g.key} className="mb-1.5">
                <div className="flex items-baseline gap-1.5 px-2 pb-1 pt-1.5">
                  {rel && (
                    <span className={cn("text-[10px] font-bold uppercase tracking-wider", rel === "Today" ? "text-[#26a69a]" : "text-[#b2b5be]")}>
                      {rel}
                    </span>
                  )}
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86]">
                    {dayLabel(g.key)}
                  </span>
                  {g.items.every((e) => e.synthetic) && (
                    <span
                      className="rounded bg-[#f0b90b]/15 px-1 py-px text-[8px] font-semibold text-[#f0b90b]"
                      title="Synthetic demo events — the live feed does not cover this week yet"
                    >
                      DEMO
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  {g.items.map((ev) => (
                    <EventRow key={ev.id} ev={ev} nextId={nextEvent?.id ?? null} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
