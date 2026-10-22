"use client";

import { useEffect, useState } from "react";
import { usePoll } from "@/hooks/use-poll";
import { fetchStatus } from "@/lib/client-api";
import { fmtClockET } from "@/lib/format";
import { isCryptoSymbol } from "@/lib/symbols";
import { useTerminal } from "@/lib/store";
import { cn } from "@/lib/utils";

type Phase = "pre" | "open" | "post" | "closed";

function phaseInfo(phase: Phase): { label: string; dot: string; text: string } {
  switch (phase) {
    case "open":
      return { label: "Market open", dot: "bg-[#26a69a]", text: "text-[#26a69a]" };
    case "pre":
      return { label: "Pre-market", dot: "bg-[#f0b90b]", text: "text-[#f0b90b]" };
    case "post":
      return { label: "After hours", dot: "bg-[#e056fd]", text: "text-[#e056fd]" };
    default:
      return { label: "Market closed", dot: "bg-[#787b86]", text: "text-[#787b86]" };
  }
}

function marketPhase(): Phase {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return "closed";
  const m = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  if (m >= 570 && m < 960) return "open";
  if (m >= 240 && m < 570) return "pre";
  if (m >= 960 && m < 1200) return "post";
  return "closed";
}

export function StatusBar() {
  const mode = useTerminal((s) => s.mode);
  const symbol = useTerminal((s) => s.symbol);
  const timeframe = useTerminal((s) => s.timeframe);
  const { data: status } = usePoll(() => fetchStatus(), 30000, []);

  // clock and market phase are computed client-side only: rendering new Date()
  // during SSR can mismatch the hydration HTML around phase boundaries
  const [now, setNow] = useState<Date | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);

  useEffect(() => {
    const tick = () => {
      setNow(new Date());
      setPhase(marketPhase());
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const effMode = mode ?? status?.mode ?? null;
  const pi = phase ? phaseInfo(phase) : null;
  const crypto = isCryptoSymbol(symbol); // crypto trades 24/7 — no US phase

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-[#1c202b] bg-[#0d1017] px-3 text-[10px] text-[#787b86]">
      {effMode === "live" ? (
        <span className="flex shrink-0 items-center gap-1.5 font-semibold text-[#26a69a]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#26a69a]" />
          LIVE · ALPACA IEX
        </span>
      ) : effMode === "demo" ? (
        <span className="flex shrink-0 items-center gap-1.5 font-semibold text-[#f0b90b]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f0b90b]" />
          DEMO DATA
        </span>
      ) : (
        <span className="h-3 w-20 shrink-0 animate-pulse rounded bg-[#1c202b]" />
      )}

      {crypto ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#26a69a]" />
          <span className="font-medium text-[#26a69a]">Crypto · 24/7</span>
        </span>
      ) : pi ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", pi.dot)} />
          <span className={cn("font-medium", pi.text)}>{pi.label}</span>
        </span>
      ) : (
        <span className="h-3 w-16 shrink-0 animate-pulse rounded bg-[#1c202b]" />
      )}

      <span className="shrink-0 font-mono tabular-nums">{now ? `${fmtClockET(now)} ET` : "--:--:-- ET"}</span>

      <span className="ml-auto hidden shrink-0 font-mono sm:inline">
        {symbol} · {timeframe}
      </span>
      <a
        href="https://alpaca.markets/docs/market-data/"
        target="_blank"
        rel="noreferrer"
        className="shrink-0 transition-colors hover:text-[#d1d4dc]"
      >
        Data by Alpaca
      </a>
    </footer>
  );
}
