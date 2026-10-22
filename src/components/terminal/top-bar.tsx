"use client";

import {
  Bell,
  ChartArea,
  ChartCandlestick,
  ChartLine,
  Check,
  ChevronDown,
  Columns2,
  Grid2x2,
  LogIn,
  LogOut,
  PanelLeftOpen,
  Rows2,
  Settings,
  ShieldCheck,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TIMEFRAMES, INTRADAY_TFS, type Timeframe } from "@/lib/types";
import { INDICATORS } from "@/lib/indicators";
import { useTerminal, type ChartType, type LayoutId } from "@/lib/store";
import { SymbolSearch } from "./symbol-search";
import { cn } from "@/lib/utils";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 select-none">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="9" width="3.4" height="9" rx="0.8" fill="#26a69a" />
        <line x1="4.7" y1="5.5" x2="4.7" y2="9" stroke="#26a69a" strokeWidth="1.4" />
        <line x1="4.7" y1="18" x2="4.7" y2="20.5" stroke="#26a69a" strokeWidth="1.4" />
        <rect x="10.3" y="5" width="3.4" height="8" rx="0.8" fill="#ef5350" />
        <line x1="12" y1="2.5" x2="12" y2="5" stroke="#ef5350" strokeWidth="1.4" />
        <line x1="12" y1="13" x2="12" y2="16.5" stroke="#ef5350" strokeWidth="1.4" />
        <rect x="17.6" y="8" width="3.4" height="10.5" rx="0.8" fill="#26a69a" />
        <line x1="19.3" y1="5" x2="19.3" y2="8" stroke="#26a69a" strokeWidth="1.4" />
        <line x1="19.3" y1="18.5" x2="19.3" y2="21.5" stroke="#26a69a" strokeWidth="1.4" />
      </svg>
      {!compact && (
        <div className="leading-none">
          <div className="text-[15px] font-bold tracking-tight text-white">FluxView</div>
          <div className="mt-0.5 text-[9px] font-medium uppercase tracking-widest text-[#787b86]">
            powered by Alpaca
          </div>
        </div>
      )}
    </div>
  );
}

const CHART_TYPES: { value: ChartType; label: string; icon: React.ReactNode }[] = [
  { value: "candles", label: "Candles", icon: <ChartCandlestick className="h-4 w-4" /> },
  { value: "line", label: "Line", icon: <ChartLine className="h-4 w-4" /> },
  { value: "area", label: "Area", icon: <ChartArea className="h-4 w-4" /> },
];

const LAYOUTS: { value: LayoutId; label: string; icon: React.ReactNode }[] = [
  { value: "1", label: "Single chart", icon: <Square className="h-3.5 w-3.5" /> },
  { value: "2h", label: "Two columns", icon: <Columns2 className="h-4 w-4" /> },
  { value: "2v", label: "Two rows", icon: <Rows2 className="h-4 w-4" /> },
  { value: "4", label: "Grid 2 × 2", icon: <Grid2x2 className="h-4 w-4" /> },
];

