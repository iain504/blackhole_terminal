'use client'

// v2.5.0 — Sentiment sidebar panel (the Chart's right movable tab strip).
//
// Scope 'symbol': live sentiment gauge for the focused chart symbol —
//   recency-weighted score, momentum, bull/bear/neutral split, a 48h
//   sparkline, the scored headline feed and the cross-sectional IC / Rank-IC
//   quality stats (the reference dashboard's quantitative evaluation).
// Scope 'market': leaderboard across the whole scanned universe (autopilot's
//   AGENT_US_100 + crypto majors), strongest sentiment first.
// A rescan button drives POST /api/sentiment {action:'scan'} — a single
// symbol scores inline (~seconds), the full universe sweeps in background.
// v2.11.2 — focus-sync honesty: the header chips follow the focused pane
// instantly, but the body states (summary/history/headlines) are fetched.
// On a latency-bearing server an in-flight response for the OLD symbol (60s
// poll tick, 3s sweep poll) can land AFTER the new symbol's response and
// overwrite the panel — "the news doesn't change when I focus another
// pane". Guard: a generation counter drops any non-newest response, an
// AbortController cancels the superseded request, and a loadedKey gate
// renders Loading/Error for the current symbol instead of stale data.
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Activity, BrainCircuit, ExternalLink, RefreshCw, TrendingDown, TrendingUp,
} from 'lucide-react'
import type { SentimentHeadlineDto, SentimentIcResult, SentimentScanState, SentimentSymbolSummary } from '@/lib/sentiment-types'

interface HistoryPoint { bucket: string; score: number; headlines: number }

