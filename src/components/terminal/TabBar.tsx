'use client'

// Top bar: local tabs (chart / calendar / heat map) + add-tab menu + account controls.
import { useTerminal, TabType } from '@/store/terminal'
import {
  CandlestickChart, CalendarDays, Flame, Plus, X, LogOut, Settings2, BellRing, UserRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'

const TYPE_META: Record<TabType, { label: string; icon: typeof CandlestickChart }> = {
  chart: { label: 'Chart', icon: CandlestickChart },
  calendar: { label: 'Economic Calendar', icon: CalendarDays },
  heatmap: { label: 'Heat Map', icon: Flame },
}

export function TabBar({
  onOpenSettings,
  alertsOpen,
  setAlertsOpen,
}: {
  onOpenSettings: () => void
  alertsOpen: boolean
  setAlertsOpen: (v: boolean) => void
}) {
  const tabs = useTerminal((s) => s.tabs)
  const activeTabId = useTerminal((s) => s.activeTabId)
  const setActiveTab = useTerminal((s) => s.setActiveTab)
  const addTab = useTerminal((s) => s.addTab)
  const closeTab = useTerminal((s) => s.closeTab)
  const user = useTerminal((s) => s.user)
  const alerts = useTerminal((s) => s.alerts)
  const activeAlerts = alerts.filter((a) => a.status === 'active').length

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  return (
    <header className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-2 py-1.5">
      <div className="mr-2 flex items-center gap-1.5 pl-1">
        <CandlestickChart className="h-4 w-4 text-emerald-500" />
        <span className="hidden text-sm font-semibold tracking-tight text-zinc-100 sm:inline">TradeTerminal</span>
      </div>

      {/* tabs strip */}
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Terminal tabs">
        {tabs.map((t) => {
          const Icon = TYPE_META[t.type].icon
          const isActive = t.id === activeTabId
          const title = t.type === 'chart' ? t.symbol : TYPE_META[t.type].label
          return (
            <div
              key={t.id}
              className={`group flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs transition-colors ${
                isActive
                  ? 'border-emerald-500 bg-zinc-800/80 text-zinc-100'
                  : 'border-transparent text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
              }`}
            >
              <button
                className="flex items-center gap-1.5"
                onClick={() => setActiveTab(t.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="max-w-[140px] truncate font-medium">{title}</span>
              </button>
              {tabs.length > 1 && (
                <button
                  className="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100"
                  onClick={() => closeTab(t.id)}
                  aria-label={`Close ${title} tab`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )
        })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-zinc-400 hover:text-zinc-100" aria-label="Add tab">
              <Plus className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="border-zinc-800 bg-zinc-900">
            <DropdownMenuLabel className="text-xs text-zinc-500">New tab</DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem onClick={() => addTab('chart')} className="gap-2 text-xs">
              <CandlestickChart className="h-3.5 w-3.5" /> Chart layout
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('calendar')} className="gap-2 text-xs">
              <CalendarDays className="h-3.5 w-3.5" /> Economic Calendar
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('heatmap')} className="gap-2 text-xs">
              <Flame className="h-3.5 w-3.5" /> Heat Map
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      {/* account cluster */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="relative h-7 w-7 text-zinc-400 hover:text-zinc-100"
          onClick={() => setAlertsOpen(!alertsOpen)}
          aria-label="Price alerts"
        >
          <BellRing className="h-4 w-4" />
          {activeAlerts > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[9px] font-bold text-zinc-950">
              {activeAlerts}
            </span>
          )}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-100" onClick={onOpenSettings} aria-label="Settings">
          <Settings2 className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-zinc-300">
              <UserRound className="h-3.5 w-3.5" />
              <span className="hidden max-w-[120px] truncate md:inline">{user?.username}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-400">
                2FA enabled
              </Badge>
            </div>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem onClick={logout} className="gap-2 text-xs text-rose-400">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
