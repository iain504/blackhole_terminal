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
  normalizeAlgoParams, type AlgoRiskBasis, type AlgoSizingMode, type AlgoStrategyId, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { Segmented } from '@/components/terminal/tabs/Segmented'
import { ATR_TF_OPTIONS } from '@/lib/atr-client'
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
  // position sizing (Task 78 — Risk Money; Task 78e — $ or % of equity basis)
  const [sizingMode, setSizingMode] = useState<AlgoSizingMode>('fixed')
  const [riskBasis, setRiskBasis] = useState<AlgoRiskBasis>('usd')
  const [qty, setQty] = useState('10')
  const [riskMoney, setRiskMoney] = useState('200')
  const [riskPct, setRiskPct] = useState('1')
  const [tpOn, setTpOn] = useState(true)
  const [tpPct, setTpPct] = useState('1.5')
  const [slOn, setSlOn] = useState(true)
  const [slPct, setSlPct] = useState('1')
  // v1.96.0 — per-leg exit unit: 'pct' = % offset · 'atr' = multiplier of
  // Wilder ATR(14) on the chosen timeframe (tpAtrTf/slAtrTf, default '1h')
  const [tpUnit, setTpUnit] = useState<'pct' | 'atr'>('pct')
  const [tpAtrTf, setTpAtrTf] = useState('1h')
  const [slUnit, setSlUnit] = useState<'pct' | 'atr'>('pct')
  const [slAtrTf, setSlAtrTf] = useState('1h')
  // v1.97.0 — trailing exit (mirrors the run setup form)
  const [trailOn, setTrailOn] = useState(false)
  const [trailArm, setTrailArm] = useState('0.5')
  const [trailGive, setTrailGive] = useState('0.3')
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
    setRiskBasis(run.riskBasis === 'pct' ? 'pct' : 'usd')
    setRiskMoney(run.riskMoney != null ? String(run.riskMoney) : '200')
    setRiskPct(run.riskMoneyPct != null ? String(run.riskMoneyPct) : '1')
    setTpOn((run.tpMode === 'pct' || run.tpMode === 'atr') && run.tpValue != null)
    setTpUnit(run.tpMode === 'atr' ? 'atr' : 'pct')
    setTpPct(run.tpValue != null ? String(run.tpValue) : '1.5')
    setTpAtrTf(run.tpMode === 'atr' ? (run.tpTf ?? '1h') : '1h')
    setSlOn((run.slMode === 'pct' || run.slMode === 'atr') && run.slValue != null)
    setSlUnit(run.slMode === 'atr' ? 'atr' : 'pct')
    setSlPct(run.slValue != null ? String(run.slValue) : '1')
    setSlAtrTf(run.slMode === 'atr' ? (run.slTf ?? '1h') : '1h')
    setTrailOn(run.trailMode === 'pct' && run.trailArmPct != null && run.trailGivePct != null)
    setTrailArm(run.trailArmPct != null ? String(run.trailArmPct) : '0.5')
    setTrailGive(run.trailGivePct != null ? String(run.trailGivePct) : '0.3')
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
  // crypto symbols trade 24/7 — equity session guards are forced off + disabled
  const isCryptoRun = (run?.symbol ?? '').includes('/')
  const identityChanged = !!run && (symbol.trim().toUpperCase() !== run.symbol || timeframe !== run.timeframe || strategy !== run.strategy)
  // risk sizing requires an SL bracket (any mode — % or ×ATR; the engine
  // resolves the stop distance at entry) — mirror the run setup's Start gate
  const riskBudgetOk = riskBasis === 'pct' ? Number(riskPct) > 0 : Number(riskMoney) > 0
  const riskOk = sizingMode === 'fixed' || (riskBudgetOk && slOn && Number(slPct) > 0)
  // TP/SL gates — an enabled bracket with a 0/negative/junk value is refused
  // by the server, so block Save (and show a hint) instead of silently
  // degrading the leg to 'none' while the switch still reads ON.
  // v1.96.0 — ATR legs must be a 0.1–20 multiplier (the API's bounds).
  const tpMultOk = Number(tpPct) >= 0.1 && Number(tpPct) <= 20
  const slMultOk = Number(slPct) >= 0.1 && Number(slPct) <= 20
  const tpInvalid = tpOn && (tpUnit === 'atr' ? !tpMultOk : !(Number(tpPct) > 0))
  const slInvalid = slOn && (slUnit === 'atr' ? !slMultOk : !(Number(slPct) > 0))
  const tpInvalidMsg = tpUnit === 'atr' ? 'TP ATR multiplier must be between 0.1 and 20' : 'TP % required when TP is on'
  const slInvalidMsg = slUnit === 'atr' ? 'SL ATR multiplier must be between 0.1 and 20' : 'SL % required when SL is on'
  // v1.97.0 — trailing exit needs BOTH percents when on (the API 400s otherwise)
  const trailInvalid = trailOn && (!(Number(trailArm) > 0) || !(Number(trailGive) > 0))
  const trailInvalidMsg = 'Trailing exit needs a positive arm % and a positive give-back %'

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
          riskBasis: sizingMode === 'risk' ? riskBasis : 'usd',
          riskMoney: sizingMode === 'risk' && riskBasis !== 'pct' ? Number(riskMoney) : null,
          riskMoneyPct: sizingMode === 'risk' && riskBasis === 'pct' ? Number(riskPct) : null,
          tpMode: tpOn ? (tpUnit === 'atr' ? 'atr' : 'pct') : 'none',
          tpValue: tpOn ? Number(tpPct) : null,
          tpTf: tpOn && tpUnit === 'atr' ? tpAtrTf : null,
          slMode: slOn ? (slUnit === 'atr' ? 'atr' : 'pct') : 'none',
          slValue: slOn ? Number(slPct) : null,
          slTf: slOn && slUnit === 'atr' ? slAtrTf : null,
          trailMode: trailOn ? 'pct' : 'off',
          trailArmPct: trailOn ? Number(trailArm) : null,
          trailGivePct: trailOn ? Number(trailGive) : null,
          maxTradesDay: Number(maxTradesDay) || 3,
          // crypto symbols trade 24/7 — the equity session guards never apply
          rthOnly: !isCryptoRun && rthOnly,
          flattenEod: !isCryptoRun && flattenEod,
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
          TP/SL applies to <span className="text-zinc-200">new entries</span> — a position opened earlier keeps the bracket it was entered with.
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
              <Label htmlFor="rs-symbol" className="text-[10px] text-zinc-500">Symbol — stock or crypto</Label>
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

          {/* size + cap (Task 78 — Risk Money sizing modes; Task 78e — $ or % basis) */}
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
                  { value: 'risk', label: 'Risk money', title: 'Risk-Money sizing — a $ amount or % of equity at risk per trade, size derived from the SL % distance at entry' },
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
                  <Label htmlFor="rs-risk" className="text-[11px] text-zinc-300">
                    {riskBasis === 'pct' ? 'Risk per trade (% of equity)' : 'Risk money per trade ($)'}
                  </Label>
                  <p className={cn('text-[10px] leading-snug', slOn && Number(slPct) > 0 ? 'text-zinc-500' : 'text-amber-400')}>
                    {riskBasis === 'pct'
                      ? `% of account equity at risk per trade — resolved at each entry`
                      : `$ at risk per trade — qty = risk ÷ (entry × SL distance)`}
                    {' '}· applies to new entries
                  </p>
                </div>
              )}
              {sizingMode === 'fixed' ? (
                <Input id="rs-qty" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="h-7 w-16 shrink-0 border-zinc-800 bg-zinc-950 text-xs" />
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
                    id="rs-risk"
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
          <div className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <Label htmlFor="rs-cap" className="text-[11px] text-zinc-300">Max trades / day</Label>
            <Input id="rs-cap" value={maxTradesDay} onChange={(e) => setMaxTradesDay(e.target.value)} inputMode="numeric" className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs" />
          </div>

          {/* TP / SL — per-leg unit: % offset or ×ATR(14) multiplier */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Switch id="rs-tp" checked={tpOn} onCheckedChange={setTpOn} className="scale-90" />
                <Label htmlFor="rs-tp" className="text-[11px] text-zinc-400">{tpUnit === 'atr' ? 'TP ×ATR' : 'TP %'}</Label>
                <Input
                  value={tpPct}
                  onChange={(e) => setTpPct(e.target.value)}
                  inputMode="decimal"
                  disabled={!tpOn}
                  aria-label={tpUnit === 'atr' ? 'Take profit ATR multiplier (0.1–20)' : 'Take profit percent'}
                  aria-invalid={tpInvalid ? true : undefined}
                  className="h-7 w-14 border-zinc-800 bg-zinc-950 text-xs"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Segmented
                  ariaLabel="Take profit unit — percent or ATR multiplier"
                  size="sm"
                  value={tpUnit}
                  onChange={(u) => {
                    setTpUnit(u)
                    // seed a sane default when the value does not fit the new unit
                    if (u === 'atr' && !tpMultOk) setTpPct('1.5')
                    if (u === 'pct' && !(Number(tpPct) > 0)) setTpPct('1.5')
                  }}
                  options={[
                    { value: 'pct', label: '%', title: 'Percent offset from the entry price' },
                    { value: 'atr', label: 'ATR', title: 'Multiplier of Wilder ATR(14) on the chosen timeframe' },
                  ]}
                />
                {tpUnit === 'atr' && (
                  <select
                    value={tpAtrTf}
                    onChange={(e) => setTpAtrTf(e.target.value)}
                    aria-label="Take profit ATR timeframe"
                    title="ATR(14) timeframe"
                    disabled={!tpOn}
                    className="h-6 rounded border border-zinc-800 bg-zinc-950 px-1 text-[10px] text-zinc-300 disabled:opacity-40"
                  >
                    {ATR_TF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
              </div>
              {tpInvalid && <p className="text-[10px] leading-snug text-rose-400">{tpInvalidMsg}</p>}
            </div>
            <div className="flex flex-col gap-1 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Switch id="rs-sl" checked={slOn} onCheckedChange={setSlOn} className="scale-90" />
                <Label htmlFor="rs-sl" className="text-[11px] text-zinc-400">{slUnit === 'atr' ? 'SL ×ATR' : 'SL %'}</Label>
                <Input
                  value={slPct}
                  onChange={(e) => setSlPct(e.target.value)}
                  inputMode="decimal"
                  disabled={!slOn}
                  aria-label={slUnit === 'atr' ? 'Stop loss ATR multiplier (0.1–20)' : 'Stop loss percent'}
                  aria-invalid={slInvalid ? true : undefined}
                  className="h-7 w-14 border-zinc-800 bg-zinc-950 text-xs"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Segmented
                  ariaLabel="Stop loss unit — percent or ATR multiplier"
                  size="sm"
                  value={slUnit}
                  onChange={(u) => {
                    setSlUnit(u)
                    if (u === 'atr' && !slMultOk) setSlPct('1.5')
                    if (u === 'pct' && !(Number(slPct) > 0)) setSlPct('1')
                  }}
                  options={[
                    { value: 'pct', label: '%', title: 'Percent offset from the entry price' },
                    { value: 'atr', label: 'ATR', title: 'Multiplier of Wilder ATR(14) on the chosen timeframe' },
                  ]}
                />
                {slUnit === 'atr' && (
                  <select
                    value={slAtrTf}
                    onChange={(e) => setSlAtrTf(e.target.value)}
                    aria-label="Stop loss ATR timeframe"
                    title="ATR(14) timeframe"
                    disabled={!slOn}
                    className="h-6 rounded border border-zinc-800 bg-zinc-950 px-1 text-[10px] text-zinc-300 disabled:opacity-40"
                  >
                    {ATR_TF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
              </div>
              {slInvalid && <p className="text-[10px] leading-snug text-rose-400">{slInvalidMsg}</p>}
            </div>
          </div>

          {/* v1.97.0 — trailing exit (engine-managed; arms once in profit) */}
          <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] text-zinc-300">Trailing exit</p>
                <p className="text-[10px] leading-snug text-zinc-500">arms once in profit ≥ arm % · closes on a give-back from the best price since — checked every 15s while the run is running (applies to the OPEN position too; the SL/TP bracket stays as the catastrophic stop)</p>
              </div>
              <Switch checked={trailOn} onCheckedChange={setTrailOn} className="scale-90 shrink-0" aria-label="Trailing exit" />
            </div>
            {trailOn && (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="rs-trail-arm" className="text-[10px] text-zinc-500">Arm after profit (%)</Label>
                  <Input
                    id="rs-trail-arm"
                    value={trailArm}
                    onChange={(e) => setTrailArm(e.target.value)}
                    onBlur={() => setTrailArm(String(Math.min(100, Math.max(0.01, Number(trailArm) || 0))))}
                    inputMode="decimal"
                    aria-label="Trailing arm threshold — percent profit needed before the trail engages"
                    aria-invalid={trailOn && !(Number(trailArm) > 0) ? true : undefined}
                    className="mt-1 h-7 border-zinc-800 bg-zinc-950 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="rs-trail-give" className="text-[10px] text-zinc-500">Give-back trail (%)</Label>
                  <Input
                    id="rs-trail-give"
                    value={trailGive}
                    onChange={(e) => setTrailGive(e.target.value)}
                    onBlur={() => setTrailGive(String(Math.min(100, Math.max(0.01, Number(trailGive) || 0))))}
                    inputMode="decimal"
                    aria-label="Trailing give-back — percent retrace from the best price that closes the position"
                    aria-invalid={trailOn && !(Number(trailGive) > 0) ? true : undefined}
                    className="mt-1 h-7 border-zinc-800 bg-zinc-950 text-xs"
                  />
                </div>
              </div>
            )}
            {trailInvalid && <p className="mt-0.5 text-[10px] leading-snug text-rose-400">{trailInvalidMsg}</p>}
          </div>

          {/* session guards — equity concepts; crypto runs 24/7 and shows them disabled */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <div>
                <p className="text-[11px] text-zinc-300">Regular hours only</p>
                <p className="text-[10px] text-zinc-500">{isCryptoRun ? 'crypto trades 24/7 — session guard not applicable' : 'enter only 09:30–16:00 ET (Mon–Fri)'}</p>
              </div>
              <Switch checked={isCryptoRun ? false : rthOnly} disabled={isCryptoRun} onCheckedChange={setRthOnly} className="scale-90" aria-label="Regular hours only" />
            </div>
            <div className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
              <div>
                <p className="text-[11px] text-zinc-300">Flatten before close</p>
                <p className="text-[10px] text-zinc-500">{isCryptoRun ? 'crypto trades 24/7 — no daily close to flatten at' : 'no entries after 15:45 ET · close open position'}</p>
              </div>
              <Switch checked={isCryptoRun ? false : flattenEod} disabled={isCryptoRun} onCheckedChange={setFlattenEod} className="scale-90" aria-label="Flatten before close" />
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
            disabled={saving || !symbol.trim() || !(Number(qty) > 0) || !riskOk || tpInvalid || slInvalid || trailInvalid}
            title={!riskOk
              ? 'Risk sizing needs a positive risk $ / % and an SL bracket (any mode)'
              : tpInvalid
                ? tpInvalidMsg
                : slInvalid
                  ? slInvalidMsg
                  : undefined}
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
