"use client";

import { Fragment } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDollarSign,
  List,
  Newspaper,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useTerminal, type SidebarPanelId } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CalendarPanel } from "./calendar-panel";
import { NewsPanel } from "./news-panel";
import { QuotePanel } from "./quote-panel";
import { WatchlistContent } from "./watchlist";

const PANEL_META: Record<SidebarPanelId, { label: string; icon: typeof List }> = {
  watchlist: { label: "Watchlist", icon: List },
  quote: { label: "Quote", icon: CircleDollarSign },
  news: { label: "News", icon: Newspaper },
  calendar: { label: "Calendar", icon: CalendarClock },
};

const EXPANDED_DEFAULT_SIZE: Record<SidebarPanelId, number> = {
  watchlist: 31,
  quote: 28,
  news: 23,
  calendar: 18,
};

const CTRL_BTN =
  "flex h-6 w-6 items-center justify-center rounded text-[#787b86] transition-colors hover:bg-[#2a2e39] hover:text-white disabled:pointer-events-none disabled:opacity-40";

/**
 * Move-up / move-down / collapse controls for one sidebar panel.
 * Rendered inside the panel's own header row.
 */
function SidebarControls({ id }: { id: SidebarPanelId }) {
  const order = useTerminal((s) => s.sidebarOrder);
  const collapsedMap = useTerminal((s) => s.sidebarCollapsed);
  const moveSidebarPanel = useTerminal((s) => s.moveSidebarPanel);
  const toggleSidebarPanel = useTerminal((s) => s.toggleSidebarPanel);

  const idx = order.indexOf(id);
  const collapsed = collapsedMap[id];
  const expandedCount = order.filter((p) => !collapsedMap[p]).length;
  const meta = PANEL_META[id];

  return (
    <>
      <button
        className={CTRL_BTN}
        disabled={idx <= 0}
        onClick={() => moveSidebarPanel(id, -1)}
        aria-label={`Move ${meta.label} panel up`}
        title="Move up"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        className={CTRL_BTN}
        disabled={idx >= order.length - 1}
        onClick={() => moveSidebarPanel(id, 1)}
        aria-label={`Move ${meta.label} panel down`}
        title="Move down"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        className={CTRL_BTN}
        disabled={expandedCount <= 1 && !collapsed}
        onClick={() => toggleSidebarPanel(id)}
        aria-label={collapsed ? `Expand ${meta.label} panel` : `Collapse ${meta.label} panel`}
        title={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? <ChevronsUpDown className="h-3.5 w-3.5" /> : <ChevronsDownUp className="h-3.5 w-3.5" />}
      </button>
    </>
  );
}

/** Slim header-only strip shown when a sidebar panel is collapsed. */
function CollapsedBar({ id }: { id: SidebarPanelId }) {
  const toggleSidebarPanel = useTerminal((s) => s.toggleSidebarPanel);
  const meta = PANEL_META[id];
  const Icon = meta.icon;

  return (
    <div className="flex h-full min-h-0 items-center gap-2 overflow-hidden border-b border-[#1c202b] bg-[#131722] px-2.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[#787b86]" />
      <span className="truncate text-xs font-semibold text-[#787b86]">{meta.label}</span>
      <button
        className={cn(CTRL_BTN, "ml-auto shrink-0")}
        onClick={() => toggleSidebarPanel(id)}
        aria-label={`Expand ${meta.label} panel`}
        title="Expand"
      >
        <ChevronsUpDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function PanelBody({ id }: { id: SidebarPanelId }) {
  const controls = <SidebarControls id={id} />;
  switch (id) {
    case "watchlist":
      return <WatchlistContent controls={controls} />;
    case "quote":
      return <QuotePanel controls={controls} />;
    case "news":
      return <NewsPanel collapsed={false} controls={controls} />;
    case "calendar":
      return <CalendarPanel controls={controls} />;
  }
}

/**
 * Right sidebar: watchlist / quote / news stacked vertically.
 * Panels can be resized (drag dividers), reordered (up/down buttons in each
 * panel header) and collapsed to a slim bar; order + collapsed state persist.
 */
export function RightSidebar() {
  const order = useTerminal((s) => s.sidebarOrder);
  const collapsedMap = useTerminal((s) => s.sidebarCollapsed);

  return (
    <PanelGroup direction="vertical" autoSaveId="flux-side" className="bg-[#131722]">
      {order.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && <PanelResizeHandle className="h-px" />}
          {collapsedMap[id] ? (
            <Panel id={`${id}-min`} order={i + 1} minSize={4} maxSize={4}>
              <CollapsedBar id={id} />
            </Panel>
          ) : (
            <Panel id={id} order={i + 1} defaultSize={EXPANDED_DEFAULT_SIZE[id]} minSize={10}>
              <PanelBody id={id} />
            </Panel>
          )}
        </Fragment>
      ))}
    </PanelGroup>
  );
}
