"use client";

import type { ReactNode } from "react";
import { fmtNum, fmtPct, fmtTimeAgo, fmtVolume, upDownClass } from "@/lib/format";
import { isCryptoSymbol } from "@/lib/symbols";
import { cn } from "@/lib/utils";
import { usePoll } from "@/hooks/use-poll";
import { fetchEarnings, fetchSearch, fetchSnapshots } from "@/lib/client-api";
import { useTerminal } from "@/lib/store";
import { ArrowDownRight, ArrowUpRight, CircleDollarSign, Loader2 } from "lucide-react";

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-[#0d1017]/60 px-2.5 py-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[#787b86]">{label}</span>
      <span className={cn("whitespace-nowrap font-mono text-xs text-[#d1d4dc]", className)}>{value}</span>
    </div>
  );
}

export function QuotePanel({ compact = false, controls }: { compact?: boolean; controls?: ReactNode }) {
  const symbol = useTerminal((s) => s.symbol);
  const crypto = isCryptoSymbol(symbol);
  const { data } = usePoll(() => fetchSnapshots([symbol]), 10000, [symbol]);
  const { data: searchData } = usePoll(() => fetchSearch(symbol), 60000, [symbol]);
  // next quarterly report (synthetic — Alpaca has no earnings endpoint); crypto
  // has none → resolve null without a request. Tagged with the symbol so a slow
  // response can't show the previous symbol's report.
  const { data: earningsTagged } = usePoll(
    () =>
      crypto
        ? Promise.resolve(null)
        : fetchEarnings(symbol).then((d) => ({ sym: symbol, events: d.events })),
    300000,
    [symbol]
  );

  const snap = data?.snapshots[symbol] ?? null;
  const meta = searchData?.results.find((r) => r.symbol === symbol) ?? null;
  const up = (snap?.change ?? 0) >= 0;

  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const nextEarn =
    earningsTagged && earningsTagged.sym === symbol
      ? earningsTagged.events.find((e) => e.date >= todayET) ?? null
      : null;
  const nextEarnDate = nextEarn
    ? new Date(`${nextEarn.date}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

  if (!snap) {
    return (
      <div className="flex h-full items-center justify-center bg-[#131722]">
        <Loader2 className="h-4 w-4 animate-spin text-[#787b86]" />
      </div>
    );
  }

  const rangeLow = snap.low ?? snap.prevClose;
  const rangeHigh = snap.high ?? snap.prevClose;
  const span = rangeHigh - rangeLow;
  const pos = span > 0 ? Math.min(100, Math.max(0, ((snap.price - rangeLow) / span) * 100)) : 50;

  return (
    <div className="term-scroll flex h-full min-h-0 flex-col overflow-y-auto bg-[#131722]">
      {/* panel chrome (right sidebar) */}
      {controls && (
        <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 border-b border-[#1c202b] bg-[#131722] px-3">
          <CircleDollarSign className="h-3.5 w-3.5 text-[#787b86]" />
          <span className="text-xs font-semibold text-[#d1d4dc]">Quote</span>
          <div className="ml-auto flex items-center gap-0.5">{controls}</div>
        </div>
      )}

      {/* header */}
      <div className="border-b border-[#1c202b] px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-mono text-lg font-bold tracking-wide text-white">{symbol}</h2>
          <div className="flex items-center gap-1">
            {crypto && (
              <span className="rounded bg-[#26a69a]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#26a69a]">
                24/7
              </span>
            )}
            {meta && (
              <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 text-[10px] font-medium text-[#787b86]">
                {meta.exchange}
              </span>
            )}
          </div>
        </div>
        <p className="mt-0.5 truncate text-xs text-[#787b86]">{meta?.name ?? (crypto ? "Crypto pair" : "US Equity")}</p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <span className={cn("font-mono text-[34px] font-bold leading-none tracking-tight", upDownClass(snap.change))}>
            {fmtNum(snap.price)}
          </span>
          <span
            className={cn(
              "flex items-center gap-0.5 rounded px-1.5 py-1 font-mono text-sm font-semibold",
              up ? "bg-[#26a69a]/15 text-[#26a69a]" : "bg-[#ef5350]/15 text-[#ef5350]"
            )}
          >
            {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {fmtPct(snap.changePct)}
          </span>
        </div>
        <p className={cn("mt-1 font-mono text-xs", upDownClass(snap.change))}>
          {snap.change >= 0 ? "+" : ""}
          {fmtNum(snap.change)} today
        </p>
      </div>

      {/* bid / ask */}
      <div className="grid grid-cols-2 gap-2 border-b border-[#1c202b] px-4 py-3">
        <div className="rounded-md bg-[#0d1017]/60 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[#26a69a]">Bid</p>
          <p className="font-mono text-sm text-[#d1d4dc]">{fmtNum(snap.bid)}</p>
        </div>
        <div className="rounded-md bg-[#0d1017]/60 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[#ef5350]">Ask</p>
          <p className="font-mono text-sm text-[#d1d4dc]">{fmtNum(snap.ask)}</p>
        </div>
      </div>

      {/* stats */}
      <div className={cn("grid gap-2 px-4 py-3", compact ? "grid-cols-2" : "grid-cols-2")}>
        <Stat label="Open" value={fmtNum(snap.open)} />
        <Stat label="Prev close" value={fmtNum(snap.prevClose)} />
        <Stat label="High" value={fmtNum(snap.high)} className="text-[#26a69a]" />
        <Stat label="Low" value={fmtNum(snap.low)} className="text-[#ef5350]" />
        <Stat label="Volume" value={fmtVolume(snap.volume)} />
        <Stat
          label="Last trade"
          value={snap.tradeTime ? fmtTimeAgo(snap.tradeTime) : "—"}
        />
      </div>

      {/* next earnings — one compact row, only when a future report exists */}
      {nextEarn && nextEarnDate && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between gap-2 rounded-md bg-[#0d1017]/60 px-2.5 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[#787b86]">
              Next earnings
            </span>
            <span className="whitespace-nowrap font-mono text-xs text-[#f0b90b]">
              {nextEarnDate} · {nextEarn.when === "bmo" ? "BMO" : "AMC"}
              {nextEarn.epsEstimate != null ? ` (est. ${fmtNum(nextEarn.epsEstimate)})` : ""}
            </span>
          </div>
        </div>
      )}

      {/* day range */}
      <div className="px-4 pb-4">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#787b86]">Day range</p>
        <div className="relative h-1.5 rounded-full bg-[#2a2e39]">
          <div
            className="absolute top-1/2 h-3 w-[3px] -translate-y-1/2 rounded-full bg-[#d1d4dc]"
            style={{ left: `calc(${pos}% - 1.5px)` }}
            aria-hidden="true"
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-[#787b86]">
          <span>{fmtNum(rangeLow)}</span>
          <span>{fmtNum(rangeHigh)}</span>
        </div>
      </div>
    </div>
  );
}
