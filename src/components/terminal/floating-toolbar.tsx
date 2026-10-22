"use client";

import { useEffect, useRef, useState } from "react";
import { GripVertical, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Floating chart toolbar: draggable by its grip, collapsible to a small pill,
 * and semi-transparent while idle so chart values behind stay readable.
 * Position + collapsed state persist to localStorage (per toolbar id).
 */

interface FloatState {
  x?: number;
  y?: number;
  collapsed?: boolean;
}

const LS_KEY = "fluxview.float.v1";

function loadState(id: string): FloatState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, FloatState>;
    const s = all[id];
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function saveState(id: string, patch: FloatState): void {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(LS_KEY) ?? "{}") as Record<string, FloatState>;
    all[id] = { ...(all[id] ?? {}), ...patch };
    window.localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    // ignore storage errors
  }
}

interface FloatingToolbarProps {
  /** persistence key, unique per toolbar */
  id: string;
  /** accessible name / tooltip base */
  label: string;
  /** icon shown on the collapsed pill */
  icon: React.ReactNode;
  /** tailwind classes anchoring the default (never-dragged) position */
  anchorClass: string;
  /** extra classes for the expanded panel body */
  className?: string;
  children: React.ReactNode;
}

export function FloatingToolbar({ id, label, icon, anchorClass, className, children }: FloatingToolbarProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragInfo = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);

  // restore persisted position/collapse after mount (post-hydration, no SSR
  // mismatch; deferred via setTimeout to satisfy react-hooks set-state-in-effect).
  // Restored positions are clamped into the parent bounds so a position saved
  // on a wide desktop can't push the toolbar off a narrow chart.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const s = loadState(id);
      if (!s) return;
      if (typeof s.x === "number" && typeof s.y === "number") {
        const el = rootRef.current;
        const parent = el?.offsetParent as HTMLElement | null;
        const maxX = parent ? Math.max(0, parent.clientWidth - (el?.offsetWidth ?? 0)) : s.x;
        const maxY = parent ? Math.max(0, parent.clientHeight - (el?.offsetHeight ?? 0)) : s.y;
        const p = { x: Math.min(Math.max(s.x, 0), maxX), y: Math.min(Math.max(s.y, 0), maxY) };
        posRef.current = p;
        setPos(p);
        if (p.x !== s.x || p.y !== s.y) saveState(id, { x: p.x, y: p.y });
      }
      if (s.collapsed === true) setCollapsed(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, [id]);

  const applyPos = (p: { x: number; y: number } | null) => {
    posRef.current = p;
    setPos(p);
  };

  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = rootRef.current;
    if (!el || e.button !== 0) return;
    const parent = el.offsetParent as HTMLElement | null;
    const pr = parent?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const ox = pr ? r.left - pr.left : r.left;
    const oy = pr ? r.top - pr.top : r.top;
    dragInfo.current = { sx: e.clientX, sy: e.clientY, ox, oy };
    applyPos({ x: ox, y: oy });
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const di = dragInfo.current;
    const el = rootRef.current;
    if (!di || !el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const pr = parent?.getBoundingClientRect();
    const maxX = pr ? pr.width - el.offsetWidth : window.innerWidth - el.offsetWidth;
    const maxY = pr ? pr.height - el.offsetHeight : window.innerHeight - el.offsetHeight;
    applyPos({
      x: Math.min(Math.max(di.ox + (e.clientX - di.sx), 0), Math.max(0, maxX)),
      y: Math.min(Math.max(di.oy + (e.clientY - di.sy), 0), Math.max(0, maxY)),
    });
  };

  const onGripUp = () => {
    if (!dragInfo.current) return;
    dragInfo.current = null;
    setDragging(false);
    if (posRef.current) saveState(id, { x: posRef.current.x, y: posRef.current.y });
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    saveState(id, { collapsed: next });
  };

  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute z-10 select-none",
        pos ? "" : anchorClass,
        collapsed
          ? "opacity-80 transition-opacity duration-200 hover:opacity-100"
          : dragging
            ? "opacity-100"
            : "opacity-50 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100"
      )}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      {collapsed ? (
        <button
          type="button"
          title={`Show ${label}`}
          aria-label={`Show ${label}`}
          onClick={toggleCollapsed}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border border-[#2a2e39] bg-[#1e222d]/85 text-[#b2b5be] shadow-lg backdrop-blur transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] hover:text-white",
            className?.includes("flex-row") ? "" : ""
          )}
        >
          {icon}
        </button>
      ) : (
        <div
          className={cn(
            "flex-col gap-0.5 rounded-lg border border-[#2a2e39] bg-[#1e222d]/75 p-1 shadow-lg backdrop-blur-sm",
            "flex",
            className
          )}
          role="toolbar"
          aria-label={label}
        >
          <button
            type="button"
            title={`Move ${label}`}
            aria-label={`Move ${label}`}
            className="flex h-5 w-7 cursor-grab touch-none items-center justify-center rounded text-[#787b86] outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] hover:text-white active:cursor-grabbing"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          {children}
          <div className="my-0.5 h-px bg-[#2a2e39]/70" role="separator" />
          <button
            type="button"
            title={`Hide ${label}`}
            aria-label={`Hide ${label}`}
            onClick={toggleCollapsed}
            className="flex h-5 w-7 items-center justify-center rounded text-[#787b86] outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] hover:bg-white/5 hover:text-white"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
