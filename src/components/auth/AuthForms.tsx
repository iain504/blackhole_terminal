'use client';

// Task 9-r — the auth screen also offers "Have a backup? Restore it": on a
// fresh install (user table empty — the same first-run bootstrap trust level
// as registration) a backup from the previous install can resurrect the
// account EXACTLY (username + password + 2FA) with all of its data. Once any
// account exists the server answers 409 and the affordance points at
// Settings → Backup & Restore instead.

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Check,
  Copy,
  DatabaseBackup,
  FolderOpen,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type AuthUser = { id: string; username: string };
type Mode = 'login' | 'register';
type TwoFactorSetup = { secret: string; otpauth: string; qrDataUrl: string };

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return (data?.error || data?.message || fallback) as string;
  } catch {
    return fallback;
  }
}

export default function AuthForms({
  onAuthed,
}: {
  onAuthed: (user: AuthUser) => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [step, setStep] = useState<1 | 2>(1);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');

  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [ticket, setTicket] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Task 27 — smooth 2FA: ref to the hidden <input> that drives the OTP slots
  // (focus() lands the caret on the first digit without clicking a slot).
  const otpInputRef = useRef<HTMLInputElement | null>(null);
  // Task 27 — the last code we AUTO-submitted; keyed by VALUE so a full code
  // pasted OVER another full code (6→6 chars, no length transition) still
  // fires, while an unchanged code never resubmits itself.
  const lastAutoSubmitted = useRef('');

  // Task 27 — the moment the 6-digit step appears (login verify + register
  // setup), park focus on the FIRST digit so the user can just start typing
  // the code from their authenticator. A short delay lets the step-2 content
  // (QR image, labels) finish mounting first.
  useEffect(() => {
    if (step !== 2) return;
    const focusTimer = window.setTimeout(() => {
      otpInputRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(focusTimer);
  }, [step]);

  // Task 27 — auto-submit as soon as a (new) 6-digit code is complete — typed,
  // pasted, or autofilled — so sign-in/sign-up needs no extra button click.
  // The value latch prevents resubmitting the same code (e.g. while the 401
  // from a wrong code is still in flight / displayed); editing any digit
  // produces a different value and re-arms the auto-submit. The Verify button
  // stays available for a deliberate retry of the same code.
  useEffect(() => {
    if (loading || step !== 2 || code.length !== 6) return;
    if (lastAutoSubmitted.current === code) return;
    lastAutoSubmitted.current = code;
    if (mode === 'register') void submitRegister(code);
    else void submitVerify(code);
  }, [code, step, mode, loading, submitRegister, submitVerify]);

  // ---- restore-from-backup dialog (Task 9-r) ----
  type RestorePhase = 'check' | 'ready' | 'unavailable' | 'done';
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>('check');
  const [restorePaste, setRestorePaste] = useState('');
  const [restoreFileName, setRestoreFileName] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoredUser, setRestoredUser] = useState('');
  const restoreFileRef = useRef<HTMLInputElement | null>(null);

  function openRestore() {
    setRestorePhase('check');
    setRestorePaste('');
    setRestoreFileName('');
    setRestoreError('');
    setRestoredUser('');
    setRestoreBusy(false);
    if (restoreFileRef.current) restoreFileRef.current.value = '';
    setRestoreOpen(true);
    // availability = user table empty (first-run bootstrap). Any other state
    // points back at Settings → Backup & Restore.
    fetch('/api/auth/restore')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Status ${res.status}`))))
      .then((data: { available?: boolean }) =>
        setRestorePhase(data.available ? 'ready' : 'unavailable')
      )
      .catch(() => {
        setRestorePhase('unavailable');
        setRestoreError('Could not check whether restore is available — try again.');
      });
  }

  function handleRestoreFile(file: File) {
    setRestoreFileName(file.name);
    file
      .text()
      .then((t) => {
        // parsed at submit; the filename badge is just feedback
        setRestorePaste(t);
      })
      .catch(() => {
        setRestoreFileName('');
        setRestoreError('Could not read that file.');
      });
  }

  async function handleRestoreSubmit() {
    if (restorePhase !== 'ready') return;
    const text = restorePaste.trim();
    if (!text) {
      setRestoreError('Choose your backup file or paste its JSON first.');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setRestoreError('That is not valid JSON — check the backup file/text.');
      return;
    }
    setRestoreBusy(true);
    setRestoreError('');
    try {
      const res = await fetch('/api/auth/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(raw),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; username?: string } | null;
      if (res.status === 409) {
        // accounts appeared meanwhile — flip the dialog to the Settings hint
        setRestorePhase('unavailable');
        setRestoreError(data?.error || 'System already has accounts — restore from Settings instead.');
        return;
      }
      if (!res.ok) {
        throw new Error(data?.error || `Restore failed (${res.status}).`);
      }
      // success: land the user on the login form with the restored username
      // pre-filled (password + 2FA are the old ones — nothing to re-create)
      setRestoredUser(data?.username || '');
      setRestorePhase('done');
      switchMode('login');
      if (data?.username) setUsername(data.username);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRestoreBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setStep(1);
    setError('');
    setSetup(null);
    setTicket('');
    setCode('');
  }

  function goBack() {
    setStep(1);
    setCode('');
    setError('');
  }

  function validateStep1(): string | null {
    if (mode === 'register') {
      const name = username.trim();
      if (name.length < 3 || name.length > 40)
        return 'Username must be 3-40 characters.';
      if (password.length < 8) return 'Password must be at least 8 characters.';
      if (password !== confirm) return 'Passwords do not match.';
    } else {
      if (!username.trim()) return 'Enter your username.';
      if (!password) return 'Enter your password.';
    }
    return null;
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateStep1();
    if (invalid) {
      setError(invalid);
      return;
    }
    setLoading(true);
    setError('');
    try {
      if (mode === 'register') {
        // Fetch 2FA provisioning (QR + secret) for this username.
        const res = await fetch(
          `/api/auth/2fa/setup?username=${encodeURIComponent(username.trim())}`
        );
        if (!res.ok)
          throw new Error(await readApiError(res, 'Could not start 2FA setup.'));
        const data = (await res.json()) as TwoFactorSetup;
        setSetup(data);
        setCode('');
        setStep(2);
      } else {
        // Login step 1: password check -> short-lived ticket for the TOTP step.
        const res = await fetch('/api/auth/register', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.trim(), password }),
        });
        if (!res.ok)
          throw new Error(
            await readApiError(
              res,
              'Sign in failed. Check your username and password.'
            )
          );
        const data = await res.json();
        setTicket(data.ticket);
        setCode('');
        setStep(2);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  // Task 27 — the core create-account call; `completed` is the just-finished
  // code handed over by the OTP auto-submit (dodges stale-state timing).
  async function submitRegister(completed?: string) {
    if (loading) return; // auto-submit can race a click/Enter — one shot only
    const otp = completed ?? code;
    if (!setup || otp.length !== 6) {
      setError('Enter the 6-digit code from your authenticator.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          totpSecret: setup.secret,
          totpCode: otp,
        }),
      });
      if (!res.ok)
        throw new Error(
          await readApiError(res, 'Invalid code. Could not create account.')
        );
      const data = await res.json();
      onAuthed(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    void submitRegister();
  }

  // Task 27 — the core login-verify call; `completed` same as submitRegister.
  async function submitVerify(completed?: string) {
    if (loading) return; // auto-submit can race a click/Enter — one shot only
    const otp = completed ?? code;
    if (!ticket || otp.length !== 6) {
      setError('Enter the 6-digit code from your authenticator.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, code: otp }),
      });
      if (!res.ok)
        throw new Error(
          await readApiError(res, 'Invalid or expired code. Try again.')
        );
      const data = await res.json();
      onAuthed(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    void submitVerify();
  }

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — user can still select the text manually
    }
  }

  const tabClass = (m: Mode) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      mode === m
        ? 'bg-zinc-800 text-zinc-100 shadow-sm'
        : 'text-zinc-400 hover:text-zinc-200'
    );

  const slotClass = 'h-10 w-10 border-zinc-800 bg-zinc-950 text-base text-zinc-100';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-zinc-950 p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 px-8 pt-8 pb-5 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950">
            <BarChart3 className="h-6 w-6 text-emerald-400" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
            TradeTerminal
          </h1>
          <p className="text-sm text-zinc-400">
            Sign in to protect your Alpaca keys &amp; alerts
          </p>
        </div>

        {/* Mode tabs (internal state, not routes) */}
        <div className="mx-8 grid grid-cols-2 gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={tabClass('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
            className={tabClass('register')}
          >
            Create account
          </button>
        </div>

        <form
          onSubmit={
            step === 1
              ? handleContinue
              : mode === 'register'
                ? handleRegister
                : handleVerify
          }
          className="flex flex-col gap-4 px-8 py-6"
        >
          {/* ---------- Step 1 ---------- */}
          {step === 1 && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="auth-username" className="text-zinc-300">
                  Username
                </Label>
                <Input
                  id="auth-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="your-username"
                  autoComplete="username"
                  disabled={loading}
                  className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="auth-password" className="text-zinc-300">
                  Password
                </Label>
                <Input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  disabled={loading}
                  className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
                />
              </div>

              {mode === 'register' && (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="auth-confirm" className="text-zinc-300">
                      Confirm password
                    </Label>
                    <Input
                      id="auth-confirm"
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      disabled={loading}
                      className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
                    />
                    <p className="text-xs text-zinc-500">
                      Username 3-40 characters, password minimum 8.
                    </p>
                  </div>
                </>
              )}

              <Button
                type="submit"
                disabled={loading}
                className="mt-1 w-full bg-emerald-600 text-white hover:bg-emerald-500"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Continue
              </Button>
            </>
          )}

          {/* ---------- Register step 2: 2FA setup ---------- */}
          {step === 2 && mode === 'register' && setup && (
            <>
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-lg border border-zinc-800 bg-white p-2">
                  { }
                  <img
                    src={setup.qrDataUrl}
                    alt="2FA QR code"
                    className="h-44 w-44"
                  />
                </div>
                <p className="text-sm text-zinc-400">
                  Scan with Google Authenticator / Authy
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-zinc-300">Manual entry secret</Label>
                <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 py-2 pr-2 pl-3">
                  <code className="flex-1 truncate font-mono text-xs text-zinc-300">
                    {setup.secret}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={copySecret}
                    className="h-7 w-7 shrink-0 text-zinc-400 hover:text-zinc-100"
                    aria-label="Copy secret"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <Label className="text-zinc-300">Enter 6-digit code</Label>
                <InputOTP
                  ref={otpInputRef}
                  maxLength={6}
                  value={code}
                  onChange={setCode}
                  disabled={loading}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} className={slotClass} />
                    <InputOTPSlot index={1} className={slotClass} />
                    <InputOTPSlot index={2} className={slotClass} />
                    <InputOTPSlot index={3} className={slotClass} />
                    <InputOTPSlot index={4} className={slotClass} />
                    <InputOTPSlot index={5} className={slotClass} />
                  </InputOTPGroup>
                </InputOTP>
              </div>

              <Button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full bg-emerald-600 text-white hover:bg-emerald-500"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Create account
              </Button>
            </>
          )}

          {/* ---------- Login step 2: 2FA verify ---------- */}
          {step === 2 && mode === 'login' && (
            <>
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm text-zinc-400">
                  Enter the 6-digit code from your authenticator app
                </p>
                <InputOTP
                  ref={otpInputRef}
                  maxLength={6}
                  value={code}
                  onChange={setCode}
                  disabled={loading}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} className={slotClass} />
                    <InputOTPSlot index={1} className={slotClass} />
                    <InputOTPSlot index={2} className={slotClass} />
                    <InputOTPSlot index={3} className={slotClass} />
                    <InputOTPSlot index={4} className={slotClass} />
                    <InputOTPSlot index={5} className={slotClass} />
                  </InputOTPGroup>
                </InputOTP>
              </div>

              <Button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full bg-emerald-600 text-white hover:bg-emerald-500"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Verify
              </Button>
            </>
          )}

          {error && <p className="text-sm font-medium text-red-500">{error}</p>}

          {step === 2 && (
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              disabled={loading}
              className="text-zinc-400 hover:text-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          )}
        </form>

        <div className="border-t border-zinc-800 px-8 py-4">
          {step === 1 && (
            <div className="mb-3 text-center">
              <button
                type="button"
                onClick={openRestore}
                className="text-xs text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-300 hover:underline"
              >
                Have a backup? Restore it
              </button>
            </div>
          )}
          <p className="flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            Your Alpaca API secret and Telegram token are encrypted at rest; 2FA
            keeps them safe.
          </p>
        </div>

        {/* ---------- Restore-from-backup dialog (Task 9-r) ---------- */}
        <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-zinc-800 bg-zinc-900 gap-3">
            <DialogHeader className="space-y-1">
              <DialogTitle className="flex items-center gap-2 text-base text-zinc-100">
                <DatabaseBackup className="h-4 w-4 text-emerald-400" aria-hidden />
                Restore from backup
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-400">
                Bring back the account from another install — username, password,
                2FA and all of its data. Only possible while this system has no
                accounts yet.
              </DialogDescription>
            </DialogHeader>

            {restorePhase === 'check' && (
              <div className="flex items-center gap-2 py-2 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking availability…
              </div>
            )}

            {restorePhase === 'unavailable' && (
              <div className="flex items-start gap-2 rounded-md border border-amber-900 bg-amber-950/40 p-3 text-xs leading-relaxed text-amber-300">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  System already has accounts — restore from Settings instead.
                  Log in, open Settings → Backup &amp; Restore → Restore from backup.
                </span>
              </div>
            )}

            {restorePhase === 'ready' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                    onClick={() => restoreFileRef.current?.click()}
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden />
                    Choose file…
                  </Button>
                  <span className="truncate text-xs text-zinc-500" aria-live="polite">
                    {restoreFileName || 'or paste the JSON below'}
                  </span>
                  <input
                    ref={restoreFileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleRestoreFile(f);
                    }}
                  />
                </div>
                <Textarea
                  value={restorePaste}
                  onChange={(e) => setRestorePaste(e.target.value)}
                  placeholder='{"app":"blackhole-terminal","version":1,…}'
                  className="h-28 resize-y overflow-y-auto border-zinc-800 bg-zinc-950 font-mono text-[10px] leading-snug text-zinc-200 placeholder:text-zinc-600 [field-sizing:fixed]"
                  aria-label="Paste backup JSON"
                />
                <p className="text-[11px] leading-snug text-zinc-500">
                  The restored account keeps its previous password and 2FA. If
                  this install uses a different encryption secret, Alpaca keys
                  / Telegram tokens may need re-entry afterwards.
                </p>
                <Button
                  type="button"
                  disabled={restoreBusy || !restorePaste.trim()}
                  className="w-full bg-emerald-600 text-white hover:bg-emerald-500"
                  onClick={() => void handleRestoreSubmit()}
                >
                  {restoreBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <DatabaseBackup className="h-4 w-4" aria-hidden />}
                  Restore backup
                </Button>
              </div>
            )}

            {restorePhase === 'done' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2 rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-xs leading-relaxed text-emerald-300">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    Restored{restoredUser ? ` as “${restoredUser}”` : ''} — now log
                    in with your previous username &amp; password (same 2FA).
                  </span>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    className="w-full bg-emerald-600 text-white hover:bg-emerald-500"
                    onClick={() => setRestoreOpen(false)}
                  >
                    Go to sign in
                  </Button>
                </DialogFooter>
              </div>
            )}

            {restoreError && <p className="text-sm font-medium text-red-500">{restoreError}</p>}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
