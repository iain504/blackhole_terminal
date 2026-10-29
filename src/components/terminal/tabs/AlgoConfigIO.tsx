'use client'

// Algo config import/export (Task 66 + 70-c) — the client half of the portable
// run-config envelope. Exports are versioned JSON blobs built by
// buildAlgoConfigExport() in algo-strategies.ts (shared with any server path);
// this file owns the download trigger and the import dialog:
//
//   • pick a .json file, drag & drop one, or paste the JSON text
//   • every entry is validated/normalized client-side (parseAlgoConfigImport —
//     same clamps as the live API) and listed with its strategy/symbol/TP-SL
//   • v2 files also carry strategy-drawer rules — listed with a PAUSED badge
//     and recreated as paused via POST /api/algo/rules-import (never auto-armed)
//   • load entries back into the run-setup form, or start them directly as
//     live runs (paper mode only — mirrors the POST /api/algo guards)
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, Download, FileJson, PauseCircle, RotateCcw, TriangleAlert, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmtAtrExit } from '@/lib/atr-client'
import {
  ALGO_STRATEGIES, parseAlgoConfigImport, strategyRuleConditionSummary,
  type AlpoRunConfig, type AlgoConfigFileEntry, type AlgoRuleImportPayload,
} from '@/lib/algo-strategies'

/** Trigger a browser download of a JSON payload. */
export function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5_000)
}

// Task 9-n — export no longer relies on the bare anchor download: sandboxed
// preview iframes silently swallow blob downloads (no `allow-downloads`), so
// the user saw "Config exported" and NO file — and with no file, import had
// nothing to import. The dialog ALWAYS offers a real download + a copy path
// (pairs with the import dialog's paste path).
//
// Task 19 — the raw JSON is NO LONGER rendered by default: "export all" blobs
// (every run + drawer rule) can be thousands of lines, and the unclamped
// textarea pushed the Copy/Download actions below the fold where the dialog
// could not scroll to them. The dialog now leads with a compact summary
// (what's inside + size) and the actions, with the JSON behind an opt-in
// "Show JSON" preview (max-height, internally scrollable). The textarea stays
// mounted (visually hidden) so the execCommand copy fallback still works when
// sandboxed iframes deny the async clipboard.

export interface AlgoExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filename: string
  data: unknown
}

