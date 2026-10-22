"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { fetchSnapshots, evaluateAlerts } from "@/lib/client-api";
import { useTerminal } from "@/lib/store";
import { fmtPrice } from "@/lib/format";

/**
 * Background alert evaluator: every 15s it fetches snapshots for the union of
 * (alert symbols ∪ watchlist symbols ∪ open chart frames) and sends the latest
 * prices to /api/alerts/evaluate. The server marks triggered alerts and pushes
 * Telegram notifications; this component surfaces the toasts.
 */
export function AlertsWatcher() {
  // keep the latest symbol universe in a ref so the poll interval never re-subscribes
  const universeRef = useRef<string[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    const update = () => {
      const st = useTerminal.getState();
      const set = new Set<string>();
      for (const a of st.alerts) if (a.active) set.add(a.symbol);
      for (const s of st.watchlist) set.add(s);
      for (const f of st.frames) set.add(f.symbol);
      universeRef.current = Array.from(set).slice(0, 60);
    };
    update();
    const t = window.setInterval(update, 3000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const tick = async () => {
      const symbols = universeRef.current;
      if (busyRef.current || symbols.length === 0) return;
      busyRef.current = true;
      try {
        const { snapshots } = await fetchSnapshots(symbols);
        const prices: Record<string, number> = {};
        for (const [sym, snap] of Object.entries(snapshots)) {
          if (snap && Number.isFinite(snap.price) && snap.price > 0) prices[sym] = snap.price;
        }
        if (Object.keys(prices).length === 0) return;
        const { triggered } = await evaluateAlerts(prices);
        if (triggered.length > 0) {
          // refresh the alert list so the dialog/badges reflect the new state
          void useTerminal.getState().loadAlerts();
          for (const t of triggered) {
            toast.success(
              `🔔 ${t.alert.symbol} ${t.alert.direction === "cross" ? "crossed" : t.alert.direction} ${fmtPrice(t.alert.price)} — now ${fmtPrice(t.price)}`,
              {
                description: t.notified
                  ? "Telegram notification sent."
                  : t.notifyError
                    ? `Telegram failed: ${t.notifyError}`
                    : t.alert.note ?? undefined,
                duration: 10000,
              }
            );
          }
        }
      } catch {
        // polling failures are non-fatal; the next tick retries
      } finally {
        busyRef.current = false;
      }
    };
    const iv = window.setInterval(() => void tick(), 15000);
    // first evaluation shortly after mount
    const initial = window.setTimeout(() => void tick(), 2500);
    return () => {
      window.clearInterval(iv);
      window.clearTimeout(initial);
    };
  }, []);

  return null;
}
