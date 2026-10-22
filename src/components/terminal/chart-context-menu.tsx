"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  BellOff,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { LINE_COLORS, type AlertDirection, type AlertItem } from "@/lib/types";
import type { Drawing } from "@/lib/drawings";
import { fmtPrice } from "@/lib/format";

// ---------------- context menu ----------------

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** render a thin separator above this item */
  separator?: boolean;
}

const DANGER_ITEM = "text-[#ef5350] hover:bg-[#ef5350]/15 hover:text-[#ef5350] focus-visible:bg-[#ef5350]/15 focus-visible:text-[#ef5350]";
const NORMAL_ITEM = "text-[#d1d4dc] hover:bg-white/5 hover:text-white focus-visible:bg-white/5 focus-visible:text-white";

/** Reusable row of color swatches (shared by the menu and both dialogs). */
export function ColorSwatchRow({
  colors = LINE_COLORS,
  active,
  onPick,
  label,
}: {
  colors?: readonly string[];
  active?: string | null;
  onPick: (color: string) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 px-2.5 py-1.5">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="menuitemradio"
          aria-checked={active === c}
          aria-label={`Color ${c}`}
          title={c}
          tabIndex={-1}
          onClick={() => onPick(c)}
          className={cn(
            "h-4 w-4 rounded-full border transition-transform outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] hover:scale-110",
            active === c ? "border-white/90 ring-2 ring-white/40" : "border-black/40"
          )}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

/**
 * TradingView-style chart context menu. Rendered into document.body with fixed
 * positioning (coords are clientX/clientY of the right-click). Closes on
 * Escape, click/press outside, wheel (chart pans under the cursor) and resize;
 * arrow keys move focus between items.
 */
export function ChartContextMenu({
  x,
  y,
  items,
  colors,
  activeColor,
  onPickColor,
  colorLabel = "Line color",
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  colors?: readonly string[];
  activeColor?: string | null;
  onPickColor?: (color: string) => void;
  colorLabel?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // clamp into the viewport once measured (layout effect → before paint, no flicker)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const ny = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    setPos((prev) => (prev.x === nx && prev.y === ny ? prev : { x: nx, y: ny }));
  }, [x, y]);

  // close on Escape / outside press / wheel / resize; focus the menu on open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
      const el = ref.current;
      if (!el) return;
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>("button[role='menuitem']:not(:disabled)")
      );
      if (!focusables.length) return;
      e.preventDefault();
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? focusables[(idx + 1) % focusables.length]
          : focusables[(idx - 1 + focusables.length) % focusables.length];
      next.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onWheel = () => onClose();
    window.addEventListener("keydown", onKey, true); // capture: wins over the chart's Escape handling
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    window.addEventListener("resize", onWheel);
    ref.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("resize", onWheel);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Chart context menu"
      tabIndex={-1}
      className="fixed z-[100] min-w-52 overflow-hidden rounded-lg border border-[#2a2e39] bg-[#1c202b]/98 py-1 font-sans text-[13px] shadow-2xl shadow-black/50 outline-none backdrop-blur"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separator && <div className="my-1 h-px bg-[#2a2e39]" role="separator" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#26a69a] disabled:cursor-not-allowed disabled:opacity-40",
              item.danger ? DANGER_ITEM : NORMAL_ITEM
            )}
          >
            {item.icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">{item.icon}</span>}
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        </div>
      ))}
      {onPickColor && (
        <>
          <div className="my-1 h-px bg-[#2a2e39]" role="separator" />
          <ColorSwatchRow active={activeColor} onPick={onPickColor} label={colorLabel} />
        </>
      )}
    </div>,
    document.body
  );
}

// ---------------- drawing properties dialog ----------------

/**
 * Properties for a drawing: color + (horizontal lines only) price.
 * `onChange` receives a patch; time/off anchors are left untouched.
 */
