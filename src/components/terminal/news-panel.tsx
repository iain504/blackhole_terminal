"use client";

import type { ReactNode } from "react";
import { ChevronDown, ExternalLink, Loader2, Newspaper } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { fetchNews } from "@/lib/client-api";
import { fmtTimeAgo } from "@/lib/format";
import { useTerminal } from "@/lib/store";

export function NewsPanel({
  collapsed,
  onToggleCollapsed,
  controls,
}: {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  controls?: ReactNode;
}) {
  const symbol = useTerminal((s) => s.symbol);

  const { data, loading } = usePoll(() => fetchNews(symbol), 60000, [symbol]);
  const news = data?.news ?? [];

  if (collapsed) {
    return (
      <div className="flex h-full flex-col bg-[#131722]">
        <button
          className="flex h-8 items-center gap-2 border-b border-[#1c202b] px-3 text-xs font-semibold text-[#787b86] hover:text-white"
          onClick={() => onToggleCollapsed?.()}
          aria-label="Expand news panel"
        >
          <Newspaper className="h-3.5 w-3.5" />
          News
          {news.length > 0 && <span className="text-[10px] font-normal">· {news.length} stories</span>}
          <ChevronDown className="ml-auto h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#131722]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[#1c202b] px-3">
        <Newspaper className="h-3.5 w-3.5 text-[#787b86]" />
        <span className="text-xs font-semibold text-[#d1d4dc]">News</span>
        <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 font-mono text-[10px] text-[#b2b5be]">{symbol}</span>
        {loading && !data && <Loader2 className="h-3 w-3 animate-spin text-[#787b86]" />}
        <div className="ml-auto flex items-center gap-0.5">
          {controls}
          {!controls && (
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-white"
              onClick={() => onToggleCollapsed?.()}
              aria-label="Collapse news panel"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="term-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !data ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-[#787b86]" />
          </div>
        ) : news.length === 0 ? (
          <p className="py-8 text-center text-xs text-[#787b86]">No recent news for {symbol}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {news.map((n) => (
              <a
                key={n.id}
                href={n.url !== "#" ? n.url : undefined}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (n.url === "#") e.preventDefault();
                }}
                className="group flex flex-col gap-1 rounded-lg border border-[#1c202b] bg-[#161a25] p-3 transition-colors hover:border-[#2a2e39] hover:bg-[#1a1f2c]"
              >
                <div className="flex items-center gap-2 text-[10px] text-[#787b86]">
                  <span className="font-semibold uppercase tracking-wide text-[#26a69a]">{n.source}</span>
                  <span>·</span>
                  <span>{fmtTimeAgo(n.publishedAt)}</span>
                  {n.url !== "#" && <ExternalLink className="ml-auto h-3 w-3 opacity-0 group-hover:opacity-100" />}
                </div>
                <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[#d1d4dc] group-hover:text-white">
                  {n.headline}
                </p>
                <p className="line-clamp-2 text-[11px] leading-relaxed text-[#787b86]">{n.summary}</p>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
