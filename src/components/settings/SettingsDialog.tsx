'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, PlugZap, Send } from 'lucide-react';
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

export const SETTINGS_CHANGED_EVENT = 'tt:settings-changed';

type AlpacaValidation = { valid: boolean; status: number; message: string };

type SettingsState = {
  alpaca: { keyIdMasked: string; secretSet: boolean; serverKeysPresent: boolean };
  telegram: { tokenSet: boolean; chatId: string };
};

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

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Any typed-but-unsaved credential — closing the dialog would lose it.
  const dirty = Boolean(keyId.trim() || secret.trim() || token.trim());

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
    const payload: Record<string, string> = {};
    if (keyId.trim()) payload.alpacaKeyId = keyId.trim();
    if (secret.trim()) payload.alpacaSecret = secret.trim();
    if (token.trim()) payload.telegramToken = token.trim();
    if (chatId.trim()) payload.telegramChatId = chatId.trim();
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
          </section>

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
