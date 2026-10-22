"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Eye, EyeOff, KeyRound, Loader2, LogIn, PlugZap, Send, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  auth2faDisable,
  auth2faEnable,
  auth2faSetup,
  clearSettings,
  clearTelegram,
  fetchSettings,
  fetchTelegramStatus,
  saveSettings,
  saveTelegram,
} from "@/lib/client-api";
import { useTerminal } from "@/lib/store";

function TwoFactorSection() {
  const authUser = useTerminal((s) => s.authUser);
  const authStatus = useTerminal((s) => s.authStatus);
  const hasUsers = useTerminal((s) => s.hasUsers);
  const setAuthOpen = useTerminal((s) => s.setAuthOpen);

  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (authStatus !== "authed" || !authUser) {
    return (
      <div className="space-y-2 rounded-lg border border-[#2a2e39] bg-[#0d1017] p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[#d1d4dc]">
          <ShieldCheck className="h-4 w-4 text-[#26a69a]" /> Account &amp; security
        </div>
        {hasUsers ? (
          <>
            <p className="text-[11px] leading-relaxed text-[#787b86]">
              You are browsing as a guest. Sign in so your Alpaca keys, Telegram, watchlists, alerts and layout stay
              private to your account and sync every 5 seconds.
            </p>
            <Button
              size="sm"
              className="h-8 bg-[#26a69a] font-semibold text-[#0d1017] hover:bg-[#2bb385]"
              onClick={() => setAuthOpen(true)}
            >
              <LogIn className="h-4 w-4" /> Sign in
            </Button>
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-[#787b86]">
            No account exists yet. Create one from the top bar to protect your private keys with login + 2FA.
          </p>
        )}
      </div>
    );
  }

  const startSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await auth2faSetup();
      setQr(res.qrDataUrl);
      setSecret(res.secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start 2FA setup");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async () => {
    setError(null);
    setBusy(true);
    try {
      await auth2faEnable(code.trim());
      toast.success("2FA enabled — you will be asked for a code at next sign-in");
      setQr(null);
      setSecret(null);
      setCode("");
      useTerminal.setState({ authUser: { ...authUser, totpEnabled: true } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  const confirmDisable = async () => {
    setError(null);
    setBusy(true);
    try {
      await auth2faDisable(code.trim());
      toast.success("2FA disabled");
      setCode("");
      useTerminal.setState({ authUser: { ...authUser, totpEnabled: false } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-[#2a2e39] bg-[#0d1017] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-[#d1d4dc]">
          <ShieldCheck className="h-4 w-4 text-[#26a69a]" /> Account &amp; security
        </div>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
            authUser.totpEnabled ? "bg-[#26a69a]/15 text-[#26a69a]" : "bg-[#f0b90b]/15 text-[#f0b90b]"
          }`}
        >
          {authUser.totpEnabled ? "2FA ON" : "2FA OFF"}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-[#787b86]">
        Signed in as <span className="font-mono text-[#b2b5be]">{authUser.username}</span>. Your layout, watchlists,
        alerts, drawings, Alpaca keys and Telegram settings belong to this account and autosave every 5 seconds.
      </p>

      {!authUser.totpEnabled && !qr && (
        <Button size="sm" variant="outline" className="h-8 border-[#2a2e39] text-xs text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white" onClick={() => void startSetup()} disabled={busy}>
          <ShieldCheck className="h-4 w-4 text-[#26a69a]" /> Set up 2FA (authenticator app)
        </Button>
      )}

      {qr && secret && (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <img src={qr} alt="2FA QR code" width={110} height={110} className="rounded border border-[#2a2e39] bg-white p-1" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[11px] text-[#787b86]">Scan with Google Authenticator / Authy, or paste this key:</p>
              <code className="block break-all rounded bg-[#131722] px-2 py-1 font-mono text-[10px] text-[#b2b5be]">{secret}</code>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="h-8 flex-1 border-[#2a2e39] bg-[#131722] text-center font-mono text-sm tracking-widest text-white"
              aria-label="2FA confirmation code"
            />
            <Button size="sm" className="h-8 bg-[#26a69a] font-semibold text-[#0d1017] hover:bg-[#2bb385]" onClick={() => void confirmEnable()} disabled={busy || code.length !== 6}>
              Confirm
            </Button>
          </div>
        </div>
      )}

      {authUser.totpEnabled && (
        <div className="flex gap-2">
          <Input
            inputMode="numeric"
            maxLength={6}
            placeholder="Code to disable"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="h-8 flex-1 border-[#2a2e39] bg-[#131722] text-center font-mono text-sm tracking-widest text-white"
            aria-label="2FA disable code"
          />
          <Button size="sm" variant="outline" className="h-8 border-[#ef5350]/40 px-2 text-xs text-[#ef5350] hover:bg-[#ef5350]/10 hover:text-[#ef5350]" onClick={() => void confirmDisable()} disabled={busy || code.length !== 6}>
            <ShieldOff className="h-3.5 w-3.5" /> Disable 2FA
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-[#ef5350]">{error}</p>}
    </div>
  );
}

export function SettingsDialog() {
  const open = useTerminal((s) => s.settingsOpen);
  const setOpen = useTerminal((s) => s.setSettingsOpen);
  const setMode = useTerminal((s) => s.setMode);

  const [configured, setConfigured] = useState(false);
  const [keyIdMasked, setKeyIdMasked] = useState<string | null>(null);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // telegram state
  const [tgConfigured, setTgConfigured] = useState(false);
  const [tgTokenMasked, setTgTokenMasked] = useState<string | null>(null);
  const [tgChatMasked, setTgChatMasked] = useState<string | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await fetchSettings();
      setConfigured(s.configured);
      setKeyIdMasked(s.keyIdMasked);
    } catch {
      setConfigured(false);
      setKeyIdMasked(null);
    }
    try {
      const tg = await fetchTelegramStatus();
      setTgConfigured(tg.configured);
      setTgTokenMasked(tg.tokenMasked);
      setTgChatMasked(tg.chatMasked);
    } catch {
      setTgConfigured(false);
      setTgTokenMasked(null);
      setTgChatMasked(null);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      setTgError(null);
      void load();
    }
  }, [open, load]);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await saveSettings(keyId.trim(), secret.trim());
      setMode("live");
      toast.success(`Alpaca connected (${res.keyIdMasked}) — reloading live data…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setSaving(false);
    }
  };

  const onDisconnect = async () => {
    setClearing(true);
    try {
      await clearSettings();
      setMode("demo");
      toast.success("Alpaca disconnected — reloading in demo mode…");
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setClearing(false);
    }
  };

  const onTgSave = async (withTest: boolean) => {
    setTgError(null);
    if (withTest) setTgTesting(true);
    else setTgSaving(true);
    try {
      await saveTelegram(tgToken.trim(), tgChat.trim(), withTest);
      setTgConfigured(true);
      setTgToken("");
      setTgChat("");
      const tg = await fetchTelegramStatus();
      setTgTokenMasked(tg.tokenMasked);
      setTgChatMasked(tg.chatMasked);
      toast.success(withTest ? "Test message sent — Telegram connected" : "Telegram notifications saved");
    } catch (err) {
      setTgError(err instanceof Error ? err.message : "Failed to save Telegram settings");
    } finally {
      setTgTesting(false);
      setTgSaving(false);
    }
  };

  const onTgDisconnect = async () => {
    setTgSaving(true);
    try {
      await clearTelegram();
      setTgConfigured(false);
      setTgTokenMasked(null);
      setTgChatMasked(null);
      toast.success("Telegram notifications disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect Telegram");
    } finally {
      setTgSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto border-[#2a2e39] bg-[#161a25] text-[#d1d4dc] sm:rounded-lg fluxview-scroll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <PlugZap className="h-5 w-5 text-[#26a69a]" />
            Connect Alpaca Market Data
          </DialogTitle>
          <DialogDescription className="text-sm text-[#787b86]">
            Paste your Alpaca API keys to stream live US equity data. Without keys the terminal
            runs on clearly-labeled synthetic demo data.
          </DialogDescription>
        </DialogHeader>

        {/* ---------------- account & 2FA ---------------- */}
        <TwoFactorSection />

        {configured && (
          <div className="flex items-center justify-between rounded-lg border border-[#26a69a]/30 bg-[#26a69a]/10 px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-[#26a69a]" />
              <span className="font-medium text-[#26a69a]">Connected</span>
              <span className="font-mono text-xs text-[#787b86]">{keyIdMasked}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-[#ef5350]/40 px-2 text-xs text-[#ef5350] hover:bg-[#ef5350]/10 hover:text-[#ef5350]"
              onClick={onDisconnect}
              disabled={clearing}
            >
              {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disconnect"}
            </Button>
          </div>
        )}

        <form onSubmit={onSave} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="alpaca-key-id" className="text-xs font-medium text-[#b2b5be]">
              API Key ID
            </Label>
            <div className="relative">
              <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#787b86]" />
              <Input
                id="alpaca-key-id"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder="PKXXXXXXXXXXXXXXXX"
                autoComplete="off"
                spellCheck={false}
                className="border-[#2a2e39] bg-[#0d1017] pl-8 font-mono text-sm focus-visible:ring-[#26a69a]"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alpaca-secret" className="text-xs font-medium text-[#b2b5be]">
              Secret Key
            </Label>
            <div className="relative">
              <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#787b86]" />
              <Input
                id="alpaca-secret"
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Your Alpaca secret key"
                autoComplete="off"
                spellCheck={false}
                className="border-[#2a2e39] bg-[#0d1017] pl-8 pr-9 font-mono text-sm focus-visible:ring-[#26a69a]"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#787b86] hover:text-[#d1d4dc]"
                aria-label={showSecret ? "Hide secret" : "Show secret"}
              >
                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-[#ef5350]/40 bg-[#ef5350]/10 px-3 py-2 text-xs text-[#ef5350]" role="alert">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={saving || !keyId.trim() || !secret.trim()}
            className="h-9 w-full bg-[#26a69a] font-semibold text-[#0d1017] hover:bg-[#2bbbad] disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Validating with Alpaca…
              </>
            ) : (
              "Connect & save"
            )}
          </Button>
        </form>

        <div className="space-y-1 rounded-lg border border-[#2a2e39] bg-[#0d1017] p-3 text-[11px] leading-relaxed text-[#787b86]">
          <p>
            1. Sign up free at{" "}
            <a
              href="https://app.alpaca.markets/signup"
              target="_blank"
              rel="noreferrer"
              className="text-[#26a69a] underline underline-offset-2"
            >
              alpaca.markets
            </a>{" "}
            and generate keys (paper trading keys work).
          </p>
          <p>2. Keys are stored only in this app&apos;s local database and used server-side — they never reach the browser.</p>
          <p>3. Free plan streams the IEX feed with a 15-minute-deep history for US equities.</p>
        </div>

        <Separator className="bg-[#2a2e39]" />

        {/* ---------------- telegram notifications ---------------- */}
        <div className="space-y-3">
          <div>
            <DialogTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-4.5 w-4.5 text-[#26a69a]" />
              Telegram alerts
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-[#787b86]">
              Triggered price alerts are pushed to your Telegram chat via a bot.
            </DialogDescription>
          </div>

          {tgConfigured && (
            <div className="flex items-center justify-between rounded-lg border border-[#26a69a]/30 bg-[#26a69a]/10 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-[#26a69a]" />
                <span className="font-medium text-[#26a69a]">Connected</span>
                <span className="font-mono text-xs text-[#787b86]">
                  {tgTokenMasked} → chat {tgChatMasked}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 border-[#ef5350]/40 px-2 text-xs text-[#ef5350] hover:bg-[#ef5350]/10 hover:text-[#ef5350]"
                onClick={onTgDisconnect}
                disabled={tgSaving}
              >
                {tgSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Disconnect
              </Button>
            </div>
          )}

          {!tgConfigured && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="tg-token" className="text-xs font-medium text-[#b2b5be]">
                  Bot token
                </Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#787b86]" />
                  <Input
                    id="tg-token"
                    value={tgToken}
                    onChange={(e) => setTgToken(e.target.value)}
                    placeholder="123456789:AAE…your bot token from @BotFather"
                    autoComplete="off"
                    spellCheck={false}
                    className="border-[#2a2e39] bg-[#0d1017] pl-8 font-mono text-xs focus-visible:ring-[#26a69a]"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tg-chat" className="text-xs font-medium text-[#b2b5be]">
                  Chat ID
                </Label>
                <div className="relative">
                  <Send className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#787b86]" />
                  <Input
                    id="tg-chat"
                    value={tgChat}
                    onChange={(e) => setTgChat(e.target.value)}
                    placeholder="e.g. 987654321 (from @userinfobot)"
                    autoComplete="off"
                    spellCheck={false}
                    className="border-[#2a2e39] bg-[#0d1017] pl-8 font-mono text-xs focus-visible:ring-[#26a69a]"
                  />
                </div>
              </div>

              {tgError && (
                <p className="rounded-md border border-[#ef5350]/40 bg-[#ef5350]/10 px-3 py-2 text-xs text-[#ef5350]" role="alert">
                  {tgError}
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={tgTesting || tgSaving || !tgToken.trim() || !tgChat.trim()}
                  className="h-8 flex-1 bg-[#26a69a] font-semibold text-[#0d1017] hover:bg-[#2bbbad] disabled:opacity-50"
                  onClick={() => void onTgSave(true)}
                >
                  {tgTesting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Sending test…
                    </>
                  ) : (
                    "Send test & save"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={tgTesting || tgSaving || !tgToken.trim() || !tgChat.trim()}
                  className="h-8 border-[#2a2e39] px-3 text-xs text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
                  onClick={() => void onTgSave(false)}
                >
                  {tgSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save without test"}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-1 rounded-lg border border-[#2a2e39] bg-[#0d1017] p-3 text-[11px] leading-relaxed text-[#787b86]">
            <p>
              1. Create a bot with{" "}
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-[#26a69a] underline underline-offset-2">
                @BotFather
              </a>{" "}
              (command /newbot) and copy its token.
            </p>
            <p>
              2. Send your bot any message once, then get your chat ID from{" "}
              <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-[#26a69a] underline underline-offset-2">
                @userinfobot
              </a>
              .
            </p>
            <p>3. &quot;Send test &amp; save&quot; verifies the chat before storing credentials.</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
