"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  BellOff,
  BellRing,
  Loader2,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/lib/store";
import { fetchSnapshots } from "@/lib/client-api";
import { fmtPrice } from "@/lib/format";
import type { AlertDirection } from "@/lib/types";

const DIRECTION_META: { value: AlertDirection; label: string; icon: React.ReactNode; hint: string }[] = [
  { value: "above", label: "Above", icon: <ArrowUp className="h-3.5 w-3.5" />, hint: "Fires when price rises to the target" },
  { value: "below", label: "Below", icon: <ArrowDown className="h-3.5 w-3.5" />, hint: "Fires when price falls to the target" },
  { value: "cross", label: "Crossing", icon: <ArrowUpDown className="h-3.5 w-3.5" />, hint: "Fires when price crosses the target either way" },
];

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function AlertsDialog() {
  const open = useTerminal((s) => s.alertsOpen);
  const setOpen = useTerminal((s) => s.setAlertsOpen);
  const alerts = useTerminal((s) => s.alerts);
  const alertsLoaded = useTerminal((s) => s.alertsLoaded);
  const symbol = useTerminal((s) => s.symbol);
  const loadAlerts = useTerminal((s) => s.loadAlerts);
  const addAlert = useTerminal((s) => s.addAlert);
  const toggleAlert = useTerminal((s) => s.toggleAlert);
  const removeAlert = useTerminal((s) => s.removeAlert);

  const [newSymbol, setNewSymbol] = useState("");
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState<AlertDirection>("above");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  // keep the form aligned with the active chart symbol while the dialog is closed→open
  useEffect(() => {
    if (open) {
      setNewSymbol((prev) => prev || useTerminal.getState().symbol);
    }
  }, [open]);

  // when the symbol in the form changes, prefill the price with the live quote
  useEffect(() => {
    const sym = newSymbol.trim().toUpperCase();
    if (!open || !sym || !/^[A-Z.]{1,10}$/.test(sym)) return;
    let cancelled = false;
    fetchSnapshots([sym])
      .then(({ snapshots }) => {
        if (!cancelled) setPrice(snapshots[sym] ? fmtPrice(snapshots[sym].price) : "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [newSymbol, open]);

  useEffect(() => {
    if (open && !alertsLoaded) void loadAlerts();
  }, [open, alertsLoaded, loadAlerts]);

  const sorted = useMemo(() => {
    return [...alerts].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }, [alerts]);

  const activeCount = alerts.filter((a) => a.active).length;

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = newSymbol.trim().toUpperCase();
    const p = Number(price);
    if (!/^[A-Z.]{1,10}$/.test(sym)) {
      toast.error("Enter a valid symbol (e.g. AAPL)");
      return;
    }
    if (!Number.isFinite(p) || p <= 0) {
      toast.error("Enter a valid alert price");
      return;
    }
    setCreating(true);
    await addAlert({ symbol: sym, price: p, direction, note: note.trim() || undefined });
    setCreating(false);
    setNote("");
  };

  const onSendTest = async () => {
    setSendingTest(true);
    try {
      // a throwaway test using existing saved credentials is done via settings;
      // here we just verify with the current saved config through a tiny alert-less ping
      const res = await fetch("/api/telegram", { cache: "no-store" });
      const st = (await res.json()) as { configured: boolean };
      if (!st.configured) {
        toast.info("Telegram is not configured yet — set it up in Settings.");
      } else {
        toast.success("Telegram is configured — triggered alerts will be pushed to your chat.");
      }
    } catch {
      toast.error("Could not check Telegram status");
    } finally {
      setSendingTest(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col border-[#2a2e39] bg-[#161a25] text-[#d1d4dc] sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <BellRing className="h-5 w-5 text-[#f0b90b]" />
            Price alerts
            {activeCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#f0b90b]/20 px-1.5 text-[11px] font-bold text-[#f0b90b]">
                {activeCount} active
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-sm text-[#787b86]">
            Get a toast the moment price reaches your level — optionally pushed to Telegram (set it up in Settings).
          </DialogDescription>
        </DialogHeader>

        {/* create form */}
        <form onSubmit={onCreate} className="space-y-3 rounded-lg border border-[#2a2e39] bg-[#0d1017] p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="alert-symbol" className="text-xs font-medium text-[#b2b5be]">
                Symbol
              </Label>
              <Input
                id="alert-symbol"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                placeholder="AAPL"
                spellCheck={false}
                className="h-8 border-[#2a2e39] bg-[#131722] font-mono text-sm focus-visible:ring-[#26a69a]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="alert-price" className="text-xs font-medium text-[#b2b5be]">
                Price
              </Label>
              <Input
                id="alert-price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-8 border-[#2a2e39] bg-[#131722] font-mono text-sm focus-visible:ring-[#26a69a]"
              />
            </div>
          </div>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Alert condition">
            {DIRECTION_META.map((d) => (
              <button
                key={d.value}
                type="button"
                title={d.hint}
                aria-pressed={direction === d.value}
                onClick={() => setDirection(d.value)}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center gap-1 rounded-md border text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a]",
                  direction === d.value
                    ? "border-[#26a69a]/60 bg-[#26a69a]/15 text-[#26a69a]"
                    : "border-[#2a2e39] bg-[#131722] text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
                )}
              >
                {d.icon}
                {d.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional) — e.g. breakout watch"
              className="h-8 flex-1 border-[#2a2e39] bg-[#131722] text-sm focus-visible:ring-[#26a69a]"
            />
            <Button
              type="submit"
              disabled={creating}
              className="h-8 shrink-0 bg-[#26a69a] px-3 font-semibold text-[#0d1017] hover:bg-[#2bbbad]"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create
            </Button>
          </div>
        </form>

        {/* alert list */}
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 fluxview-scroll">
          {!alertsLoaded && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#787b86]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading alerts…
            </div>
          )}
          {alertsLoaded && sorted.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Bell className="h-7 w-7 text-[#2a2e39]" />
              <p className="text-sm text-[#787b86]">No alerts yet — create one above.</p>
            </div>
          )}
          {sorted.map((a) => {
            const dm = DIRECTION_META.find((d) => d.value === a.direction) ?? DIRECTION_META[0];
            return (
              <div
                key={a.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2",
                  a.active ? "border-[#2a2e39] bg-[#131722]" : "border-[#2a2e39]/60 bg-[#131722]/50 opacity-70"
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    a.active ? "bg-[#26a69a]/15 text-[#26a69a]" : "bg-[#2a2e39] text-[#787b86]"
                  )}
                >
                  {dm.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 font-mono text-sm">
                    <span className="font-bold text-white">{a.symbol}</span>
                    <span className="text-[#787b86]">{dm.label.toLowerCase()}</span>
                    <span className="flex items-center gap-1 font-semibold text-[#f0b90b]">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: a.color ?? "#f0b90b" }}
                        aria-hidden="true"
                      />
                      {fmtPrice(a.price)}
                    </span>
                    {a.triggeredAt && (
                      <span className="rounded bg-[#f0b90b]/15 px-1.5 py-0.5 font-sans text-[10px] font-bold text-[#f0b90b]">
                        TRIGGERED {timeAgo(a.triggeredAt)}
                      </span>
                    )}
                  </div>
                  {a.note && <p className="truncate text-xs text-[#787b86]">{a.note}</p>}
                </div>
                <Switch
                  checked={a.active}
                  onCheckedChange={(v) => void toggleAlert(a.id, v)}
                  aria-label={a.active ? "Pause alert" : "Re-arm alert"}
                  className="data-[state=checked]:bg-[#26a69a]"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-[#787b86] hover:bg-[#ef5350]/15 hover:text-[#ef5350]"
                  onClick={() => void removeAlert(a.id)}
                  aria-label={`Delete ${a.symbol} alert`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        {/* telegram hint */}
        <div className="flex items-center justify-between rounded-lg border border-[#2a2e39] bg-[#0d1017] px-3 py-2.5 text-xs text-[#787b86]">
          <span className="flex items-center gap-2">
            <Send className="h-3.5 w-3.5 text-[#26a69a]" />
            Alerts can be pushed to Telegram
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-[#2a2e39] px-2 text-xs text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
            disabled={sendingTest}
            onClick={onSendTest}
          >
            {sendingTest ? <Loader2 className="h-3 w-3 animate-spin" /> : <BellOff className="h-3 w-3" />}
            Check status
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
