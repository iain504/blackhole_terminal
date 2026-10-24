'use client';

// Task 9-r — Settings → Backup & Restore. One file with the ACCOUNT (username,
// password hash, 2FA secret as stored) plus watchlists, layout, drawings,
// alerts, strategy rules, algo runs + logs, the recommended-setups cache and
// grid trades + fills — so a publish/redeploy reset (fresh DB) is recoverable
// in ~30 seconds from Settings, or from the login screen on a fresh install.
//
// Export copies the AlgoExportDialog pattern (AlgoConfigIO.tsx, Task 9-n):
// sandboxed preview iframes silently swallow blob downloads, so the JSON is
// ALWAYS shown in a readonly textarea with a copy chain (async clipboard →
// execCommand → "select and copy manually") and the real download is a bonus
// that warns when it appears blocked.

import { useRef, useState } from 'react';
import {
  DatabaseBackup,
  Download,
  FileJson,
  FolderOpen,
  Loader2,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useTerminal } from '@/store/terminal';

// table keys shown in the restore preview (mirrors the server envelope)
const TABLE_LABELS: Record<string, string> = {
  watchlists: 'watchlist(s)',
  drawings: 'drawing(s)',
  alerts: 'alert(s)',
  strategyRules: 'strategy rule(s)',
  algoRuns: 'algo run(s)',
  algoLogs: 'algo log entr(ies)',
  calendarAlarms: 'calendar alarm(s)',
  gridTrades: 'grid trade(s)',
  gridFills: 'grid fill(s)',
};

interface ExportDlg {
  filename: string;
  json: string;
  data: unknown;
}

interface RestoreSummary {
  watchlists?: number;
  drawings?: number;
  alerts?: number;
  strategyRules?: number;
  algoRuns?: number;
  algoLogs?: number;
  calendarAlarms?: number;
  gridTrades?: number;
  gridFills?: number;
  [key: string]: number | undefined;
}

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** Client-side peek at what the file will replace (server re-validates). */
function summarizeBackup(raw: unknown): { lines: string[]; hasSettings: boolean } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let file = raw as Record<string, unknown>;
  // unwrap a { backup: {...} } wrapper — the server accepts both forms
  if (file.backup && typeof file.backup === 'object' && !Array.isArray(file.backup)) {
    file = file.backup as Record<string, unknown>;
  }
  if (file.app !== 'blackhole-terminal') return null;
  const data = file.data && typeof file.data === 'object' && !Array.isArray(file.data)
    ? (file.data as Record<string, unknown>)
    : null;
  if (!data) return null;
  const lines: string[] = [];
  for (const [key, label] of Object.entries(TABLE_LABELS)) {
    const rows = data[key];
    if (Array.isArray(rows)) lines.push(`${rows.length} ${label}`);
  }
  if (data.layout) lines.push('layout (tabs, chart layouts & symbols)');
  if (data.algoRecoCache) lines.push('recommended-setups cache');
  const user = file.user && typeof file.user === 'object' ? (file.user as Record<string, unknown>) : null;
  const hasSettings = Boolean(user?.settings);
  if (hasSettings) lines.push('account settings (API keys / Telegram, encrypted)');
  if (user?.username) lines.unshift(`account "${String(user.username)}"`);
  return { lines, hasSettings };
}