export function DrawingPropsDialog({
  drawing,
  onChange,
  onDelete,
  onClose,
}: {
  drawing: Drawing | null;
  onChange: (patch: { color?: string; price?: number }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [color, setColor] = useState<string>(drawing?.color ?? "#26a69a");
  const [price, setPrice] = useState<string>(() =>
    drawing && drawing.tool === "hline" ? String(Number(drawing.points[0].price.toFixed(4))) : ""
  );

  if (!drawing) return null;
  const isHline = drawing.tool === "hline";
  const parsed = Number(price);
  const priceValid = !isHline || (Number.isFinite(parsed) && parsed > 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xs gap-3 border-[#2a2e39] bg-[#1c202b] text-[#d1d4dc]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4 text-[#26a69a]" />
            {TOOL_LABELS[drawing.tool] ?? drawing.tool} properties
          </DialogTitle>
          <DialogDescription className="text-xs text-[#787b86]">
            {isHline ? "Change the line color and price level." : "Change the line color."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-[#b2b5be]">Color</Label>
            <ColorSwatchRow active={color} onPick={setColor} label="Line color" />
          </div>
          {isHline && (
            <div className="space-y-1.5">
              <Label htmlFor="drawing-price" className="text-xs font-medium text-[#b2b5be]">
                Price
              </Label>
              <Input
                id="drawing-price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-8 border-[#2a2e39] bg-[#131722] font-mono text-sm focus-visible:ring-[#26a69a]"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-[#ef5350] hover:bg-[#ef5350]/15 hover:text-[#ef5350]"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-[#2a2e39] px-3 text-xs text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!priceValid}
              className="h-8 bg-[#26a69a] px-3 text-xs font-semibold text-[#0d1017] hover:bg-[#2bbbad]"
              onClick={() => {
                const patch: { color?: string; price?: number } = { color };
                if (isHline && priceValid) patch.price = parsed;
                onChange(patch);
                onClose();
              }}
            >
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TOOL_LABELS: Record<string, string> = {
  hline: "Horizontal line",
  vline: "Vertical line",
  trend: "Trend line",
  ray: "Ray",
  rect: "Rectangle",
  fib: "Fib retracement",
  brush: "Freehand",
};

// ---------------- alert edit dialog ----------------

const DIR_BUTTONS: { value: AlertDirection; label: string; icon: React.ReactNode }[] = [
  { value: "above", label: "Above", icon: <ArrowUp className="h-3.5 w-3.5" /> },
  { value: "below", label: "Below", icon: <ArrowDown className="h-3.5 w-3.5" /> },
  { value: "cross", label: "Crossing", icon: <ArrowUpDown className="h-3.5 w-3.5" /> },
];

/** Edit an alert's price, direction and line color. */
export function AlertEditDialog({
  alert,
  onSave,
  onClose,
}: {
  alert: AlertItem | null;
  onSave: (patch: { price: number; direction: AlertDirection; color: string | null }) => void;
  onClose: () => void;
}) {
  const [price, setPrice] = useState<string>(() => (alert ? String(Number(alert.price.toFixed(4))) : ""));
  const [direction, setDirection] = useState<AlertDirection>(alert?.direction ?? "cross");
  const [color, setColor] = useState<string | null>(alert?.color ?? null);

  if (!alert) return null;
  const parsed = Number(price);
  const valid = Number.isFinite(parsed) && parsed > 0;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xs gap-3 border-[#2a2e39] bg-[#1c202b] text-[#d1d4dc]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4 text-[#f0b90b]" />
            Edit alert · {alert.symbol}
          </DialogTitle>
          <DialogDescription className="text-xs text-[#787b86]">
            Currently {fmtPrice(alert.price)} · {alert.active ? "active" : "paused"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="alert-edit-price" className="text-xs font-medium text-[#b2b5be]">
              Price
            </Label>
            <Input
              id="alert-edit-price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="h-8 border-[#2a2e39] bg-[#131722] font-mono text-sm focus-visible:ring-[#26a69a]"
            />
          </div>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Alert condition">
            {DIR_BUTTONS.map((d) => (
              <button
                key={d.value}
                type="button"
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
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-[#b2b5be]">Line color</Label>
            <ColorSwatchRow active={color} onPick={setColor} label="Alert line color" />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-[#2a2e39] px-3 text-xs text-[#b2b5be] hover:bg-[#2a2e39] hover:text-white"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!valid}
            className="h-8 bg-[#26a69a] px-3 text-xs font-semibold text-[#0d1017] hover:bg-[#2bbbad]"
            onClick={() => {
              if (!valid) return;
              onSave({ price: parsed, direction, color });
              onClose();
            }}
          >
            <Pencil className="h-3.5 w-3.5" /> Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shared icon set for menu rows (kept here so callers stay tidy). */
export const MENU_ICONS = {
  bell: <Bell className="h-4 w-4" />,
  bellOff: <BellOff className="h-4 w-4" />,
  edit: <Pencil className="h-4 w-4" />,
  props: <SlidersHorizontal className="h-4 w-4" />,
  trash: <Trash2 className="h-4 w-4" />,
} as const;
