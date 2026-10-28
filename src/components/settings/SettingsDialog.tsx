'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, FileJson, KeyRound, Loader2, Palette, Percent, PlugZap, Send, Sparkles, Sunrise, Upload } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import {
  applyUiTheme,
  saveUiThemeToServer,
  UI_THEMES,
  useUiTheme,
  type UiTheme,
} from '@/lib/ui-theme';
import BackupRestoreCard from '@/components/settings/BackupRestoreCard';

export const SETTINGS_CHANGED_EVENT = 'tt:settings-changed';

const INDICATORS_LS_KEY = 'tt.indicators.v1';

/** Task 37 — per-section dual-host key check result (/api/settings/alpaca/test
 * and the PUT save response). `matchesMode === false` means the keys WORK but
 * belong to the OTHER account — the exact 401-on-live trap. */
type AlpacaKeyCheckResult = {
  valid: boolean;
  detected: 'paper' | 'live' | null;
  matchesMode: boolean | null;
  tested?: 'typed' | 'stored';
  message: string;
};

type SettingsState = {
  alpaca: {
    paper: { keyIdMasked: string; secretSet: boolean };
    live: { keyIdMasked: string; secretSet: boolean };
    legacy?: { keyIdMasked: string; secretSet: boolean };
    serverKeysPresent: boolean;
  };
  telegram: { tokenSet: boolean; chatId: string; notifyFills?: boolean; notifyCloses?: boolean };
  tradeMode?: string;
  tpslPercent?: number;
  glow?: { grid: string; algo: string };
  sessionSplash?: boolean;
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

  const [paperKeyId, setPaperKeyId] = useState('');
  const [paperSecret, setPaperSecret] = useState('');
  const [liveKeyId, setLiveKeyId] = useState('');
  const [liveSecret, setLiveSecret] = useState('');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [notifyFills, setNotifyFills] = useState(true);
  const [notifyCloses, setNotifyCloses] = useState(true);
  // v1.87.0 — session open/close splash alert (default ON; mirrored to
  // localStorage `tt:session-splash` so SessionSplash boots flash-free)
  const [sessionSplash, setSessionSplash] = useState(true);
  const [tpslPct, setTpslPct] = useState('5');
  const [tpslPctLoaded, setTpslPctLoaded] = useState(false);
  // Task 10-g — chart glow colors (grid running / algo running)
  const [glowGrid, setGlowGrid] = useState(DEFAULT_GLOW_GRID);
  const [glowAlgo, setGlowAlgo] = useState(DEFAULT_GLOW_ALGO);
  const [glowLoaded, setGlowLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testingPaper, setTestingPaper] = useState(false);
  const [testingLive, setTestingLive] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);

  // ---- Task 28 — appearance (UI theme) ----
  // The applied theme (html class + localStorage) IS the source of truth for
  // display — useUiTheme re-renders the section the moment it changes.
  const uiTheme = useUiTheme();
  const [savingTheme, setSavingTheme] = useState(false);
  async function handleThemeSelect(t: UiTheme) {
    if (t === uiTheme || savingTheme) return;
    applyUiTheme(t); // live preview + localStorage, before the round-trip
    setSavingTheme(true);
    try {
      const ok = await saveUiThemeToServer(t);
      if (ok) {
        // label from UI_THEMES so new themes never show a stale hard-coded name
        toast({
          title: `${UI_THEMES.find((d) => d.id === t)?.label ?? 'Theme'} theme on`,
          description: 'Saved to your account — follows you to every device.',
        });
      } else {
        toast({
          title: 'Theme applied on this device',
          description: 'Could not save to your account just now — it will not sync to other devices.',
          variant: 'destructive',
        });
      }
    } finally {
      setSavingTheme(false);
    }
  }

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
    paperKeyId.trim() ||
    paperSecret.trim() ||
    liveKeyId.trim() ||
    liveSecret.trim() ||
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
      const splashOn = data?.sessionSplash !== false;
      setSessionSplash(splashOn);
      try {
        localStorage.setItem('tt:session-splash', splashOn ? '1' : '0');
      } catch {
        /* private mode */
      }
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
    if (paperKeyId.trim()) payload.alpacaPaperKeyId = paperKeyId.trim();
    if (paperSecret.trim()) payload.alpacaPaperSecret = paperSecret.trim();
    if (liveKeyId.trim()) payload.alpacaLiveKeyId = liveKeyId.trim();
    if (liveSecret.trim()) payload.alpacaLiveSecret = liveSecret.trim();
    if (token.trim()) payload.telegramToken = token.trim();
    if (chatId.trim()) payload.telegramChatId = chatId.trim();
    // toggles always ride along (booleans can't be "empty")
    payload.notifyFills = notifyFills;
    payload.notifyCloses = notifyCloses;
    payload.sessionSplash = sessionSplash;
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
      const data: { ok: boolean; alpacaChecks?: { mode: 'paper' | 'live'; check: AlpacaKeyCheckResult }[] } = await res
        .json()
        .catch(() => ({ ok: true }));
      // Clear secret inputs so they read "unchanged" again.
      setPaperKeyId('');
      setPaperSecret('');
      setLiveKeyId('');
      setLiveSecret('');
      setToken('');
      // Task 37 — the server verified EVERY stored pair against BOTH hosts;
      // surface rejected pairs and wrong-section keys loudly.
      const checks = data.alpacaChecks ?? [];
      const rejected = checks.filter((c) => !c.check.valid);
      const mismatched = checks.filter((c) => c.check.valid && c.check.matchesMode === false);
      if (rejected.length > 0) {
        toast({
          title: 'Saved, but Alpaca rejected some keys',
          description: rejected.map((c) => `${c.mode.toUpperCase()}: ${c.check.message}`).join(' '),
          variant: 'destructive',
        });
      } else if (mismatched.length > 0) {
        toast({
          title: 'Saved — but a key is in the wrong section',
          description: mismatched
            .map((c) =>
              c.check.detected === 'paper'
                ? 'Paper-account keys are saved in the LIVE section — they will 401 on every live call. Swap the sections.'
                : 'Live-account keys are saved in the PAPER section — swap the sections.'
            )
            .join(' '),
          variant: 'destructive',
        });
      } else if (checks.length > 0) {
        toast({
          title: 'Settings saved — keys verified ✓',
          description: checks.map((c) => `${c.mode.toUpperCase()} keys OK (${c.check.detected?.toUpperCase()} account)`).join(' · '),
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

  // Task 37 — verify the PAPER or LIVE pair: typed (unsaved) values when both
  // fields are filled, otherwise the stored keys for that section. The server
  // probes BOTH trading hosts so a paper key pasted into the Live section is
  // caught before it can 401 on every real call.
  async function handleTestAlpaca(m: 'paper' | 'live') {
    const setTesting = m === 'paper' ? setTestingPaper : setTestingLive;
    setTesting(true);
    try {
      const res = await fetch('/api/settings/alpaca/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: m,
          alpacaKeyId: (m === 'paper' ? paperKeyId : liveKeyId).trim() || undefined,
          alpacaSecret: (m === 'paper' ? paperSecret : liveSecret).trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as AlpacaKeyCheckResult | null;
      if (data?.valid && data.matchesMode !== false) {
        toast({
          title: m === 'paper' ? 'Paper keys working ✓' : 'Live keys working ✓',
          description:
            data.tested === 'typed'
              ? 'These typed keys are valid — press Save to use them.'
              : data.message || 'Saved keys are valid.',
        });
      } else if (data?.valid && data.matchesMode === false) {
        toast({ title: 'Wrong section for these keys', description: data.message, variant: 'destructive' });
      } else {
        toast({
          title: m === 'paper' ? 'Paper keys failed' : 'Live keys failed',
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
    setTestingTelegram(true);
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
      setTestingTelegram(false);
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
          {/* ------- Appearance (Task 28) ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Appearance</h3>
              {savingTheme && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" aria-label="Saving theme" />}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {UI_THEMES.map((t) => {
                const active = uiTheme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void handleThemeSelect(t.id)}
                    aria-pressed={active}
                    disabled={savingTheme}
                    className={cn(
                      'flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                      active
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700 hover:bg-zinc-900'
                    )}
                  >
                    <span className="flex w-full items-center justify-between">
                      <span className="text-sm font-medium text-zinc-100">{t.label}</span>
                      {active && <Check className="h-4 w-4 shrink-0 text-emerald-400" aria-label="Active theme" />}
                    </span>
                    <span className="flex gap-1" aria-hidden>
                      {t.swatch.map((c) => (
                        <span
                          key={c}
                          className="h-4 w-4 rounded-full border border-black/40"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                    <span className="text-xs leading-snug text-zinc-500">{t.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              Applies instantly and saves to your account automatically — also
              used on the landing page of this browser.
            </p>
          </section>

          <div className="h-px bg-zinc-800" />

          {/* ------- Alpaca API keys (Task 37 — dual: Paper + Live) ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Alpaca API keys
              </h3>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
              {state?.tradeMode && (
                <Badge
                  className={
                    state.tradeMode === 'live'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                      : 'border-emerald-900 bg-emerald-950 text-emerald-400'
                  }
                >
                  Trade mode: {state.tradeMode === 'live' ? 'LIVE' : 'PAPER'}
                </Badge>
              )}
              {state?.alpaca?.serverKeysPresent && (
                <Badge className="border-emerald-900 bg-emerald-950 text-emerald-400">
                  Server keys active
                </Badge>
              )}
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              One Alpaca key only works on a <span className="text-zinc-300">paper</span> OR a{' '}
              <span className="text-zinc-300">live</span> account — never both — so save each
              account&apos;s keys in its own section. The trade ticket&apos;s Paper/Live toggle
              picks which pair is used; charts load market data with whichever pair is saved.
            </p>

            {/* ---- Paper account ---- */}
            <div className="flex flex-col gap-2.5 rounded-md border border-emerald-900/60 bg-emerald-950/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                  Paper account
                </span>
                {state?.alpaca?.paper?.keyIdMasked ? (
                  <span className="text-[11px] text-zinc-400">
                    Key ID: <span className="font-mono text-zinc-200">{state.alpaca.paper.keyIdMasked}</span>
                  </span>
                ) : state?.alpaca?.legacy?.keyIdMasked ? (
                  <span className="text-[11px] text-amber-400/90">
                    Legacy key serves Paper until saved here
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500">Not configured</span>
                )}
                {state?.alpaca?.paper?.secretSet && (
                  <Badge className="border-zinc-700 bg-zinc-800 text-zinc-200">Secret saved</Badge>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alpaca-paper-key-id" className="text-xs text-zinc-400">
                    Key ID
                  </Label>
                  <Input
                    id="alpaca-paper-key-id"
                    type="password"
                    placeholder="unchanged"
                    value={paperKeyId}
                    onChange={(e) => setPaperKeyId(e.target.value)}
                    autoComplete="off"
                    disabled={loading || saving}
                    className={inputClass}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alpaca-paper-secret" className="text-xs text-zinc-400">
                    Secret
                  </Label>
                  <Input
                    id="alpaca-paper-secret"
                    type="password"
                    placeholder="unchanged"
                    value={paperSecret}
                    onChange={(e) => setPaperSecret(e.target.value)}
                    autoComplete="off"
                    disabled={loading || saving}
                    className={inputClass}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleTestAlpaca('paper')}
                disabled={testingPaper || saving}
                className="w-fit border-emerald-900/70 bg-zinc-950 text-emerald-300 hover:bg-zinc-900 hover:text-emerald-200"
              >
                {testingPaper ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                Test paper key
              </Button>
            </div>

            {/* ---- Live account ---- */}
            <div className="flex flex-col gap-2.5 rounded-md border border-amber-900/60 bg-amber-950/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Live account
                </span>
                <span className="text-[11px] font-medium text-amber-500/80">real money</span>
                {state?.alpaca?.live?.keyIdMasked ? (
                  <span className="text-[11px] text-zinc-400">
                    Key ID: <span className="font-mono text-zinc-200">{state.alpaca.live.keyIdMasked}</span>
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500">Not configured</span>
                )}
                {state?.alpaca?.live?.secretSet && (
                  <Badge className="border-zinc-700 bg-zinc-800 text-zinc-200">Secret saved</Badge>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alpaca-live-key-id" className="text-xs text-zinc-400">
                    Key ID
                  </Label>
                  <Input
                    id="alpaca-live-key-id"
                    type="password"
                    placeholder="unchanged"
                    value={liveKeyId}
                    onChange={(e) => setLiveKeyId(e.target.value)}
                    autoComplete="off"
                    disabled={loading || saving}
                    className={inputClass}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alpaca-live-secret" className="text-xs text-zinc-400">
                    Secret
                  </Label>
                  <Input
                    id="alpaca-live-secret"
                    type="password"
                    placeholder="unchanged"
                    value={liveSecret}
                    onChange={(e) => setLiveSecret(e.target.value)}
                    autoComplete="off"
                    disabled={loading || saving}
                    className={inputClass}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleTestAlpaca('live')}
                disabled={testingLive || saving}
                className="w-fit border-amber-900/70 bg-zinc-950 text-amber-300 hover:bg-zinc-900 hover:text-amber-200"
              >
                {testingLive ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                Test live key
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-zinc-500">
              Keys are encrypted (AES-256-GCM) and only used server-side. Get keys at
              alpaca.markets (free) — paper keys start with &quot;PK&quot;, live keys with
              &quot;AK&quot;. Each Test proves which account a key belongs to before it can 401.
            </p>
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
                  disabled={testingTelegram || saving}
                  className="shrink-0 border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  {testingTelegram && <Loader2 className="h-4 w-4 animate-spin" />}
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

          {/* ------- Trading session alerts (v1.87.0) ------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Sunrise className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Trading session alerts</h3>
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={sessionSplash}
                  onChange={(e) => setSessionSplash(e.target.checked)}
                  disabled={loading || saving}
                  className="h-3.5 w-3.5 accent-emerald-500"
                  aria-label="Show a splash screen when regular trading opens and closes"
                />
                🔔 Splash screen when regular trading opens &amp; closes
              </label>
              <p className="text-[10px] leading-snug text-zinc-600">
                Full-screen alert at 09:30 ET (open) and 16:00 ET (close), Mon–Fri — the hours
                stock orders fill. Auto-dismisses after 10 seconds, once per day. Default ON.
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
