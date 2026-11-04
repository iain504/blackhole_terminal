'use client'

// v2.4.0 — Nebula Autopilot (智慧體) — the FSD-style fleet tab.
//
// ONE tab drives the whole autonomous loop:
//   LAUNCH SCAN → 100 US high-VOL stocks (+ crypto majors) swept across the
//   algo catalog on both lanes → top candidates tuned on optimizer grids →
//   Calmar-score ranking (OOS-verified first) → account BUYING POWER sizing
//   → ENGAGE spawns real algo engines → rainbow frame spins while the fleet
//   trades → live ops cards stream every move.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { visibleAwareInterval } from '@/lib/visible-poll'
import { ALGO_STRATEGIES } from '@/lib/algo-strategies'
import {
  AGENT_SETTINGS_DEFAULTS, type AgentCandidate, type AgentSettings,
  type AgentStateResponse, type AgentEventDto, type AgentBudget, type AgentStats,
} from '@/lib/agent-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import type { RegimeSnapshot, RegimeState } from '@/lib/regime-types'
import { DevicesCard } from '@/components/terminal/DevicesCard'
import { useToast } from '@/hooks/use-toast'
import {
  Sparkles, Radar, BrainCircuit, Trophy, Wallet, Rocket, Square, Play, Trash2,
  Activity, TrendingUp, Crosshair, Gauge, CircleDollarSign, Zap, Globe2,
  TriangleAlert, HardDrive, ShieldCheck, CircleHelp, CalendarClock,
} from 'lucide-react'

// v2.7.5 — which broker lanes the account can actually ENGAGE with. The
// fleet places real paper/live orders, so the server refuses ENGAGE without
// Alpaca keys — and every platform DB reset wipes the saved ones together
// with the account. Mirrors the server's mode-strict resolution:
//   paper lane ← paper pair OR legacy single pair OR env-shared keys
//   live lane  ← live pair only
// Advisory only — the server side stays the single source of truth.
type BrokerAvail = { paper: boolean; live: boolean }

