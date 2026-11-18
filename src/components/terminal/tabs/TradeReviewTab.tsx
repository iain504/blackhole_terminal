'use client'

// Trade Review 智慧複盤 (v2.12.49) — the AI post-trade auditor panel.
// Pipeline: recent closed round-trips → enrichment (session, MAE/MFE vs ATR,
// slippage, volume pulse — point-in-time only) → LLM batches (temp 0.15) →
// quadrant-graded audits + cross-trade patterns + candidate guardrail rules.
// The panel closes the loop: candidates are promoted/discarded by hand, the
// consolidation pass caps the ACTIVE list at 5-7, and active rules are
// injected into the AI steward's live prompt when the session tag matches.
// Process-vs-outcome doctrine: GOOD_PROCESS_LOSS is NOT a strategy change
// signal, BAD_PROCESS_WIN is dangerous luck — both render accordingly.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, Loader2, RefreshCw, ShieldCheck, Sparkles, Trash2, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TaijiSpinner } from '@/components/theme/TaoistLoader'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'

type Mode = 'paper' | 'live'
const MODES: Mode[] = ['paper', 'live']

interface AuditRow {
  id: string
  batchId: string
  symbol: string
  side: string
  quadrant: string
  score: number
  pnl: number
  pnlPct: number
  maePct: number | null
  mfePct: number | null
  maeAtr: number | null
  mfeAtr: number | null
  entrySession: string | null
  exitSession: string | null
  heldMinutes: number | null
  diagnosis: string
  sessionImpact: string
  rootCause: string
}
interface BatchRow {
  id: string
  mode: string
  status: string
  tradeCount: number
  patternCount: number
  ruleCount: number
  note: string | null
  patternsJson: string | null
  createdAt: string
  audits: AuditRow[]
}
interface RuleRow {
  id: string
  condition: string
  action: string
  confidence: string
  tags: string
  status: string
  frequency: number
  pnlImpact: string | null
  firstSeenAt: string
  lastSeenAt: string
  promotedAt: string | null
}
interface PatternRow {
  pattern_description: string
  frequency_in_batch: number
  estimated_pnl_impact: string
}

// v2.12.50 — pre-trade veto gate: the gatekeeper audit lives next to the
// guardrails it enforces (the closed loop: post-trade rules → pre-trade veto
// → shadow-tracked veto outcomes → guardrail-too-strict flag)
interface GateEvalRow {
  id: string
  symbol: string
  side: string
  decision: string
  confidenceScore: number | null
  sizeMultiplier: number | null
  sessionTag: string | null
  spreadPct: number | null
  rvol: number | null
  htfAlignment: string | null
  rationale: string | null
  error: string | null
  orderId: string | null
  cited: string[]
  createdAt: number
}
interface GateStatsRow {
  total: number
  approve: number
  reduced: number
  reject: number
  error: number
}
interface GateAuditData {
  vetoed: number
  graded: number
  goodWait: number
  missedRun: number
  neutral: number
  tooStrict: boolean
  recent: { symbol: string; side: string; outcome: string | null; resolved: boolean; note: string | null }[]
}
interface GatePayload {
  stats?: GateStatsRow
  topCited?: { id: string; condition: string; count: number }[]
  gateAudit?: GateAuditData
  logs?: GateEvalRow[]
}

