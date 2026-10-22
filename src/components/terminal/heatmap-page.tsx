"use client";

/**
 * Full-page market heat map (bottom "Heat Map" tab): squarified treemap of
 * US stocks + crypto sized by market cap and colored by daily % change
 * (Finviz/TradingView style). Clicking a tile opens the symbol in the chart
 * workspace. Quotes come from /api/snapshots via usePoll (20s).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bitcoin, DollarSign, LayoutGrid, Loader2, RefreshCw } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { fetchSnapshots } from "@/lib/client-api";
import { fmtPct, fmtSigned, upDownClass } from "@/lib/format";
import { CRYPTO_PAIRS } from "@/lib/symbols";
import { useTerminal } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { DataMode, Snapshot } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fmtMcap,
  fmtVal,
  SECTOR_COLORS,
  squarify,
  UNIVERSE_SECTORS,
  US_UNIVERSE,
  type HeatmapEntry,
} from "@/lib/heatmap-universe";

type Market = "us" | "crypto";

interface TileData extends HeatmapEntry {
  price: number | null;
  change: number | null;
  changePct: number | null;
}

const CRYPTO_UNIVERSE: readonly HeatmapEntry[] = CRYPTO_PAIRS.map((p) => ({
  symbol: p.symbol,
  name: p.name,
  sector: "Crypto",
  mcap: p.mcap,
}));

const UNIVERSE: Record<Market, readonly HeatmapEntry[]> = {
  us: US_UNIVERSE,
  crypto: CRYPTO_UNIVERSE,
};

// /api/snapshots caps the symbol list server-side (parseSymbols max=40),
// so split the universe into chunks and merge the responses.
function chunk(arr: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const CHUNKS: Record<Market, string[][]> = {
  us: chunk(UNIVERSE.us.map((u) => u.symbol), 40),
  crypto: chunk(UNIVERSE.crypto.map((u) => u.symbol), 40),
};

type SnapResponse = { snapshots: Record<string, Snapshot>; mode?: DataMode };

async function fetchAllSnapshots(market: Market): Promise<SnapResponse> {
  const parts = (await Promise.all(CHUNKS[market].map((syms) => fetchSnapshots(syms)))) as SnapResponse[];
  const snapshots: Record<string, Snapshot> = {};
  for (const p of parts) Object.assign(snapshots, p.snapshots ?? {});
  return { snapshots, mode: parts[0]?.mode };
}

// ---------------- tile coloring: daily % change clamped to ±3% ----------------

const TILE_BG: [number, number, number] = [0x1c, 0x20, 0x2b];
const GREEN: [number, number, number] = [0x26, 0xa6, 0x9a];
const RED: [number, number, number] = [0xef, 0x53, 0x50];

function mix(base: [number, number, number], t: number): string {
  const [r, g, b] = [0, 1, 2].map((i) => Math.round(base[i] * t + TILE_BG[i] * (1 - t)));
  return `rgb(${r},${g},${b})`;
}

function tileColor(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct) || Math.abs(pct) < 0.05) return "#2a2e39";
  const clamped = Math.max(-3, Math.min(3, pct));
  const mag = Math.abs(clamped) / 3;
  return mix(clamped > 0 ? GREEN : RED, 0.3 + 0.7 * mag);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

// deterministic skeleton spans (no random → no hydration mismatch)
const SKELETON_SPANS = [
  "col-span-2 row-span-2", "col-span-1 row-span-2", "col-span-1 row-span-1", "col-span-1 row-span-1",
  "col-span-1 row-span-1", "col-span-2 row-span-1", "col-span-1 row-span-2", "col-span-1 row-span-1",
  "col-span-1 row-span-1", "col-span-1 row-span-1", "col-span-2 row-span-2", "col-span-1 row-span-1",
  "col-span-1 row-span-2", "col-span-1 row-span-1", "col-span-1 row-span-1", "col-span-2 row-span-1",
  "col-span-1 row-span-1", "col-span-1 row-span-1", "col-span-1 row-span-2", "col-span-1 row-span-1",
  "col-span-2 row-span-1", "col-span-1 row-span-1", "col-span-1 row-span-1", "col-span-1 row-span-1",
];

/** Full-page heat map: header (market pills, sector filter) + treemap + legend. */
export function HeatmapPage() {
  const [market, setMarket] = useState<Market>("us");
  const [sector, setSector] = useState("all");
  const { data, error, loading, refresh } = usePoll(() => fetchAllSnapshots(market), 20_000, [market]);
  const [hover, setHover] = useState<{ t: TileData; cx: number; cy: number } | null>(null);

  // measure the treemap container → lay out in real pixels (crisp labels)
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const feedMode: DataMode | null = data?.mode ?? null;
  const snaps = useMemo(() => data?.snapshots ?? {}, [data]);
  const entries = UNIVERSE[market];
  const visible = useMemo(
    () =>
      market === "us" && sector !== "all" ? entries.filter((e) => e.sector === sector) : entries,
    [market, sector, entries]
  );

  const cw = box.w || 1000;
  const ch = box.h || 620;

  const tiles = useMemo(() => {
    const list: TileData[] = visible.map((e) => {
      const sn = snaps[e.symbol] ?? snaps[e.symbol.replace("/", "")] ?? null;
      return {
        ...e,
        price: sn?.price ?? null,
        change: sn?.change ?? null,
        changePct: sn?.changePct ?? null,
      };
    });
    return squarify(
      list.map((t) => ({ item: t, value: t.mcap })),
      0,
      0,
      cw,
      ch
    );
  }, [visible, snaps, cw, ch]);

  /** open the clicked symbol in the chart workspace */
  function openInChart(symbol: string) {
    const st = useTerminal.getState();
    st.setSymbol(symbol);
    const active = st.tabs.find((t) => t.id === st.activeTabId);
    if (active && active.kind !== "charts") {
      const chartTab = st.tabs.find((t) => t.kind === "charts");
      if (chartTab) st.setActiveTab(chartTab.id);
      else st.addTab("charts"); // addTab activates the new tab
    }
  }

  const hasData = tiles.length > 0;
  const measured = box.w > 0 && box.h > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#131722]">
      {/* header */}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#1c202b] px-3 py-1.5">
        <LayoutGrid className="h-4 w-4 text-[#26a69a]" />
        <span className="text-sm font-semibold text-white">Heat Map</span>
        {feedMode === "demo" && (
          <span
            className="rounded bg-[#f0b90b]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#f0b90b]"
            title="Demo data — add Alpaca keys in settings for live quotes"
          >
            DEMO
          </span>
        )}
        {feedMode === "live" && (
          <span className="rounded bg-[#26a69a]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#26a69a]">
            LIVE
          </span>
        )}

        {/* market sub-tabs */}
        <div className="flex items-center rounded bg-[#1c202b] p-0.5" role="tablist" aria-label="Market">
          {(
            [
              { id: "us" as const, label: "US Stocks", Icon: DollarSign },
              { id: "crypto" as const, label: "Crypto", Icon: Bitcoin },
            ]
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={market === id}
              onClick={() => {
                setMarket(id);
                setSector("all");
                setHover(null);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                market === id ? "bg-[#2a2e39] text-white" : "text-[#787b86] hover:text-[#b2b5be]"
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>

        {/* sector filter (US universe only) */}
        {market === "us" && (
          <Select
            value={sector}
            onValueChange={(v) => {
              setSector(v);
              setHover(null);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Filter by sector"
              className="h-7 min-w-[132px] gap-1.5 border-[#2a2e39] bg-[#1c202b] px-2 text-[11px] text-[#d1d4dc]"
            >
              <SelectValue placeholder="All Sectors" />
            </SelectTrigger>
            <SelectContent className="border-[#2a2e39] bg-[#1c202b] text-[#d1d4dc]">
              <SelectItem value="all" className="text-xs focus:bg-[#2a2e39]">
                All Sectors
              </SelectItem>
              {UNIVERSE_SECTORS.map((s) => (
                <SelectItem key={s} value={s} className="text-xs focus:bg-[#2a2e39]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SECTOR_COLORS[s] }} />
                    {s}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <span className="text-[10px] text-[#565b6b]">
          {visible.length === entries.length ? `${entries.length} symbols` : `${visible.length}/${entries.length}`}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {loading && data && <Loader2 className="h-3 w-3 animate-spin text-[#787b86]" />}
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh heat map"
            className="cursor-pointer rounded p-1.5 text-[#787b86] hover:bg-[#1c202b] hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* treemap */}
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden p-1.5">
        {loading && !data ? (
          <div className="grid h-full grid-cols-6 grid-rows-5 gap-1">
            {SKELETON_SPANS.map((span, i) => (
              <div key={i} className={cn("animate-pulse rounded-sm bg-[#1a1f2c]", span)} />
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
        ) : !measured || !hasData ? (
          <p className="flex h-full items-center justify-center text-xs text-[#787b86]">
            {hasData ? "" : "No symbols in this view"}
          </p>
        ) : (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${cw} ${ch}`}
            className="block"
            role="img"
            aria-label={`${market === "us" ? "US stocks" : "Crypto"} heat map, tile size by market cap, color by daily change`}
            onMouseLeave={() => setHover(null)}
          >
            {tiles.map(({ item, x, y, w, h }) => {
              const t = item;
              const neutral = t.changePct == null || Math.abs(t.changePct) < 0.05;
              const color = tileColor(t.changePct);
              const hovered = hover?.t.symbol === t.symbol;
              const cx = x + w / 2;
              const cy = y + h / 2;
              const dim = t.price == null;

              // label tiers: skip → symbol only → symbol + change% → symbol + change% + name
              const skipText = w < 30 || h < 14;
              const symbolOnly = w < 52 || h < 26;
              const showName = w >= 140 && h >= 84;
              const showPct = !symbolOnly && h >= 40;

              const symFont = showName ? 15 : 13;
              const maxSymChars = Math.max(2, Math.floor((w - 8) / (symFont * 0.62)));
              const symLabel = truncate(t.symbol, maxSymChars);
              const maxNameChars = Math.max(4, Math.floor((w - 12) / 6));

              return (
                <g
                  key={t.symbol}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.symbol} ${t.name} ${fmtPct(t.changePct)}`}
                  className="cursor-pointer outline-none"
                  onMouseEnter={(e) => setHover({ t, cx: e.clientX, cy: e.clientY })}
                  onClick={() => openInChart(t.symbol)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openInChart(t.symbol);
                    }
                  }}
                >
                  <title>{`${t.symbol} — ${t.name}`}</title>
                  <rect
                    x={x + 1}
                    y={y + 1}
                    width={Math.max(0, w - 2)}
                    height={Math.max(0, h - 2)}
                    rx={2}
                    fill={color}
                    opacity={dim ? 0.55 : 1}
                    stroke={hovered ? "#d1d4dc" : "#131722"}
                    strokeWidth={hovered ? 1.2 : 1}
                  />
                  {!skipText && (
                    <>
                      {showName && (
                        <text
                          x={cx}
                          y={cy - 18}
                          textAnchor="middle"
                          fontSize={10}
                          fill="#d1d4dc"
                          opacity={0.85}
                        >
                          {truncate(t.name, maxNameChars)}
                        </text>
                      )}
                      <text
                        x={cx}
                        y={showName ? cy - 2 : showPct ? cy - 1 : cy + 4}
                        textAnchor="middle"
                        fontSize={symFont}
                        fontWeight={700}
                        fill={neutral ? "#c5c9d3" : "#ffffff"}
                        opacity={dim ? 0.8 : 1}
                        className="font-mono"
                      >
                        {symLabel}
                      </text>
                      {showPct && (
                        <text
                          x={cx}
                          y={showName ? cy + 14 : cy + 15}
                          textAnchor="middle"
                          fontSize={showName ? 12 : 11}
                          fill={neutral ? "#8a8f9c" : "#ffffff"}
                          opacity={0.9}
                          className="font-mono"
                        >
                          {fmtPct(t.changePct)}
                        </text>
                      )}
                      {showName && (
                        <text
                          x={cx}
                          y={cy + 30}
                          textAnchor="middle"
                          fontSize={11}
                          fill="#ffffff"
                          opacity={0.9}
                          className="font-mono"
                        >
                          {fmtVal(t.price)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {/* hover tooltip */}
        {hover && (
          <div
            className="pointer-events-none fixed z-50 w-56 rounded border border-[#2a2e39] bg-[#1c202b]/95 px-2.5 py-2 shadow-xl"
            style={{
              left: Math.max(8, Math.min(hover.cx + 12, window.innerWidth - 240)),
              top: Math.max(8, Math.min(hover.cy + 12, window.innerHeight - 110)),
            }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-bold text-white">{hover.t.symbol}</span>
              <span className="truncate text-[10px] text-[#787b86]">{hover.t.name}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[11px]">
              <span className="text-[#d1d4dc]">{fmtVal(hover.t.price)}</span>
              <span className={cn("whitespace-nowrap", upDownClass(hover.t.change))}>
                {fmtSigned(hover.t.change)} ({fmtPct(hover.t.changePct)})
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[#787b86]">
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: SECTOR_COLORS[hover.t.sector] ?? "#787b86" }}
                />
                <span className="truncate">{hover.t.sector}</span>
              </span>
              <span className="font-mono">MCap {fmtMcap(hover.t.mcap)}</span>
            </div>
          </div>
        )}
      </div>

      {/* legend */}
      <div className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#1c202b] px-3 py-1 text-[10px] text-[#787b86]">
        <div className="flex items-center gap-1.5" title="Daily % change">
          <span className="font-mono">-3%</span>
          <span
            className="h-2 w-24 rounded-full"
            style={{ background: "linear-gradient(to right, #ef5350, #2a2e39, #26a69a)" }}
          />
          <span className="font-mono">+3%</span>
        </div>
        <span>Tile size = market cap</span>
        <span className="ml-auto font-mono">{feedMode ? feedMode.toUpperCase() : "…"} · 20s auto-refresh</span>
      </div>
    </div>
  );
}