export default function BackupRestoreCard() {
  const { toast } = useToast();

  // ---- export ----
  const [exporting, setExporting] = useState(false);
  const [exportDlg, setExportDlg] = useState<ExportDlg | null>(null);
  const exportTaRef = useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- import ----
  const [importOpen, setImportOpen] = useState(false);
  const [confirmRaw, setConfirmRaw] = useState<{ raw: Record<string, unknown>; source: string } | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [pendingFileName, setPendingFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [restored, setRestored] = useState<RestoreSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleExport() {
    setExporting(true);
    try {
      // flush any pending layout change (autosave runs every 5s) so the file
      // carries the CURRENT tab/chart state
      const store = useTerminal.getState();
      if (store.layoutDirty) {
        await fetch('/api/layout', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: store.layoutSnapshot() }),
        }).catch(() => undefined);
        store.markLayoutClean();
      }
      const res = await fetch('/api/user/backup');
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || `Export failed (${res.status}).`);
      }
      const file = (await res.json()) as Record<string, unknown>;
      const user = (file.user ?? {}) as Record<string, unknown>;
      const username = typeof user.username === 'string' ? user.username : 'user';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      setExportDlg({
        filename: `blackhole-backup-${username.replace(/[^A-Za-z0-9._-]/g, '') || 'user'}-${stamp}.json`,
        json: JSON.stringify(file, null, 2),
        data: file,
      });
      setCopied(false);
    } catch (err) {
      toast({
        title: 'Backup export failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  }

  async function copyJson() {
    if (!exportDlg) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(exportDlg.json);
        setCopied(true);
        toast({ title: 'Backup JSON copied to clipboard', description: 'Paste it somewhere safe — you will need it after a redeploy.' });
        return;
      }
      throw new Error('clipboard API unavailable');
    } catch {
      // sandboxed iframes often deny the async clipboard — select+execCommand fallback
      const ta = exportTaRef.current;
      if (ta) {
        ta.focus();
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.focus(); // execCommand may blur — keep focus inside the dialog
        if (ok) {
          setCopied(true);
          toast({ title: 'Backup JSON copied to clipboard' });
          return;
        }
      }
      toast({ title: 'Copy blocked — select the JSON text and copy manually (Ctrl/Cmd+C)', variant: 'destructive' });
    }
  }

  function openImport() {
    setPasteText('');
    setPendingFileName('');
    setRestored(null);
    setImportOpen(true);
  }

  function parseFromText(text: string, source: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast({ title: 'Not valid JSON', description: 'Check the backup file/text and try again.', variant: 'destructive' });
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast({ title: 'Not a BLACKHOLE Terminal backup file', variant: 'destructive' });
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  function handleFileChosen(file: File) {
    setPendingFileName(file.name);
    file
      .text()
      .then((t) => {
        const raw = parseFromText(t, file.name);
        if (!raw) {
          setPendingFileName('');
          if (fileInputRef.current) fileInputRef.current.value = '';
          return;
        }
        const summary = summarizeBackup(raw);
        if (!summary) {
          toast({ title: 'Not a BLACKHOLE Terminal backup file', description: 'Expected app "blackhole-terminal" with a data section.', variant: 'destructive' });
          setPendingFileName('');
          if (fileInputRef.current) fileInputRef.current.value = '';
          return;
        }
        setPasteText('');
        setConfirmRaw({ raw, source: file.name });
      })
      .catch(() => {
        toast({ title: 'Could not read file', variant: 'destructive' });
        setPendingFileName('');
      });
  }

  function confirmPaste() {
    const raw = parseFromText(pasteText, 'pasted JSON');
    if (!raw) return;
    const summary = summarizeBackup(raw);
    if (!summary) {
      toast({ title: 'Not a BLACKHOLE Terminal backup file', description: 'Expected app "blackhole-terminal" with a data section.', variant: 'destructive' });
      return;
    }
    setConfirmRaw({ raw, source: 'pasted JSON' });
  }

  /** POST the backup; the server replaces the current account's data. */
  async function runRestore() {
    if (!confirmRaw) return;
    setImporting(true);
    try {
      const res = await fetch('/api/user/backup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(confirmRaw.raw),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; restored?: RestoreSummary } | null;
      if (!res.ok) throw new Error(json?.error || `Restore failed (${res.status}).`);
      // prevent the 5s autosave from overwriting the restored layout with the
      // stale in-memory one
      useTerminal.getState().markLayoutClean();
      setRestored(json?.restored ?? {});
      setConfirmRaw(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast({
        title: 'Backup restored',
        description: 'Reload the terminal to re-hydrate the restored data.',
      });
    } catch (err) {
      toast({
        title: 'Restore failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setImporting(false);
    }
  }

  const restorePreview = confirmRaw ? summarizeBackup(confirmRaw.raw) : null;
  const restoredLines = restored
    ? Object.entries(restored)
        .filter(([, n]) => typeof n === 'number' && n > 0)
        .map(([k, n]) => {
          if (k === 'settings') return 'account settings';
          if (k === 'layout') return 'layout (tabs & charts)';
          return `${n} ${TABLE_LABELS[k] ?? k}`;
        })
    : [];

  return (
    <Card className="border-zinc-800 bg-zinc-950/60">
      <CardHeader className="gap-1.5 p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <DatabaseBackup className="h-4 w-4 text-emerald-400" aria-hidden />
          Backup &amp; Restore
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed text-zinc-500">
          One file with your account, watchlists, charts, algo runs, alerts and
          grid trades. Restore it after a redeploy instead of starting over —
          from here, or from the login screen on a fresh install.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleExport}
            disabled={exporting || importing}
            className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            Export backup
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={openImport}
            disabled={exporting || importing}
            className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Upload className="h-4 w-4" aria-hidden />
            Restore from backup
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-amber-500/90">
          The backup file carries your password hash and your 2FA / Alpaca /
          Telegram secrets exactly as stored (encrypted) — never share it. If
          this install&apos;s encryption secret changed since the backup, those
          secrets stop decrypting and Alpaca keys / Telegram tokens may need
          re-entry after restore.
        </p>

        {/* ------- Export dialog (copy-first, per AlgoConfigIO Task 9-n) ------- */}
        <Dialog open={Boolean(exportDlg)} onOpenChange={(open) => { if (!open) setExportDlg(null); }}>
          <DialogContent
            className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg gap-3 overflow-y-auto border-zinc-800 bg-zinc-900"
            // the clipboard fallback (select+execCommand) and the programmatic
            // download anchor transiently move focus OUT of the dialog — a
            // nested Radix dialog treats that as focus-outside and dismisses
            // itself mid-action. Keep it open; pointer dismissal still works.
            onFocusOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="space-y-1">
              <DialogTitle className="flex items-center gap-2 text-base text-zinc-100">
                <FileJson className="h-4 w-4 text-emerald-400" aria-hidden />
                Backup exported
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-400">
                <span className="font-mono">{exportDlg?.filename}</span> — copy the JSON
                (embeds/previews may block downloads) or download the file. Store it safely.
              </DialogDescription>
            </DialogHeader>
            {/* [field-sizing:fixed] — the base Textarea auto-grows with its
                content (field-sizing-content), which turned this into a
                ~5000px dialog for a 6KB backup and pushed the buttons off-
                viewport */}
            <Textarea
              ref={exportTaRef}
              readOnly
              value={exportDlg?.json ?? ''}
              onFocus={(e) => e.currentTarget.select()}
              className="h-56 min-h-44 resize-y overflow-y-auto border-zinc-800 bg-zinc-950 font-mono text-[10px] leading-snug text-zinc-200 [field-sizing:fixed]"
              aria-label="Backup JSON"
            />
            <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
              <span className="text-[10px] text-zinc-500">
                {exportDlg ? new Blob([exportDlg.json]).size.toLocaleString('en-US') : 0} bytes · account + data
              </span>
              <span className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-zinc-800 bg-zinc-950 text-[11px] text-zinc-200 hover:bg-zinc-900"
                  onClick={() => void copyJson()}
                >
                  {copied ? 'Copied — copy again' : 'Copy JSON'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 bg-emerald-600 text-[11px] text-white hover:bg-emerald-500"
                  onClick={() => {
                    if (!exportDlg) return;
                    try {
                      downloadJsonFile(exportDlg.filename, exportDlg.data);
                      toast({ title: 'Download started', description: 'If no file appears, the preview is blocking downloads — use Copy JSON instead.' });
                    } catch {
                      toast({ title: 'Download blocked here — use Copy JSON', variant: 'destructive' });
                    }
                  }}
                >
                  <Download className="h-3 w-3" aria-hidden />
                  Download .json
                </Button>
              </span>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ------- Import dialog: file OR paste → confirm → POST ------- */}
        <Dialog open={importOpen} onOpenChange={(open) => { if (!importing) setImportOpen(open); }}>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-lg border-zinc-800 bg-zinc-900 gap-3">
            <DialogHeader className="space-y-1">
              <DialogTitle className="flex items-center gap-2 text-base text-zinc-100">
                <RotateCcw className="h-4 w-4 text-emerald-400" aria-hidden />
                Restore from backup
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-400">
                Pick the backup file or paste its JSON. Everything present in
                the backup replaces this account&apos;s current data.
              </DialogDescription>
            </DialogHeader>

            {restored ? (
              <div className="flex flex-col gap-3">
                <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-xs leading-relaxed text-emerald-300">
                  <p className="font-semibold">Restored ✓</p>
                  <p>{restoredLines.length ? restoredLines.join(' · ') : 'No data rows in the backup.'}</p>
                </div>
                <DialogFooter className="gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                    onClick={() => setImportOpen(false)}
                  >
                    Close
                  </Button>
                  <Button
                    type="button"
                    className="bg-emerald-600 text-white hover:bg-emerald-500"
                    onClick={() => window.location.reload()}
                  >
                    Reload terminal
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden />
                    Choose file…
                  </Button>
                  <span className="truncate text-xs text-zinc-500" aria-live="polite">
                    {pendingFileName || 'or paste the JSON below'}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFileChosen(f);
                    }}
                  />
                </div>
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder='{"app":"blackhole-terminal","version":1,…}'
                  className="h-28 resize-y overflow-y-auto border-zinc-800 bg-zinc-950 font-mono text-[10px] leading-snug text-zinc-200 placeholder:text-zinc-600 [field-sizing:fixed]"
                  aria-label="Paste backup JSON"
                />
                <DialogFooter className="gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-zinc-400 hover:text-zinc-100"
                    onClick={() => setImportOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="bg-emerald-600 text-white hover:bg-emerald-500"
                    disabled={importing || !pasteText.trim()}
                    onClick={confirmPaste}
                  >
                    {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                    Review &amp; restore
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* ------- Confirm: importing replaces current data ------- */}
        <AlertDialog open={Boolean(confirmRaw)} onOpenChange={(open) => { if (!open) setConfirmRaw(null); }}>
          <AlertDialogContent className="border-zinc-800 bg-zinc-900">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-zinc-100">Replace current data with this backup?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-zinc-400">
                  <span className="block">
                    Source: <span className="font-mono text-zinc-300">{confirmRaw?.source}</span>. This
                    REPLACES what your account has now for every section in the file:
                  </span>
                  <span className="block font-mono text-[11px] text-zinc-300">
                    {restorePreview?.lines.join(' · ') || 'unknown contents'}
                  </span>
                  <span className="block">
                    Sections not in the file are kept. This cannot be undone.
                  </span>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-emerald-600 text-white hover:bg-emerald-500"
                disabled={importing}
                onClick={(e) => {
                  e.preventDefault(); // keep the dialog open while the request runs
                  void runRestore();
                }}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Replace &amp; restore
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
