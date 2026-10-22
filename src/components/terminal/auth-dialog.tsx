"use client";

import { useState } from "react";
import { KeyRound, Loader2, Lock, LogIn, ShieldCheck, UserPlus } from "lucide-react";
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
import { authLogin, authRegister, authVerify2fa } from "@/lib/client-api";
import { useTerminal } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Sign in / create account dialog with the 2FA (TOTP) step. Opened from the
 * TopBar, the watchlist panel and the alerts dialog whenever a private API
 * answers 401.
 */
export function AuthDialog() {
  const open = useTerminal((s) => s.authOpen);
  const setAuthOpen = useTerminal((s) => s.setAuthOpen);
  const finishLogin = useTerminal((s) => s.finishLogin);
  const hasUsers = useTerminal((s) => s.hasUsers);

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode("signin");
    setUsername("");
    setPassword("");
    setConfirm("");
    setCode("");
    setTicket(null);
    setBusy(false);
    setError(null);
  };

  const close = (v: boolean) => {
    setAuthOpen(v);
    if (!v) reset();
  };

  const submit = async () => {
    setError(null);
    if (ticket) {
      if (!/^\d{6}$/.test(code.trim())) {
        setError("Enter the 6-digit code from your authenticator app");
        return;
      }
      setBusy(true);
      try {
        const { user } = await authVerify2fa(ticket, code.trim());
        await finishLogin(user);
        reset();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Verification failed");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!username.trim() || !password) {
      setError("Username and password are required");
      return;
    }
    if (mode === "signup" && password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const { user } = await authRegister(username.trim(), password);
        await finishLogin(user);
        reset();
      } else {
        const res = await authLogin(username.trim(), password);
        if (res.twofa && res.ticket) {
          setTicket(res.ticket);
          setError(null);
        } else if (res.user) {
          await finishLogin(res.user);
          reset();
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-sm border-[#2a2e39] bg-[#1c202b] text-[#d1d4dc]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            {ticket ? (
              <>
                <ShieldCheck className="h-5 w-5 text-[#26a69a]" /> Two-factor authentication
              </>
            ) : mode === "signup" ? (
              <>
                <UserPlus className="h-5 w-5 text-[#26a69a]" /> Create your account
              </>
            ) : (
              <>
                <LogIn className="h-5 w-5 text-[#26a69a]" /> Sign in to FluxView
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-[#787b86]">
            {ticket
              ? "Enter the 6-digit code from your authenticator app (Google Authenticator, Authy…)."
              : "Your Alpaca API keys, Telegram settings, watchlists, alerts and layout are stored per account and kept private."}
          </DialogDescription>
        </DialogHeader>

        {ticket ? (
          <div className="flex flex-col gap-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="flex flex-col gap-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="totp-code" className="text-xs text-[#b2b5be]">
                  Authentication code
                </Label>
                <Input
                  id="totp-code"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="h-10 border-[#2a2e39] bg-[#131722] text-center font-mono text-xl tracking-[0.4em] text-white"
                />
              </div>
              {error && <p className="text-xs text-[#ef5350]">{error}</p>}
              <Button type="submit" disabled={busy} className="h-9 bg-[#26a69a] font-semibold text-[#0d1017] hover:bg-[#2bb385]">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Verify & sign in
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-8 text-xs text-[#787b86] hover:text-white"
                onClick={() => {
                  setTicket(null);
                  setCode("");
                  setError(null);
                }}
              >
                Back to sign in
              </Button>
            </form>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="flex flex-col gap-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="auth-username" className="text-xs text-[#b2b5be]">
                Username
              </Label>
              <Input
                id="auth-username"
                autoFocus
                autoComplete="username"
                placeholder="trader"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-9 border-[#2a2e39] bg-[#131722] text-white"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="auth-password" className="text-xs text-[#b2b5be]">
                Password
              </Label>
              <Input
                id="auth-password"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 border-[#2a2e39] bg-[#131722] text-white"
              />
            </div>
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-confirm" className="text-xs text-[#b2b5be]">
                  Confirm password
                </Label>
                <Input
                  id="auth-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-9 border-[#2a2e39] bg-[#131722] text-white"
                />
              </div>
            )}
            {error && <p className="text-xs text-[#ef5350]">{error}</p>}
            <Button type="submit" disabled={busy} className="h-9 bg-[#26a69a] font-semibold text-[#0d1017] hover:bg-[#2bb385]">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : mode === "signup" ? (
                <UserPlus className="h-4 w-4" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              {mode === "signup" ? "Create account" : "Sign in"}
            </Button>
            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                className="text-[#26a69a] hover:underline"
                onClick={() => {
                  setMode(mode === "signin" ? "signup" : "signin");
                  setError(null);
                }}
              >
                {mode === "signin" ? "Need an account? Create one" : "Already registered? Sign in"}
              </button>
              {mode === "signin" && (
                <span className={cn("flex items-center gap-1 text-[10px] text-[#787b86]")}>
                  <KeyRound className="h-3 w-3" /> 2FA supported
                </span>
              )}
            </div>
            {mode === "signin" && !hasUsers && (
              <p className="text-[10px] leading-relaxed text-[#787b86]">
                No account exists yet — create the first one to secure your Alpaca keys, Telegram, watchlists and alerts.
              </p>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
