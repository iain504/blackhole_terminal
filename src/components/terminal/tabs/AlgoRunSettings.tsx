'use client'

// Run settings dialog (Task 71-1) — show + edit the FULL config of an
// existing algo run: instrument (symbol / timeframe), strategy + parameters,
// size, % TP/SL bracket, session guards and the re-entry control — saved via
// PATCH /api/algo/[id].
//
// The engine re-reads the run row every 15s cycle ("the DB is the single
// source of truth"), so a running run picks the change up on its next tick —
// no restart, no lost journal. Nuances surfaced in the dialog:
//   • % TP/SL applies to NEW entries — an already-open position keeps the
//     bracket it was entered with (broker state is not retroactively replaced)
//   • changing symbol / timeframe / strategy resets the session memory
//     (opening range, VWAP accumulators, per-side signal edges) on save
import { useEffect, useState } from 'react'
import { RefreshCw, Settings2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  ALGO_STRATEGIES, ALGO_STRATEGY_IDS, ALGO_TIMEFRAMES, isAlgoStrategyId,
  normalizeAlgoParams, type AlgoSizingMode, type AlgoStrategyId, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { Segmented } from '@/components/terminal/tabs/Segmented'
import type { AlgoRunDto } from '@/app/api/algo/route'

export default function AlgoRunSettingsDialog({
  run, open, onOpenChange, onSaved,
}: {
  run: AlgoRunDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  // editable mirror of the run config — re-seeded every time the dialog opens
  const [strategy, setStrategy] = useState<AlgoStrategyId>('bb-reversion')
  const [symbol, setSymbol] = useState('')
  const [timeframe, setTimeframe] = useState<AlgoTimeframe>('5m')
  // position sizing (Task 78 — Risk Money)
  const [sizingMode, setSizingMode] = useState<AlgoSizingMode>('fixed')
  const [qty, setQty] = useState('10')
  const [riskMoney, setRiskMoney] = useState('200')
  const [tpOn, setTpOn] = useState(true)
  const [tpPct, setTpPct] = useState('1.5')
  const [slOn, setSlOn] = useState(true)
  const [slPct, setSlPct] = useState('1')
  const [maxTradesDay, setMaxTradesDay] = useState('3')
  const [rthOnly, setRthOnly] = useState(true)
  const [flattenEod, setFlattenEod] = useState(true)
  const [cooldownMin, setCooldownMin] = useState('0')
  const [requireNewSignal, setRequireNewSignal] = useState(false)
  const [params, setParams] = useState<Record<string, number>>(() => normalizeAlgoParams('bb-reversion', undefined))
  // raw text being typed per param key — keeps decimal points alive while
  // editing (parsing "0." → 0 and re-rendering "0" would otherwise swallow
  // the dot before the user can type "0.6")
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [showParams, setShowParams] = useState(true)

  useEffect(() => {
    if (!run || !open) return
    const sid = isAlgoStrategyId(run.strategy) ? run.strategy : 'bb-reversion'
    setStrategy(sid)
    setSymbol(run.symbol)
    setTimeframe((ALGO_TIMEFRAMES as readonly string[]).includes(run.timeframe) ? (run.timeframe as AlgoTimeframe) : '5m')
    setQty(String(run.qty))
    setSizingMode(run.sizingMode === 'risk' ? 'risk' : 'fixed')
    setRiskMoney(run.riskMoney != null ? String(run.riskMoney) : '200')
    setTpOn(run.tpMode === 'pct' && run.tpValue != null)
    setTpPct(run.tpValue != null ? String(run.tpValue) : '1.5')
    setSlOn(run.slMode === 'pct' && run.slValue != null)
    setSlPct(run.slValue != null ? String(run.slValue) : '1')
    setMaxTradesDay(String(run.maxTradesDay))
    setRthOnly(run.rthOnly)
    setFlattenEod(run.flattenEod)
    setCooldownMin(String(run.cooldownMin ?? 0))
    setRequireNewSignal(run.requireNewSignal === true)
    setParams(normalizeAlgoParams(sid, run.params))
    setParamDraft({})
    setShowParams(false)
    setSaving(false)
  }, [run, open])

  const pickStrategy = (id: AlgoStrategyId) => {
    if (id === strategy) return
    setStrategy(id)
    setParams(normalizeAlgoParams(id, undefined))
    setParamDraft({})
  }

  const def = ALGO_STRATEGIES[strategy]
  const identityChanged = !!run && (symbol.trim().toUpperCase() !== run.symbol || timeframe !== run.timeframe || strategy !== run.strategy)
  // risk sizing requires an SL % bracket — mirror the run setup's Start gate
  const riskOk = sizingMode === 'fixed' || (Number(riskMoney) > 0 && slOn && Number(slPct) > 0)

  const save = async () => {
    if (!run) return
    setSaving(true)
    try {
      const res = await fetch(`/api/algo/${run.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          timeframe,
          strategy,
          params,
          qty: Number(qty),
          sizingMode,
          riskMoney: sizingMode === 'risk' ? Number(riskMoney) : null,
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
        toast({ title: 'Run settings saved', description: `${ALGO_STRATEGIES[strategy].name} · ${symbol.trim().toUpperCase()} ${timeframe} — the engine picks it up on its next cycle` })
        onSaved()
        onOpenChange(false)
      } else {
        toast({ title: 'Could not save settings', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Could not save settings', description: 'Network error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] max-w-md gap-3 overflow-y-auto terminal-scroll">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-sky-400" aria-hidden />
            Run settings
            {run && (
              <Badge
                variant="outline"
                className={cn('text-[10px]', run.status === 'running' ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-700 text-zinc-400')}
              >
                {run.status === 'running' ? 'running' : 'stopped'}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {run ? `${run.symbol} · ${ALGO_STRATEGIES[isAlgoStrategyId(run.strategy) ? run.strategy : 'bb-reversion']?.name ?? run.strategy}` : ''}{' '}
            — every saved setting is live immediately (the engine re-reads its config each 15s cycle; no restart).
          </DialogDescription>
        </DialogHeader>

        {identityChanged && (
          <p className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] leading-snug text-amber-300" role="note">
            <TriangleAlert className="mr-1 inline h-3 w-3" aria-hidden />
            Changing symbol / timeframe / strategy resets the session memory on save (opening range, VWAP accumulators, signal edges re-arm from scratch).
          </p>
        )}
        <p className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 text-[11px] leading-snug text-zinc-400">
          % TP/SL applies to <span className="text-zinc-200">new entries</span> — a position opened earlier keeps the bracket it was entered with.
        </p>

        <div className="flex flex-col gap-2.5">
          {/* strategy */}
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Strategy</p>
            <div className="grid grid-cols-2 gap-1.5">
              {ALGO_STRATEGY_IDS.map((id) => {
                const s = ALGO_STRATEGIES[id]
                const sel = id === strategy
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => pickStrategy(id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors',
                      sel ? 'border-zinc-500 bg-zinc-800/80' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-900',
                    )}
                    aria-pressed={sel}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                    <span className="truncate text-[11px] font-semibold text-zinc-100">{s.name}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* instrument */}
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-1">
              <Label htmlFor="rs-symbol" className="text-[10px] text-zinc-500">Symbol (US stock)</Label>
              <Input id="rs-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs uppercase" />
            </div>
            <div className="col-span-1">
              <Label className="text-[10px] text-zinc-500">Timeframe</Label>
              <div className="mt-1 flex gap-1">
                {ALGO_TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    className={cn(
                      'h-8 flex-1 rounded border text-xs',
                      tf === timeframe ? 'border-zinc-500 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700',
                    )}
                    aria-pressed={tf === timeframe}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* size + cap (Task 78 — Risk Money sizing modes) */}
          <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Position sizing</p>
              <Segmented
                ariaLabel="Position sizing mode"
                size="sm"
                value={sizingMode}
                onChange={setSizingMode}
                options={[
                  { value: 'fixed', label: 'Fixed qty', title: 'Trade a fixed quantity every entry' },
                  { value: 'risk', label: 'Risk $ / trade', title: 'Risk-Money sizing — dollars at risk per trade, size derived from the SL % distance at entry' },
                ]}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              {sizingMode === 'fixed' ? (
                <div className="min-w-0">
                  <Label htmlFor="rs-qty" className="text-[11px] text-zinc-300">Quantity (shares)</Label>
                  <p className="text-[10px] leading-snug text-zinc-500">units traded per entry</p>
                </div>
              ) : (
                <div className="min-w-0">
                  <Label htmlFor="rs-risk" className="text-[11px] text-zinc-300">Risk money per trade ($)</Label>
                  <p className={cn('text-[10px] leading-snug', slOn && Number(slPct) > 0 ? 'text-zinc-500' : 'text-amber-400')}>
                    $ at risk per trade — qty = risk ÷ (entry × SL%) · applies to new entries
                  </p>
                </div>
              )}
              {sizingMode === 'fixed' ? (
                <Input id="rs-qty" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="h-7 w-16 shrink-0 border-zinc-800 bg-zinc-950 text-xs" />
              ) : (
                <Input
                  id="rs-risk"
                  value={riskMoney}
                  onChange={(e) => setRiskMoney(e.target.value)}
                  onBlur={() => setRiskMoney(String(Math.min(10_000_000, Math.max(0, Number(riskMoney) || 0))))}
                  inputMode="decimal"
                  aria-label="Risk money per trade in dollars"
                  className="h-7 w-16 shrink-0 border-zinc-800 bg-zinc-950 text-xs"
                />
              )}
            </div>
          </div>
          <div className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <Label htmlFor="rs-cap" className="text-[11px] text-zinc-300">Max trades / day</Label>
            <Input id="rs-cap" value={maxTradesDay} onChange={(e) => setMaxTradesDay(e.target.value)} inputMode="numeric" className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs" />
          </div>

          {/* TP / SL */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <Switch id="rs-tp" checked={tpOn} onCheckedChange={setTpOn} className="scale-90" />
              <Label htmlFor="rs-tp" className="text-[11px] text-zinc-400">TP %</Label>
              <Input value={tpPct} onChange={(e) => setTpPct(e.target.value)} inputMode="decimal" disabled={!tpOn} className="h-7 w-14 border-zinc-800 bg-zinc-950 text-xs" />
            </div>
            <div className="flex items-center gap-2 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <Switch id="rs-sl" checked={slOn} onCheckedChange={setSlOn} className="scale-90" />
              <Label htmlFor="rs-sl" className="text-[11px] text-zinc-400">SL %</Label>
              <Input value={slPct} onChange={(e) => setSlPct(e.target.value)} inputMode="decimal" disabled={!slOn} className="h-7 w-14 border-zinc-800 bg-zinc-950 text-xs" />
            </div>
          </div>

          {/* session guards */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <div>
                <p className="text-[11px] text-zinc-300">Regular hours only</p>
                <p className="text-[10px] text-zinc-500">enter only 09:30–16:00 ET (Mon–Fri)</p>
              </div>
              <Switch checked={rthOnly} onCheckedChange={setRthOnly} className="scale-90" aria-label="Regular hours only" />
            </div>
            <div className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <div>
                <p className="text-[11px] text-zinc-300">Flatten before close</p>
                <p className="text-[10px] text-zinc-500">no entries after 15:45 ET · close open position</p>
              </div>
              <Switch checked={flattenEod} onCheckedChange={setFlattenEod} className="scale-90" aria-label="Flatten before close" />
            </div>
          </div>

          {/* re-entry control */}
          <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Re-entry control</p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <Label htmlFor="rs-cooldown" className="text-[11px] text-zinc-300">Cooldown after close (min, 0 = off)</Label>
              <Input
                id="rs-cooldown"
                value={cooldownMin}
                onChange={(e) => setCooldownMin(e.target.value)}
                onBlur={() => setCooldownMin(String(Math.min(240, Math.max(0, Math.round(Number(cooldownMin) || 0)))))}
                inputMode="numeric"
                className="h-7 w-14 shrink-0 border-zinc-800 bg-zinc-950 text-xs"
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <Label htmlFor="rs-fresh" className="text-[11px] text-zinc-300">Require fresh signal</Label>
                <p className="text-[10px] leading-snug text-zinc-500">wait for a new cross before re-entering</p>
              </div>
              <Switch id="rs-fresh" checked={requireNewSignal} onCheckedChange={setRequireNewSignal} className="scale-90 shrink-0" />
            </div>
          </div>

          {/* strategy parameters */}
          <div>
            <button type="button" onClick={() => setShowParams((v) => !v)} className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300" aria-expanded={showParams}>
              <span className="font-semibold uppercase tracking-wider">Strategy parameters</span>
              <span className="text-zinc-600">{showParams ? '▲' : '▼'}</span>
            </button>
            {showParams && (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                {def.params.map((p) => (
                  <div key={p.key}>
                    <Label htmlFor={`rs-p-${p.key}`} className="text-[10px] text-zinc-500">{p.label}</Label>
                    {p.bool ? (
                      <button
                        id={`rs-p-${p.key}`}
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
                        id={`rs-p-${p.key}`}
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
          </div>
        </div>

        <DialogFooter className="flex-row items-center gap-2 sm:justify-end">
          <Button
            variant="outline" size="sm"
            className="h-8 border-zinc-800 bg-zinc-950 text-[11px] text-zinc-300 hover:bg-zinc-900"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-sky-600 px-3 text-[11px] text-white hover:bg-sky-500"
            disabled={saving || !symbol.trim() || !(Number(qty) > 0) || !riskOk}
            title={!riskOk ? 'Risk sizing needs a positive risk $ and an SL % bracket' : undefined}
            onClick={() => void save()}
          >
            {saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Settings2 className="h-3 w-3" />}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
