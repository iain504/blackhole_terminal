'use client'

// Algo Trading tab (Task 61 + 62 + 66) — set up and start automated strategy
// runs, backtest / auto-tune their parameters on real historical bars, and
// import/export run configs as portable JSON files.
//
// Left column: strategy picker (4 community-proven regular-hours strategies
// that suit Stage 3 / range-bound stocks) + run config (symbol, timeframe,
// qty, % TP/SL bracket, daily trade cap, session guards) → Start.
// Right column switches via the header segmented control:
//   • Live runs — running engines (status, trades today, Stop/Restart/Delete/
//     Flatten) with their live journals, polled every 5s.
//   • Backtest — BacktestPanel: replays the SAME config over history
//     (metrics, equity curve, trade list) and grid-searches parameter
//     ranges with one-click "apply best to run setup".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Rocket, RefreshCw, Play, Square, Trash2, ChevronDown, ChevronRight,
  CircleAlert, CircleCheck, Zap, Info, Ban, FlaskConical, Download, Upload, Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  ALGO_STRATEGIES, ALGO_STRATEGY_IDS, ALGO_TIMEFRAMES,
  normalizeAlgoParams, algoConfigSummaryName, algoExportFileBase,
  buildAlgoConfigExport, runToAlgoConfig, ruleToExportEntry,
  type AlpoRunConfig, type AlgoRiskBasis, type AlgoStrategyId, type AlgoSizingMode, type AlgoTimeframe,
  type AlgoRuleFileEntry, type AlgoRuleLike,
} from '@/lib/algo-strategies'
import BacktestPanel, { type AlgoSetupCfg } from '@/components/terminal/tabs/BacktestPanel'
import { Segmented } from '@/components/terminal/tabs/Segmented'
import AlgoImportDialog, { downloadJsonFile } from '@/components/terminal/tabs/AlgoConfigIO'
import AlgoRunSettingsDialog from '@/components/terminal/tabs/AlgoRunSettings'
import type { AlgoRunDto } from '@/app/api/algo/route'

const LEVEL_META: Record<string, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'text-zinc-400' },
  signal: { icon: Zap, cls: 'text-amber-300' },
  trade: { icon: CircleCheck, cls: 'text-emerald-400' },
  error: { icon: CircleAlert, cls: 'text-rose-400' },
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface AlgoData { runs: AlgoRunDto[]; rules?: AlgoRuleLike[]; mode: string; configured: boolean }

