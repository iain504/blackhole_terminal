"use client";

import { useRef, useState } from "react";
import { CalendarDays, CandlestickChart, Grid2x2, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTerminal, type TerminalTab } from "@/lib/store";
import { cn } from "@/lib/utils";

function TabIcon({ kind, className }: { kind: TerminalTab["kind"]; className?: string }) {
  return kind === "calendar" ? (
    <CalendarDays className={className} />
  ) : (
    <CandlestickChart className={className} />
  );
}

function Tab({
  tab,
  active,
  canClose,
  onSelect,
  onClose,
  onRename,
}: {
  tab: TerminalTab;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== tab.name) onRename(draft);
    else setDraft(tab.name);
  };

  if (editing) {
    return (
      <div className="flex h-7 shrink-0 items-center rounded-md bg-[#2a2e39] px-2">
        <TabIcon kind={tab.kind} className="mr-1.5 h-3.5 w-3.5 text-[#26a69a]" />
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(tab.name);
              setEditing(false);
            }
          }}
          maxLength={40}
          aria-label="Tab name"
          className="w-28 bg-transparent text-xs text-white outline-none"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(tab.name);
        setEditing(true);
      }}
      title={`${tab.name} — double-click to rename`}
      className={cn(
        "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
        active
          ? "bg-[#2a2e39] font-medium text-white"
          : "text-[#787b86] hover:bg-[#1c202b] hover:text-[#b2b5be]"
      )}
    >
      <TabIcon kind={tab.kind} className={cn("h-3.5 w-3.5", active ? "text-[#26a69a]" : "text-[#787b86]")} />
      <span className="max-w-36 truncate">{tab.name}</span>
      <span
        role="button"
        tabIndex={canClose ? 0 : -1}
        aria-label={canClose ? `Close ${tab.name}` : "The last tab cannot be closed"}
        onClick={(e) => {
          e.stopPropagation();
          if (canClose) onClose();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === "Delete") && canClose) {
            e.stopPropagation();
            onClose();
          }
        }}
        className={cn(
          "rounded p-0.5 text-[#787b86] hover:bg-[#363a45] hover:text-white",
          canClose ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  );
}

/** TradingView-style bottom tab bar: chart workspace pages and full-page tools. */
export function TabBar() {
  const tabs = useTerminal((s) => s.tabs);
  const activeTabId = useTerminal((s) => s.activeTabId);
  const setActiveTab = useTerminal((s) => s.setActiveTab);
  const addTab = useTerminal((s) => s.addTab);
  const closeTab = useTerminal((s) => s.closeTab);
  const renameTab = useTerminal((s) => s.renameTab);

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-[#1c202b] bg-[#131722] px-1.5"
      role="tablist"
      aria-label="Workspace tabs"
    >
      {tabs.map((t) => (
        <Tab
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          canClose={tabs.length > 1}
          onSelect={() => setActiveTab(t.id)}
          onClose={() => closeTab(t.id)}
          onRename={(name) => renameTab(t.id, name)}
        />
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="New tab"
            title="New tab"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[#787b86] transition-colors hover:bg-[#1c202b] hover:text-white"
          >
            <Plus className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="border-[#2a2e39] bg-[#1c202b] text-[#d1d4dc]">
          <DropdownMenuItem
            onClick={() => addTab("charts")}
            className="cursor-pointer gap-2 text-xs focus:bg-[#2a2e39] focus:text-white"
          >
            <CandlestickChart className="h-4 w-4 text-[#26a69a]" />
            <div className="flex flex-col">
              <span>Chart</span>
              <span className="text-[10px] text-[#787b86]">Stock chart workspace</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => addTab("heatmap")}
            className="cursor-pointer gap-2 text-xs focus:bg-[#2a2e39] focus:text-white"
          >
            <Grid2x2 className="h-4 w-4 text-[#e056fd]" />
            <div className="flex flex-col">
              <span>Heat Map</span>
              <span className="text-[10px] text-[#787b86]">US stocks &amp; crypto, sized by market cap</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => addTab("calendar")}
            className="cursor-pointer gap-2 text-xs focus:bg-[#2a2e39] focus:text-white"
          >
            <CalendarDays className="h-4 w-4 text-[#f0b90b]" />
            <div className="flex flex-col">
              <span>Economic Calendar</span>
              <span className="text-[10px] text-[#787b86]">Coming week macro events</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