const STATUS_META: Record<string, { label: string; cls: string; dot: string }> = {
  scanning: { label: 'SCANNING', cls: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10', dot: 'bg-cyan-400' },
  tuning: { label: 'TUNING', cls: 'text-violet-300 border-violet-500/40 bg-violet-500/10', dot: 'bg-violet-400' },
  ranking: { label: 'RANKING', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10', dot: 'bg-amber-400' },
  budget: { label: 'SIZING', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10', dot: 'bg-emerald-400' },
  ready: { label: 'READY', cls: 'text-emerald-300 border-emerald-400/50 bg-emerald-500/10', dot: 'bg-emerald-400' },
  engaged: { label: 'ENGAGED', cls: 'text-fuchsia-300 border-fuchsia-500/50 bg-fuchsia-500/10', dot: 'bg-fuchsia-400' },
  stopped: { label: 'STOPPED', cls: 'text-zinc-300 border-zinc-600/60 bg-zinc-700/20', dot: 'bg-zinc-400' },
  error: { label: 'FAILED', cls: 'text-rose-300 border-rose-500/50 bg-rose-500/10', dot: 'bg-rose-400' },
}

const EVENT_CLS: Record<string, string> = {
  scan: 'text-cyan-300', tune: 'text-violet-300', rank: 'text-amber-300',
  budget: 'text-emerald-300', trade: 'text-fuchsia-300', warn: 'text-yellow-300',
  error: 'text-rose-400', info: 'text-zinc-400',
}

// v2.10.0 — the US-tape regime chip (SPY/QQQ trend + UVXY vol, 15-min cached
// server-side). Advisory here — the ENFORCERS live server-side: the pipeline
// halves the deployable budget in RISK_OFF and the per-entry regime gate
// blocks fleet BUYs while the tape stays risk-off.
const REGIME_META: Record<RegimeState, { label: string; cls: string }> = {
  RISK_ON: { label: 'RISK ON', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  NEUTRAL: { label: 'NEUTRAL', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  RISK_OFF: { label: 'RISK OFF', cls: 'text-rose-300 border-rose-500/50 bg-rose-500/10' },
  UNKNOWN: { label: 'NO TAPE DATA', cls: 'text-zinc-400 border-zinc-600/60 bg-zinc-700/20' },
}

const money = (v: number | null | undefined, dp = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: dp })}`
const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp)

interface PositionRow {
  symbol: string
  qty: number
  avgEntry: number
  upl: number
  uplPct: number
  current: number
}

export default function AgentTab() {
  const { toast } = useToast()
  const [data, setData] = useState<AgentStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AgentSettings>(AGENT_SETTINGS_DEFAULTS)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const syncedRef = useRef(false)
  const seqRef = useRef(0)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const [positions, setPositions] = useState<Record<string, PositionRow>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmEngage, setConfirmEngage] = useState(false)
  const [confirmDisengage, setConfirmDisengage] = useState(false)
  const [broker, setBroker] = useState<BrokerAvail | null>(null)
  // v2.10.0 — the US-tape regime chip. 5-min poll (the server snapshot itself
  // is 15-min cached); a failed probe just hides the chip, never blocks UI.
  const [regime, setRegime] = useState<RegimeSnapshot | null>(null)

  // v2.7.5 — fetch key availability so the Command deck can warn BEFORE a
  // scan is burned on an account that cannot engage. Re-fetched on mount and
  // whenever the session changes state (keys may have just been added in
  // Settings → Broker).
  const loadBroker = useCallback(async () => {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' })
      if (!res.ok) return
      const j = (await res.json()) as {
        alpaca?: {
          paper?: { secretSet?: boolean }
          live?: { secretSet?: boolean }
          legacy?: { secretSet?: boolean }
          serverKeysPresent?: boolean
        }
      }
      setBroker({
        paper: Boolean(j.alpaca?.paper?.secretSet || j.alpaca?.legacy?.secretSet || j.alpaca?.serverKeysPresent),
        live: Boolean(j.alpaca?.live?.secretSet),
      })
    } catch {
      // banner is advisory — a failed probe just hides it
    }
  }, [])

  useEffect(() => { void loadBroker() }, [loadBroker])

  const loadRegime = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/regime', { cache: 'no-store' })
      if (!res.ok) return
      setRegime((await res.json()) as RegimeSnapshot)
    } catch {
      // the chip is advisory — a failed probe just leaves the last state up
    }
  }, [])

  useEffect(() => {
    void loadRegime()
    const t = setInterval(() => { void loadRegime() }, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [loadRegime])

  const session = data?.session ?? null
  const candidates = data?.candidates ?? []
  const events = data?.events ?? []
  const runs = data?.runs ?? []
  const status = session?.status ?? 'idle'
  const engaged = status === 'engaged'
  const inFlight = status === 'scanning' || status === 'tuning' || status === 'ranking' || status === 'budget'
  const budget = (session?.budget ?? null) as AgentBudget | null
  const stats = (session?.stats ?? null) as AgentStats | null
  // v2.6.1 — the paper/live switch must respond INSTANTLY: while the fleet is
  // idle/ready the mode comes from the local settings form (the switch writes
  // there); once scanning/engaged the mode is baked into the session, so the
  // display locks to the server's truth and the switch disables.
  const modeLocked = engaged || inFlight
  const mode = ((modeLocked ? session?.settings?.mode : settings.mode) === 'live' ? 'live' : 'paper') as 'live' | 'paper'

  // v2.7.5 — keys can be added mid-session in Settings → Broker: re-probe
  // availability whenever the session state changes (idle → ready matters
  // most, that is the moment ENGAGE becomes possible).
  const brokerStatusRef = useRef<string | null>(null)
  useEffect(() => {
    if (brokerStatusRef.current !== status) {
      brokerStatusRef.current = status
      void loadBroker()
    }
  }, [status, loadBroker])

  // v2.8.0 — a parked board (disengaged fleet) can be re-engaged instantly;
  // the scan button relabels to make the fresh-scan choice explicit.
  const parkedBoard = status === 'ready' && !!session?.phase?.startsWith('PARKED')

  // ---- server storage card (v2.8.0) ----
  type StorageReport = {
    disk: {
      free: { bytes: number | null; human: string | null }
      total: { bytes: number | null; human: string | null }
      db: { bytes: number | null; human: string | null; reclaimable?: { bytes: number | null; human: string | null } | null }
      wal: { bytes: number | null; human: string | null }
      path: string
    }
    tables: { key: string; label: string; rows: number; hint: string }[]
  }
  const [storage, setStorage] = useState<StorageReport | null>(null)
  const [storageOpen, setStorageOpen] = useState(false)
  const [storageBusy, setStorageBusy] = useState<string | null>(null)
  const [storageMsg, setStorageMsg] = useState('')

  const loadStorage = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/storage', { cache: 'no-store' })
      if (!res.ok) return
      setStorage((await res.json()) as StorageReport)
    } catch { /* card is advisory */ }
  }, [])

  useEffect(() => {
    if (storageOpen) void loadStorage()
  }, [storageOpen, loadStorage])

  const storageAction = async (action: string) => {
    setStorageBusy(action)
    setStorageMsg('')
    try {
      const res = await fetch('/api/agent/storage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      })
      const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      setStorageMsg(res.ok ? (j.message ?? 'Done') : (j.error ?? `HTTP ${res.status}`))
      if (res.ok) await loadStorage()
    } catch (e) {
      setStorageMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setStorageBusy(null)
    }
  }

  // ---- poll the agent state (3s) ----
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const res = await fetch('/api/agent', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as AgentStateResponse
      if (seq !== seqRef.current) return
      setData(json)
      setLoadError(null)
      // v2.8.3 — broadcast engagement to the global chrome (footer / mobile
      // bottom nav): the "running rainbow" reacts instantly while this tab is
      // open, instead of waiting for the chrome's own 15s backstop poll.
      window.dispatchEvent(
        new CustomEvent('tt:fleet-state', { detail: { engaged: json.session?.status === 'engaged' } }),
      )
      // sync the form from the session ONCE (never stomp user edits)
      if (!syncedRef.current && json.session?.settings) {
        syncedRef.current = true
        setSettings({ ...AGENT_SETTINGS_DEFAULTS, ...json.session.settings } as AgentSettings)
      }
    } catch (e) {
      if (seq === seqRef.current) setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // v2.11.3 — the 3s brain poll is the heaviest cadence in the terminal;
    // paused while the tab is hidden (one refresh on return)
    return visibleAwareInterval(() => void load(), 3000)
  }, [load])

  // ---- live positions for the engaged fleet (15s) ----
  useEffect(() => {
    if (!engaged) return
    const pull = async () => {
      try {
        const res = await fetch('/api/trading/positions', { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        if (!Array.isArray(json.positions)) return
        const map: Record<string, PositionRow> = {}
        for (const p of json.positions) {
          map[p.symbol as string] = p as PositionRow
        }
        setPositions(map)
      } catch { /* transient */ }
    }
    void pull()
    // v2.11.3 — paused while the tab is hidden (one refresh on return)
    return visibleAwareInterval(() => void pull(), 15_000)
  }, [engaged])

  // autoscroll the brain feed
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])

  const post = useCallback(async (body: Record<string, unknown>, okMsg?: string) => {
    setBusy(String(body.action ?? ''))
    try {
      const res = await fetch('/api/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      if (okMsg) toast({ title: okMsg, description: json.error ?? undefined })
      if (body.action === 'start') syncedRef.current = false
      await load()
      return json
    } catch (e) {
      toast({ title: 'Autopilot command failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' })
      return null
    } finally {
      setBusy(null)
    }
  }, [load, toast])

  const setS = (patch: Partial<AgentSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    setSettingsDirty(true)
  }

  const applySettings = async () => {
    if (!session) return
    const res = await post({ action: 'update', sessionId: session.id, settings })
    if (res?.ok) { setSettingsDirty(false); toast({ title: 'Fleet re-sized', description: 'BUYING POWER allocation updated.' }) }
  }

  const runBySymbol = useMemo(() => {
    const m = new Map<string, AgentStateResponse['runs'][number]>()
    for (const r of runs) m.set(r.symbol, r)
    return m
  }, [runs])

  const fleetSymbols = useMemo(
    () => candidates.filter((c) => c.selected && (c.allocQty ?? 0) > 0).map((c) => `${c.symbol} ${c.score >= 0 ? '' : ''}·${num(c.score, 1)}`),
    [candidates],
  )

  const selectedCount = candidates.filter((c) => c.selected && (c.allocQty ?? 0) > 0).length

  // ------------------------------------------------------------------ render
  if (loading && !data) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const sMeta = STATUS_META[status]

  const inner = (
    <div className="relative z-10 flex flex-col gap-4 p-4 md:p-5">
      {/* ---------------- header ---------------- */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={cn(
            'grid h-11 w-11 place-items-center rounded-xl border',
            engaged
              ? 'border-fuchsia-400/60 bg-fuchsia-500/10 shadow-[0_0_18px_rgba(217,70,239,0.45)]'
              : 'border-zinc-700 bg-zinc-900',
          )}>
            <Sparkles className={cn('h-5 w-5', engaged ? 'text-fuchsia-300' : 'text-violet-300')} />
          </div>
          <div>
            <h1 className="bg-gradient-to-r from-cyan-300 via-violet-300 to-fuchsia-300 bg-clip-text text-lg font-bold tracking-tight text-transparent md:text-xl">
              智慧體 · NEBULA AUTOPILOT
            </h1>
            <p className="text-xs text-zinc-500">
              Full-Self-Driving fleet — scan 100 US high-VOL{settings.includeCrypto ? ' + crypto majors' : ''} · backtest · tune · rank · size · trade
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sMeta && (
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wider', sMeta.cls)}>
              <span className={cn('h-1.5 w-1.5 animate-pulse rounded-full', sMeta.dot)} />
              {sMeta.label}
            </span>
          )}
          {regime && (
            <span
              title={[
                ...regime.reasons,
                regime.barsAsOf ? `Daily bars as of ${regime.barsAsOf}${regime.stale ? ' · STALE — gates fail open' : ''}` : null,
              ].filter(Boolean).join('\n')}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wider', REGIME_META[regime.regime].cls)}
            >
              {regime.regime === 'RISK_ON' ? (
                <TrendingUp className="h-3 w-3" />
              ) : regime.regime === 'RISK_OFF' ? (
                <TriangleAlert className="h-3 w-3" />
              ) : regime.regime === 'UNKNOWN' ? (
                <CircleHelp className="h-3 w-3" />
              ) : (
                <Activity className="h-3 w-3" />
              )}
              {REGIME_META[regime.regime].label}
            </span>
          )}
          <span className={cn(
            'rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wider',
            mode === 'live' ? 'border-rose-500/50 bg-rose-500/10 text-rose-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
          )}>
            {mode.toUpperCase()}
          </span>
          {(engaged || status === 'ready') && session && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-zinc-500 hover:text-rose-300"
              onClick={() => void post({ action: 'delete', sessionId: session.id }, 'Session cleared')}
              disabled={engaged}>
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>
      </header>

      {data?.configured === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          No Alpaca keys on this account — scans run on real market data but ENGAGE needs keys (Settings → Broker). Paper mode included.
        </div>
      )}

      {/* ---------------- rainbow marquee (engaged) ---------------- */}
      {engaged && fleetSymbols.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-900/60 py-1.5" aria-hidden>
          <div className="agent-marquee-track gap-8 pr-8 text-[11px] font-semibold tracking-wide">
            {[...fleetSymbols, ...fleetSymbols].map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 text-zinc-300">
                <Zap className="h-3 w-3 text-fuchsia-400" /> {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- progress / phase ---------------- */}
      {inFlight && (
        <div className="relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="agent-scanline pointer-events-none absolute inset-y-0 left-0 w-1/3" />
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-zinc-300">
              <Radar className="h-3.5 w-3.5 animate-spin text-cyan-300" style={{ animationDuration: '3s' }} />
              {session?.phase || 'WORKING'}
            </span>
            <span className="font-mono text-zinc-500">{Math.round((session?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 transition-all duration-500"
              style={{ width: `${Math.max(2, (session?.progress ?? 0) * 100)}%` }} />
          </div>
          {/* v2.8.1 — abort is user-scoped server-side; sessionId is sent when
              available but no longer required (it used to 400 without one). */}
          <Button size="sm" variant="outline" className="mt-2 h-7 border-rose-500/40 text-xs text-rose-300 hover:bg-rose-500/10"
            onClick={() => void post({ action: 'abort', sessionId: session?.id }, 'Abort signalled')} disabled={busy === 'abort'}>
            <Square className="h-3 w-3" /> Abort scan
          </Button>
        </div>
      )}

      {session?.error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {session.error}
        </div>
      )}

      {/* ---------------- control deck ---------------- */}
      <section className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        {/* settings */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Gauge className="h-4 w-4 text-violet-300" /> Mission parameters
            {settingsDirty && <Badge variant="outline" className="ml-1 border-amber-500/40 text-[10px] text-amber-300">unsaved</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <NumberField label="Fleet size (top N)" value={settings.topN} min={3} max={15} step={1} onChange={(v) => setS({ topN: v })} />
            <NumberField label="Tune top candidates" value={settings.topTune} min={4} max={40} step={1} onChange={(v) => setS({ topTune: v })} />
            <NumberField label="Risk / trade (% equity)" value={settings.riskPerTradePct} min={0.1} max={3} step={0.1} onChange={(v) => setS({ riskPerTradePct: v })} />
            <NumberField label="Deploy cap (% BUYING POWER)" value={settings.deployCapPct} min={10} max={95} step={5} onChange={(v) => setS({ deployCapPct: v })} />
            <NumberField label="Position cap (% equity)" value={settings.maxPosPct} min={2} max={25} step={1} onChange={(v) => setS({ maxPosPct: v })} />
            <NumberField label="Max trades / day" value={settings.maxTradesDay} min={1} max={10} step={1} onChange={(v) => setS({ maxTradesDay: v })} />
            <NumberField label="Min Calmar score" value={settings.minScore} min={0} max={5} step={0.05} onChange={(v) => setS({ minScore: v })} />
            <NumberField label="Sentiment weight (news ×)" value={settings.sentimentWeight} min={0} max={1} step={0.05} onChange={(v) => setS({ sentimentWeight: v })} />
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2 pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <Switch checked={settings.includeCrypto} onCheckedChange={(v) => setS({ includeCrypto: v })} />
                <Globe2 className="h-3.5 w-3.5 text-amber-300" /> Crypto majors
              </label>
              <label
                className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300"
                title="Reads the US tape (QQQ/SPY 50-DMA trend + UVXY vol): RISK OFF halves the deployable budget and blocks new longs on fleet entries — shorts and crypto stay live, an unknown tape fails open."
              >
                <Switch checked={settings.regimeGate !== false} onCheckedChange={(v) => setS({ regimeGate: v })} />
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" /> US regime gate
              </label>
              <label
                className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300"
                title="Pulls each candidate's next earnings date (Yahoo consensus): a report within 5 days dampens the score ×0.85, and fleet entries refuse NEW longs inside the 2-day pre-report window (crypto exempt, unknown dates fail open)."
              >
                <Switch checked={settings.earningsGate !== false} onCheckedChange={(v) => setS({ earningsGate: v })} />
                <CalendarClock className="h-3.5 w-3.5 text-amber-300" /> Earnings gate
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2 pb-1">
              <label
                className={cn('flex items-center gap-2 text-xs text-zinc-300', !modeLocked && 'cursor-pointer')}
                title={modeLocked ? 'Mode is locked while the fleet is scanning or engaged' : 'PAPER = simulated orders · LIVE = real orders on your Alpaca account'}
              >
                <Switch
                  checked={mode === 'live'}
                  disabled={modeLocked}
                  onCheckedChange={(v) => setS({ mode: v ? 'live' : 'paper' })}
                />
                <span className={mode === 'live' ? 'font-semibold text-rose-300' : ''}>LIVE mode</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <Switch checked={settings.autoEngage} onCheckedChange={(v) => setS({ autoEngage: v })} />
                Auto-engage
              </label>
            </div>
          </div>
          {mode === 'live' && (
            <p className="mt-2 text-[11px] text-rose-300/90">
              LIVE — real orders on your Alpaca live account. Keys + explicit mode choice are the only guards.
            </p>
          )}
          {status === 'ready' && settingsDirty && (
            <Button size="sm" className="mt-3 h-8 bg-violet-600 text-xs hover:bg-violet-500" onClick={() => void applySettings()} disabled={busy === 'update'}>
              Re-size fleet with new parameters
            </Button>
          )}
        </div>

        {/* launch / engage deck */}
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="text-sm font-semibold text-zinc-200">Command deck</div>
          {/* v2.7.5 — broker-readiness banner: ENGAGE is refused without Alpaca
              keys (the fleet places real orders), and platform DB resets wipe
              the saved ones with the account. Warn BEFORE the scan, not after. */}
          {!engaged && broker && !(mode === 'live' ? broker.live : broker.paper) && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <div className="flex-1 text-xs leading-relaxed text-amber-200">
                ENGAGE is refused without Alpaca <span className="font-bold">{mode.toUpperCase()}</span> keys — this
                account has none (platform DB resets clear saved keys). Add them in Settings → Broker, then relaunch
                the scan.
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 border-amber-500/40 px-2 text-[11px] text-amber-200 hover:bg-amber-500/15"
                onClick={() => window.dispatchEvent(new CustomEvent('tt:open-settings'))}
              >
                Open Settings
              </Button>
            </div>
          )}
          {!inFlight && status !== 'engaged' && (
            <Button
              className="h-14 bg-gradient-to-r from-cyan-500 via-violet-500 to-fuchsia-500 text-sm font-bold tracking-wide text-white shadow-[0_0_24px_rgba(139,92,246,0.35)] transition hover:brightness-110"
              onClick={() => void post({ action: 'start', settings }, 'Full scan launched')}
              disabled={busy === 'start' || data?.jobRunning}
            >
              <Rocket className="mr-2 h-5 w-5" />
              {data?.jobRunning ? 'PIPELINE RUNNING…' : parkedBoard ? 'LAUNCH FRESH SCAN' : 'LAUNCH FULL SCAN'}
            </Button>
          )}
          {status === 'ready' && (
            <Button
              className="h-14 animate-pulse bg-gradient-to-r from-emerald-500 via-lime-500 to-emerald-400 text-sm font-bold tracking-wide text-zinc-950 shadow-[0_0_24px_rgba(16,185,129,0.45)] transition hover:animate-none hover:brightness-110"
              onClick={() => setConfirmEngage(true)}
              disabled={busy === 'engage'}
            >
              {/* v2.8.0 — a disengaged session parks at READY: the board is
                  still sized and live, so this button restarts the fleet
                  instantly (no full re-scan needed). */}
              <Play className="mr-2 h-5 w-5" />
              {session?.phase?.startsWith('PARKED') ? 'RE-ENGAGE FLEET' : 'ENGAGE FLEET'} {mode === 'live' ? '· LIVE' : '· PAPER'}
            </Button>
          )}
          {engaged && session && (
            <Button
              variant="outline"
              className="h-14 border-rose-500/50 bg-rose-500/10 text-sm font-bold tracking-wide text-rose-300 hover:bg-rose-500/20"
              onClick={() => setConfirmDisengage(true)}
              disabled={busy === 'disengage'}
            >
              <Square className="mr-2 h-5 w-5" /> DISENGAGE FLEET
            </Button>
          )}
          <div className="grid grid-cols-3 gap-2 text-center">
            <StatChip label="Scanned" value={stats ? `${stats.scanned}/${stats.scanTotal}` : '—'} icon={<Radar className="h-3 w-3 text-cyan-300" />} />
            <StatChip label="Tuned" value={stats ? `${stats.tuned}/${stats.tuneTotal}` : '—'} icon={<BrainCircuit className="h-3 w-3 text-violet-300" />} />
            <StatChip label="Fleet" value={stats && engaged ? `${stats.fleetStarted}` : `${selectedCount}`} icon={<Rocket className="h-3 w-3 text-fuchsia-300" />} />
          </div>
          {parkedBoard && (
            <div className="rounded-lg border border-zinc-700/60 bg-zinc-800/40 p-2.5 text-[11px] leading-relaxed text-zinc-400">
              Score board parked from the last fleet run — RE-ENGAGE restarts the engines instantly, no scan needed.
              The board refreshes when you launch a fresh scan.
            </div>
          )}
        </div>
      </section>

      {/* ---------------- server storage (v2.8.0) ---------------- */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setStorageOpen((v) => !v)}
          aria-expanded={storageOpen}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <HardDrive className="h-4 w-4 text-zinc-400" /> Server storage
          </span>
          <span className="text-[11px] font-normal text-zinc-500">
            {storage?.disk.db.human
              ? `DB ${storage.disk.db.human}${storage.disk.wal.human ? ` · WAL ${storage.disk.wal.human}` : ''}${storage.disk.free.human ? ` · ${storage.disk.free.human} free` : ''}`
              : 'show usage'}
          </span>
        </button>
        {storageOpen && (
          <div className="mt-3 space-y-3">
            {/* v2.8.4 — freelist diagnostic: says BEFORE the rebuild whether
                VACUUM can free anything at all (≈0 ⇒ the space is in the
                container log / host Docker disk image, not the db). */}
            {storage?.disk.db.reclaimable?.bytes ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-200">
                ~{storage.disk.db.reclaimable.human} of free pages sit inside the db file — "Reclaim space" rebuilds
                the file to return them to the disk.
              </div>
            ) : null}
            <div className="grid gap-1.5 text-[11px]">
              {(storage?.tables ?? []).map((t) => (
                <div key={t.key} className="flex items-center justify-between gap-2 rounded-md bg-zinc-800/40 px-2.5 py-1.5">
                  <span className="text-zinc-300">
                    {t.label}
                    {t.hint ? <span className="ml-2 text-zinc-600">{t.hint}</span> : null}
                  </span>
                  <span className="font-mono text-zinc-400">{t.rows.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="h-8 border-emerald-500/40 bg-emerald-500/15 text-xs text-emerald-200 hover:bg-emerald-500/25"
                variant="outline"
                disabled={storageBusy != null}
                onClick={() => void storageAction('vacuum')}
              >
                {storageBusy === 'vacuum' ? 'REBUILDING…' : 'Reclaim space (VACUUM)'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800"
                disabled={storageBusy != null}
                onClick={() => void storageAction('purge-bars')}
              >
                {storageBusy === 'purge-bars' ? 'PURGING…' : 'Purge bar cache'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800"
                disabled={storageBusy != null}
                onClick={() => void storageAction('purge-logs')}
              >
                {storageBusy === 'purge-logs' ? 'PURGING…' : 'Purge old logs'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800"
                disabled={storageBusy != null}
                onClick={() => void storageAction('purge-kronos')}
              >
                {storageBusy === 'purge-kronos' ? 'PURGING…' : 'Purge old forecasts'}
              </Button>
            </div>
            {storageMsg && <div className="rounded-md bg-zinc-800/60 p-2 text-[11px] text-zinc-300">{storageMsg}</div>}
            <p className="text-[10px] leading-relaxed text-zinc-600">
              SQLite keeps deleted rows inside the file until VACUUM rebuilds it — reclaim space after big purges.
              The FSD results store is tiny and makes the next scan fast; leave it alone. VACUUM only rebuilds the db
              file INSIDE the container — it can never shrink the container stdout log or the Docker VM disk image on
              the host (Docker.raw / ext4.vhdx keep their high-water mark until pruned/compacted: docker system prune,
              docker builder prune).
            </p>
          </div>
        )}
      </section>

      {/* ---------------- devices (v2.9.3) ---------------- */}
      <DevicesCard />

      {/* ---------------- budget strip ---------------- */}
      {budget && (
        <section className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <BudgetCard icon={<Wallet className="h-3.5 w-3.5 text-emerald-300" />} label="Equity" value={money(budget.equity, 2)} />
          <BudgetCard icon={<CircleDollarSign className="h-3.5 w-3.5 text-cyan-300" />} label="Buying power" value={money(budget.buyingPower, 2)} />
          <BudgetCard icon={<Activity className="h-3.5 w-3.5 text-violet-300" />} label={`Deployable (${session?.settings?.deployCapPct ?? '—'}%)`} value={money(budget.deployable)} />
          <BudgetCard icon={<Crosshair className="h-3.5 w-3.5 text-amber-300" />} label="Per slot" value={money(budget.perSlot)} />
          <BudgetCard icon={<TrendingUp className="h-3.5 w-3.5 text-lime-300" />} label="Risk / trade" value={money(budget.riskPerTrade, 2)} />
          <BudgetCard icon={<Zap className="h-3.5 w-3.5 text-fuchsia-300" />} label="Fleet notional" value={money(budget.fleetNotional)} />
        </section>
      )}

      {/* ---------------- brain console + live ops ---------------- */}
      <section className="grid gap-3 lg:grid-cols-2">
        {/* brain feed */}
        <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-sm font-semibold text-zinc-200">
            <BrainCircuit className="h-4 w-4 text-cyan-300" /> Autopilot brain
            <span className="ml-auto font-mono text-[10px] text-zinc-600">{events.length} events</span>
          </div>
          <div ref={feedRef} className="agent-scroll max-h-64 min-h-40 overflow-y-auto px-4 py-2 font-mono text-[11px] leading-relaxed">
            {events.length === 0 && <div className="py-6 text-center text-zinc-600">No decisions yet — launch a scan and the brain starts talking.</div>}
            {events.map((e: AgentEventDto) => (
              <div key={e.id} className="flex gap-2 py-0.5">
                <span className="shrink-0 text-zinc-600">{new Date(e.createdAt).toLocaleTimeString([], { hour12: false })}</span>
                <span className={cn('shrink-0 font-semibold uppercase', EVENT_CLS[e.level] ?? 'text-zinc-400')}>{e.level}</span>
                <span className={cn(EVENT_CLS[e.level] ?? 'text-zinc-400')}>{e.message}</span>
              </div>
            ))}
          </div>
        </div>

        {/* live ops */}
        <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-sm font-semibold text-zinc-200">
            <Activity className={cn('h-4 w-4', engaged ? 'text-fuchsia-300' : 'text-zinc-500')} /> Fleet operations
            {engaged && <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold tracking-widest text-fuchsia-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fuchsia-400" /> LIVE</span>}
          </div>
          <div className="agent-scroll max-h-64 min-h-40 space-y-2 overflow-y-auto p-3">
            {runs.length === 0 && (
              <div className="py-6 text-center text-xs text-zinc-600">
                {engaged ? 'Starting engines…' : 'No fleet engines — the ops board lights up on ENGAGE.'}
              </div>
            )}
            {runs.map((r) => {
              const pos = positions[r.symbol]
              return (
                <div key={r.runId} className={cn(
                  'rounded-lg border px-3 py-2 transition',
                  r.status === 'running' ? 'border-fuchsia-500/30 bg-fuchsia-500/5' : 'border-zinc-800 bg-zinc-900',
                )}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-zinc-100">{r.symbol}</span>
                    <Badge variant="outline" className="h-4 border-zinc-700 px-1 text-[9px] text-zinc-400">{(r.timeframe ?? '—').toUpperCase()}</Badge>
                    <span className="text-[11px] text-zinc-400">{ALGO_STRATEGIES[r.strategy as keyof typeof ALGO_STRATEGIES]?.name ?? r.strategy}</span>
                    <span className="ml-auto font-mono text-[11px] text-zinc-500">×{r.qty}</span>
                    <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider',
                      r.status === 'running' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-zinc-700/40 text-zinc-400')}>
                      {r.status === 'running' ? 'TRADING' : (r.status ?? '').toUpperCase()}
                    </span>
                  </div>
                  {pos && (
                    <div className="mt-1 flex items-center gap-3 font-mono text-[11px]">
                      <span className="text-zinc-500">@{pos.avgEntry}</span>
                      <span className={cn('font-semibold', pos.upl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {pos.upl >= 0 ? '+' : ''}{pos.upl.toFixed(2)} ({pos.uplPct.toFixed(2)}%)
                      </span>
                    </div>
                  )}
                  {r.lastLog && (
                    <div className="mt-1 truncate text-[10px] text-zinc-600" title={r.lastLog}>{r.lastLog}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ---------------- ranking table ---------------- */}
      {candidates.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-sm font-semibold text-zinc-200">
            <Trophy className="h-4 w-4 text-amber-300" /> Score board
            <span className="text-xs font-normal text-zinc-500">— highest Calmar score first (OOS-verified rows outrank bigger in-sample numbers)</span>
          </div>
          <div className="agent-scroll max-h-96 overflow-auto">
            <table className="w-full min-w-[860px] text-left text-[11px]">
              <thead className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur">
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Symbol</th>
                  <th className="px-3 py-2 font-medium">TF</th>
                  <th className="px-3 py-2 font-medium">Strategy</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 text-right font-medium">Net %</th>
                  <th className="px-3 py-2 text-right font-medium">Win %</th>
                  <th className="px-3 py-2 text-right font-medium">PF</th>
                  <th className="px-3 py-2 text-right font-medium">DD %</th>
                  <th className="px-3 py-2 text-right font-medium">Trades</th>
                  <th className="px-3 py-2 text-right font-medium">OOS %</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Notional</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c: AgentCandidate) => {
                  const run = c.runId ? runBySymbol.get(c.symbol) : undefined
                  const isTop = (c.rank ?? 99) <= 3
                  return (
                    <tr key={`${c.symbol}-${c.tf}-${c.strategy}`} className={cn(
                      'border-t border-zinc-800/70 transition hover:bg-zinc-800/40',
                      c.selected && (c.allocQty ?? 0) > 0 && 'bg-emerald-500/[0.06]',
                      isTop && 'bg-amber-500/[0.04]',
                    )}>
                      <td className={cn('px-3 py-1.5 font-mono font-bold', isTop ? 'text-amber-300' : 'text-zinc-500')}>{c.rank}</td>
                      <td className="px-3 py-1.5 font-bold text-zinc-100">
                        {c.symbol}
                        {c.isCrypto && <Badge variant="outline" className="ml-1 h-3.5 border-amber-600/40 px-1 text-[8px] text-amber-300">C</Badge>}
                        {/* v2.11.0 — earnings calendar risk: E·Nd badge when the
                            next consensus report sits inside the warn (5d) or
                            block (2d) window; the full story is in the title */}
                        {c.earningsFlag && c.earningsDays != null && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'ml-1 h-3.5 px-1 text-[8px] font-bold',
                              c.earningsFlag === 'block' ? 'border-rose-500/50 text-rose-300' : 'border-amber-600/40 text-amber-300',
                            )}
                            title={`Reports earnings ${c.earningsAt ? c.earningsAt.slice(0, 10) : 'soon'} (est.) — score damped ×0.85 inside the 5-day window;${c.earningsFlag === 'block' ? ' inside the 2-day window the fleet\'s earnings gate also REFUSES new longs through the report.' : ' the entry gate arms only inside 2 days.'}`}
                          >
                            E·{c.earningsDays}d
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-400">{(c.tf ?? '?').toUpperCase()}</td>
                      <td className="px-3 py-1.5 text-zinc-300">
                        {ALGO_STRATEGIES[c.strategy]?.name ?? c.strategy}
                        <span className={cn('ml-1 text-[9px] font-bold uppercase', c.lane === 'swing' ? 'text-violet-400' : 'text-cyan-500')}>{c.lane}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold text-zinc-100">
                        {num(c.score)}
                        {/* v2.5.0 — news sentiment blended into the rank score */}
                        {c.sent != null && (
                          <span
                            className={cn(
                              'ml-1 align-middle text-[9px] font-semibold',
                              c.sent > 0.15 ? 'text-emerald-400' : c.sent < -0.15 ? 'text-rose-400' : 'text-zinc-500',
                            )}
                            title={`news sentiment ${c.sent >= 0 ? '+' : ''}${c.sent.toFixed(2)} blended (base ${c.scoreBase != null ? num(c.scoreBase) : '—'}); fleet entries also carry the sentiment gate`}
                          >
                            {c.sent >= 0 ? '▲' : '▼'}{Math.abs(c.sent).toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className={cn('px-3 py-1.5 text-right font-mono', c.netPct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{num(c.netPct, 1)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{num(c.winRate, 0)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{num(c.pf)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-rose-300/80">{num(c.maxDDPct, 1)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{c.trades}</td>
                      <td className={cn('px-3 py-1.5 text-right font-mono', c.oosNetPct == null ? 'text-zinc-600' : c.oosNetPct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {c.oosNetPct == null ? '—' : num(c.oosNetPct, 1)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{c.allocQty != null ? c.allocQty : '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{c.allocNotional != null ? money(c.allocNotional, 0) : '—'}</td>
                      <td className="px-3 py-1.5">
                        {run ? (
                          <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider',
                            run.status === 'running' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-zinc-700/40 text-zinc-400')}>
                            {run.status === 'running' ? '● TRADING' : 'STOPPED'}
                          </span>
                        ) : c.selected && (c.allocQty ?? 0) > 0 ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-emerald-300">ARMED</span>
                        ) : c.skipReason ? (
                          <span className="text-[10px] text-zinc-600" title={c.skipReason}>{c.skipReason}</span>
                        ) : (
                          <span className="text-[10px] text-zinc-600">bench</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )

  return (
    // v2.8.2 — self-scrolling bounded root (AlgoTab pattern). min-h-full let
    // the content grow past <main> and paint OVER the translucent footer bar
    // (inner is relative z-10, so it won the stacking contest); h-bounded +
    // overflow-y-auto keeps the footer visible and scrolls the tab instead.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto terminal-scroll bg-zinc-950 p-1 md:p-2">
      {engaged ? (
        // RAINBOW FSD HALO — spins while the fleet trades
        <div className="agent-rainbow-frame agent-rainbow-glow">
          {inner}
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950">{inner}</div>
      )}
      {loadError && (
        <div className="px-4 pb-3 text-center text-[11px] text-rose-400">state feed error — {loadError} (retrying every 3s)</div>
      )}

      {/* ---------------- dialogs ---------------- */}
      <AlertDialog open={confirmEngage} onOpenChange={setConfirmEngage}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-950">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-emerald-300" /> Engage the fleet {mode === 'live' ? 'in LIVE?' : 'in paper?'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              {selectedCount} engine(s) will start trading the ranked setups
              {budget ? <> with ≈{money(budget.fleetNotional)} total notional against {money(budget.buyingPower, 2)} buying power</> : null}.
              {mode === 'live' && (
                <span className="mt-2 block font-semibold text-rose-300">
                  LIVE MODE — real orders on your Alpaca live account. Real money, real risk.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              className={mode === 'live' ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'}
              onClick={() => {
                setConfirmEngage(false)
                // v2.6.1 — carry the current form so a paper/live flip made
                // after READY is applied at engage time (server applies the
                // settings patch, re-sizes the budget, then engages)
                if (session) void post({ action: 'engage', sessionId: session.id, settings }, 'Fleet engaged')
              }}
            >
              ENGAGE {mode === 'live' ? 'LIVE' : 'PAPER'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDisengage} onOpenChange={setConfirmDisengage}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-950">
          <AlertDialogHeader>
            <AlertDialogTitle>Disengage the fleet?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              All fleet engines stop evaluating. {session?.settings?.flattenOnStop !== false ? 'Open fleet positions will be FLATTENED at market.' : 'Positions stay open (flatten disabled).'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep flying</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 hover:bg-rose-500" onClick={() => {
              setConfirmDisengage(false)
              if (session) void post({ action: 'disengage', sessionId: session.id, flatten: session.settings?.flattenOnStop !== false }, 'Fleet disengaged')
            }}>
              DISENGAGE
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// small presentational helpers
// ---------------------------------------------------------------------------
function NumberField({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</Label>
      <Input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
        className="h-8 border-zinc-800 bg-zinc-900 text-xs tabular-nums"
      />
    </div>
  )
}

function StatChip({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 py-1.5">
      <div className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-wider text-zinc-500">{icon}{label}</div>
      <div className="text-center font-mono text-sm font-bold text-zinc-200">{value}</div>
    </div>
  )
}

function BudgetCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">{icon}{label}</div>
      <div className="font-mono text-sm font-bold text-zinc-100">{value}</div>
    </div>
  )
}