export default function AlgoTab() {
  const { toast } = useToast()
  const [data, setData] = useState<AlgoData | null>(null)
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const logRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // ---- setup form state ----
  const [strategy, setStrategy] = useState<AlgoStrategyId>('bb-reversion')
  const [symbol, setSymbol] = useState('TSLA')
  const [timeframe, setTimeframe] = useState<AlgoTimeframe>('5m')
  // position sizing (Task 78 — Risk Money): 'fixed' trades `qty` units per
  // entry · 'risk' risks the Risk-Money budget per trade (size derived at
  // entry from the SL % distance — hence risk sizing requires SL % below).
  // Task 78e — the budget is either $ (riskMoney) or % of account equity
  // (riskBasis 'pct'), resolved to dollars at each entry.
  const [sizingMode, setSizingMode] = useState<AlgoSizingMode>('fixed')
  const [riskBasis, setRiskBasis] = useState<AlgoRiskBasis>('usd')
  const [qty, setQty] = useState('10')
  const [riskMoney, setRiskMoney] = useState('200')
  const [riskPct, setRiskPct] = useState('1')
  const [tpOn, setTpOn] = useState(true)
  const [tpPct, setTpPct] = useState('1.5')
  const [slOn, setSlOn] = useState(true)
  const [slPct, setSlPct] = useState('1')
  const [maxTradesDay, setMaxTradesDay] = useState('3')
  const [rthOnly, setRthOnly] = useState(true)
  const [flattenEod, setFlattenEod] = useState(true)
  // re-entry control (Task 70-c): cooldown minutes after a close + edge-triggered re-entry
  const [cooldownMin, setCooldownMin] = useState('0')
  const [requireNewSignal, setRequireNewSignal] = useState(false)
  const [params, setParams] = useState<Record<string, number>>(() => normalizeAlgoParams('bb-reversion', undefined))
  // raw text being typed per param key — keeps decimal points alive while
  // editing (parsing "0." → 0 and re-rendering "0" would otherwise swallow
  // the dot before the user can type "0.6")
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [showParams, setShowParams] = useState(false)
  // 'runs' = live engines view · 'backtest' = Backtest & Optimize (Task 62)
  const [view, setView] = useState<'runs' | 'backtest'>('runs')
  // import/export run configs (Task 66)
  const [importOpen, setImportOpen] = useState(false)
  // per-run settings editor (Task 71-1)
  const [settingsRun, setSettingsRun] = useState<AlgoRunDto | null>(null)

  // when the strategy changes → prefill its default params
  const pickStrategy = (id: AlgoStrategyId) => {
    setStrategy(id)
    setParams(normalizeAlgoParams(id, undefined))
    setParamDraft({})
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/algo')
      if (res.ok) setData((await res.json()) as AlgoData)
    } catch { /* offline */ }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  // keep each run's log pinned to the newest line
  useEffect(() => {
    for (const r of data?.runs ?? []) {
      const el = logRefs.current[r.id]
      if (el && expanded[r.id]) el.scrollTop = el.scrollHeight
    }
  }, [data, expanded])

  const start = async (ignoreDup = false) => {
    // Task 79 — starting a SECOND enabled run on a symbol that already has one
    // is legal but usually a mistake (two engines trade the same book
    // independently → double exposure). Confirm with a warning first.
    const sym = symbol.trim().toUpperCase()
    if (!ignoreDup) {
      const dup = dupRunning(sym)
      if (dup.length > 0) {
        setDupWarn({
          kind: 'start',
          symbol: sym,
          others: dup.map((r) => `${ALGO_STRATEGIES[r.strategy]?.name ?? r.strategy} · ${r.symbol} ${r.timeframe}`),
        })
        return
      }
    }
    setStarting(true)
    try {
      const res = await fetch('/api/algo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: sym,
          timeframe,
          strategy,
          params,
          qty: Number(qty),
          sizingMode,
          riskBasis: sizingMode === 'risk' ? riskBasis : 'usd',
          riskMoney: sizingMode === 'risk' && riskBasis !== 'pct' ? Number(riskMoney) : null,
          riskMoneyPct: sizingMode === 'risk' && riskBasis === 'pct' ? Number(riskPct) : null,
          tpMode: tpOn && Number(tpPct) > 0 ? 'pct' : 'none',
          tpValue: tpOn && Number(tpPct) > 0 ? Number(tpPct) : null,
          slMode: slOn && Number(slPct) > 0 ? 'pct' : 'none',
          slValue: slOn && Number(slPct) > 0 ? Number(slPct) : null,
          maxTradesDay: Number(maxTradesDay) || 3,
          rthOnly,
          flattenEod,
          cooldownMin: Math.min(240, Math.max(0, Math.round(Number(cooldownMin) || 0))),
          requireNewSignal,
        }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: 'Algo run started', description: `${ALGO_STRATEGIES[strategy].name} · ${symbol.toUpperCase()} ${timeframe}` })
        setExpanded((e) => ({ ...e, [json.run.id]: true }))
      } else {
        toast({ title: 'Could not start run', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Could not start run', description: 'Network error', variant: 'destructive' })
    } finally {
      setStarting(false)
      void load()
    }
  }

  const act = async (id: string, action: 'stop' | 'start' | 'delete', flatten = false, label = '', ignoreDup = false) => {
    if (action === 'start' && !ignoreDup) {
      const run = (data?.runs ?? []).find((r) => r.id === id)
      const dup = run ? dupRunning(run.symbol, id) : []
      if (run && dup.length > 0) {
        setDupWarn({
          kind: 'restart',
          symbol: run.symbol,
          runId: id,
          others: dup.map((r) => `${ALGO_STRATEGIES[r.strategy]?.name ?? r.strategy} · ${r.symbol} ${r.timeframe}`),
        })
        return
      }
    }
    setBusyId(id)
    try {
      const res = action === 'start'
        ? await fetch(`/api/algo/${id}/start`, { method: 'POST' })
        : action === 'stop'
          ? await fetch(`/api/algo/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flatten }) })
          : await fetch(`/api/algo/${id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => null)
      if (res.ok) toast({ title: label || `Run ${action === 'start' ? 'restarted' : action === 'stop' ? 'stopped' : 'deleted'}` })
      else toast({ title: 'Action failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
    } catch {
      toast({ title: 'Action failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusyId(null)
      void load()
    }
  }

  const runs = data?.runs ?? []
  const ruleRows = data?.rules ?? []
  const running = useMemo(() => runs.filter((r) => r.status === 'running').length, [runs])
  // Task 79 — symbols with an enabled run, for the duplicate-symbol warning
  // (start guard) and the import dialog's double-exposure banner
  const runningSymbols = useMemo(() => new Set(runs.filter((r) => r.status === 'running').map((r) => r.symbol)), [runs])
  const dupRunning = useCallback((sym: string, excludeId?: string) =>
    runs.filter((r) => r.status === 'running' && r.symbol === sym && r.id !== excludeId), [runs])
  // pending duplicate-symbol confirmation (AlertDialog): start from the setup
  // form or restart a stopped run while another run on the same symbol is live
  const [dupWarn, setDupWarn] = useState<null | { kind: 'start' | 'restart'; symbol: string; runId?: string; others: string[] }>(null)
  const def = ALGO_STRATEGIES[strategy]
  // risk sizing is only meaningful with an SL % bracket (the stop distance IS
  // the risk unit) — Start/backtest stay disabled until the config is coherent
  const riskBudgetOk = riskBasis === 'pct' ? Number(riskPct) > 0 : Number(riskMoney) > 0
  const riskOk = sizingMode === 'fixed' || (riskBudgetOk && slOn && Number(slPct) > 0)
  const sizingHint = sizingMode === 'risk'
    ? (riskBasis === 'pct'
        ? `% of account equity at risk per trade — qty = equity×% ÷ (entry × SL%)${slOn && Number(slPct) > 0 ? '' : ' · turn SL % ON'}`
        : `$ at risk per trade — qty = risk ÷ (entry × SL%)${slOn && Number(slPct) > 0 ? '' : ' · turn SL % ON'}`)
    : 'units traded per entry'

  // shared config bundle — the backtest replays EXACTLY what a run would do
  const setupCfg: AlgoSetupCfg = useMemo(() => ({
    strategy,
    symbol: symbol.trim().toUpperCase(),
    timeframe,
    params,
    qty: Number(qty) || 0,
    sizingMode,
    riskBasis: sizingMode === 'risk' ? riskBasis : 'usd',
    riskMoney: sizingMode === 'risk' && riskBasis !== 'pct' ? (Number(riskMoney) || 0) : null,
    riskMoneyPct: sizingMode === 'risk' && riskBasis === 'pct' ? (Number(riskPct) || 0) : null,
    tpMode: tpOn && Number(tpPct) > 0 ? 'pct' : 'none',
    tpValue: tpOn && Number(tpPct) > 0 ? Number(tpPct) : null,
    slMode: slOn && Number(slPct) > 0 ? 'pct' : 'none',
    slValue: slOn && Number(slPct) > 0 ? Number(slPct) : null,
    maxTradesDay: Number(maxTradesDay) || 3,
    rthOnly,
    flattenEod,
    cooldownMin: Math.min(240, Math.max(0, Math.round(Number(cooldownMin) || 0))),
    requireNewSignal,
  }), [strategy, symbol, timeframe, params, qty, sizingMode, riskBasis, riskMoney, riskPct, tpOn, tpPct, slOn, slPct, maxTradesDay, rthOnly, flattenEod, cooldownMin, requireNewSignal])

  // ---- config import / export (Task 66) ----
  const exportSetup = () => {
    downloadJsonFile(
      `${algoExportFileBase()}-${symbol.trim().toUpperCase() || 'setup'}.json`,
      buildAlgoConfigExport([{ name: algoConfigSummaryName(setupCfg), config: setupCfg }]),
    )
    toast({ title: 'Config exported', description: algoConfigSummaryName(setupCfg) })
  }

  const exportRun = (r: AlgoRunDto) => {
    const cfg = runToAlgoConfig(r)
    downloadJsonFile(
      `${algoExportFileBase()}-${r.symbol}-${r.strategy}.json`,
      // Task 79 — the run's enable/disable state rides the export so an import
      // on any machine recreates the same stopped/running state
      buildAlgoConfigExport([{ name: algoConfigSummaryName(cfg), config: cfg, enabled: r.status === 'running' }]),
    )
    toast({ title: 'Run config exported', description: algoConfigSummaryName(cfg) })
  }

  const exportAllRuns = () => {
    const entries = runs.map((r) => {
      const cfg = runToAlgoConfig(r)
      return { name: algoConfigSummaryName(cfg), config: cfg, enabled: r.status === 'running' }
    })
    // v2 envelope — ALL strategy-drawer rules ride along (Task 70-c)
    const ruleEntries: AlgoRuleFileEntry[] = []
    for (const rule of ruleRows) {
      const e = ruleToExportEntry(rule)
      if (typeof e !== 'string') ruleEntries.push(e)
    }
    downloadJsonFile(`${algoExportFileBase()}-all.json`, buildAlgoConfigExport(entries, ruleEntries))
    toast({
      title: 'All run configs exported',
      description: `${entries.length} config${entries.length === 1 ? '' : 's'} + ${ruleEntries.length} rule${ruleEntries.length === 1 ? '' : 's'}`,
    })
  }

  const loadConfigIntoForm = (cfg: AlpoRunConfig) => {
    setStrategy(cfg.strategy)
    setSymbol(cfg.symbol)
    setTimeframe(cfg.timeframe)
    setSizingMode(cfg.sizingMode === 'risk' ? 'risk' : 'fixed')
    setRiskBasis(cfg.riskBasis === 'pct' ? 'pct' : 'usd')
    setRiskMoney(cfg.riskMoney != null ? String(cfg.riskMoney) : '200')
    setRiskPct(cfg.riskMoneyPct != null ? String(cfg.riskMoneyPct) : '1')
    setQty(String(cfg.qty))
    setTpOn(cfg.tpMode === 'pct')
    setTpPct(cfg.tpValue != null ? String(cfg.tpValue) : '1.5')
    setSlOn(cfg.slMode === 'pct')
    setSlPct(cfg.slValue != null ? String(cfg.slValue) : '1')
    setMaxTradesDay(String(cfg.maxTradesDay))
    setRthOnly(cfg.rthOnly)
    setFlattenEod(cfg.flattenEod)
    setCooldownMin(String(cfg.cooldownMin ?? 0))
    setRequireNewSignal(cfg.requireNewSignal === true)
    setParams(normalizeAlgoParams(cfg.strategy, cfg.params))
    setParamDraft({})
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 terminal-scroll">
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
        <Rocket className="h-4 w-4 text-sky-400" aria-hidden />
        <span className="text-sm font-semibold text-zinc-100">Algo Trading</span>
        <Badge variant="outline" className={cn('text-[10px]', running > 0 ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-700 text-zinc-400')}>
          {running} running
        </Badge>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {runs.length} run{runs.length === 1 ? '' : 's'}
        </Badge>
        {data && (
          <Badge
            variant="outline"
            className={cn('text-[10px]', data.mode === 'live' ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400')}
            title="Algo runs place orders in this trade mode"
          >
            {data.mode} mode
          </Badge>
        )}
        <Segmented
          ariaLabel="Algo view"
          size="sm"
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: 'runs', label: 'Live runs' },
            { value: 'backtest', label: 'Backtest' },
          ]}
        />
        <span className="ml-auto text-[11px] text-zinc-500">strategies evaluated on closed bars · every 15s</span>
        {runs.length > 0 && (
          <Button
            variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-100" onClick={exportAllRuns}
            aria-label={`Export all run configs${ruleRows.length > 0 ? ` + ${ruleRows.length} rules` : ''}`}
            title={`Export all run configs${ruleRows.length > 0 ? ` + ${ruleRows.length} rule${ruleRows.length === 1 ? '' : 's'}` : ''} (JSON)`}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-100" onClick={() => void load()} aria-label="Refresh algo runs">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {data && !data.configured && (
        <p className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
          No Alpaca keys — add them in Settings before starting a run (algo runs place real paper orders).
        </p>
      )}

      <div className="flex flex-col gap-2 lg:flex-row">
        {/* ---------------- setup column ---------------- */}
        <div className="flex w-full shrink-0 flex-col gap-2 lg:w-[400px]">
          <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Strategy</p>
            <div className="flex flex-col gap-1.5">
              {ALGO_STRATEGY_IDS.map((id) => {
                const s = ALGO_STRATEGIES[id]
                const sel = id === strategy
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => pickStrategy(id)}
                    className={cn(
                      'rounded-md border px-2.5 py-2 text-left transition-colors',
                      sel ? 'border-zinc-500 bg-zinc-800/80' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-900',
                    )}
                    aria-pressed={sel}
                  >
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                      <span className="text-xs font-semibold text-zinc-100">{s.name}</span>
                      <span className="ml-auto text-[10px] text-zinc-500">{s.tagline}</span>
                    </span>
                    {sel && (
                      <>
                        <p className="mt-1.5 text-[11px] leading-snug text-zinc-400">{s.rules}</p>
                        <p className="mt-1 text-[10px] leading-snug text-sky-400/80">{s.fit}</p>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Run setup</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-1">
                <Label htmlFor="algo-symbol" className="text-[10px] text-zinc-500">Symbol (US stock)</Label>
                <Input id="algo-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs uppercase" placeholder="TSLA" />
              </div>
              <div className="col-span-1">
                <Label htmlFor="algo-tf" className="text-[10px] text-zinc-500">Timeframe</Label>
                <Segmented
                  ariaLabel="Timeframe"
                  size="md"
                  grow
                  className="mt-1 w-full"
                  value={timeframe}
                  onChange={(tf) => setTimeframe(tf as AlgoTimeframe)}
                  options={ALGO_TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))}
                />
              </div>
              {/* position sizing (Task 78 — Risk Money; Task 78e — $ or % basis) */}
              <div className="col-span-2 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Position sizing</p>
                  <Segmented
                    ariaLabel="Position sizing mode"
                    size="sm"
                    value={sizingMode}
                    onChange={setSizingMode}
                    options={[
                      { value: 'fixed', label: 'Fixed qty', title: 'Trade a fixed quantity every entry' },
                      { value: 'risk', label: 'Risk money', title: 'Risk-Money sizing — a $ amount or % of equity at risk per trade, size derived from the SL % distance at entry' },
                    ]}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  {sizingMode === 'fixed' ? (
                    <div className="min-w-0">
                      <Label htmlFor="algo-qty" className="text-[11px] text-zinc-300">Quantity (shares)</Label>
                      <p className="text-[10px] leading-snug text-zinc-500">{sizingHint}</p>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <Label htmlFor="algo-risk" className="text-[11px] text-zinc-300">
                        {riskBasis === 'pct' ? 'Risk per trade (% of equity)' : 'Risk money per trade ($)'}
                      </Label>
                      <p className={cn('text-[10px] leading-snug', slOn && Number(slPct) > 0 ? 'text-zinc-500' : 'text-amber-400')}>{sizingHint}</p>
                    </div>
                  )}
                  {sizingMode === 'fixed' ? (
                    <Input
                      id="algo-qty"
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      inputMode="decimal"
                      className="h-7 w-16 shrink-0 border-zinc-800 bg-zinc-950 text-xs"
                    />
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Segmented
                        ariaLabel="Risk money basis — dollars or percent of equity"
                        size="sm"
                        value={riskBasis}
                        onChange={setRiskBasis}
                        options={[
                          { value: 'usd', label: '$', title: 'Fixed dollars at risk per trade' },
                          { value: 'pct', label: '%', title: 'Percent of account equity at risk per trade — resolved to dollars at each entry' },
                        ]}
                      />
                      <Input
                        id="algo-risk"
                        value={riskBasis === 'pct' ? riskPct : riskMoney}
                        onChange={(e) => (riskBasis === 'pct' ? setRiskPct(e.target.value) : setRiskMoney(e.target.value))}
                        onBlur={() => (riskBasis === 'pct'
                          ? setRiskPct(String(Math.min(100, Math.max(0, Number(riskPct) || 0))))
                          : setRiskMoney(String(Math.min(10_000_000, Math.max(0, Number(riskMoney) || 0)))))}
                        inputMode="decimal"
                        aria-label={riskBasis === 'pct' ? 'Risk per trade as percent of account equity' : 'Risk money per trade in dollars'}
                        className="h-7 w-14 shrink-0 border-zinc-800 bg-zinc-950 text-xs"
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                <Label htmlFor="algo-cap" className="text-[11px] text-zinc-300">Max trades / day</Label>
                <Input id="algo-cap" value={maxTradesDay} onChange={(e) => setMaxTradesDay(e.target.value)} inputMode="numeric" className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs" />
              </div>
              <div className="col-span-1 flex items-center gap-2">
                <Switch id="algo-tp" checked={tpOn} onCheckedChange={setTpOn} className="scale-90" />
                <Label htmlFor="algo-tp" className="text-[11px] text-zinc-400">Take profit %</Label>
                <Input value={tpPct} onChange={(e) => setTpPct(e.target.value)} inputMode="decimal" disabled={!tpOn} className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs" />
              </div>
              <div className="col-span-1 flex items-center gap-2">
                <Switch id="algo-sl" checked={slOn} onCheckedChange={setSlOn} className="scale-90" />
                <Label htmlFor="algo-sl" className="text-[11px] text-zinc-400">Stop loss %</Label>
                <Input value={slPct} onChange={(e) => setSlPct(e.target.value)} inputMode="decimal" disabled={!slOn} className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs" />
              </div>
              <div className="col-span-2 flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                <div>
                  <p className="text-[11px] text-zinc-300">Regular hours only</p>
                  <p className="text-[10px] text-zinc-500">enter only 09:30–16:00 ET (Mon–Fri)</p>
                </div>
                <Switch checked={rthOnly} onCheckedChange={setRthOnly} className="scale-90" />
              </div>
              <div className="col-span-2 flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                <div>
                  <p className="text-[11px] text-zinc-300">Flatten before close</p>
                  <p className="text-[10px] text-zinc-500">no entries after 15:45 ET · close open position</p>
                </div>
                <Switch checked={flattenEod} onCheckedChange={setFlattenEod} className="scale-90" />
              </div>
              <div className="col-span-2 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Re-entry control</p>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Label htmlFor="algo-cooldown" className="text-[11px] text-zinc-300">Cooldown after close</Label>
                    <p className="text-[10px] leading-snug text-zinc-500">minutes with no new entries after a position closes (0 = off)</p>
                  </div>
                  <Input
                    id="algo-cooldown"
                    value={cooldownMin}
                    onChange={(e) => setCooldownMin(e.target.value)}
                    onBlur={() => setCooldownMin(String(Math.min(240, Math.max(0, Math.round(Number(cooldownMin) || 0)))))}
                    inputMode="numeric"
                    className="h-7 w-14 shrink-0 border-zinc-800 bg-zinc-950 text-xs"
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Label htmlFor="algo-fresh" className="text-[11px] text-zinc-300">Require fresh signal</Label>
                    <p className="text-[10px] leading-snug text-zinc-500">wait for a new cross before re-entering — a level held past the trigger cannot fire twice</p>
                  </div>
                  <Switch id="algo-fresh" checked={requireNewSignal} onCheckedChange={setRequireNewSignal} className="scale-90 shrink-0" />
                </div>
              </div>
            </div>

            {/* advanced params */}
            <button type="button" onClick={() => setShowParams((v) => !v)} className="mt-2 flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300" aria-expanded={showParams}>
              {showParams ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Strategy parameters
            </button>
            {showParams && (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                {def.params.map((p) => (
                  <div key={p.key}>
                    <Label htmlFor={`algo-p-${p.key}`} className="text-[10px] text-zinc-500">{p.label}</Label>
                    {p.bool ? (
                      <button
                        id={`algo-p-${p.key}`}
                        type="button"
                        onClick={() => setParams((pr) => ({ ...pr, [p.key]: pr[p.key] >= 1 ? 0 : 1 }))}
                        className={cn(
                          'mt-1 h-8 w-full rounded border text-xs',
                          params[p.key] >= 1 ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400' : 'border-zinc-800 bg-zinc-950 text-zinc-500',
                        )}
                      >
                        {params[p.key] >= 1 ? 'ON' : 'OFF'}
                      </button>
                    ) : (
                      <Input
                        id={`algo-p-${p.key}`}
                        value={paramDraft[p.key] ?? String(params[p.key] ?? '')}
                        onChange={(e) => {
                          const text = e.target.value
                          setParamDraft((d) => ({ ...d, [p.key]: text }))
                          const v = Number(text)
                          if (Number.isFinite(v)) setParams((pr) => ({ ...pr, [p.key]: v }))
                        }}
                        onBlur={() =>
                          setParamDraft((d) => {
                            if (!(p.key in d)) return d
                            const next = { ...d }
                            delete next[p.key]
                            return next
                          })
                        }
                        inputMode="decimal"
                        className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            <Button
              className="mt-3 h-9 w-full gap-2 bg-sky-600 text-xs text-white hover:bg-sky-500"
              disabled={starting || !symbol.trim() || !(Number(qty) > 0) || !riskOk}
              title={!riskOk ? 'Risk sizing needs a positive risk $ / % and an SL % bracket' : undefined}
              onClick={() => void start()}
            >
              {starting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start algo run
            </Button>

            {/* import/export run configs (Task 66) */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 border-zinc-800 bg-zinc-950 text-[11px] text-zinc-300 hover:bg-zinc-900"
                onClick={() => setImportOpen(true)}
              >
                <Upload className="h-3 w-3" aria-hidden />
                Import config
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 border-zinc-800 bg-zinc-950 text-[11px] text-zinc-300 hover:bg-zinc-900"
                onClick={exportSetup}
              >
                <Download className="h-3 w-3" aria-hidden />
                Export current setup
              </Button>
            </div>
          </div>
        </div>

        {/* ---------------- right column: live runs OR backtest ---------------- */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {view === 'backtest' && (
            <BacktestPanel
              cfg={setupCfg}
              onApplyParams={(p) => {
                setParams((prev) => normalizeAlgoParams(strategy, { ...prev, ...p }))
                setShowParams(true)
              }}
            />
          )}
          {view === 'runs' && runs.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center">
              <Rocket className="h-8 w-8 text-zinc-600" aria-hidden />
              <p className="max-w-md text-sm text-zinc-400">
                No algo runs yet. Pick a strategy on the left, configure symbol / quantity / TP-SL and press
                <span className="text-zinc-200"> Start algo run</span> — the engine evaluates closed bars every 15s
                and journals every signal, order and error here.
              </p>
            </div>
          )}

          {view === 'runs' && runs.map((r) => {
            const sDef = ALGO_STRATEGIES[r.strategy as AlgoStrategyId]
            const open = expanded[r.id] ?? false
            const isRunning = r.status === 'running'
            return (
              <div key={r.id} className="flex flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
                  <span
                    className={cn('inline-block h-2 w-2 shrink-0 rounded-full', isRunning ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600')}
                    title={isRunning ? 'engine running' : 'stopped'}
                    aria-hidden
                  />
                  <span className="text-sm font-semibold text-zinc-100">{r.symbol}</span>
                  <span className="font-medium text-zinc-300">{sDef?.name ?? r.strategy}</span>
                  <Badge variant="outline" className="text-[10px] text-zinc-400">{r.timeframe}</Badge>
                  {r.sizingMode === 'risk' ? (
                    <span
                      className="text-sky-400/90"
                      title={r.riskBasis === 'pct'
                        ? `Risk-Money sizing — ${r.riskMoneyPct}% of account equity at risk per trade (resolved to dollars at entry), position size derived from the SL % distance (risk ÷ (entry × SL%)) · fallback qty ${r.qty}`
                        : `Risk-Money sizing — $${r.riskMoney} at risk per trade, position size derived at entry (risk ÷ (entry × SL%)) · fallback qty ${r.qty}`}
                    >
                      risk {r.riskBasis === 'pct' ? `${r.riskMoneyPct}%` : `$${r.riskMoney}`}/trade
                    </span>
                  ) : (
                    <span className="text-zinc-400">qty {r.qty}</span>
                  )}
                  {(r.tpMode === 'pct' || r.slMode === 'pct') && (
                    <span className="text-zinc-500">
                      {r.tpMode === 'pct' && <span className="text-emerald-400/80">TP {r.tpValue}%</span>}
                      {r.tpMode === 'pct' && r.slMode === 'pct' ? ' · ' : ''}
                      {r.slMode === 'pct' && <span className="text-rose-400/80">SL {r.slValue}%</span>}
                    </span>
                  )}
                  {r.rthOnly && <Badge variant="outline" className="text-[10px] text-zinc-500" title="Entries only during regular hours">RTH</Badge>}
                  {r.flattenEod && <Badge variant="outline" className="text-[10px] text-zinc-500" title="Flattens before the close">EOD</Badge>}
                  {(r.cooldownMin ?? 0) > 0 && (
                    <Badge variant="outline" className="border-sky-500/30 text-[10px] text-sky-400/90" title={`No new entries for ${r.cooldownMin}m after a position closes`}>
                      cooldown {r.cooldownMin}m
                    </Badge>
                  )}
                  {r.requireNewSignal && (
                    <Badge variant="outline" className="border-amber-500/30 text-[10px] text-amber-400/90" title="Waits for a fresh false→true signal before re-entering">
                      fresh-signal
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] text-zinc-500">
                    trades today <span className="font-semibold text-zinc-300">{r.tradesToday}</span>/{r.maxTradesDay}
                  </span>
                  <span className="flex items-center gap-0.5">
                    {isRunning ? (
                      <>
                        <Button
                          variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-rose-400 hover:text-rose-300"
                          disabled={busyId === r.id}
                          onClick={() => void act(r.id, 'stop', false, 'Run stopped')}
                          title="Stop the engine (keep any open position)"
                        >
                          <Square className="h-3 w-3" /> Stop
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-rose-300 hover:text-rose-200"
                          disabled={busyId === r.id}
                          onClick={() => void act(r.id, 'stop', true, 'Run stopped + position flattened')}
                          title="Stop the engine AND market-close the run's position"
                        >
                          <Ban className="h-3 w-3" /> Stop+Flat
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-emerald-400 hover:text-emerald-300"
                        disabled={busyId === r.id}
                        onClick={() => void act(r.id, 'start', false, 'Run restarted')}
                        title="Restart this run with the same config"
                      >
                        <Play className="h-3 w-3" /> Restart
                      </Button>
                    )}
                    <Button
                      variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                      disabled={busyId === r.id}
                      onClick={() => setExpanded((e) => ({ ...e, [r.id]: !open }))}
                      aria-expanded={open}
                      title="Show the engine journal"
                    >
                      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Log
                    </Button>
                    <Button
                      variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                      onClick={() => setSettingsRun(r)}
                      aria-label={`Edit settings of algo run ${r.symbol}`}
                      title="Show & edit this run's settings (applies on the next engine cycle)"
                    >
                      <Settings2 className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                      onClick={() => exportRun(r)}
                      aria-label={`Export config of algo run ${r.symbol}`}
                      title="Export this run's config (JSON)"
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-rose-400 hover:text-rose-300"
                      disabled={busyId === r.id}
                      onClick={() => void act(r.id, 'delete', false, 'Run deleted')}
                      aria-label={`Delete algo run ${r.symbol}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </span>
                </div>

                {open && (
                  <div ref={(el) => { logRefs.current[r.id] = el }} className="max-h-72 overflow-y-auto border-t border-zinc-800/60 bg-zinc-950/80 px-3 py-2 terminal-scroll" aria-label={`Engine journal for ${r.symbol}`}>
                    {r.logs.length === 0 && <p className="py-2 text-center text-[11px] text-zinc-600">No journal entries yet.</p>}
                    <div className="flex flex-col gap-1">
                      {r.logs.map((l) => {
                        const meta = LEVEL_META[l.level] ?? LEVEL_META.info
                        const Icon = meta.icon
                        return (
                          <div key={l.id} className="flex items-start gap-2 text-[11px] leading-snug">
                            <span className="w-14 shrink-0 tabular-nums text-zinc-600">{fmtClock(l.createdAt)}</span>
                            <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', meta.cls)} aria-hidden />
                            <span className={cn('min-w-0 break-words', l.level === 'error' ? 'text-rose-300' : l.level === 'trade' ? 'text-emerald-300' : l.level === 'signal' ? 'text-amber-200' : 'text-zinc-400')}>
                              {l.message}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {view === 'runs' && (
            <p className="shrink-0 px-1 text-[11px] text-zinc-600">
              Community-proven regular-hours strategies tuned for Stage 3 (distribution) names: range fades
              (BB+RSI, VWAP) exploit the chop between support and resistance; RSI-2 buys panic dips inside strength;
              the opening-range breakout trades the first directional move. Signals fire on CLOSED bars only,
              entries respect the daily cap + session guards, and % TP/SL attach as an Alpaca bracket.
            </p>
          )}
        </div>
      </div>

      <AlgoRunSettingsDialog
        run={settingsRun}
        open={settingsRun !== null}
        onOpenChange={(o) => { if (!o) setSettingsRun(null) }}
        onSaved={() => void load()}
      />
      <AlgoImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        mode={data?.mode ?? 'paper'}
        configured={data?.configured ?? false}
        runningSymbols={runningSymbols}
        onLoadIntoSetup={loadConfigIntoForm}
        onRunsStarted={() => void load()}
      />

      {/* Task 79 — double-exposure warning: the confirmed symbol already has
          an enabled run. Starting anyway is a deliberate user choice. */}
      <AlertDialog open={dupWarn !== null} onOpenChange={(o) => { if (!o) setDupWarn(null) }}>
        <AlertDialogContent className="max-w-md border-zinc-800 bg-zinc-950">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base text-zinc-100">
              <CircleAlert className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
              {dupWarn?.symbol} already has an enabled run
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed text-zinc-400">
              <span className="block">Already live on {dupWarn?.symbol}:</span>
              <span className="mt-1 block space-y-0.5">
                {dupWarn?.others.map((o) => (
                  <span key={o} className="block pl-3 text-zinc-300">• {o}</span>
                ))}
              </span>
              <span className="mt-2 block">
                Each run trades independently — two enabled runs on one symbol mean double exposure and duplicate signals on the same book. Start another one anyway?
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="h-8 border-zinc-800 bg-zinc-950 text-xs text-zinc-200 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => setDupWarn(null)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-amber-600 text-xs text-white hover:bg-amber-500"
              onClick={(e) => {
                e.preventDefault()
                const w = dupWarn
                setDupWarn(null)
                if (!w) return
                if (w.kind === 'start') void start(true)
                else if (w.runId) void act(w.runId, 'start', false, '', true)
              }}
            >
              Start anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