export function TopBar() {
  const symbol = useTerminal((s) => s.symbol);
  const timeframe = useTerminal((s) => s.timeframe);
  const chartType = useTerminal((s) => s.chartType);
  const indicators = useTerminal((s) => s.indicators);
  const setTimeframe = useTerminal((s) => s.setTimeframe);
  const setChartType = useTerminal((s) => s.setChartType);
  const toggleIndicator = useTerminal((s) => s.toggleIndicator);
  const layout = useTerminal((s) => s.layout);
  const setLayout = useTerminal((s) => s.setLayout);
  const setSettingsOpen = useTerminal((s) => s.setSettingsOpen);
  const setMobileListOpen = useTerminal((s) => s.setMobileListOpen);
  const setAlertsOpen = useTerminal((s) => s.setAlertsOpen);
  const mode = useTerminal((s) => s.mode);
  const alerts = useTerminal((s) => s.alerts);
  const authUser = useTerminal((s) => s.authUser);
  const authStatus = useTerminal((s) => s.authStatus);
  const hasUsers = useTerminal((s) => s.hasUsers);
  const setAuthOpen = useTerminal((s) => s.setAuthOpen);
  const logout = useTerminal((s) => s.logout);
  const activeAlerts = alerts.filter((a) => a.active).length;

  const activeType = CHART_TYPES.find((t) => t.value === chartType) ?? CHART_TYPES[0];
  const overlays = INDICATORS.filter((m) => m.pane === "overlay");
  const subs = INDICATORS.filter((m) => m.pane === "sub");
  const activeCount = Object.values(indicators).filter(Boolean).length;
  const isIntraday = INTRADAY_TFS.has(timeframe);

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-[#1c202b] bg-[#131722] px-2 md:gap-2 md:px-3">
      <button
        className="flex items-center rounded p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] md:hidden"
        onClick={() => setMobileListOpen(true)}
        aria-label="Open watchlist"
      >
        <PanelLeftOpen className="h-5 w-5 text-[#b2b5be]" />
      </button>

      <div className="hidden shrink-0 items-center pr-1 md:flex">
        <Logo />
      </div>

      <SymbolSearch
        onSelect={(s) => useTerminal.getState().setSymbol(s)}
        align="start"
        trigger={
          <Button
            variant="ghost"
            className="h-9 gap-1.5 rounded-md bg-transparent px-2.5 font-mono text-[15px] font-bold tracking-wide text-white hover:bg-[#2a2e39]"
            aria-label={`Change symbol, current ${symbol}`}
          >
            {symbol}
            <ChevronDown className="h-3.5 w-3.5 text-[#787b86]" />
          </Button>
        }
      />

      <div className="relative h-full min-w-0 flex-1 overflow-x-auto" role="group" aria-label="Timeframes">
        <div className="flex h-full items-center gap-0.5 px-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf as Timeframe)}
              aria-pressed={timeframe === tf}
              className={cn(
                "h-7 shrink-0 rounded-md px-2 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a]",
                timeframe === tf
                  ? "bg-[#2a2e39] text-white"
                  : "text-[#b2b5be] hover:bg-white/5 hover:text-white"
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="hidden h-9 shrink-0 gap-1.5 px-2 text-xs font-semibold text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white sm:flex"
            aria-label={`Chart layout, ${LAYOUTS.find((l) => l.value === layout)?.label ?? "Single chart"}`}
            title="Chart layout"
          >
            {LAYOUTS.find((l) => l.value === layout)?.icon ?? <Square className="h-3.5 w-3.5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44 border-[#2a2e39] bg-[#1e222d] text-[#d1d4dc]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#787b86]">
            Chart layout
          </DropdownMenuLabel>
          {LAYOUTS.map((l) => (
            <DropdownMenuItem
              key={l.value}
              onClick={() => setLayout(l.value)}
              className="cursor-pointer gap-2.5 data-[highlighted]:bg-[#2a2e39]"
            >
              {l.icon}
              <span className="flex-1">{l.label}</span>
              {layout === l.value && <Check className="h-3.5 w-3.5 text-[#26a69a]" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 px-2 text-xs font-semibold text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white">
            {activeType.icon}
            <span className="hidden lg:inline">{activeType.label}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40 border-[#2a2e39] bg-[#1e222d] text-[#d1d4dc]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#787b86]">Chart style</DropdownMenuLabel>
          {CHART_TYPES.map((t) => (
            <DropdownMenuItem
              key={t.value}
              onClick={() => setChartType(t.value)}
              className="cursor-pointer gap-2 aria-checked:bg-[#2a2e39] data-[highlighted]:bg-[#2a2e39]"
            >
              {t.icon}
              {t.label}
              {chartType === t.value && <Check className="ml-auto h-3.5 w-3.5 text-[#26a69a]" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 px-2 text-xs font-semibold text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white" aria-label={`Indicators, ${activeCount} active`}>
            <span className="hidden font-serif text-base leading-none lg:inline">ƒx</span>
            <span className="lg:hidden">ƒ</span>
            {activeCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#26a69a]/20 px-1 text-[10px] font-bold text-[#26a69a]">
                {activeCount}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 border-[#2a2e39] bg-[#1e222d] text-[#d1d4dc]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#787b86]">
            Overlays · price pane
          </DropdownMenuLabel>
          {overlays.map((m) => (
            <DropdownMenuItem
              key={m.key}
              disabled={m.intradayOnly && !isIntraday}
              onClick={() => toggleIndicator(m.key)}
              className={cn(
                "cursor-pointer gap-2.5 data-[highlighted]:bg-[#2a2e39]",
                m.intradayOnly && !isIntraday && "cursor-not-allowed opacity-40"
              )}
              title={m.intradayOnly && !isIntraday ? "Intraday timeframes only" : undefined}
            >
              <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: m.color }} />
              <span className="flex-1">{m.label}</span>
              {indicators[m.key] && <Check className="h-3.5 w-3.5 text-[#26a69a]" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="bg-[#2a2e39]" />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#787b86]">
            Oscillators · separate panes
          </DropdownMenuLabel>
          {subs.map((m) => (
            <DropdownMenuItem
              key={m.key}
              onClick={() => toggleIndicator(m.key)}
              className="cursor-pointer gap-2.5 data-[highlighted]:bg-[#2a2e39]"
            >
              <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: m.color }} />
              <span className="flex-1">{m.label}</span>
              {indicators[m.key] && <Check className="ml-auto h-3.5 w-3.5 text-[#26a69a]" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {mode === "demo" && (
        <button
          onClick={() => setSettingsOpen(true)}
          className="hidden shrink-0 items-center gap-1.5 rounded-md border border-[#f0b90b]/30 bg-[#f0b90b]/10 px-2.5 py-1.5 text-[11px] font-semibold text-[#f0b90b] transition-colors hover:bg-[#f0b90b]/20 sm:flex"
          title="Connect Alpaca API keys for live data"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f0b90b]" />
          Demo data · Connect
        </button>
      )}
      {mode === "live" && (
        <div className="hidden shrink-0 items-center gap-1.5 rounded-md border border-[#26a69a]/30 bg-[#26a69a]/10 px-2.5 py-1.5 text-[11px] font-semibold text-[#26a69a] sm:flex">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#26a69a]" />
          Live · Alpaca IEX
        </div>
      )}

      {/* account */}
      {authStatus === "authed" && authUser ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 shrink-0 gap-1.5 px-2 text-xs font-semibold text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
              aria-label={`Account: ${authUser.username}`}
              title={`Signed in as ${authUser.username}`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#26a69a]/15 text-[10px] font-bold uppercase text-[#26a69a]">
                {authUser.username.slice(0, 2)}
              </span>
              <span className="hidden lg:inline max-w-24 truncate">{authUser.username}</span>
              {authUser.totpEnabled && <ShieldCheck className="h-3.5 w-3.5 text-[#26a69a]" aria-label="2FA enabled" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 border-[#2a2e39] bg-[#1e222d] text-[#d1d4dc]">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#787b86]">
              Signed in as {authUser.username}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => setSettingsOpen(true)}
              className="cursor-pointer gap-2.5 data-[highlighted]:bg-[#2a2e39]"
            >
              <ShieldCheck className="h-4 w-4 text-[#26a69a]" />
              <span className="flex-1">Security &amp; 2FA</span>
              {authUser.totpEnabled && <Check className="h-3.5 w-3.5 text-[#26a69a]" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[#2a2e39]" />
            <DropdownMenuItem
              onClick={() => void logout()}
              className="cursor-pointer gap-2.5 text-[#ef5350] data-[highlighted]:bg-[#2a2e39] data-[highlighted]:text-[#ef5350]"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        authStatus === "guest" &&
        hasUsers && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 shrink-0 gap-1.5 px-2.5 text-xs font-semibold text-[#26a69a] hover:bg-[#26a69a]/10 hover:text-[#26a69a]"
            onClick={() => setAuthOpen(true)}
            aria-label="Sign in"
            title="Sign in to sync your layout, watchlists and alerts"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden sm:inline">Sign in</span>
          </Button>
        )
      )}

      <Button
        variant="ghost"
        size="icon"
        className="relative h-9 w-9 shrink-0 text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
        onClick={() => setAlertsOpen(true)}
        aria-label={`Price alerts, ${activeAlerts} active`}
        title="Price alerts"
      >
        <Bell className="h-[18px] w-[18px]" />
        {activeAlerts > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#f0b90b] px-1 text-[9px] font-bold text-[#131722]"
            aria-hidden="true"
          >
            {activeAlerts > 9 ? "9+" : activeAlerts}
          </span>
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0 text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
        onClick={() => setSettingsOpen(true)}
        aria-label="Settings"
      >
        <Settings className="h-[18px] w-[18px]" />
      </Button>
    </header>
  );
}
