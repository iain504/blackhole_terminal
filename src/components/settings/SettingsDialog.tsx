'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileJson, KeyRound, Loader2, Percent, PlugZap, Send, Sparkles, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useTerminal } from '@/store/terminal';
import { loadIndicators } from '@/lib/indicators';
import BackupRestoreCard from '@/components/settings/BackupRestoreCard';

export const SETTINGS_CHANGED_EVENT = 'tt:settings-changed';

const INDICATORS_LS_KEY = 'tt.indicators.v1';

type AlpacaValidation = { valid: boolean; status: number; message: string };

type SettingsState = {
  alpaca: { keyIdMasked: string; secretSet: boolean; serverKeysPresent: boolean };
  telegram: { tokenSet: boolean; chatId: string; notifyFills?: boolean; notifyCloses?: boolean };
  tradeMode?: string;
  tpslPercent?: number;
  glow?: { grid: string; algo: string };
};

const DEFAULT_GLOW_GRID = '#10b981';
const DEFAULT_GLOW_ALGO = '#a855f7';

export default function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();

  const [state, setState] = useState<SettingsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [notifyFills, setNotifyFills] = useState(true);
  const [notifyCloses, setNotifyCloses] = useState(true);
  const [tpslPct, setTpslPct] = useState('5');
  const [tpslPctLoaded, setTpslPctLoaded] = useState(false);
  // Task 10-g — chart glow colors (grid running / algo running)
  const [glowGrid, setGlowGrid] = useState(DEFAULT_GLOW_GRID);
  const [glowAlgo, setGlowAlgo] = useState(DEFAULT_GLOW_ALGO);
  const [glowLoaded, setGlowLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // ---- config backup (export / import) ----
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Export: flush unsaved layout so the file has the CURRENT state, fetch the
  // server-side bundle, merge the client-side indicator settings (localStorage)
  // and download as one JSON file.
  async function handleExport() {
    setExporting(true);
    try {
      // flush any pending layout changes (autosave runs every 5s)
      const store = useTerminal.getState();
      if (store.layoutDirty) {
        await fetch('/api/layout', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: store.layoutSnapshot() }),
        }).catch(() => undefined);
        store.markLayoutClean();
      }
      const res = await fetch('/api/user/config');
      if (!res.ok) throw new Error(`Export failed (${res.status}).`);
      const file = await res.json();
      // merge client-side indicator settings into the bundle
      try {
        file.data.indicators = loadIndicators();
      } catch {
        /* indicators optional */
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const name = `blackhole-config-${file.username || 'user'}-${stamp}.json`;
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({
        title: 'Config exported',
        description: `${name} — includes API keys in plaintext, store it safely.`,
      });
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  }

  // Import: parse the picked file client-side (friendly errors), confirm the
  // sections it will REPLACE, then POST it. Applied sections: layout,
  // watchlists, alerts, strategies, drawings, calendar alarms, settings.
  // Absent sections are untouched. Reload afterwards for a clean re-hydrate.
  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error('Not a valid JSON file.');
      }
      const data = (parsed.data ?? parsed) as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') throw new Error('Not a BLACKHOLE Terminal config file.');
      const parts: string[] = [];
      const count = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]).length : 0);
      if (data.layout) parts.push('layout (tabs, chart layouts & symbols, panels)');
      if (count('watchlists')) parts.push(`${count('watchlists')} watchlist(s)`);
      if (count('alerts')) parts.push(`${count('alerts')} alert(s)`);
      // Task 79 — show the arm-state split: armed rules come back live,
      // paused rules stay paused (status round-trips through the file)
      const stratRows = Array.isArray(data.strategies) ? (data.strategies as unknown[]) : [];
      const armedCount = stratRows.filter((s) => s && typeof s === 'object' && (s as Record<string, unknown>).status !== 'paused').length;
      const pausedCount = stratRows.length - armedCount;
      if (stratRows.length > 0) parts.push(`${stratRows.length} strategy rule(s) (${armedCount} armed, ${pausedCount} paused — arm state preserved)`);
      if (count('drawings')) parts.push(`${count('drawings')} drawing(s)`);
      if (count('calendarAlarms')) parts.push(`${count('calendarAlarms')} calendar alarm(s)`);
      if (data.settings) parts.push('settings (API keys, Telegram, trading defaults)');
      if (data.indicators) parts.push('indicator settings');
      if (parts.length === 0) throw new Error('Nothing importable found in the file.');
      const ok = window.confirm(
        `Import config from "${file.name}"?\n\nThis will REPLACE:\n• ${parts.join('\n• ')}\n\nSections not in the file are kept. Continue?`
      );
      if (!ok) return;
      const res = await fetch('/api/user/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `Import failed (${res.status}).`);
      // write client-side indicators before the reload picks them up
      if (data.indicators && typeof data.indicators === 'object') {
        try {
          window.localStorage.setItem(INDICATORS_LS_KEY, JSON.stringify(data.indicators));
        } catch {
          /* storage full / private mode — indicators just stay as-is */
        }
      }
      // prevent the 5s autosave from overwriting the imported layout with the
      // stale in-memory one, then hard-reload for a clean re-hydration
      useTerminal.getState().markLayoutClean();
      toast({ title: 'Config imported — reloading…' });
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // Any typed-but-unsaved credential — closing the dialog would lose it.
  const dirty = Boolean(
    keyId.trim() ||
    secret.trim() ||
    token.trim() ||
    chatId.trim() !== (state?.telegram?.chatId ?? '') ||
    (glowLoaded && (glowGrid !== (state?.glow?.grid ?? DEFAULT_GLOW_GRID) || glowAlgo !== (state?.glow?.algo ?? DEFAULT_GLOW_ALGO)))
  );

  const confirmDiscard = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && dirty) {
        return window.confirm(
          'You typed credentials that are NOT saved yet.\n\nClick Cancel, then press Save to keep them.'
        );
      }
      return true;
    },
    [dirty]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`Failed to load settings (${res.status}).`);
      const data: SettingsState = await res.json();
      setState(data);
      setChatId(data?.telegram?.chatId ?? '');
      setNotifyFills(data?.telegram?.notifyFills !== false);
      setNotifyCloses(data?.telegram?.notifyCloses !== false);
      if (!tpslPctLoaded) {
        setTpslPct(String(data?.tpslPercent ?? 5));
        setTpslPctLoaded(true);
      }
      if (!glowLoaded) {
        setGlowGrid(data?.glow?.grid ?? DEFAULT_GLOW_GRID);
        setGlowAlgo(data?.glow?.algo ?? DEFAULT_GLOW_ALGO);
        setGlowLoaded(true);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Failed to load settings.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // Only send fields the user actually changed (non-empty = "send me").
    const payload: Record<string, string | number | boolean> = {};
    if (keyId.trim()) payload.alpacaKeyId = keyId.trim();
    if (secret.trim()) payload.alpacaSecret = secret.trim();
    if (token.trim()) payload.telegramToken = token.trim();
    if (chatId.trim()) payload.telegramChatId = chatId.trim();
    // toggles always ride along (booleans can't be "empty")
    payload.notifyFills = notifyFills;
    payload.notifyCloses = notifyCloses;
    const pct = parseFloat(tpslPct);
    if (tpslPctLoaded && isFinite(pct) && pct > 0) payload.tpslPercent = pct;
    // glow colors always ride along once loaded (strings can't be "empty")
    if (glowLoaded) {
      payload.glowGridColor = glowGrid;
      payload.glowAlgoColor = glowAlgo;
    }
    if (Object.keys(payload).length === 0) {
      toast({ title: 'Nothing to save', description: 'Enter a value first.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = `Save failed (${res.status}).`;
        try {
          const data = await res.json();
          msg = data?.error || data?.message || msg;
        } catch {
          // keep default message
        }
        throw new Error(msg);
      }
      const data: { ok: boolean; alpaca?: AlpacaValidation | null } = await res
        .json()
        .catch(() => ({ ok: true }));
      // Clear secret inputs so they read "unchanged" again.
      setKeyId('');
      setSecret('');
      setToken('');
      if (data.alpaca && !data.alpaca.valid) {
        // Saved, but Alpaca rejected the keys — say so loudly, the chart
        // would otherwise silently keep showing demo data.
        toast({
          title: 'Saved, but Alpaca rejected the keys',
          description: `${data.alpaca.message} The chart will stay in demo mode until fixed.`,
          variant: 'destructive',
        });
      } else if (data.alpaca?.valid) {
        toast({
          title: 'Settings saved — keys verified ✓',
          description: 'Live Alpaca data is loading now.',
        });
      } else {
        toast({ title: 'Settings saved' });
      }
      // Tell every open panel (chart, footer badge, watchlist) to refetch.
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
      await load();
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  // Verify Alpaca keys: uses what is typed (unsaved) when both fields are
  // filled, otherwise the stored keys.
  async function handleTestAlpaca() {
    setTesting(true);
    try {
      const res = await fetch('/api/settings/alpaca/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alpacaKeyId: keyId.trim() || undefined,
          alpacaSecret: secret.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (data?.valid) {
        toast({
          title: 'Alpaca keys working ✓',
          description:
            data.tested === 'typed'
              ? 'These typed keys are valid — press Save to use them.'
              : data.message || 'Saved keys are valid.',
        });
      } else {
        toast({
          title: 'Alpaca keys failed',
          description: data?.message || `Test failed (${res.status}).`,
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Test failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch('/api/settings/telegram/test', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.message ||
            `Test failed (${res.status}). Is the bot token and chat ID configured?`
        );
      }
      toast({
        title: 'Test message sent',
        description: 'Check your Telegram chat.',
      });
    } catch (err) {
      toast({
        title: 'Telegram test failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      });
    } finally {
      setTesting(false);
    }
  }

  const inputClass =
    'border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (confirmDiscard(next)) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto border-zinc-800 bg-zinc-900 sm:max-w-lg"
        onInteractOutside={(e) => {
          if (dirty) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (dirty) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Settings</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Manage your Alpaca API keys and Telegram alert delivery.
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="text-sm font-medium text-red-500">{loadError}</p>
        )}

        <form onSubmit={handleSave} className="flex flex-col gap-5">
          {/* ------- Alpaca API keys ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Alpaca API keys
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {loading && (
                <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
              )}
              {state?.alpaca?.serverKeysPresent && (
                <Badge className="border-emerald-900 bg-emerald-950 text-emerald-400">
                  Server keys active
                </Badge>
              )}
              {state?.alpaca?.keyIdMasked && (
                <span className="text-xs text-zinc-400">
                  Key ID:{' '}
                  <span className="font-mono text-zinc-200">
                    {state.alpaca.keyIdMasked}
                  </span>
                </span>
              )}
              {state?.alpaca?.secretSet && (
                <Badge className="border-zinc-700 bg-zinc-800 text-zinc-200">
                  Secret saved
                </Badge>
              )}
              {!loading &&
                state &&
                !state.alpaca?.serverKeysPresent &&
                !state.alpaca?.keyIdMasked &&
                !state.alpaca?.secretSet && (
                  <span className="text-xs text-zinc-500">
                    No keys configured — market data falls back to demo mode.
                  </span>
                )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="alpaca-key-id" className="text-zinc-300">
                API Key ID
              </Label>
              <Input
                id="alpaca-key-id"
                type="password"
                placeholder="unchanged"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                autoComplete="off"
                disabled={loading || saving}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="alpaca-secret" className="text-zinc-300">
                API Secret
              </Label>
              <Input
                id="alpaca-secret"
                type="password"
                placeholder="unchanged"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
                disabled={loading || saving}
                className={inputClass}
              />
            </div>

            <p className="text-xs leading-relaxed text-zinc-500">
              Keys are encrypted (AES-256-GCM) and only used server-side. Get
              keys at alpaca.markets (free). Real-time US stock + crypto data.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={handleTestAlpaca}
              disabled={testing || saving}
              className="w-fit border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
              Test keys
            </Button>
          </section>

          <div className="h-px bg-zinc-800" />

          {/* ------- Trading defaults ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Percent className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Trading defaults</h3>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="tpsl-percent" className="text-zinc-300">
                Default TP / SL distance (% from entry)
              </Label>
              <Input
                id="tpsl-percent"
                type="number"
                min="0.1"
                max="90"
                step="any"
                value={tpslPct}
                onChange={(e) => setTpslPct(e.target.value)}
                disabled={loading || saving}
                className={inputClass}
              />
              <p className="text-xs leading-relaxed text-zinc-500">
                New orders in the trade ticket are pre-filled with take-profit
                and stop-loss at this distance from the entry price (5 = ±5%).
                Still adjustable per order before submitting.
              </p>
            </div>
          </section>

          <div className="h-px bg-zinc-800" />

          {/* ------- Chart glow (Task 10-g) ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Chart glow</h3>
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              The chart border pulses while a bot is running on the charted
              symbol. Pick the glow color for each engine (defaults: grid
              emerald, algo purple).
            </p>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="glow-grid" className="text-zinc-300">
                Grid running
              </Label>
              <input
                id="glow-grid"
                type="color"
                value={glowGrid}
                onChange={(e) => setGlowGrid(e.target.value)}
                disabled={loading || saving}
                aria-label="Glow color while a grid trade is running"
                className="h-9 w-16 cursor-pointer rounded border border-zinc-800 bg-zinc-950 p-0.5"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="glow-algo" className="text-zinc-300">
                Algo running
              </Label>
              <input
                id="glow-algo"
                type="color"
                value={glowAlgo}
                onChange={(e) => setGlowAlgo(e.target.value)}
                disabled={loading || saving}
                aria-label="Glow color while an algo run is live"
                className="h-9 w-16 cursor-pointer rounded border border-zinc-800 bg-zinc-950 p-0.5"
              />
            </div>
          </section>

          <div className="h-px bg-zinc-800" />

          {/* ------- Telegram alerts ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Send className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Telegram alerts
              </h3>
              {state?.telegram?.tokenSet && (
                <Badge className="border-emerald-900 bg-emerald-950 text-emerald-400">
                  Token saved
                </Badge>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="telegram-token" className="text-zinc-300">
                Bot token
              </Label>
              <Input
                id="telegram-token"
                type="password"
                placeholder="unchanged"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                disabled={loading || saving}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="telegram-chat-id" className="text-zinc-300">
                Chat ID
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="telegram-chat-id"
                  type="text"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="e.g. 123456789"
                  autoComplete="off"
                  disabled={loading || saving}
                  className={inputClass}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing || saving}
                  className="shrink-0 border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                  Send test message
                </Button>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-zinc-500">
              Create a bot with @BotFather, then message your bot and find your
              chat id via @userinfobot.
            </p>

            {/* notification toggles */}
            <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Notify me on Telegram when…
              </span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={notifyFills}
                  onChange={(e) => setNotifyFills(e.target.checked)}
                  disabled={loading || saving}
                  className="h-3.5 w-3.5 accent-emerald-500"
                  aria-label="Notify when an order fills"
                />
                ✅ An order fills (entry, take-profit, stop-loss)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={notifyCloses}
                  onChange={(e) => setNotifyCloses(e.target.checked)}
                  disabled={loading || saving}
                  className="h-3.5 w-3.5 accent-emerald-500"
                  aria-label="Notify when a position closes"
                />
                🔒 A position closes (with estimated realized P&amp;L)
              </label>
              <p className="text-[10px] leading-snug text-zinc-600">
                Sent through the bot above while the terminal is open. Both default ON.
              </p>
            </div>
          </section>

          <div className="h-px bg-zinc-800" />

          {/* ------- Config backup (export / import) ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <FileJson className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Config backup</h3>
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              Export everything to one file — layout, watchlists, alerts,
              strategy rules, chart drawings, calendar alarms, indicator
              settings, API keys and trading defaults — and restore it here or
              on another install.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleExport}
                disabled={exporting || importing}
                className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export config file
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={exporting || importing}
                className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Import config file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImportFile(f);
                }}
              />
            </div>
            <p className="text-xs leading-relaxed text-amber-500/90">
              The export file contains your API keys in plaintext — store it
              safely. Import replaces the sections present in the file (alarms
              and strategies are re-armed fresh).
            </p>
          </section>

          <div className="h-px bg-zinc-800" />

          {/* ------- Full account backup / restore (Task 9-r) ------- */}
          <BackupRestoreCard />

          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-4">
            {dirty && (
              <span className="text-xs text-amber-400">
                Unsaved changes — press Save before closing.
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                type="submit"
                disabled={loading || saving}
                className="bg-emerald-600 text-white hover:bg-emerald-500"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