export function SentimentPanel({ symbol }: { symbol: string }) {
  const [scope, setScope] = useState<'symbol' | 'market'>('symbol')
  const [summary, setSummary] = useState<SentimentSymbolSummary[]>([])
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [headlines, setHeadlines] = useState<SentimentHeadlineDto[]>([])
  const [state, setState] = useState<SentimentScanState | null>(null)
  const [scanning, setScanning] = useState(false)
  const [showIc, setShowIc] = useState(false)
  const [ic, setIc] = useState<SentimentIcResult | null>(null)
  const [icLoading, setIcLoading] = useState(false)

  // The panel body may only ever show data for the symbol/scope pair currently
  // in the header chips. While loadedKey !== dataKey the body renders Loading
  // (or Error) — never the previous symbol's data under the new chip.
  const dataKey = `${scope}|${symbol}`
  const [loadedKey, setLoadedKey] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const reqGen = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const gen = ++reqGen.current
    abortRef.current?.abort() // a superseded in-flight request is dead weight
    const ac = new AbortController()
    abortRef.current = ac
    const q = new URLSearchParams({ scope, symbol, hours: '48', headlines: '25' })
    try {
      const res = await fetch(`/api/sentiment?${q}`, { signal: ac.signal })
      if (gen !== reqGen.current) return // superseded — never write state
      if (!res.ok) {
        setErrorKey(dataKey)
        return
      }
      const j = await res.json()
      if (gen !== reqGen.current) return
      setSummary((j.summary as SentimentSymbolSummary[]) ?? [])
      setHistory((j.history as HistoryPoint[]) ?? [])
      setHeadlines((j.headlines as SentimentHeadlineDto[]) ?? [])
      setState((j.state as SentimentScanState) ?? null)
      setLoadedKey(dataKey)
      setErrorKey(null)
    } catch (e) {
      // AbortError = a newer request superseded this one — not an error.
      if (gen !== reqGen.current || (e as Error)?.name === 'AbortError') return
      setErrorKey(dataKey)
    }
  }, [scope, symbol, dataKey])

  useEffect(() => {
    // new symbol/scope → stale data out, honest loading state in
    setLoadedKey('')
    setErrorKey(null)
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      reqGen.current++ // in-flight responses from this instance can no longer write
      clearInterval(timer)
    }
  }, [load])

  // poll faster while a background sweep is running
  useEffect(() => {
    if (!state?.running) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [state?.running, load])

  const rescan = useCallback(async (symbols?: string[]) => {
    setScanning(true)
    try {
      await fetch('/api/sentiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan', symbols }),
      })
      // inline scans finish before the POST returns; background ones poll
      await load()
    } catch { /* offline */ } finally {
      setScanning(false)
    }
  }, [load])

  const toggleIc = useCallback(async () => {
    const next = !showIc
    setShowIc(next)
    if (next && !ic && !icLoading) {
      setIcLoading(true)
      try {
        const res = await fetch('/api/sentiment/correlation?days=30')
        if (res.ok) setIc(await res.json())
      } catch { /* offline */ } finally {
        setIcLoading(false)
      }
    }
  }, [showIc, ic, icLoading])

  const me = summary[0]
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
  const bodyStale = loadedKey !== dataKey

  return (
    <div className="flex flex-col">
      {/* scope switch — mirrors the News panel's chips */}
      <div className="flex items-center gap-1 border-b border-zinc-800/60 px-2 py-1.5">
        {(
          [
            { key: 'symbol' as const, label: symbol },
            { key: 'market' as const, label: 'Market' },
          ]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setScope(key)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] transition-colors',
              scope === key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300',
            )}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {state?.running && (
            <span className="text-[10px] tabular-nums text-amber-300/90">
              {state.done}/{state.total}
            </span>
          )}
          <Button
            variant="ghost" size="icon"
            className="h-5 w-5 text-zinc-500 hover:text-zinc-200"
            disabled={scanning || state?.running}
            onClick={() => (scope === 'symbol' ? rescan([symbol]) : rescan(undefined))}
            aria-label={scope === 'symbol' ? `Rescan sentiment for ${symbol}` : 'Scan market sentiment'}
          >
            <RefreshCw className={cn('h-3 w-3', (scanning || state?.running) && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {errorKey === dataKey && bodyStale ? (
        <div className="px-3 py-6 text-center text-[11px] text-zinc-500">
          <BrainCircuit className="mx-auto mb-1.5 h-5 w-5 text-zinc-600" />
          Couldn&apos;t load sentiment for <span className="text-zinc-300">{symbol}</span>.
          <button
            onClick={() => load()}
            className="ml-1.5 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Retry
          </button>
        </div>
      ) : bodyStale ? (
        // header chips moved to a new symbol/scope — never render the previous
        // pair's fetched data underneath them
        <div className="px-3 py-6 text-center text-[11px] text-zinc-500">Loading sentiment…</div>
      ) : scope === 'symbol' ? (
        <SymbolView
          symbol={symbol}
          me={me}
          history={history}
          headlines={headlines}
          fmt={fmt}
          showIc={showIc}
          ic={ic}
          icLoading={icLoading}
          toggleIc={toggleIc}
        />
      ) : (
        <MarketView summary={summary} fmt={fmt} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Symbol scope
// ---------------------------------------------------------------------------

function SymbolView({
  symbol, me, history, headlines, fmt, showIc, ic, icLoading, toggleIc,
}: {
  symbol: string
  me?: SentimentSymbolSummary
  history: HistoryPoint[]
  headlines: SentimentHeadlineDto[]
  fmt: (v: number) => string
  showIc: boolean
  ic: SentimentIcResult | null
  icLoading: boolean
  toggleIc: () => void
}) {
  if (!me) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-zinc-500">
        <BrainCircuit className="mx-auto mb-1.5 h-5 w-5 text-zinc-600" />
        No sentiment yet for <span className="text-zinc-300">{symbol}</span>.
        <br />Hit the <span className="text-zinc-300">rescan</span> button to ingest + score news.
      </div>
    )
  }
  return (
    <div>
      {/* gauge row */}
      <div className="flex items-center gap-2.5 border-b border-zinc-800/60 px-2.5 py-2">
        <div className={cn(
          'flex h-11 w-14 shrink-0 flex-col items-center justify-center rounded-md border',
          scoreBorder(me.score), scoreBg(me.score),
        )}>
          <span className={cn('text-[15px] font-bold tabular-nums leading-none', scoreText(me.score))}>
            {fmt(me.score)}
          </span>
          <span className="mt-0.5 text-[8px] uppercase tracking-wider text-zinc-500">
            {me.stale ? 'stale' : 'live'}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {me.momentum != null && Math.abs(me.momentum) > 0.01 && (
              <span className={cn('flex items-center gap-0.5 text-[10.5px] font-medium', me.momentum > 0 ? 'text-emerald-400' : 'text-red-400')}>
                {me.momentum > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {fmt(me.momentum)}
              </span>
            )}
            <span className="text-[10px] text-zinc-600" title={`snapshot ${fullDate(me.asOf)}`}>
              · {me.headlines} headlines · updated {timeAgo(me.asOf)}
            </span>
          </div>
          {/* bull/bear/neutral split bar */}
          <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
            {me.headlines > 0 && (
              <>
                <div className="bg-emerald-500/80" style={{ width: `${(me.bull / me.headlines) * 100}%` }} />
                <div className="bg-zinc-600" style={{ width: `${(me.neutral / me.headlines) * 100}%` }} />
                <div className="bg-red-500/80" style={{ width: `${(me.bear / me.headlines) * 100}%` }} />
              </>
            )}
          </div>
          <div className="mt-1 flex gap-2.5 text-[9.5px] text-zinc-500">
            <span className="text-emerald-400/90">{me.bull} bull</span>
            <span>{me.neutral} neutral</span>
            <span className="text-red-400/90">{me.bear} bear</span>
            <span className="ml-auto uppercase opacity-70">{me.engine === 'llm-finance-v1' ? 'LLM' : 'lexicon'}</span>
          </div>
        </div>
      </div>

      {/* sparkline */}
      {history.length >= 2 && (
        <div className="border-b border-zinc-800/60 px-2.5 py-2">
          <Sparkline points={history.map((h) => h.score)} />
          <p className="mt-1 text-[9px] text-zinc-600">sentiment · last {history.length}h</p>
        </div>
      )}

      {/* IC / Rank-IC quality stats */}
      <div className="border-b border-zinc-800/60 px-2.5 py-1.5">
        <button
          onClick={toggleIc}
          className="flex w-full items-center gap-1 text-[10px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <Activity className="h-3 w-3" />
          IC / Rank-IC vs next-day returns
          <span className="ml-auto">{showIc ? '−' : '+'}</span>
        </button>
        {showIc && (
          <div className="mt-1.5">
            {icLoading && <p className="text-[10px] text-zinc-600">computing…</p>}
            {!icLoading && ic && (
              <div>
                <div className="flex gap-2">
                  <StatChip label="IC" value={ic.ic} />
                  <StatChip label="Rank IC" value={ic.rankIc} />
                  <span className="ml-auto self-center text-[9px] text-zinc-600">{ic.symbols} syms · {ic.pairs} pairs</span>
                </div>
                {ic.rows.length > 0 && (
                  <p className="mt-1 truncate text-[9px] text-zinc-600" title={ic.rows.slice(0, 12).map((r) => `${r.symbol} ${r.rankCorr != null ? r.rankCorr.toFixed(2) : '—'}`).join(' · ')}>
                    per-symbol Rank-IC: {ic.rows.slice(0, 12).map((r) => `${r.symbol} ${r.rankCorr != null ? r.rankCorr.toFixed(2) : '—'}`).join(' · ')}
                  </p>
                )}
                <p className="mt-0.5 text-[9px] leading-snug text-zinc-600">{ic.note}</p>
              </div>
            )}
            {!icLoading && !ic && <p className="text-[10px] text-zinc-600">expand to compute</p>}
          </div>
        )}
      </div>

      {/* scored headline feed */}
      <HeadlineList headlines={headlines} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Market scope
// ---------------------------------------------------------------------------

function MarketView({ summary, fmt }: { summary: SentimentSymbolSummary[]; fmt: (v: number) => string }) {
  if (summary.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-zinc-500">
        <BrainCircuit className="mx-auto mb-1.5 h-5 w-5 text-zinc-600" />
        Nothing scanned yet — press <span className="text-zinc-300">rescan</span> to sweep
        the full universe (100 US names + crypto majors).
      </div>
    )
  }
  const maxAbs = Math.max(0.2, ...summary.map((s) => Math.abs(s.score)))
  return (
    <ul className="divide-y divide-zinc-800/50">
      {summary.map((s, i) => (
        <li key={s.symbol} className="flex items-center gap-2 px-2.5 py-1.5">
          <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-zinc-600">{i + 1}</span>
          <span className="w-14 shrink-0 truncate text-[11.5px] font-medium text-zinc-200">{s.symbol}</span>
          <div className="relative h-1.5 min-w-0 flex-1 rounded-full bg-zinc-800/80">
            {/* bipolar bar: center = 0 */}
            <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
            <div
              className={cn('absolute inset-y-0 rounded-full', s.score >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70')}
              style={
                s.score >= 0
                  ? { left: '50%', width: `${(Math.abs(s.score) / maxAbs) * 50}%` }
                  : { right: '50%', width: `${(Math.abs(s.score) / maxAbs) * 50}%` }
              }
            />
          </div>
          <span className={cn('w-10 shrink-0 text-right text-[11px] font-semibold tabular-nums', scoreText(s.score))}>
            {fmt(s.score)}
          </span>
          {s.momentum != null && Math.abs(s.momentum) > 0.01 ? (
            s.momentum > 0
              ? <TrendingUp className="h-3 w-3 shrink-0 text-emerald-400" />
              : <TrendingDown className="h-3 w-3 shrink-0 text-red-400" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function HeadlineList({ headlines }: { headlines: SentimentHeadlineDto[] }) {
  const scored = headlines.filter((h) => h.label)
  if (scored.length === 0) {
    return (
      <div className="px-3 py-5 text-center text-[11px] text-zinc-500">No scored headlines yet</div>
    )
  }
  return (
    <ul className="divide-y divide-zinc-800/50">
      {scored.map((h) => (
        <li key={h.id}>
          <a
            href={h.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex gap-2 px-2.5 py-2 transition-colors hover:bg-zinc-800/50"
          >
            <span className={cn(
              'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
              h.label === 'positive' ? 'bg-emerald-400' : h.label === 'negative' ? 'bg-red-400' : 'bg-zinc-500',
            )} />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[12px] leading-4 text-zinc-200">{h.title}</p>
              <p className="mt-1 flex items-center gap-1.5 text-[9.5px] text-zinc-600">
                {h.symbol && <span className="rounded bg-zinc-800/80 px-1 py-px text-zinc-400">{h.symbol}</span>}
                <span>{h.publisher ?? h.source}</span>
                {h.publishedAt && <span title={fullDate(h.publishedAt)}>· {timeAgo(h.publishedAt)}</span>}
                {h.confidence != null && <span>· {(h.confidence * 100).toFixed(0)}%</span>}
                <ExternalLink className="h-2.5 w-2.5" />
              </p>
            </div>
          </a>
        </li>
      ))}
    </ul>
  )
}

function StatChip({ label, value }: { label: string; value: number | null }) {
  return (
    <div className={cn('rounded border px-1.5 py-0.5', value == null ? 'border-zinc-800 bg-zinc-900' : scoreBorder(value), value == null ? 'bg-zinc-900' : scoreBg(value))}>
      <span className="text-[8.5px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={cn('ml-1 text-[11px] font-bold tabular-nums', value == null ? 'text-zinc-600' : scoreText(value))}>
        {value == null ? '—' : value >= 0 ? `+${value.toFixed(3)}` : value.toFixed(3)}
      </span>
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  const W = 220
  const H = 34
  const n = points.length
  const min = Math.min(-0.4, ...points)
  const max = Math.max(0.4, ...points)
  const x = (i: number) => (i / Math.max(1, n - 1)) * W
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * H
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const zeroY = y(0)
  const last = points[n - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full" preserveAspectRatio="none" aria-hidden>
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="rgb(63 63 70)" strokeWidth="1" strokeDasharray="3 3" />
      <path d={path} fill="none" stroke={last >= 0 ? 'rgb(52 211 153)' : 'rgb(248 113 113)'} strokeWidth="1.5" />
    </svg>
  )
}

function scoreText(v: number): string {
  return v > 0.15 ? 'text-emerald-400' : v < -0.15 ? 'text-red-400' : 'text-zinc-300'
}
function scoreBorder(v: number): string {
  return v > 0.15 ? 'border-emerald-500/40' : v < -0.15 ? 'border-red-500/40' : 'border-zinc-700/60'
}
function scoreBg(v: number): string {
  return v > 0.15 ? 'bg-emerald-500/10' : v < -0.15 ? 'bg-red-500/10' : 'bg-zinc-800/40'
}

// v2.6.1 — honest relative time: future-safe, month granularity past 60 days
// ("128d ago" read like fresh news next to "23h ago" labels), and every label
// carries the absolute datetime on hover so there is zero ambiguity.
function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  const d = Math.floor(diff / 86400)
  if (d < 60) return `${d}d ago`
  return `${Math.round(d / 30.44)}mo ago`
}

function fullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}