const QUADRANT_META: Record<string, { label: string; short: string; cls: string; note: string }> = {
  GOOD_PROCESS_WIN: { label: 'Good Process · Win', short: 'GW', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400', note: 'Valid setup + profitable' },
  GOOD_PROCESS_LOSS: { label: 'Good Process · Loss', short: 'GL', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300', note: 'Valid setup stopped by variance — do NOT change strategy' },
  BAD_PROCESS_WIN: { label: 'Bad Process · Win', short: 'BW', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400', note: 'Dangerous luck — flawed execution that paid' },
  BAD_PROCESS_LOSS: { label: 'Bad Process · Loss', short: 'BL', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-400', note: 'Preventable error' },
}
const CONF_CLS: Record<string, string> = {
  HIGH: 'border-emerald-500/40 text-emerald-400',
  MEDIUM: 'border-amber-500/40 text-amber-400',
  LOW: 'border-zinc-500/40 text-zinc-400',
}
const fmtDT = (iso: string) => {
  const t = new Date(iso).getTime()
  return Number.isFinite(t)
    ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—'
}
const fmtMoney = (v: number) => `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`
const parseTags = (raw: string): string[] => {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

export default function TradeReviewTab() {
  const { toast } = useToast()
  const [mode, setMode] = useState<Mode>('paper')
  const [limit, setLimit] = useState<12 | 24 | 36 | 48 | 60 | 72>(24)
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [rules, setRules] = useState<RuleRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [auditing, setAuditing] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [actingRule, setActingRule] = useState<string | null>(null)
  // v2.12.50 — pre-trade veto gate state
  const [gateStats, setGateStats] = useState<GateStatsRow | null>(null)
  const [gateTopCited, setGateTopCited] = useState<{ id: string; condition: string; count: number }[]>([])
  const [gateAudit, setGateAudit] = useState<GateAuditData | null>(null)
  const [gateLogs, setGateLogs] = useState<GateEvalRow[]>([])

  const loadHistory = useCallback(async (m: Mode) => {
    try {
      const res = await fetch(`/api/trade-review/audit?mode=${m}`, { cache: 'no-store' })
      const json = (await res.json().catch(() => null)) as { batches?: BatchRow[]; error?: string } | null
      if (!res.ok) {
        setLoadError(json?.error || `HTTP ${res.status}`)
        return
      }
      setBatches(Array.isArray(json?.batches) ? json.batches : [])
      setLoadError(null)
    } catch {
      setLoadError('Network error — could not load audit history')
    } finally {
      setLoaded(true)
    }
  }, [])

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch('/api/trade-review/rules', { cache: 'no-store' })
      const json = (await res.json().catch(() => null)) as { rules?: RuleRow[] } | null
      if (res.ok && Array.isArray(json?.rules)) setRules(json.rules)
    } catch { /* rules are secondary — silent */ }
  }, [])

  // v2.12.50 — gate evaluations + gatekeeper audit for THIS mode
  const loadGate = useCallback(async (m: Mode) => {
    try {
      const res = await fetch(`/api/ai-trade/gate?mode=${m}`, { cache: 'no-store' })
      const json = (await res.json().catch(() => null)) as GatePayload | null
      if (res.ok && json) {
        setGateStats(json.stats ?? null)
        setGateTopCited(Array.isArray(json.topCited) ? json.topCited : [])
        setGateAudit(json.gateAudit ?? null)
        setGateLogs(Array.isArray(json.logs) ? json.logs : [])
      }
    } catch { /* gate panel is secondary — silent */ }
  }, [])

  useEffect(() => {
    setLoaded(false)
    setBatches([])
    void loadHistory(mode)
    void loadRules()
    void loadGate(mode)
  }, [mode, loadHistory, loadRules, loadGate])

  const latest = batches[0] ?? null
  const latestAudits = latest?.audits ?? []

  const quadrantCounts = useMemo(() => {
    const c = { GOOD_PROCESS_WIN: 0, GOOD_PROCESS_LOSS: 0, BAD_PROCESS_WIN: 0, BAD_PROCESS_LOSS: 0 }
    for (const a of latestAudits) if (a.quadrant in c) c[a.quadrant as keyof typeof c]++
    return c
  }, [latestAudits])

  const avgScore = useMemo(() => {
    if (latestAudits.length === 0) return null
    return latestAudits.reduce((acc, a) => acc + a.score, 0) / latestAudits.length
  }, [latestAudits])

  const auditedPnl = useMemo(() => latestAudits.reduce((acc, a) => acc + (Number.isFinite(a.pnl) ? a.pnl : 0), 0), [latestAudits])

  const candidates = rules.filter((r) => r.status === 'candidate')
  const actives = rules.filter((r) => r.status === 'active')

  const runAudit = async () => {
    setAuditing(true)
    try {
      const res = await fetch('/api/trade-review/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, limit }),
      })
      const json = (await res.json().catch(() => null)) as {
        audits?: number; patterns?: number; rules?: number; status?: string
        error?: string; failures?: string[]; batches?: number; okBatches?: number
      } | null
      if (!res.ok) {
        toast({ title: 'Audit failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      if (json?.error) {
        toast({ title: 'Nothing to audit', description: json.error, variant: 'destructive' })
        return
      }
      const fails = json?.failures?.length ? ` · ${json.failures.length} batch failure(s)` : ''
      toast({
        title: `Audit ${json?.status === 'partial' ? 'partially complete' : 'complete'}`,
        description: `${json?.audits ?? 0} trades graded across ${json?.okBatches ?? 0}/${json?.batches ?? 0} batches · ${json?.patterns ?? 0} patterns · ${json?.rules ?? 0} new rule(s)${fails}`,
      })
    } catch {
      toast({ title: 'Audit failed', description: 'Network error — the run may still be in progress; refresh in a minute.', variant: 'destructive' })
    } finally {
      setAuditing(false)
      void loadHistory(mode)
      void loadRules()
    }
  }

  const ruleAction = async (action: 'promote' | 'discard' | 'retire', ruleId: string) => {
    setActingRule(ruleId)
    try {
      const res = await fetch('/api/trade-review/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ruleId }),
      })
      const json = (await res.json().catch(() => null)) as { error?: string; evicted?: { condition?: string; action?: string } | null } | null
      if (!res.ok) {
        toast({ title: 'Action failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      // v2.12.55 — promoting onto a full board (7/7) auto-retires the
      // lowest-ranked active (confidence × frequency × recency); the eviction
      // is disclosed here instead of silently loosening the live guardrails
      if (action === 'promote' && json?.evicted?.condition) {
        toast({
          title: 'Rule promoted to ACTIVE — board was full (7/7)',
          description: `Lowest-ranked active retired to make room: “${json.evicted.condition.slice(0, 80)}” — review it under Retired.`,
        })
      } else {
        toast({ title: action === 'promote' ? 'Rule promoted to ACTIVE' : action === 'discard' ? 'Rule discarded' : 'Rule retired' })
      }
    } catch {
      toast({ title: 'Action failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setActingRule(null)
      void loadRules()
    }
  }

  const consolidate = async () => {
    setConsolidating(true)
    try {
      const res = await fetch('/api/trade-review/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'consolidate' }),
      })
      const json = (await res.json().catch(() => null)) as { via?: string; active?: RuleRow[]; error?: string } | null
      if (!res.ok) {
        toast({ title: 'Consolidation failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      if (json?.error) {
        toast({ title: 'Nothing to consolidate', description: json.error })
        return
      }
      toast({ title: 'Guardrails consolidated', description: `${json?.active?.length ?? 0} active rules (via ${json?.via === 'llm' ? 'AI merge' : 'deterministic ranking'}), cap 7` })
    } catch {
      toast({ title: 'Consolidation failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setConsolidating(false)
      void loadRules()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 terminal-scroll">
      {/* header + controls */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
        <ClipboardCheck className="h-4 w-4 text-emerald-400" aria-hidden />
        <span className="text-sm font-semibold text-zinc-100">Trade Review 智慧複盤</span>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400" title="Process quality graded separately from outcome — hindsight-bias guarded, MAE/MFE vs ATR, session attribution, no single-trade overfitting">
          AI post-trade auditor
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-zinc-700" role="group" aria-label="Account mode">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'px-2.5 py-1 text-xs transition-colors',
                  mode === m ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60',
                )}
                aria-pressed={mode === m}
              >
                {m === 'live' ? 'LIVE' : 'Paper'}
              </button>
            ))}
          </div>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) as 12 | 24 | 36 | 48 | 60 | 72)}
            className="h-7 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 text-xs text-zinc-300"
            aria-label="Trades to audit"
            title="Most recent closed round-trips to audit (batches of 6 per LLM call)"
          >
            <option value={12}>12 trades</option>
            <option value={24}>24 trades</option>
            <option value={36}>36 trades</option>
            <option value={48}>48 trades</option>
            <option value={60}>60 trades</option>
            <option value={72}>72 trades</option>
          </select>
          <Button
            size="sm"
            className="h-7 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
            onClick={runAudit}
            disabled={auditing}
            title="Run the AI audit: enrich recent closed trades (session, MAE/MFE vs ATR, slippage) and grade process vs outcome in batches of 6"
          >
            {auditing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
            {auditing ? 'Auditing…' : 'Run AI audit'}
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1.5 border-zinc-700 px-2 text-zinc-400 hover:text-zinc-100" onClick={() => { void loadHistory(mode); void loadRules() }} aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <p className="px-1 text-[11px] leading-snug text-zinc-500">
        Grades <span className="text-zinc-300">PROCESS</span> separately from <span className="text-zinc-300">P&amp;L</span> — a lucky bad-process win is flagged dangerous, a disciplined
        stop-out is not a strategy change. Enrichment uses point-in-time data only (ATR from daily bars closed before entry; MAE/MFE from intraday bars
        inside the trade window). Candidate rules need 2+ sightings before promotion; the consolidated ACTIVE list (cap 7) is injected into the AI steward's live prompt.
      </p>

      {/* latest-run quadrant summary */}
      {latest && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2" title={`Run ${fmtDT(latest.createdAt)} · ${latest.status}`}>
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Latest run</p>
            <p className="text-sm font-semibold text-zinc-100">{fmtDT(latest.createdAt)}</p>
            <p className="text-[10px] text-zinc-500">{latest.tradeCount} trades · {latest.status}</p>
          </div>
          {(Object.keys(quadrantCounts) as (keyof typeof quadrantCounts)[]).map((q) => {
            const meta = QUADRANT_META[q]
            return (
              <div key={q} className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2" title={meta.note}>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500">{meta.short}</p>
                <p className={cn('text-sm font-semibold', meta.cls.split(' ').find((c) => c.startsWith('text-')))}>{quadrantCounts[q]}</p>
                <p className="truncate text-[10px] text-zinc-500" title={meta.label}>{meta.label}</p>
              </div>
            )
          })}
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2" title="Mean execution score (1-10) across the latest run">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Avg score</p>
            <p className="text-sm font-semibold text-zinc-100">{avgScore != null ? avgScore.toFixed(1) : '—'}</p>
            <p className="text-[10px] text-zinc-500">execution 1-10</p>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2" title="Realized P&L of the audited trades">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Audited P&amp;L</p>
            <p className={cn('text-sm font-semibold', auditedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtMoney(auditedPnl)}</p>
            <p className="text-[10px] text-zinc-500">{latestAudits.length} graded</p>
          </div>
        </div>
      )}

      {/* audits table (latest run) */}
      <section className="rounded-md border border-zinc-800/80 bg-zinc-900/70" aria-label="Trade audits">
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Trade audits <span className="font-normal normal-case text-zinc-500">— latest run, process vs outcome</span>
          </h2>
          {latest?.note && (
            <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-400" title={latest.note}>
              {latest.status === 'partial' ? 'partial run' : 'warnings'}
            </Badge>
          )}
        </div>
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-zinc-500">
            <TaijiSpinner className="h-4 w-4" /> Loading audit history…
          </div>
        ) : loadError ? (
          <p className="px-3 py-6 text-center text-xs text-rose-400/90">{loadError}</p>
        ) : latestAudits.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">
            No audits yet — close some trades, then press <span className="font-medium text-zinc-300">Run AI audit</span>. The auditor grades each round-trip
            into a quadrant, scores execution 1-10, and proposes guardrail rules only from repeated patterns.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto terminal-scroll">
            <table className="w-full min-w-[900px] border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-1.5 text-left font-medium">Symbol</th>
                  <th className="px-3 py-1.5 text-left font-medium">Side</th>
                  <th className="px-3 py-1.5 text-left font-medium" title="Process vs outcome quadrant — hover for meaning">Quadrant</th>
                  <th className="px-3 py-1.5 text-right font-medium" title="Execution quality 1-10 (10 = flawless process)">Score</th>
                  <th className="px-3 py-1.5 text-right font-medium">P&amp;L</th>
                  <th className="px-3 py-1.5 text-right font-medium" title="MAE / MFE in ATR multiples — how far the trade travelled against / with the position relative to its volatility">MAE/MFE (ATR)</th>
                  <th className="px-3 py-1.5 text-left font-medium" title="Entry → exit session (pre/regular/post/overnight; crypto 24h)">Session</th>
                  <th className="px-3 py-1.5 text-left font-medium">Root cause</th>
                </tr>
              </thead>
              <tbody>
                {latestAudits.map((a) => {
                  const meta = QUADRANT_META[a.quadrant] ?? QUADRANT_META.GOOD_PROCESS_LOSS
                  return (
                    <tr key={a.id} className="border-b border-zinc-800/40 transition-colors hover:bg-zinc-800/30">
                      <td className="px-3 py-1.5 font-semibold text-zinc-100">{a.symbol}</td>
                      <td className={cn('px-3 py-1.5 font-medium', a.side === 'long' ? 'text-emerald-400' : 'text-rose-400')}>{a.side.toUpperCase()}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant="outline" className={cn('text-[10px]', meta.cls)} title={meta.note}>{meta.label}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-200">{a.score}/10</td>
                      <td className={cn('px-3 py-1.5 text-right tabular-nums', a.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400')} title={`${fmtMoney(a.pnl)} (${a.pnlPct >= 0 ? '+' : ''}${a.pnlPct.toFixed(2)}%)`}>
                        {fmtMoney(a.pnl)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400" title={a.diagnosis}>
                        {a.maeAtr != null || a.mfeAtr != null ? `${a.maeAtr != null ? `${a.maeAtr.toFixed(1)}×` : '—'} / ${a.mfeAtr != null ? `${a.mfeAtr.toFixed(1)}×` : '—'}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-500" title={a.sessionImpact}>
                        {a.entrySession ?? '—'}
                        {a.exitSession && a.exitSession !== a.entrySession ? ` → ${a.exitSession}` : ''}
                      </td>
                      <td className="max-w-[280px] truncate px-3 py-1.5 text-zinc-400" title={a.rootCause}>{a.rootCause}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* batch patterns */}
      {(() => {
        let patterns: PatternRow[] = []
        try { const p = latest?.patternsJson ? JSON.parse(latest.patternsJson) : []; if (Array.isArray(p)) patterns = p } catch { patterns = [] }
        if (patterns.length === 0) return null
        return (
          <section className="rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2" aria-label="Cross-trade patterns">
            <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">
              <TrendingUp className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Cross-trade patterns — latest run
            </h2>
            <ul className="flex flex-col gap-1">
              {patterns.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px] text-zinc-400">
                  <Badge variant="outline" className="mt-0.5 shrink-0 border-zinc-700 text-[10px] text-zinc-400">×{p.frequency_in_batch}</Badge>
                  <span className="min-w-0 flex-1">{p.pattern_description}</span>
                  <span className="shrink-0 text-zinc-500" title="Estimated P&L impact">{p.estimated_pnl_impact}</span>
                </li>
              ))}
            </ul>
          </section>
        )
      })()}

      {/* rules: candidates + active guardrails */}
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-md border border-zinc-800/80 bg-zinc-900/70" aria-label="Candidate rules">
          <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Candidate rules <span className="font-normal normal-case text-zinc-500">— promote / discard</span></h2>
            <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">{candidates.length}</Badge>
          </div>
          <div className="max-h-80 overflow-y-auto terminal-scroll">
            {candidates.length === 0 ? (
              <p className="px-3 py-5 text-center text-[11px] text-zinc-500">No candidate rules — audits that surface REPEATED patterns propose them here.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/40">
                {candidates.map((r) => (
                  <li key={r.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className={cn('text-[10px]', CONF_CLS[r.confidence] ?? CONF_CLS.LOW)}>{r.confidence}</Badge>
                      <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400" title="Seen across this many audit sightings">×{r.frequency}</Badge>
                      {parseTags(r.tags).map((t) => (
                        <span key={t} className="rounded border border-zinc-800 bg-zinc-950 px-1 py-px text-[9px] text-zinc-500">{t}</span>
                      ))}
                      <span className="ml-auto flex gap-1">
                        <Button size="sm" variant="outline" className="h-6 gap-1 border-emerald-500/40 px-2 text-[10px] text-emerald-400 hover:bg-emerald-500/10" disabled={actingRule === r.id} onClick={() => void ruleAction('promote', r.id)}>
                          <ShieldCheck className="h-3 w-3" aria-hidden /> Promote
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 gap-1 border-zinc-700 px-2 text-[10px] text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400" disabled={actingRule === r.id} onClick={() => void ruleAction('discard', r.id)}>
                          <Trash2 className="h-3 w-3" aria-hidden /> Discard
                        </Button>
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-zinc-300"><span className="text-zinc-500">if</span> {r.condition}</p>
                    <p className="text-[11px] leading-snug text-emerald-300/90"><span className="text-zinc-500">then</span> {r.action}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-md border border-zinc-800/80 bg-zinc-900/70" aria-label="Active guardrails">
          <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Active guardrails <span className="font-normal normal-case text-zinc-500">— injected into the AI steward (cap 7)</span>
            </h2>
            <span className="flex items-center gap-1.5">
              <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-400">{actives.length}/7</Badge>
              <Button size="sm" variant="outline" className="h-6 gap-1 border-zinc-700 px-2 text-[10px] text-zinc-300 hover:bg-zinc-800" disabled={consolidating} onClick={() => void consolidate()} title="AI merge: dedupe candidates + actives into a fresh capped list (deterministic ranking fallback)">
                {consolidating ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="h-3 w-3" aria-hidden />} Consolidate
              </Button>
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto terminal-scroll">
            {actives.length === 0 ? (
              <p className="px-3 py-5 text-center text-[11px] text-zinc-500">No active guardrails — promote candidates or press Consolidate. Active rules ride into the steward's DATA block when their session tag matches.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/40">
                {actives.map((r) => (
                  <li key={r.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className={cn('text-[10px]', CONF_CLS[r.confidence] ?? CONF_CLS.LOW)}>{r.confidence}</Badge>
                      {parseTags(r.tags).map((t) => (
                        <span key={t} className="rounded border border-zinc-800 bg-zinc-950 px-1 py-px text-[9px] text-zinc-500">{t}</span>
                      ))}
                      <Button size="sm" variant="outline" className="ml-auto h-6 gap-1 border-zinc-700 px-2 text-[10px] text-zinc-500 hover:bg-amber-500/10 hover:text-amber-400" disabled={actingRule === r.id} onClick={() => void ruleAction('retire', r.id)} title="Retire — remove from the steward prompt">
                        Retire
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-zinc-300"><span className="text-zinc-500">if</span> {r.condition}</p>
                    <p className="text-[11px] leading-snug text-emerald-300/90"><span className="text-zinc-500">then</span> {r.action}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* v2.12.50 — GATE AUDIT: the veto gate enforces these guardrails
          pre-trade; this section audits the gatekeeper itself. Shadow-tracked
          vetoes grade 24h later — a majority of missed-runs means the
          guardrails are choking off would-be winners and need relaxing. */}
      {(gateStats || gateLogs.length > 0) && (
        <section className="rounded-md border border-zinc-800/80 bg-zinc-900/70" aria-label="Pre-trade gate audit">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Pre-trade gate audit <span className="font-normal normal-case text-zinc-500">— shadow-tracked vetoes grade the gatekeeper</span>
            </h2>
            {gateStats && (
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                <span className="text-emerald-400">approve {gateStats.approve}</span>
                <span className="text-sky-400">reduced {gateStats.reduced}</span>
                <span className={gateStats.reject > 0 ? 'text-amber-400' : 'text-zinc-600'}>reject {gateStats.reject}</span>
                {gateStats.error > 0 && <span className="text-rose-400">error {gateStats.error}</span>}
              </span>
            )}
          </div>
          {gateAudit && gateAudit.vetoed > 0 && (
            <div className={cn('border-b border-zinc-800/80 px-3 py-2 text-[11px] leading-snug', gateAudit.tooStrict ? 'text-amber-400' : 'text-zinc-400')}>
              <span className="font-semibold">Gatekeeper audit:</span> {gateAudit.vetoed} veto(s) shadow-tracked · {gateAudit.graded} graded —
              {' '}good-wait {gateAudit.goodWait} (capital preserved) · missed-run {gateAudit.missedRun} (would have run) · neutral {gateAudit.neutral}
              {gateAudit.tooStrict && (
                <p className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-400">
                  ⚠ Majority of graded vetoes were missed-runs — one or more ACTIVE guardrails is likely too restrictive. Relax the cited rules below or promote fewer candidates.
                </p>
              )}
            </div>
          )}
          {gateTopCited.length > 0 && (
            <div className="border-b border-zinc-800/80 px-3 py-2">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Most-cited guardrails (30d)</p>
              <ul className="flex flex-col gap-0.5">
                {gateTopCited.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <Badge variant="outline" className="shrink-0 border-violet-500/40 text-[10px] text-violet-300">{c.id}</Badge>
                    <span className="min-w-0 flex-1 truncate" title={c.condition}>{c.condition}</span>
                    <span className="shrink-0 font-mono text-zinc-500">×{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto terminal-scroll">
            {gateLogs.length === 0 ? (
              <p className="px-3 py-5 text-center text-[11px] text-zinc-500">No gate evaluations yet — every execution the engine attempts is evaluated here first (session, spread friction, RVOL, HTF alignment, guardrails).</p>
            ) : (
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-zinc-900 text-[9px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Time</th>
                    <th className="px-2 py-1.5 font-medium">Candidate</th>
                    <th className="px-2 py-1.5 font-medium">Decision</th>
                    <th className="px-2 py-1.5 font-medium">Session</th>
                    <th className="px-2 py-1.5 font-medium">Spread%</th>
                    <th className="px-2 py-1.5 font-medium">RVOL</th>
                    <th className="px-2 py-1.5 font-medium">HTF</th>
                    <th className="px-2 py-1.5 font-medium">Guardrails</th>
                    <th className="px-3 py-1.5 font-medium">Rationale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/40">
                  {gateLogs.slice(0, 12).map((g) => (
                    <tr key={g.id} className="align-middle">
                      <td className="whitespace-nowrap px-3 py-1.5 text-zinc-500">{new Date(g.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-300">
                        {g.symbol} <span className={g.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{g.side === 'buy' ? '▲' : '▼'}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <Badge variant="outline" className={cn(
                          'text-[10px]',
                          g.decision === 'APPROVE' ? 'border-emerald-500/40 text-emerald-400'
                            : g.decision === 'APPROVE_REDUCED_SIZE' ? 'border-sky-500/40 text-sky-400'
                            : g.decision === 'REJECT' ? 'border-amber-500/40 text-amber-400'
                            : 'border-rose-500/40 text-rose-400',
                        )}>
                          {g.decision === 'APPROVE' ? 'APPROVE'
                            : g.decision === 'APPROVE_REDUCED_SIZE' ? `×${g.sizeMultiplier?.toFixed(2) ?? '?'} SIZE`
                            : g.decision === 'REJECT' ? 'REJECT'
                            : 'ERROR'}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-zinc-500">{g.sessionTag ?? '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-zinc-500">{g.spreadPct != null ? g.spreadPct.toFixed(2) : '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-zinc-500">{g.rvol != null ? g.rvol.toFixed(2) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[10px] text-zinc-500">{g.htfAlignment ?? '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-violet-300">{g.cited.length > 0 ? g.cited.join(',') : '—'}</td>
                      <td className="max-w-[280px] truncate px-3 py-1.5 text-zinc-400" title={g.error ?? g.rationale ?? ''}>{g.error ?? g.rationale ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {/* prior runs */}
      {batches.length > 1 && (
        <section className="rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2" aria-label="Previous audit runs">
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">Previous runs</h2>
          <ul className="flex flex-col gap-1">
            {batches.slice(1).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span className="text-zinc-400">{fmtDT(b.createdAt)}</span>
                <Badge variant="outline" className={cn('text-[10px]', b.status === 'ok' ? 'border-emerald-500/40 text-emerald-400' : b.status === 'partial' ? 'border-amber-500/40 text-amber-400' : 'border-rose-500/40 text-rose-400')}>{b.status}</Badge>
                <span>{b.tradeCount} trades · {b.audits.length} graded · {b.patternCount} patterns · {b.ruleCount} rules</span>
                {b.note && <span className="truncate text-zinc-600" title={b.note}>{b.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