export function AlgoExportDialog({ open, onOpenChange, filename, data }: AlgoExportDialogProps) {
  const { toast } = useToast()
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [copied, setCopied] = useState(false)
  // Task 19 — the JSON preview starts COLLAPSED every time the dialog opens;
  // the summary + actions are the primary content now.
  const [showJson, setShowJson] = useState(false)
  useEffect(() => {
    if (!open) setShowJson(false)
  }, [open])
  const json = open ? JSON.stringify(data ?? null, null, 2) : ''

  // compact summary of what the envelope contains (Task 19) — derived straight
  // from the export payload so it always matches what would be downloaded
  const envelope = (data ?? null) as
    | { configs?: { name?: string; enabled?: boolean }[]; rules?: unknown[] }
    | null
  const configs = Array.isArray(envelope?.configs) ? envelope?.configs ?? [] : []
  const rules = Array.isArray(envelope?.rules) ? envelope?.rules : []
  const bytes = new Blob([json]).size

  const copyJson = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json)
        setCopied(true)
        toast({ title: 'JSON copied to clipboard', description: 'Open Import configs → paste the JSON to bring it back (or move it to another machine).' })
        return
      }
      throw new Error('clipboard API unavailable')
    } catch {
      // sandboxed iframes often deny the async clipboard — fall back to select+execCommand
      const ta = taRef.current
      if (ta) {
        ta.focus()
        ta.select()
        let ok = false
        try { ok = document.execCommand('copy') } catch { ok = false }
        if (ok) {
          setCopied(true)
          toast({ title: 'JSON copied to clipboard' })
          return
        }
      }
      toast({ title: 'Copy blocked — select the JSON text and copy manually (Ctrl/Cmd+C)', variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg gap-3">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileJson className="h-4 w-4 text-sky-400" aria-hidden />
            Export algo configs
          </DialogTitle>
          <DialogDescription className="text-xs">
            Download the file, or copy the JSON — embeds/previews may block downloads;
            the copy pairs with Import configs → paste.
          </DialogDescription>
        </DialogHeader>
        {/* Task 19 — compact content summary instead of the raw JSON blob */}
        <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
            <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-300">
              {configs.length} config{configs.length === 1 ? '' : 's'}
            </Badge>
            {rules.length > 0 && (
              <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-300">
                {rules.length} rule{rules.length === 1 ? '' : 's'}
              </Badge>
            )}
            <span className="tabular-nums">{bytes.toLocaleString('en-US')} bytes · v2 envelope</span>
          </div>
          {configs.length > 0 && (
            <ul className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto terminal-scroll">
              {configs.map((c, i) => (
                <li key={i}>
                  <Badge
                    variant="outline"
                    className={cn(
                      'max-w-full text-[10px] font-normal',
                      c.enabled ? 'border-emerald-500/40 text-emerald-300' : 'border-zinc-800 text-zinc-400',
                    )}
                    title={c.enabled ? 'exported enabled' : 'exported disabled/paused'}
                  >
                    {c.name || `config ${i + 1}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          <span className="text-[10px] text-zinc-500">
            {filename ? <span className="font-mono">{filename}</span> : 'algo configs'}
          </span>
          <span className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-zinc-800 bg-zinc-950 text-[11px] text-zinc-200 hover:bg-zinc-900"
              onClick={() => void copyJson()}
            >
              <Copy className="h-3 w-3" aria-hidden />
              {copied ? 'Copied — copy again' : 'Copy JSON'}
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-sky-600 text-[11px] text-white hover:bg-sky-500"
              onClick={() => {
                try {
                  downloadJsonFile(filename, data)
                  toast({ title: 'Download started', description: 'If no file appears, the preview is blocking downloads — use Copy JSON instead.' })
                } catch {
                  toast({ title: 'Download blocked here — use Copy JSON', variant: 'destructive' })
                }
              }}
            >
              <Download className="h-3 w-3" aria-hidden />
              Download .json
            </Button>
          </span>
        </DialogFooter>

        {/* Task 19 — opt-in raw JSON: collapsed so it can never push the
            actions off-screen; max-height + internal scroll when expanded.
            The textarea is always mounted (sr-only while collapsed) so the
            execCommand copy fallback keeps working when the clipboard API
            is denied by sandboxed iframes. */}
        <div>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowJson((v) => !v)}
            aria-expanded={showJson}
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showJson && 'rotate-180')} aria-hidden />
            {showJson ? 'Hide JSON' : 'Show JSON'}
          </button>
          <Textarea
            ref={taRef}
            readOnly
            value={json}
            onFocus={(e) => e.currentTarget.select()}
            className={cn(
              'border-zinc-800 bg-zinc-950 font-mono text-[10px] leading-snug',
              showJson
                ? 'mt-1 max-h-56 resize-none overflow-y-auto terminal-scroll'
                : 'sr-only',
            )}
            aria-label="Exported config JSON"
            aria-hidden={!showJson}
            tabIndex={showJson ? 0 : -1}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export interface AlgoImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** trade mode from GET /api/algo — starting runs is refused in live mode */
  mode: string
  /** whether Alpaca keys are configured */
  configured: boolean
  /** Task 79 — symbols that currently have an ENABLED run; selected configs
   *  targeting one of them trigger the double-exposure warning banner */
  runningSymbols?: Set<string>
  onLoadIntoSetup: (cfg: AlpoRunConfig) => void
  /** called after runs were started so the parent refreshes the runs list */
  onRunsStarted: () => void
}

interface ParsedState {
  entries: AlgoConfigFileEntry[]
  errors: { index: number; reason: string }[]
  rules: AlgoRuleImportPayload[]
  ruleNames: string[]
  ruleErrors: { index: number; reason: string }[]
  source: string
}

const canStartRuns = (mode: string, configured: boolean) => configured && mode !== 'live'

export default function AlgoImportDialog({
  open, onOpenChange, mode, configured, runningSymbols, onLoadIntoSetup, onRunsStarted,
}: AlgoImportDialogProps) {
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [parsed, setParsed] = useState<ParsedState | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [selectedRules, setSelectedRules] = useState<Set<number>>(new Set())
  const [pasteText, setPasteText] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [starting, setStarting] = useState(false)
  const [importingRules, setImportingRules] = useState(false)

  const applyParse = (raw: unknown, source: string) => {
    const res = parseAlgoConfigImport(raw)
    setParsed({ ...res, source })
    // preselect every valid entry (by position in the entries/rules arrays)
    setSelected(new Set(res.entries.map((_, i) => i)))
    setSelectedRules(new Set(res.rules.map((_, i) => i)))
    if (res.entries.length === 0 && res.rules.length === 0 && res.errors.length + res.ruleErrors.length > 0) {
      toast({ title: 'Nothing importable found', description: res.errors[0]?.reason ?? res.ruleErrors[0]?.reason, variant: 'destructive' })
    }
  }

  const readText = (text: string, source: string) => {
    try {
      applyParse(JSON.parse(text), source)
    } catch {
      toast({ title: 'Not valid JSON', description: 'Check the file/pasted text and try again.', variant: 'destructive' })
    }
  }

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    file.text().then((t) => readText(t, file.name)).catch(() => {
      toast({ title: 'Could not read file', variant: 'destructive' })
    })
  }

  const reset = () => {
    setParsed(null)
    setSelected(new Set())
    setSelectedRules(new Set())
    setPasteText('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const toggle = (i: number) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const toggleRule = (i: number) => {
    setSelectedRules((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const selectedConfigs = parsed ? parsed.entries.filter((_, i) => selected.has(i)) : []
  const selectedRuleList = parsed ? parsed.rules.filter((_, i) => selectedRules.has(i)) : []
  const startable = canStartRuns(mode, configured)
  // Task 79 — how many selected entries start right away vs recreate as STOPPED
  const nStart = selectedConfigs.filter((e) => e.enabled !== false).length
  const nStopped = selectedConfigs.length - nStart
  // Task 79 — selected entries whose symbol already has an ENABLED run
  const dupSymbols = runningSymbols
    ? [...new Set(selectedConfigs.map((e) => e.config.symbol).filter((s) => runningSymbols.has(s)))]
    : []

  const loadIntoSetup = () => {
    if (selectedConfigs.length === 0) return
    onLoadIntoSetup(selectedConfigs[0].config)
    toast({ title: 'Config loaded into the run setup', description: selectedConfigs[0].name })
    onOpenChange(false)
  }

  const startRuns = async () => {
    if (selectedConfigs.length === 0 || starting) return
    setStarting(true)
    let ok = 0
    let stopped = 0
    let fail = 0
    let firstErr = ''
    for (const e of selectedConfigs) {
      // Task 79 — entries exported from a STOPPED run are recreated as stopped
      // (autoStart: false → the run is created paused, trading starts only
      // when the user presses Start); everything else starts right away.
      const createStopped = e.enabled === false
      try {
        const res = await fetch('/api/algo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...e.config, autoStart: !createStopped }),
        })
        if (res.ok) {
          if (createStopped) stopped += 1
          else ok += 1
        } else {
          fail += 1
          const j = await res.json().catch(() => null)
          if (!firstErr) firstErr = j?.error ?? `HTTP ${res.status}`
        }
      } catch {
        fail += 1
        if (!firstErr) firstErr = 'Network error'
      }
    }
    setStarting(false)
    if (ok + stopped > 0) {
      toast({
        title: ok > 0 && stopped > 0
          ? `Started ${ok} · Imported ${stopped} stopped`
          : ok > 0
            ? `Started ${ok} run${ok === 1 ? '' : 's'}`
            : `Imported ${stopped} run${stopped === 1 ? '' : 's'} (stopped — press Start to trade)`,
        description: fail > 0 ? `${fail} failed: ${firstErr}` : undefined,
      })
      onRunsStarted()
      onOpenChange(false)
    } else {
      toast({ title: 'Could not start runs', description: firstErr, variant: 'destructive' })
    }
  }

  // recreate strategy-drawer rules — ALWAYS created paused (never auto-armed)
  const importRules = async () => {
    if (selectedRuleList.length === 0 || importingRules) return
    setImportingRules(true)
    let created = 0
    const failed: { index: number; reason: string }[] = []
    try {
      const res = await fetch('/api/algo/rules-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: selectedRuleList }),
      })
      const j = await res.json().catch(() => null)
      if (res.ok && j) {
        created = Number(j.created) || 0
        failed.push(...(Array.isArray(j.failed) ? j.failed : []))
      } else {
        failed.push({ index: 0, reason: j?.error || `HTTP ${res.status}` })
      }
    } catch {
      failed.push({ index: 0, reason: 'Network error' })
    }
    setImportingRules(false)
    if (created > 0) {
      toast({
        title: `Imported ${created} rule${created === 1 ? '' : 's'} (paused)`,
        description: failed.length > 0
          ? `${failed.length} skipped: ${failed[0].reason}${failed.length > 1 ? ` +${failed.length - 1} more` : ''}. Review them in Strategy Orders and arm when ready.`
          : 'Review them in Strategy Orders and arm when ready.',
      })
      setSelectedRules(new Set())
    } else {
      toast({ title: 'Could not import rules', description: failed[0]?.reason, variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!starting) onOpenChange(v) }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg gap-3">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4 text-sky-400" aria-hidden />
            Import algo configs
          </DialogTitle>
          <DialogDescription className="text-xs">
            Load a config file exported from this terminal (any machine) — review, then load into the
            setup form or start the runs directly.
          </DialogDescription>
        </DialogHeader>

        {!parsed && (
          <div className="flex flex-col gap-2">
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose or drop a config file"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                handleFiles(e.dataTransfer.files)
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center gap-1.5 rounded-md border border-dashed px-4 py-6 text-center transition-colors',
                dragOver ? 'border-sky-500/60 bg-sky-500/5' : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700',
              )}
            >
              <FileJson className="h-6 w-6 text-zinc-500" aria-hidden />
              <p className="text-xs text-zinc-300">Click to choose a .json file or drop it here</p>
              <p className="text-[10px] text-zinc-500">Exported from Algo Trading → Export config</p>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
            <details className="rounded-md border border-zinc-800/80 bg-zinc-950/50">
              <summary className="cursor-pointer px-3 py-2 text-[11px] text-zinc-400 hover:text-zinc-200">
                …or paste the JSON instead
              </summary>
              <div className="flex flex-col gap-2 px-3 pb-3">
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder='{"kind":"blackhole-algo-config","version":1,...}'
                  className="min-h-24 resize-y border-zinc-800 bg-zinc-950 font-mono text-[10px]"
                  aria-label="Paste config JSON"
                />
                <Button size="sm" variant="outline" className="h-7 gap-1.5 self-end border-zinc-800 bg-zinc-950 text-[11px] text-zinc-200 hover:bg-zinc-900" disabled={!pasteText.trim()} onClick={() => readText(pasteText, 'pasted JSON')}>
                  Parse
                </Button>
              </div>
            </details>
          </div>
        )}

        {parsed && (
          <>
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="min-w-0 truncate">
                {parsed.source} — <span className="font-medium text-zinc-200">{parsed.entries.length}</span> valid
                {parsed.errors.length > 0 && <span className="text-rose-400"> · {parsed.errors.length} skipped</span>}
                {parsed.rules.length > 0 && <span> · <span className="font-medium text-zinc-200">{parsed.rules.length}</span> rule{parsed.rules.length === 1 ? '' : 's'}</span>}
                {parsed.ruleErrors.length > 0 && <span className="text-rose-400"> · {parsed.ruleErrors.length} rule skip{parsed.ruleErrors.length === 1 ? '' : 's'}</span>}
              </span>
              <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200" onClick={reset}>
                <RotateCcw className="h-3 w-3" /> Choose another
              </Button>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-md border border-zinc-800/80 terminal-scroll" aria-label="Importable configs">
              {parsed.entries.map((e, i) => {
                const s = ALGO_STRATEGIES[e.config.strategy]
                const checked = selected.has(i)
                return (
                  <label
                    key={i}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 border-b border-zinc-800/50 px-2.5 py-2 last:border-b-0',
                      checked ? 'bg-zinc-900/70' : 'hover:bg-zinc-900/40',
                    )}
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggle(i)} aria-label={`Select ${e.name}`} className="mt-0.5" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                        <span className="truncate text-xs font-medium text-zinc-100">{e.name}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
                        <span className="text-zinc-400">{e.config.symbol}</span>
                        <Badge variant="outline" className="h-3.5 px-1 text-[9px] text-zinc-400">{e.config.timeframe}</Badge>
                        <span>qty {e.config.qty}</span>
                        {e.config.tpMode === 'pct' && <span className="text-emerald-400/80">TP {e.config.tpValue}%</span>}
                        {e.config.tpMode === 'atr' && <span className="text-emerald-400/80">TP {fmtAtrExit(e.config.tpValue, e.config.tpTf)}</span>}
                        {e.config.slMode === 'pct' && <span className="text-rose-400/80">SL {e.config.slValue}%</span>}
                        {e.config.slMode === 'atr' && <span className="text-rose-400/80">SL {fmtAtrExit(e.config.slValue, e.config.slTf)}</span>}
                        {e.config.rthOnly && <span>RTH</span>}
                        {e.config.flattenEod && <span>EOD</span>}
                        {(e.config.cooldownMin ?? 0) > 0 && <span className="text-sky-400/80">cooldown {e.config.cooldownMin}m</span>}
                        {e.config.requireNewSignal && <span className="text-amber-400/80">fresh-signal</span>}
                        {e.enabled === true && (
                          <Badge variant="outline" className="h-3.5 border-emerald-500/40 px-1 text-[9px] text-emerald-400" title="The run was RUNNING when exported — importing starts it right away (paper mode only)">
                            was RUNNING
                          </Badge>
                        )}
                        {e.enabled === false && (
                          <Badge variant="outline" className="h-3.5 border-zinc-600 px-1 text-[9px] text-zinc-400" title="The run was STOPPED when exported — it will be recreated as a stopped run you can start later">
                            was STOPPED
                          </Badge>
                        )}
                      </span>
                    </span>
                  </label>
                )
              })}
              {parsed.errors.map((err) => (
                <div key={`err-${err.index}`} className="flex items-start gap-2 border-b border-zinc-800/50 px-2.5 py-2 last:border-b-0" role="note">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                  <span className="text-[11px] leading-snug text-rose-300">
                    Entry {err.index + 1} skipped — {err.reason}
                  </span>
                </div>
              ))}
              {parsed.entries.length === 0 && parsed.errors.length === 0 && parsed.rules.length === 0 && parsed.ruleErrors.length === 0 && (
                <p className="px-3 py-4 text-center text-[11px] text-zinc-500">The file contains no configs.</p>
              )}

              {parsed.rules.length > 0 && (
                <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/95 px-2.5 py-1.5 backdrop-blur">
                  <PauseCircle className="h-3.5 w-3.5 text-violet-400" aria-hidden />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Strategy rules — recreated as paused</span>
                </div>
              )}
              {parsed.rules.map((rule, i) => {
                const checked = selectedRules.has(i)
                return (
                  <label
                    key={`rule-${i}`}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 border-b border-zinc-800/50 px-2.5 py-2 last:border-b-0',
                      checked ? 'bg-zinc-900/70' : 'hover:bg-zinc-900/40',
                    )}
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggleRule(i)} aria-label={`Select rule ${parsed.ruleNames[i] ?? i + 1}`} className="mt-0.5" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-zinc-100">{parsed.ruleNames[i]}</span>
                        <Badge variant="outline" className={cn('h-3.5 px-1 text-[9px]', rule.action === 'buy' ? 'border-emerald-500/40 text-emerald-400' : 'border-rose-500/40 text-rose-400')}>
                          {rule.action.toUpperCase()}
                        </Badge>
                        <Badge variant="outline" className="h-3.5 border-violet-500/40 px-1 text-[9px] text-violet-300" title="Rules are never auto-armed — review and arm them in Strategy Orders">
                          PAUSED
                        </Badge>
                      </span>
                      <span className="flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
                        <span className="text-zinc-400">{rule.symbol}</span>
                        <span>{strategyRuleConditionSummary(rule)}</span>
                        <span>qty {rule.qty}</span>
                        {rule.tpMode === 'pct' && <span className="text-emerald-400/80">TP {rule.tpValue}%</span>}
                        {rule.tpMode === 'price' && <span className="text-emerald-400/80">TP {rule.tpValue}</span>}
                        {rule.tpMode === 'atr' && <span className="text-emerald-400/80">TP {fmtAtrExit(rule.tpValue, rule.tpTf)}</span>}
                        {rule.slMode === 'pct' && <span className="text-rose-400/80">SL {rule.slValue}%</span>}
                        {rule.slMode === 'price' && <span className="text-rose-400/80">SL {rule.slValue}</span>}
                        {rule.slMode === 'atr' && <span className="text-rose-400/80">SL {fmtAtrExit(rule.slValue, rule.slTf)}</span>}
                        {rule.repeat && <span>repeats</span>}
                      </span>
                    </span>
                  </label>
                )
              })}
              {parsed.ruleErrors.map((err) => (
                <div key={`rerr-${err.index}`} className="flex items-start gap-2 border-b border-zinc-800/50 px-2.5 py-2 last:border-b-0" role="note">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                  <span className="text-[11px] leading-snug text-rose-300">
                    Rule {err.index + 1} skipped — {err.reason}
                  </span>
                </div>
              ))}
            </div>

            {!startable && parsed.entries.length > 0 && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-400">
                {mode === 'live'
                  ? 'Live mode — runs can only be started in paper mode. You can still load configs into the setup form.'
                  : 'No Alpaca keys — add them in Settings to start runs. You can still load configs into the setup form.'}
              </p>
            )}

            {startable && dupSymbols.length > 0 && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] leading-snug text-amber-400" role="alert">
                <TriangleAlert className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />
                Already enabled on {dupSymbols.join(', ')}: another run is live on this symbol. Multiple enabled runs on one symbol trade independently — double exposure.
              </p>
            )}

            <DialogFooter className="flex-row flex-wrap items-center gap-2 sm:justify-between">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-zinc-800 bg-zinc-950 text-[11px] text-zinc-200 hover:bg-zinc-900"
                disabled={selectedConfigs.length === 0}
                onClick={loadIntoSetup}
              >
                Load into setup form
              </Button>
              <span className="flex items-center gap-2">
                {parsed.rules.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 border-violet-500/40 bg-zinc-950 text-[11px] text-violet-300 hover:bg-violet-500/10"
                    disabled={selectedRuleList.length === 0 || importingRules}
                    onClick={() => void importRules()}
                    title="Rules are recreated as PAUSED — they never place orders until you arm them"
                  >
                    <PauseCircle className="h-3 w-3" aria-hidden />
                    Import {selectedRuleList.length} rule{selectedRuleList.length === 1 ? '' : 's'} (paused)
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-8 gap-1.5 bg-sky-600 text-[11px] text-white hover:bg-sky-500"
                  disabled={selectedConfigs.length === 0 || !startable || starting}
                  onClick={() => void startRuns()}
                  title={!startable ? 'Starting runs requires paper mode + Alpaca keys' : nStopped > 0 ? 'Configs exported from stopped runs are recreated as stopped (press Start on the run card to trade)' : undefined}
                >
                  <Upload className="h-3 w-3" aria-hidden />
                  {nStopped === 0
                    ? `Start ${selectedConfigs.length} run${selectedConfigs.length === 1 ? '' : 's'}`
                    : nStart === 0
                      ? `Import ${nStopped} stopped`
                      : `Import ${selectedConfigs.length} (start ${nStart})`}
                </Button>
              </span>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
