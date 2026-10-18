'use client';

import { useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Check,
  Copy,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!setup || code.length !== 6) {
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
          totpCode: code,
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

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!ticket || code.length !== 6) {
      setError('Enter the 6-digit code from your authenticator.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, code }),
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
          <p className="flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            Your Alpaca API secret and Telegram token are encrypted at rest; 2FA
            keeps them safe.
          </p>
        </div>
      </div>
    </div>
  );
}
