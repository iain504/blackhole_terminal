"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type LineSeriesOptions,
  type Logical,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import {
  ArrowUpDown,
  ArrowUpRight,
  Bell,
  Brush,
  Eraser,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  MoveVertical,
  PenTool,
  Plus,
  RefreshCw,
  Ruler,
  Slash,
  Square,
  Trash2,
  TriangleAlert,
  ZoomIn,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/hooks/use-poll";
import { fetchBars, fetchEarnings, fetchNews, fetchSnapshots } from "@/lib/client-api";
import {
  DRAW_COLORS,
  FIB_LEVELS,
  drawingKey,
  hitTestDrawings,
  loadDrawingStore,
  persistDrawingStore,
  setDrawingResetHook,
  type DrawAnchor,
  type DrawHit,
  type DrawShape,
  type DrawTool,
  type Drawing,
  type Pt,
} from "@/lib/drawings";
import { DOWN_COLOR, UP_COLOR, fmtPrice, fmtVolume } from "@/lib/format";
import { isCryptoSymbol } from "@/lib/symbols";
import {
  INDICATORS as INDICATORS_META,
  bollinger,
  ema,
  macd as macdCalc,
  rsi as rsiCalc,
  sma,
  vwap as vwapCalc,
  type IndicatorKey,
  type LegendMaps,
} from "@/lib/indicators";
import { useTerminal, noteUserStateDirty, type ChartFrame } from "@/lib/store";
import { INTRADAY_TFS, LINE_COLORS, type Bar, type Timeframe } from "@/lib/types";
import { FloatingToolbar } from "@/components/terminal/floating-toolbar";
import {
  AlertEditDialog,
  ChartContextMenu,
  DrawingPropsDialog,
  MENU_ICONS,
  type MenuItem,
} from "@/components/terminal/chart-context-menu";
import { cn } from "@/lib/utils";

const GRID_COLOR = "rgba(42, 46, 57, 0.55)";
const BORDER_COLOR = "#1c202b";

interface LegendValues {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  prev: number | null;
}

type AnySeries = ISeriesApi<"Line"> | ISeriesApi<"Histogram">;

function toTime(b: Bar): Time {
  return b.time as Time;
}

function tk(time: number | string): string {
  return typeof time === "string" ? time : String(time);
}

// ---------------- earnings + news markers ----------------

/** Bar width in seconds for intraday timeframes (news → bar mapping). */
const TF_SEC: Partial<Record<Timeframe, number>> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
};

const ET_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ET calendar date "YYYY-MM-DD" of a unix-second timestamp. */
function etDateOf(unixSec: number): string {
  return ET_DATE_FMT.format(new Date(unixSec * 1000));
}

/** Monday of the week containing `dateStr` (matches the weekly bar buckets). */
function weekMonday(dateStr: string): string {
  const dt = new Date(`${dateStr}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** Which bar a date lands on for this timeframe: daily bars are keyed by the
 *  date itself, weekly by the week's Monday, monthly by "YYYY-MM". */
function bucketKey(dateStr: string, tf: Timeframe): string {
  if (tf === "1M") return dateStr.slice(0, 7);
  if (tf === "1W") return weekMonday(dateStr);
  return dateStr;
}

/** The intraday bar whose window contains `t` (bars ascending), else null —
 *  equivalent to floor(t/tfSec)*tfSec on aligned grids and also correct for
 *  session-offset windows like 4h bars opening 13:30 ET. */
function barWindowAt(times: number[], t: number, tfSec: number): number | null {
  let lo = 0;
  let hi = times.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === -1 || t - times[idx] >= tfSec) return null;
  return times[idx];
}

// ---------------- drawing canvas ----------------

function drawShape(
  ctx: CanvasRenderingContext2D,
  tool: DrawShape,
  pts: Pt[],
  color: string,
  w: number,
  h: number,
  label: string | undefined,
  opts?: {
    selected?: boolean;
    draft?: boolean;
    fibPrices?: { a: number; b: number };
  }
): void {
  if (pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = opts?.selected ? 2 : 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (opts?.selected) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
  }
  if (opts?.draft) ctx.setLineDash([5, 4]);

  switch (tool) {
    case "hline": {
      ctx.beginPath();
      ctx.moveTo(0, pts[0].y);
      ctx.lineTo(w, pts[0].y);
      ctx.stroke();
      if (label) {
        ctx.setLineDash([]);
        ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(19, 23, 34, 0.9)";
        ctx.fillRect(w - tw - 12, pts[0].y - 15, tw + 8, 13);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(w - tw - 12, pts[0].y - 15, tw + 8, 13);
        ctx.fillStyle = color;
        ctx.fillText(label, w - tw - 8, pts[0].y - 5);
      }
      break;
    }
    case "vline":
      ctx.beginPath();
      ctx.moveTo(pts[0].x, 0);
      ctx.lineTo(pts[0].x, h);
      ctx.stroke();
      break;
    case "trend":
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      break;
    case "ray": {
      if (pts.length < 2) break;
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const len = Math.hypot(dx, dy) || 1;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[0].x + (dx / len) * (w + h), pts[0].y + (dy / len) * (w + h));
      ctx.stroke();
      break;
    }
    case "rect": {
      if (pts.length < 2) break;
      const x = Math.min(pts[0].x, pts[1].x);
      const y = Math.min(pts[0].y, pts[1].y);
      const rw = Math.abs(pts[1].x - pts[0].x);
      const rh = Math.abs(pts[1].y - pts[0].y);
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillRect(x, y, rw, rh);
      ctx.restore();
      ctx.strokeRect(x, y, rw, rh);
      break;
    }
    case "brush": {
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      break;
    }
    case "fib": {
      if (pts.length < 2) break;
      const x1 = Math.min(pts[0].x, pts[1].x);
      const x2 = Math.max(pts[0].x, pts[1].x);
      const span = Math.max(x2 - x1, 78);
      // subtle A→B swing connector
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      ctx.restore();
      ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
      const fb = opts?.fibPrices;
      for (const { level, color: lc } of FIB_LEVELS) {
        const ly = pts[1].y + level * (pts[0].y - pts[1].y);
        ctx.strokeStyle = lc;
        ctx.fillStyle = lc;
        ctx.lineWidth = opts?.selected ? 1.7 : 1.1;
        ctx.beginPath();
        ctx.moveTo(x1, ly);
        ctx.lineTo(x1 + span, ly);
        ctx.stroke();
        const price = fb ? fb.b + level * (fb.a - fb.b) : null;
        const text = price != null ? `${level.toFixed(3)}  ${fmtPrice(price)}` : level.toFixed(3);
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = "rgba(19, 23, 34, 0.85)";
        ctx.fillRect(x1 + span - tw - 9, ly - 13.5, tw + 7, 12);
        ctx.fillStyle = lc;
        ctx.fillText(text, x1 + span - tw - 5.5, ly - 4);
      }
      break;
    }
  }

  // endpoint handles
  if ((opts?.selected || opts?.draft) && tool !== "brush") {
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "#131722";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }
  ctx.restore();
}

interface Draft {
  tool: DrawShape;
  points: { anchor: DrawAnchor; pt: Pt }[];
  cursorPt: Pt | null;
  brushing: boolean;
}

/** In-progress move/resize of a committed drawing (cursor tool). */
interface DragEdit {
  id: string;
  tool: DrawShape;
  color: string;
  mode: "body" | "handle";
  handleIdx: number;
  startPt: Pt;
  origPts: Pt[];
  origAnchors: DrawAnchor[];
  /** current screen points (mutated while dragging) */
  pts: Pt[];
  /** current anchors (mutated while dragging) */
  anchors: DrawAnchor[];
}

/** What a right-click landed on (drives the chart context menu). */
type MenuTarget =
  | { kind: "drawing"; id: string; tool: DrawShape; hitPrice: number }
  | { kind: "alert"; id: string }
  | { kind: "empty"; price: number };

const SUB_KEYS: readonly IndicatorKey[] = ["rsi", "macd"];

const DRAW_TOOLS: { key: DrawTool; label: string; icon: React.ReactNode }[] = [
  { key: "cursor", label: "Cursor · select (Esc)", icon: <MousePointer2 className="h-4 w-4" /> },
  { key: "trend", label: "Trend line", icon: <Slash className="h-4 w-4" /> },
  { key: "ray", label: "Ray", icon: <ArrowUpRight className="h-4 w-4" /> },
  { key: "hline", label: "Horizontal line", icon: <Minus className="h-4 w-4" /> },
  { key: "vline", label: "Vertical line", icon: <MoveVertical className="h-4 w-4" /> },
  { key: "rect", label: "Rectangle", icon: <Square className="h-4 w-4" /> },
  { key: "fib", label: "Fib retracement", icon: <Ruler className="h-4 w-4" /> },
  { key: "brush", label: "Freehand", icon: <Brush className="h-4 w-4" /> },
];

const TOOL_HINTS: Record<DrawShape, string> = {
  trend: "Click two points to draw a trend line",
  ray: "Click two points to draw a ray",
  hline: "Click to place a horizontal line",
  vline: "Click to place a vertical line",
  rect: "Click two corners to draw a rectangle",
  fib: "Click swing start, then swing end to draw Fibonacci retracement",
  brush: "Drag to draw freehand",
};

const ctlBtn =
  "flex h-7 w-7 items-center justify-center rounded-md text-[#b2b5be] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30";
const toolBtn =
  "flex h-7 w-7 items-center justify-center rounded-md text-[#b2b5be] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#26a69a] hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 aria-pressed:bg-[#26a69a]/15 aria-pressed:text-[#26a69a]";

// module-level drawing store (survives remounts; persisted to localStorage on change)
let drawingStoreSingleton: Record<string, Drawing[]> | null = null;
function getDrawingStore(): Record<string, Drawing[]> {
  if (!drawingStoreSingleton) drawingStoreSingleton = loadDrawingStore();
  return drawingStoreSingleton;
}
// the per-user state sync wipes the cache after pulling a saved blob from the server
setDrawingResetHook(() => {
  drawingStoreSingleton = null;
});

/** Cross-instance sync: multiple chart frames can show the same symbol|tf. */
const DRAWINGS_EVENT = "fluxview:drawings";
interface DrawingsEventDetail {
  key: string;
  sourceId: string;
}
let panelSeq = 0;

interface ChartPanelProps {
  /** per-frame symbol + timeframe (multi-chart layouts) */
  frame: ChartFrame;
  /** only the active frame responds to keyboard shortcuts */
  active: boolean;
}

export function ChartPanel({ frame, active }: ChartPanelProps) {
  const { symbol, timeframe } = frame;
  const chartType = useTerminal((s) => s.chartType);
  const indicators = useTerminal((s) => s.indicators);
  const drawTool = useTerminal((s) => s.drawTool);
  const alerts = useTerminal((s) => s.alerts);
  const updateAlert = useTerminal((s) => s.updateAlert);
  const removeAlert = useTerminal((s) => s.removeAlert);
  // active alerts on THIS symbol render as dashed price lines
  const frameAlerts = useMemo(() => alerts.filter((a) => a.active && a.symbol === symbol), [alerts, symbol]);

  const { data, error, loading, refresh } = usePoll(
    () => fetchBars(symbol, timeframe),
    20000,
    [symbol, timeframe]
  );
  const { data: snapData } = usePoll(() => fetchSnapshots([symbol]), 30000, [symbol]);
  // news + earnings feed the [E]/⚡ x-axis markers. Payloads are tagged with the
  // symbol they were fetched for: polls reset on symbol change, but a slow or
  // failed response must never paint the previous symbol's events onto the new
  // chart. Crypto has no earnings — resolve null, no request at all.
  const { data: newsTagged } = usePoll(
    () => fetchNews(symbol).then((d) => ({ sym: symbol, news: d.news })),
    60000,
    [symbol]
  );
  const { data: earningsTagged } = usePoll(
    () =>
      isCryptoSymbol(symbol)
        ? Promise.resolve(null)
        : fetchEarnings(symbol).then((d) => ({ sym: symbol, events: d.events })),
    300000,
    [symbol]
  );

  const bars = data?.bars ?? null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | ISeriesApi<"Area"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // markers plugin ([E] earnings / ⚡ news) — attached to the main series, so it
  // is created/destroyed alongside it when the chart type changes
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const alertLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const barsRef = useRef<Bar[] | null>(null);
  const keyRef = useRef<string>("");
  const chartTypeRef = useRef(chartType);
  const frameRef = useRef(frame);

  // indicator runtime
  const indSeriesRef = useRef<Map<IndicatorKey, AnySeries[]>>(new Map());
  const indLegendRef = useRef<LegendMaps>(new Map());

  // drawing runtime — a module-level store backs the per-symbol|tf lists
  const drawingsRef = useRef<Drawing[]>([]);
  const draftRef = useRef<Draft | null>(null);
  const selectedRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const drawToolRef = useRef<DrawTool>(drawTool);
  // move/resize of a committed drawing + whether the overlay canvas captures
  // the pointer in cursor mode (only while hovering a drawing)
  const dragRef = useRef<DragEdit | null>(null);
  const [interactive, setInteractive] = useState(false);

  // right-click menu: what was hit + where to show it (portal-rendered)
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [propsId, setPropsId] = useState<string | null>(null); // drawing properties dialog
  const [editAlertId, setEditAlertId] = useState<string | null>(null); // alert edit dialog

  const [logScale, setLogScale] = useState(false);

  // drawings live in state, keyed by symbol|timeframe; switching keys resets via
  // the render-adjustment pattern (no setState-in-effect needed)
  const dKey = drawingKey(symbol, timeframe);
  // First render uses an empty list so SSR and client hydration match exactly;
  // persisted drawings load in an effect after mount (never read during render).
  const [drawState, setDrawState] = useState<{ key: string; list: Drawing[]; selected: string | null; loaded: boolean }>({
    key: dKey,
    list: [],
    selected: null,
    loaded: false,
  });
  if (drawState.key !== dKey) {
    setDrawState({ key: dKey, list: getDrawingStore()[dKey] ?? [], selected: null, loaded: true });
  }
  const drawings = drawState.list;
  const selectedId = drawState.selected;

  // 5b) load persisted drawings for the current key once after mount.
  // Deferred via setTimeout so the first committed render matches SSR exactly
  // (no hydration mismatch) and to satisfy react-hooks set-state-in-effect.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDrawState((prev) => {
        if (prev.loaded) return prev;
        return { ...prev, list: getDrawingStore()[prev.key] ?? [], loaded: true };
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  // auto-scale button derives from the chart key, so a symbol/timeframe switch
  // resets it to true without an effect
  const chartKey = `${symbol}|${timeframe}`;
  const [scaleUi, setScaleUi] = useState<{ key: string; auto: boolean }>({ key: "", auto: true });
  const autoScale = scaleUi.key === chartKey ? scaleUi.auto : true;

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);
  useEffect(() => {
    chartTypeRef.current = chartType;
  }, [chartType]);
  useEffect(() => {
    drawToolRef.current = drawTool;
  }, [drawTool]);

  // ---------------- coordinate projection ----------------

  const project = useCallback((a: DrawAnchor): Pt | null => {
    const chart = chartRef.current;
    const main = mainRef.current;
    const bs = barsRef.current;
    if (!chart || !main || !bs || !bs.length) return null;
    const ts = chart.timeScale();
    let x: number | null = null;
    if (a.time != null) x = ts.timeToCoordinate(a.time as Time) ?? null;
    if (x == null && a.off != null) x = ts.logicalToCoordinate((bs.length - 1 + a.off) as Logical) ?? null;
    if (x == null) return null;
    const y = main.priceToCoordinate(a.price) ?? null;
    if (y == null) return null;
    return { x, y };
  }, []);

  // ---------------- legend ----------------

  const updateLegend = useCallback((lv: LegendValues | null) => {
    const el = legendRef.current;
    const bs = barsRef.current;
    if (!el) return;
    if (!bs || bs.length === 0) {
      el.innerHTML = "";
      return;
    }
    let v = lv;
    if (!v) {
      const last = bs[bs.length - 1];
      const prev = bs.length > 1 ? bs[bs.length - 2].close : last.open;
      v = {
        time: last.time,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
        volume: last.volume,
        prev,
      };
    }
    const chg = v.prev ? v.close - v.prev : 0;
    const chgPct = v.prev ? (chg / v.prev) * 100 : 0;
    const color = chg > 0 ? UP_COLOR : chg < 0 ? DOWN_COLOR : "#787b86";
    const num = (n: number) => `<span style="color:${color}">${fmtPrice(n)}</span>`;
    const fr = frameRef.current;
    let html =
      `<span style="font-weight:700;color:#fff;font-size:13px">${fr.symbol}</span>` +
      `<span style="color:#787b86">&nbsp;· ${fr.timeframe} ·&nbsp;</span>` +
      `<span style="color:#787b86">O&nbsp;</span>${num(v.open)}` +
      `<span style="color:#787b86">&nbsp;H&nbsp;</span>${num(v.high)}` +
      `<span style="color:#787b86">&nbsp;L&nbsp;</span>${num(v.low)}` +
      `<span style="color:#787b86">&nbsp;C&nbsp;</span>${num(v.close)}` +
      (v.prev
        ? `<span style="color:${color}">&nbsp;${chg >= 0 ? "+" : ""}${fmtPrice(chg)} (${chg >= 0 ? "+" : ""}${chgPct.toFixed(2)}%)</span>`
        : "") +
      (v.volume != null
        ? `<span style="color:#787b86">&nbsp;Vol&nbsp;${fmtVolume(v.volume)}</span>`
        : "");

    // indicator values at the hovered bar
    const maps = indLegendRef.current;
    let row2 = "";
    for (const m of INDICATORS_META) {
      const vals = maps.get(m.key)?.get(tk(v.time));
      if (!vals || vals.some((x) => !Number.isFinite(x))) continue;
      const txt = vals.length === 1 ? fmtPrice(vals[0]) : vals.map((x) => fmtPrice(x)).join(" / ");
      row2 += `<span style="color:${m.color};margin-right:10px">${m.short}&nbsp;${txt}</span>`;
    }
    if (row2) html += `<div style="margin-top:2px">${row2}</div>`;
    el.innerHTML = html;
  }, []);

  // ---------------- data application ----------------

  const applyData = useCallback(
    (bs: Bar[]) => {
      const main = mainRef.current;
      const vol = volRef.current;
      const chart = chartRef.current;
      if (!main || !vol || !chart) return;
      const intraday = INTRADAY_TFS.has(frameRef.current.timeframe);
      const data = bs.map((b) => ({
        time: toTime(b),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }));
      const volData: HistogramData[] = bs.map((b) => ({
        time: toTime(b),
        value: b.volume,
        color: b.close >= b.open ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)",
      }));

      chart.applyOptions({
        timeScale: { timeVisible: intraday, secondsVisible: false },
      });

      if (chartTypeRef.current === "candles") {
        (main as ISeriesApi<"Candlestick">).setData(data as CandlestickData[]);
      } else {
        (main as ISeriesApi<"Line">).setData(bs.map((b) => ({ time: toTime(b), value: b.close })) as LineData[]);
      }
      vol.setData(volData);
      updateLegend(null);
    },
    [updateLegend]
  );

  const computeIndicators = useCallback((bs: Bar[]) => {
    const ind = indSeriesRef.current;
    const maps: LegendMaps = new Map();
    const set1 = (key: IndicatorKey, pts: { time: Bar["time"]; value: number }[]) => {
      const list = ind.get(key);
      if (list?.length) list[0].setData(pts.map((p) => ({ time: p.time as Time, value: p.value })));
    };
    for (const key of Array.from(ind.keys())) {
      switch (key) {
        case "sma20": {
          const pts = sma(bs, 20);
          set1(key, pts);
          maps.set(key, new Map(pts.map((p) => [tk(p.time), [p.value]])));
          break;
        }
        case "sma50": {
          const pts = sma(bs, 50);
          set1(key, pts);
          maps.set(key, new Map(pts.map((p) => [tk(p.time), [p.value]])));
          break;
        }
        case "ema20": {
          const pts = ema(bs, 20);
          set1(key, pts);
          maps.set(key, new Map(pts.map((p) => [tk(p.time), [p.value]])));
          break;
        }
        case "vwap": {
          const pts = vwapCalc(bs);
          set1(key, pts);
          maps.set(key, new Map(pts.map((p) => [tk(p.time), [p.value]])));
          break;
        }
        case "rsi": {
          const pts = rsiCalc(bs, 14);
          set1(key, pts);
          maps.set(key, new Map(pts.map((p) => [tk(p.time), [p.value]])));
          break;
        }
        case "bb": {
          const bb = bollinger(bs, 20, 2);
          const list = ind.get(key);
          if (list?.length === 3) {
            list[0].setData(bb.upper.map((p) => ({ time: p.time as Time, value: p.value })));
            list[1].setData(bb.mid.map((p) => ({ time: p.time as Time, value: p.value })));
            list[2].setData(bb.lower.map((p) => ({ time: p.time as Time, value: p.value })));
          }
          maps.set(key, new Map(bb.mid.map((p, i) => [tk(p.time), [bb.upper[i].value, p.value, bb.lower[i].value]])));
          break;
        }
        case "macd": {
          const m = macdCalc(bs);
          const list = ind.get(key);
          if (list?.length === 3) {
            list[0].setData(
              m.hist
                .filter((p) => Number.isFinite(p.value))
                .map((p) => ({
                  time: p.time as Time,
                  value: p.value,
                  color: p.value >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
                }))
            );
            list[1].setData(m.line.map((p) => ({ time: p.time as Time, value: p.value })));
            list[2].setData(
              m.signal
                .filter((p) => Number.isFinite(p.value))
                .map((p) => ({ time: p.time as Time, value: p.value }))
            );
          }
          maps.set(
            key,
            new Map(m.line.map((p, i) => [tk(p.time), [p.value, m.signal[i]?.value ?? NaN, m.hist[i]?.value ?? NaN]]))
          );
          break;
        }
      }
    }
    indLegendRef.current = maps;
    updateLegend(null);
  }, [updateLegend]);

  // ---------------- indicator series lifecycle ----------------

  const createIndicatorSeries = useCallback((chart: IChartApi, key: IndicatorKey, paneIndex: number): void => {
    const line = (color: string, extra?: Partial<LineSeriesOptions>) =>
      chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...extra,
        },
        paneIndex
      );
    let list: AnySeries[];
    switch (key) {
      case "sma20":
        list = [line("#f0b90b")];
        break;
      case "sma50":
        list = [line("#e056fd")];
        break;
      case "ema20":
        list = [line("#ff9800")];
        break;
      case "vwap":
        list = [line("#e91e63")];
        break;
      case "bb":
        list = [line("#4dd0e1"), line("#787b86", { lineStyle: LineStyle.Dashed }), line("#4dd0e1")];
        break;
      case "rsi": {
        const s = line("#b39ddb");
        for (const lvl of [70, 30]) {
          s.createPriceLine({
            price: lvl,
            color: "#5d606b",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "",
          });
        }
        list = [s];
        break;
      }
      case "macd": {
        const h = chart.addSeries(
          HistogramSeries,
          {
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            priceLineVisible: false,
            lastValueVisible: false,
          },
          paneIndex
        );
        const ml = line("#26a69a");
        ml.createPriceLine({
          price: 0,
          color: "#3a3e4c",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: false,
          title: "",
        });
        const sl = line("#f0b90b");
        list = [h, ml, sl];
        break;
      }
      default:
        return;
    }
    indSeriesRef.current.set(key, list);
  }, []);

  const removeIndicatorSeries = useCallback((chart: IChartApi, key: IndicatorKey): void => {
    const list = indSeriesRef.current.get(key);
    if (!list) return;
    for (const s of list) {
      try {
        chart.removeSeries(s);
      } catch {
        // already removed
      }
    }
    indSeriesRef.current.delete(key);
  }, []);

  // 1) create chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa0b0",
        fontSize: 11,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#758696", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#2a2e39" },
        horzLine: { color: "#758696", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#2a2e39" },
      },
      rightPriceScale: {
        borderColor: BORDER_COLOR,
        scaleMargins: { top: 0.08, bottom: 0.24 },
        autoScale: true,
      },
      timeScale: {
        borderColor: BORDER_COLOR,
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: true,
      },
    });
    chartRef.current = chart;

    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = vol;

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const bs = barsRef.current;
      if (!param.time || !param.point || !bs || !bs.length) {
        updateLegend(null);
        hoverRef.current = null;
        return;
      }
      const idx = bs.findIndex((b) => String(b.time) === String(param.time));
      const main = mainRef.current;
      const d = main
        ? (param.seriesData.get(main) as CandlestickData<Time> | LineData<Time> | undefined)
        : undefined;
      const volD = volRef.current
        ? (param.seriesData.get(volRef.current) as HistogramData<Time> | undefined)
        : undefined;
      if (idx === -1 || !d) {
        updateLegend(null);
        hoverRef.current = null;
        return;
      }
      const close = "close" in d ? d.close : (d.value ?? 0);
      const open = "open" in d ? d.open : close;
      const high = "high" in d ? d.high : close;
      const low = "low" in d ? d.low : close;
      const prev = idx > 0 ? bs[idx - 1].close : null;
      updateLegend({
        time: bs[idx].time,
        open,
        high,
        low,
        close,
        volume: volD?.value ?? bs[idx].volume,
        prev,
      });
      // hover-highlight drawings in cursor mode; while hovering one, the
      // overlay canvas takes over the pointer so drawings can be grabbed
      hoverRef.current = null;
      if (drawToolRef.current === "cursor") {
        const hit = hitTestDrawings(param.point.x, param.point.y, drawingsRef.current, project);
        hoverRef.current = hit?.id ?? null;
        if (hit && !dragRef.current) {
          setInteractive(true);
          canvasRef.current?.style.setProperty(
            "cursor",
            hit.handle != null ? "grab" : "move"
          );
        }
      }
    };
    chart.subscribeCrosshairMove(onCrosshair);

    // click-to-select drawings (cursor mode, canvas not capturing the pointer)
    chart.subscribeClick((param) => {
      if (drawToolRef.current !== "cursor" || !param.point) return;
      const hit = hitTestDrawings(param.point.x, param.point.y, drawingsRef.current, project);
      const id = hit?.id ?? null;
      selectedRef.current = id;
      setDrawState((prev) => (prev.selected === id ? prev : { ...prev, selected: id }));
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
      markersApiRef.current = null;
      priceLineRef.current = null;
      indSeriesRef.current.clear();
      draftRef.current = null;
      hoverRef.current = null;
      selectedRef.current = null;
      dragRef.current = null;
    };
  }, [updateLegend, project]);

  // 1b) indicator series lifecycle — declared AFTER chart creation so the chart
  // exists on first mount (persisted indicator prefs restore panes correctly).
  // Overlay series managed individually; sub-pane series rebuilt as a set.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const intraday = INTRADAY_TFS.has(timeframe);
    const active = INDICATORS_META.filter((m) => indicators[m.key] && (!m.intradayOnly || intraday));
    const desired = new Set(active.map((m) => m.key));

    for (const key of Array.from(indSeriesRef.current.keys())) {
      const isSub = SUB_KEYS.includes(key);
      if (!desired.has(key) && !isSub) removeIndicatorSeries(chart, key);
    }

    const desiredSubs = active.filter((m) => m.pane === "sub").map((m) => m.key);
    const currentSubs = Array.from(indSeriesRef.current.keys()).filter((k) => SUB_KEYS.includes(k));
    if (currentSubs.join(",") !== desiredSubs.join(",")) {
      for (const k of currentSubs) removeIndicatorSeries(chart, k);
      for (let i = chart.panes().length - 1; i >= 1; i--) {
        try {
          chart.removePane(i);
        } catch {
          // pane not empty — ignore
        }
      }
      desiredSubs.forEach((k, idx) => createIndicatorSeries(chart, k, idx + 1));
    }

    for (const m of active) {
      if (m.pane === "overlay" && !indSeriesRef.current.has(m.key)) createIndicatorSeries(chart, m.key, 0);
    }

    // main pane dominates; sub panes share the rest equally
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 4 : 1));

    if (barsRef.current) computeIndicators(barsRef.current);
  }, [indicators, timeframe, createIndicatorSeries, removeIndicatorSeries, computeIndicators]);

  // 2) (re)create main series when chart type changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (mainRef.current) {
      if (priceLineRef.current) {
        try {
          mainRef.current.removePriceLine(priceLineRef.current);
        } catch {
          // series already removed
        }
        priceLineRef.current = null;
      }
      if (markersApiRef.current) {
        try {
          markersApiRef.current.detach();
        } catch {
          // plugin already gone with the series
        }
        markersApiRef.current = null;
      }
      chart.removeSeries(mainRef.current);
      mainRef.current = null;
    }
    let series: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;
    if (chartType === "candles") {
      series = chart.addSeries(CandlestickSeries, {
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        borderUpColor: UP_COLOR,
        borderDownColor: DOWN_COLOR,
        wickUpColor: UP_COLOR,
        wickDownColor: DOWN_COLOR,
        priceLineVisible: false,
      });
    } else if (chartType === "line") {
      series = chart.addSeries(LineSeries, {
        color: "#b2b5be",
        lineWidth: 2,
        priceLineVisible: false,
      });
    } else {
      series = chart.addSeries(AreaSeries, {
        lineColor: UP_COLOR,
        topColor: "rgba(38,166,154,0.30)",
        bottomColor: "rgba(38,166,154,0.02)",
        lineWidth: 2,
        priceLineVisible: false,
      });
    }
    mainRef.current = series;
    // markers live on the main series — recreate the plugin with it
    markersApiRef.current = createSeriesMarkers(series, []);
    if (barsRef.current) applyData(barsRef.current);
  }, [chartType, applyData]);

  // 3) apply data when bars / symbol / timeframe / indicators change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars) return;
    barsRef.current = bars;
    const key = `${symbol}|${timeframe}`;
    const keyChanged = keyRef.current !== key;
    keyRef.current = key;
    applyData(bars);
    computeIndicators(bars);
    if (keyChanged) {
      chart.timeScale().fitContent();
      chart.priceScale("right").applyOptions({ autoScale: true });
      // re-fit once the frame settles so newly-created pane series / layout
      // changes cannot leave the range mismatched
      const ts = chart.timeScale();
      requestAnimationFrame(() => {
        try {
          ts.fitContent();
        } catch {
          // chart already removed
        }
      });
    }
  }, [bars, symbol, timeframe, indicators, applyData, computeIndicators]);

  // 4) previous-close price line from snapshot
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (priceLineRef.current) {
      try {
        main.removePriceLine(priceLineRef.current);
      } catch {
        // ignore
      }
      priceLineRef.current = null;
    }
    const snap = snapData?.snapshots[symbol];
    if (snap?.prevClose && bars && bars.length) {
      try {
        priceLineRef.current = main.createPriceLine({
          price: snap.prevClose,
          color: "#787b86",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "PC",
        });
      } catch {
        // ignore
      }
    }
  }, [snapData, symbol, chartType, bars]);

  // 4b) dashed price lines for this symbol's active alerts (bell marker on axis)
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const existing = alertLinesRef.current;
    for (const [, line] of existing) {
      try {
        main.removePriceLine(line);
      } catch {
        // series already removed
      }
    }
    existing.clear();
    for (const a of frameAlerts) {
      try {
        existing.set(
          a.id,
          main.createPriceLine({
            price: a.price,
            color: a.color ?? "#f0b90b",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `🔔 ${a.direction === "above" ? "≥" : a.direction === "below" ? "≤" : "⇄"} ${a.price}`,
          })
        );
      } catch {
        // ignore
      }
    }
    return () => {
      for (const [, line] of existing) {
        try {
          main.removePriceLine(line);
        } catch {
          // ignore
        }
      }
      existing.clear();
    };
  }, [frameAlerts, symbol, chartType]);

  // 4c) earnings [E] + news ⚡ markers on the main series
  const newsItems = newsTagged && newsTagged.sym === symbol ? newsTagged.news : null;
  const earningsEvents =
    earningsTagged && earningsTagged.sym === symbol ? earningsTagged.events : null;
  const markers = useMemo<SeriesMarker<Time>[]>(() => {
    if (!bars || bars.length === 0) return [];
    const intraday = INTRADAY_TFS.has(timeframe);
    const out: SeriesMarker<Time>[] = [];

    if (intraday) {
      // earnings: a bmo report marks that ET day's first bar, amc its last bar
      if (earningsEvents?.length) {
        const dayBars = new Map<string, { first: Time; last: Time }>();
        for (const b of bars) {
          if (typeof b.time !== "number") continue;
          const t = b.time as Time;
          const d = etDateOf(b.time);
          const slot = dayBars.get(d);
          if (slot) slot.last = t;
          else dayBars.set(d, { first: t, last: t });
        }
        for (const ev of earningsEvents) {
          const slot = dayBars.get(ev.date);
          if (!slot) continue;
          out.push({
            time: ev.when === "bmo" ? slot.first : slot.last,
            position: "belowBar",
            shape: "square",
            text: "E",
            color: "#f0b90b",
            size: 1,
            id: `e:${ev.id}`,
          });
        }
      }
      // news: only when the timestamp falls inside a bar's window (else it floods)
      if (newsItems?.length) {
        const tfSec = TF_SEC[timeframe] ?? 60;
        const times: number[] = [];
        for (const b of bars) if (typeof b.time === "number") times.push(b.time);
        for (const n of newsItems) {
          const t = barWindowAt(times, n.publishedAt, tfSec);
          if (t == null) continue;
          out.push({
            time: t as Time,
            position: "aboveBar",
            shape: "circle",
            text: "⚡",
            color: "#26a69a",
            size: 1,
            id: `n:${n.id}`,
          });
        }
      }
    } else {
      // daily+: map event/news dates onto the timeframe's calendar buckets
      const barKey = new Map<string, Time>();
      for (const b of bars) {
        if (typeof b.time !== "string") continue;
        barKey.set(bucketKey(b.time, timeframe), b.time);
      }
      if (earningsEvents?.length) {
        for (const ev of earningsEvents) {
          const t = barKey.get(bucketKey(ev.date, timeframe));
          if (t == null) continue;
          out.push({
            time: t,
            position: "belowBar",
            shape: "square",
            text: "E",
            color: "#f0b90b",
            size: 1,
            id: `e:${ev.id}`,
          });
        }
      }
      if (newsItems?.length) {
        for (const n of newsItems) {
          const t = barKey.get(bucketKey(etDateOf(n.publishedAt), timeframe));
          if (t == null) continue;
          out.push({
            time: t,
            position: "aboveBar",
            shape: "circle",
            text: "⚡",
            color: "#26a69a",
            size: 1,
            id: `n:${n.id}`,
          });
        }
      }
    }

    // lightweight-charts wants time-ascending markers; cap to the latest ~120
    out.sort((a, b) => {
      const at = a.time;
      const bt = b.time;
      if (typeof at === "number" && typeof bt === "number") return at - bt;
      return String(at).localeCompare(String(bt));
    });
    return out.length > 120 ? out.slice(out.length - 120) : out;
  }, [bars, newsItems, earningsEvents, timeframe]);

  // push markers onto the plugin; also re-run on chartType because the plugin
  // is recreated (empty) alongside the main series when the type changes
  useEffect(() => {
    const api = markersApiRef.current;
    if (!api) return;
    api.setMarkers(markers);
  }, [markers, chartType]);

  // 5) drawing mode toggles chart interaction
  useEffect(() => {
    draftRef.current = null;
    const chart = chartRef.current;
    if (!chart) return;
    const drawing = drawTool !== "cursor";
    chart.applyOptions({
      handleScroll: drawing
        ? false
        : { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: drawing
        ? false
        : {
            mouseWheel: true,
            pinch: true,
            axisPressedMouseMove: { time: true, price: true },
            axisDoubleClickReset: true,
          },
      crosshair: { mode: drawing ? CrosshairMode.Hidden : CrosshairMode.Normal },
    });
  }, [drawTool]);

  // 6) mirror drawing state to refs (render loop) and localStorage (persistence).
  // Skip persistence until the persisted store has been loaded, otherwise the
  // empty initial list would wipe saved drawings on mount.
  const selfIdRef = useRef(`p${++panelSeq}`);
  useEffect(() => {
    drawingsRef.current = drawState.list;
    selectedRef.current = drawState.selected;
    if (!drawState.loaded) return;
    const store = getDrawingStore();
    store[drawState.key] = drawState.list;
    persistDrawingStore(store);
    noteUserStateDirty(); // signed-in users: drawings ride the 5s autosave
    const detail: DrawingsEventDetail = { key: drawState.key, sourceId: selfIdRef.current };
    window.dispatchEvent(new CustomEvent<DrawingsEventDetail>(DRAWINGS_EVENT, { detail }));
  }, [drawState]);

  // 6b) pull drawings committed by another frame showing the same symbol|tf
  useEffect(() => {
    const onExternal = (e: Event): void => {
      const detail = (e as CustomEvent<DrawingsEventDetail>).detail;
      if (!detail || detail.sourceId === selfIdRef.current) return;
      if (draftRef.current) return; // never yank the list mid-stroke
      setDrawState((prev) => {
        const next = getDrawingStore()[prev.key] ?? [];
        if (next.length === prev.list.length && next.every((d, i) => d.id === prev.list[i]?.id)) return prev;
        return { ...prev, list: next, selected: null };
      });
    };
    window.addEventListener(DRAWINGS_EVENT, onExternal);
    return () => window.removeEventListener(DRAWINGS_EVENT, onExternal);
  }, []);

  const commitDrawing = useCallback((tool: DrawShape, points: DrawAnchor[]) => {
    setDrawState((prev) => ({
      ...prev,
      list: [
        ...prev.list,
        {
          id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          tool,
          color: DRAW_COLORS[prev.list.length % DRAW_COLORS.length],
          points,
        },
      ],
    }));
  }, []);

  const deleteSelected = useCallback(() => {
    setDrawState((prev) => ({
      ...prev,
      list: prev.selected ? prev.list.filter((d) => d.id !== prev.selected) : prev.list,
      selected: null,
    }));
  }, []);

  const deleteDrawing = useCallback((id: string) => {
    setDrawState((prev) => ({
      ...prev,
      list: prev.list.filter((d) => d.id !== id),
      selected: prev.selected === id ? null : prev.selected,
    }));
  }, []);

  const clearAllDrawings = useCallback(() => {
    setDrawState((prev) => {
      if (!prev.list.length) return prev;
      return { ...prev, list: [], selected: null };
    });
    toast.success("All drawings cleared");
  }, []);

  // ---------------- zoom controls ----------------

  const zoomBy = useCallback((factor: number) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const span = r.to - r.from;
    if (span <= 0) return;
    const half = Math.min(20000, Math.max(2, (span / 2) * factor));
    const center = (r.from + r.to) / 2;
    ts.setVisibleLogicalRange({ from: center - half, to: center + half });
  }, []);

  const zoomIn = useCallback(() => zoomBy(0.7), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 0.7), [zoomBy]);

  const fitAll = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
    chart.priceScale("right").applyOptions({ autoScale: true });
    const f = frameRef.current;
    setScaleUi({ key: `${f.symbol}|${f.timeframe}`, auto: true });
  }, []);

  const toggleAutoScale = useCallback(() => {
    const on = !autoScale;
    setScaleUi({ key: chartKey, auto: on });
    chartRef.current?.priceScale("right").applyOptions({ autoScale: on });
  }, [autoScale, chartKey]);

  const toggleLogScale = useCallback(() => {
    const on = !logScale;
    setLogScale(on);
    chartRef.current?.priceScale("right").applyOptions({
      mode: on ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale]);

  // 7) keyboard: zoom shortcuts + drawing escape/delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

      if (e.key === "Escape") {
        if (dragRef.current) {
          dragRef.current = null; // cancel move/resize, keep selection
          return;
        }
        if (draftRef.current) {
          draftRef.current = null;
          return;
        }
        const st = useTerminal.getState();
        if (st.drawTool !== "cursor") {
          st.setDrawTool("cursor");
          return;
        }
        if (selectedRef.current) {
          setDrawState((prev) => (prev.selected ? { ...prev, selected: null } : prev));
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        fitAll();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedRef.current) {
          e.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut, fitAll, deleteSelected, active]);

  // 8) overlay canvas render loop (drawings + drag preview + draft preview)
  const drawOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const drawings = drawingsRef.current;
      const drag = dragRef.current;
      for (const d of drawings) {
        if (drag && d.id === drag.id) continue; // dragged drawing drawn from drag state below
        const pts: Pt[] = [];
        let ok = true;
        for (const a of d.points) {
          const p = project(a);
          if (!p) {
            ok = false;
            break;
          }
          pts.push(p);
        }
        if (!ok) continue;
        const selected = d.id === selectedRef.current;
        const hovered = !selected && d.id === hoverRef.current;
        drawShape(
          ctx,
          d.tool,
          pts,
          d.color,
          w,
          h,
          d.tool === "hline" ? fmtPrice(d.points[0].price) : undefined,
          {
            selected: selected || hovered,
            fibPrices:
              d.tool === "fib" && d.points.length >= 2
                ? { a: d.points[0].price, b: d.points[1].price }
                : undefined,
          }
        );
      }
      if (drag) {
        drawShape(
          ctx,
          drag.tool,
          drag.pts,
          drag.color,
          w,
          h,
          drag.tool === "hline" ? fmtPrice(drag.anchors[0].price) : undefined,
          {
            selected: true,
            fibPrices:
              drag.tool === "fib" && drag.anchors.length >= 2
                ? { a: drag.anchors[0].price, b: drag.anchors[1].price }
                : undefined,
          }
        );
      }
      const draft = draftRef.current;
      if (draft) {
        const color = DRAW_COLORS[drawings.length % DRAW_COLORS.length];
        if (draft.tool === "brush") {
          const pts = draft.points.map((p) => p.pt);
          if (draft.brushing && draft.cursorPt) pts.push(draft.cursorPt);
          if (pts.length >= 2) drawShape(ctx, "brush", pts, color, w, h, undefined, { draft: true });
        } else if (draft.tool !== "hline" && draft.tool !== "vline") {
          const pts = draft.points.map((p) => p.pt);
          if (draft.cursorPt) pts.push(draft.cursorPt);
          if (pts.length >= 2) {
            drawShape(ctx, draft.tool, pts, color, w, h, undefined, {
              draft: true,
              fibPrices:
                draft.tool === "fib" && draft.points.length >= 2
                  ? { a: draft.points[0].anchor.price, b: draft.points[1].anchor.price }
                  : undefined,
            });
          }
        }
      }
    },
    [project]
  );

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const chart = chartRef.current;
      const canvas = canvasRef.current;
      if (!chart || !canvas) return;
      const ps = chart.paneSize(0);
      const w = Math.max(0, Math.round(ps.width));
      const h = Math.max(0, Math.round(ps.height));
      const dpr = window.devicePixelRatio || 1;
      const sw = Math.round(w * dpr);
      const sh = Math.round(h * dpr);
      if (canvas.width !== sw || canvas.height !== sh) {
        canvas.width = sw;
        canvas.height = sh;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawOverlay(ctx, w, h);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [drawOverlay]);

  // ---------------- drawing pointer handlers ----------------

  const anchorAt = useCallback((pt: Pt): DrawAnchor | null => {
    const chart = chartRef.current;
    const main = mainRef.current;
    const bs = barsRef.current;
    if (!chart || !main || !bs || !bs.length) return null;
    const price = main.coordinateToPrice(pt.y);
    if (price == null || !Number.isFinite(price)) return null;
    const ts = chart.timeScale();
    const t = ts.coordinateToTime(pt.x);
    if (t != null) return { time: t as number | string, price };
    const logical = ts.coordinateToLogical(pt.x);
    if (logical == null) return null;
    return { off: logical - (bs.length - 1), price };
  }, []);

  const toLocal = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Screen point clamped into the pane so anchorAt never sees out-of-range pixels. */
  const clampPt = (pt: Pt, w: number, h: number): Pt => ({
    x: Math.min(Math.max(pt.x, 0), w - 1),
    y: Math.min(Math.max(pt.y, 0), h - 1),
  });

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const tool = drawToolRef.current;
    const pt = toLocal(e);

    // cursor mode: grab a drawing body (move) or endpoint (resize)
    if (tool === "cursor") {
      const hit = hitTestDrawings(pt.x, pt.y, drawingsRef.current, project);
      const canvas = e.currentTarget;
      if (!hit) {
        // click on empty overlay area → deselect (chart would do the same)
        selectedRef.current = null;
        setDrawState((prev) => (prev.selected ? { ...prev, selected: null } : prev));
        setInteractive(false);
        return;
      }
      const d = drawingsRef.current.find((x) => x.id === hit.id);
      if (!d) return;
      const pts: Pt[] = [];
      let ok = true;
      for (const a of d.points) {
        const p = project(a);
        if (!p) {
          ok = false;
          break;
        }
        pts.push(p);
      }
      if (!ok) return;
      selectedRef.current = d.id;
      setDrawState((prev) => (prev.selected === d.id ? prev : { ...prev, selected: d.id }));
      dragRef.current = {
        id: d.id,
        tool: d.tool,
        color: d.color,
        mode: hit.handle != null ? "handle" : "body",
        handleIdx: hit.handle ?? -1,
        startPt: pt,
        origPts: pts,
        origAnchors: d.points.map((a) => ({ ...a })),
        pts: pts.map((p) => ({ ...p })),
        anchors: d.points.map((a) => ({ ...a })),
      };
      canvas.style.setProperty("cursor", "grabbing");
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    const anchor = anchorAt(pt);
    if (!anchor) return;
    if (tool === "brush") {
      draftRef.current = { tool: "brush", points: [{ anchor, pt }], cursorPt: pt, brushing: true };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "hline" || tool === "vline") {
      commitDrawing(tool, [anchor]);
      return;
    }
    const draft = draftRef.current;
    if (!draft) {
      draftRef.current = { tool, points: [{ anchor, pt }], cursorPt: pt, brushing: false };
    } else if (draft.tool === tool && draft.points.length === 1) {
      const points = [draft.points[0].anchor, anchor];
      draftRef.current = null;
      commitDrawing(tool, points);
    }
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toLocal(e);

    // live move/resize of a committed drawing
    const drag = dragRef.current;
    if (drag) {
      const dx = pt.x - drag.startPt.x;
      const dy = pt.y - drag.startPt.y;
      const isH = drag.tool === "hline"; // horizontal line: vertical movement only
      const isV = drag.tool === "vline"; // vertical line: horizontal movement only
      drag.pts = drag.origPts.map((p, i) => {
        if (drag.mode === "handle" && i !== drag.handleIdx) return p;
        if (isH) return { x: p.x, y: p.y + dy };
        if (isV) return { x: p.x + dx, y: p.y };
        return { x: p.x + dx, y: p.y + dy };
      });
      drag.anchors = drag.origAnchors.map((a, i) => {
        const moved = drag.pts[i] !== drag.origPts[i];
        if (!moved) return a;
        const ps = chartRef.current?.paneSize(0);
        const next = anchorAt(clampPt(drag.pts[i], ps?.width ?? 4096, ps?.height ?? 4096));
        return next ?? a;
      });
      return;
    }

    const draft = draftRef.current;
    if (draft) {
      draft.cursorPt = pt;
      if (draft.brushing) {
        const last = draft.points[draft.points.length - 1].pt;
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 3) {
          const anchor = anchorAt(pt);
          if (anchor) draft.points.push({ anchor, pt });
        }
      }
      return;
    }

    // cursor mode, not dragging: keep hover-to-grab arbitration — when the
    // pointer leaves every drawing, hand control back to the chart
    if (drawToolRef.current === "cursor") {
      const hit = hitTestDrawings(pt.x, pt.y, drawingsRef.current, project);
      const canvas = e.currentTarget;
      if (hit) {
        hoverRef.current = hit.id;
        canvas.style.setProperty("cursor", hit.handle != null ? "grab" : "move");
      } else {
        hoverRef.current = null;
        canvas.style.setProperty("cursor", "default");
        setInteractive(false);
      }
    }
  };

  const onCanvasPointerUp = () => {
    // commit a finished freehand stroke
    const draft = draftRef.current;
    if (draft?.brushing) {
      const anchors = draft.points.map((p) => p.anchor);
      draftRef.current = null;
      if (anchors.length >= 2) commitDrawing("brush", anchors);
      return;
    }
    // commit a finished move/resize
    const drag = dragRef.current;
    if (drag) {
      const moved = drag.pts.some((p, i) => p !== drag.origPts[i]);
      const { id, anchors } = drag;
      dragRef.current = null;
      if (moved) {
        setDrawState((prev) => ({
          ...prev,
          list: prev.list.map((d) => (d.id === id ? { ...d, points: anchors } : d)),
        }));
      }
    }
  };

  const onCanvasPointerLeave = () => {
    const draft = draftRef.current;
    if (draft && !draft.brushing) draft.cursorPt = null;
    // release pointer back to the chart unless a drag holds the capture
    if (!dragRef.current && !draftRef.current) {
      hoverRef.current = null;
      setInteractive(false);
    }
  };

  /** Alert dashed price lines live on the main series — ±6px vertical hit. */
  const hitTestAlerts = useCallback(
    (x: number, y: number): string | null => {
      const main = mainRef.current;
      const ps = chartRef.current?.paneSize(0);
      if (!main || !ps || x < 0 || x > ps.width) return null;
      for (const a of frameAlerts) {
        const ay = main.priceToCoordinate(a.price);
        if (ay != null && Math.abs(y - ay) <= 6) return a.id;
      }
      return null;
    },
    [frameAlerts]
  );

  // right-click: cancel drafts (unchanged), then hit-test drawings → alert
  // lines → empty space and open the context menu accordingly. Attached to
  // both the chart container (internal canvases bubble up) and the overlay
  // canvas (its sibling, so no double-fire).
  const onChartContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (dragRef.current) return; // never open a menu mid move/resize
    if (draftRef.current) {
      draftRef.current = null;
      return;
    }
    if (drawToolRef.current !== "cursor") useTerminal.getState().setDrawTool("cursor");
    const chart = chartRef.current;
    const main = mainRef.current;
    if (!chart || !main) return;
    const ps = chart.paneSize(0);
    const rect = canvasRef.current?.getBoundingClientRect() ?? containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cx = Math.min(Math.max(x, 0), Math.max(0, ps.width - 1));
    const cy = Math.min(Math.max(y, 0), Math.max(0, ps.height - 1));

    // 1) drawings — select exactly like a left click, then offer line actions
    const hit = hitTestDrawings(cx, cy, drawingsRef.current, project);
    if (hit) {
      const d = drawingsRef.current.find((dd) => dd.id === hit.id);
      if (d) {
        selectedRef.current = d.id;
        setDrawState((prev) => (prev.selected === d.id ? prev : { ...prev, selected: d.id }));
        setMenu({
          x: e.clientX,
          y: e.clientY,
          target: { kind: "drawing", id: d.id, tool: d.tool, hitPrice: d.points[0].price },
        });
        return;
      }
    }

    // 2) active alert price lines (dashed, rendered from the store)
    const alertId = hitTestAlerts(cx, cy);
    if (alertId) {
      setMenu({ x: e.clientX, y: e.clientY, target: { kind: "alert", id: alertId } });
      return;
    }

    // 3) empty space — offer an alert at the clicked price (main pane only)
    if (x < 0 || y < 0 || x > ps.width || y > ps.height) return;
    const price = main.coordinateToPrice(cy);
    if (price == null || !Number.isFinite(price)) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      target: { kind: "empty", price: Math.round(price * 100) / 100 },
    });
  };

  // the context menu belongs to the frame it was opened on
  useEffect(() => {
    setMenu(null);
  }, [symbol, timeframe]);

  // ---------------- render ----------------

  const isLoading = loading && !bars;
  const hasError = Boolean(error) && !bars;
  const isEmpty = !loading && !error && bars && bars.length === 0;
  const drawingMode = drawTool !== "cursor";

  // context-menu resolution: live drawing/alert objects for labels + swatches
  const menuTarget = menu ? menu.target : null;
  const menuAlert =
    menuTarget !== null && menuTarget.kind === "alert"
      ? alerts.find((a) => a.id === menuTarget.id) ?? null
      : null;
  const menuDrawing =
    menuTarget !== null && menuTarget.kind === "drawing"
      ? drawings.find((d) => d.id === menuTarget.id) ?? null
      : null;
  const propsDrawing = drawings.find((d) => d.id === propsId) ?? null;
  const editAlert = alerts.find((a) => a.id === editAlertId) ?? null;

  const menuItems: MenuItem[] = [];
  if (menu?.target.kind === "drawing") {
    const t = menu.target;
    menuItems.push({
      label: `Add alert at ${fmtPrice(t.hitPrice)}`,
      icon: MENU_ICONS.bell,
      onSelect: () =>
        void useTerminal.getState().addAlert({
          symbol: frameRef.current.symbol,
          price: Number(t.hitPrice.toFixed(2)),
          direction: "cross",
        }),
    });
    if (t.tool === "hline") {
      menuItems.push({ label: "Change value…", icon: MENU_ICONS.edit, onSelect: () => setPropsId(t.id) });
    }
    menuItems.push(
      { label: "Delete", icon: MENU_ICONS.trash, danger: true, separator: true, onSelect: () => deleteDrawing(t.id) },
      { label: "More…", icon: MENU_ICONS.props, onSelect: () => setPropsId(t.id) }
    );
  } else if (menu?.target.kind === "alert" && menuAlert) {
    const a = menuAlert;
    menuItems.push(
      a.active
        ? { label: "Pause", icon: MENU_ICONS.bellOff, onSelect: () => void updateAlert(a.id, { active: false }) }
        : { label: "Resume", icon: MENU_ICONS.bell, onSelect: () => void updateAlert(a.id, { active: true }) },
      { label: "Edit…", icon: MENU_ICONS.edit, onSelect: () => setEditAlertId(a.id) },
      { label: "Delete", icon: MENU_ICONS.trash, danger: true, separator: true, onSelect: () => void removeAlert(a.id) }
    );
  } else if (menu?.target.kind === "empty") {
    const p = menu.target.price;
    menuItems.push({
      label: `Add alert at ${fmtPrice(p)}`,
      icon: MENU_ICONS.bell,
      onSelect: () =>
        void useTerminal.getState().addAlert({ symbol: frameRef.current.symbol, price: p, direction: "cross" }),
    });
  }

  return (
    <section className="relative h-full min-h-0 bg-[#131722]" aria-label={`${symbol} ${timeframe} chart`}>
      <div ref={containerRef} className="absolute inset-0" onContextMenu={onChartContextMenu} />

      {/* drawing overlay canvas — sized to the main pane by the render loop */}
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 z-[6] touch-none"
        style={{
          pointerEvents: drawingMode || interactive ? "auto" : "none",
          cursor: drawingMode ? "crosshair" : "default",
        }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerLeave={onCanvasPointerLeave}
        onContextMenu={onChartContextMenu}
        aria-hidden={!drawingMode}
      />

      {/* watermark */}
      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1"
        aria-hidden="true"
      >
        <span className="font-mono text-6xl font-extrabold tracking-widest text-white/[0.04]">{symbol}</span>
        <span className="font-mono text-xl font-bold tracking-[0.3em] text-white/[0.03]">{timeframe}</span>
      </div>

      {/* legend */}
      <div
        ref={legendRef}
        className="pointer-events-none absolute left-14 top-2 z-10 max-w-[calc(100%-8rem)] font-mono text-[11px] tracking-tight"
        aria-hidden="true"
      />

      {/* drawing toolbar — draggable / collapsible / fades when idle */}
      <FloatingToolbar
        id="draw"
        label="Drawing tools"
        icon={<PenTool className="h-4 w-4" />}
        anchorClass="left-1.5 top-1/2 -translate-y-1/2"
      >
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.label}
            aria-label={t.label}
            aria-pressed={drawTool === t.key}
            className={toolBtn}
            onClick={() => useTerminal.getState().setDrawTool(t.key)}
          >
            {t.icon}
          </button>
        ))}
        <div className="my-0.5 h-px bg-[#2a2e39]" role="separator" />
        <button
          type="button"
          title="Delete selected (Del)"
          aria-label="Delete selected drawing"
          className={toolBtn}
          disabled={!selectedId}
          onClick={deleteSelected}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Clear all drawings"
          aria-label="Clear all drawings"
          className={toolBtn}
          disabled={drawings.length === 0}
          onClick={clearAllDrawings}
        >
          <Eraser className="h-4 w-4" />
        </button>
      </FloatingToolbar>

      {/* drawing hint */}
      {drawingMode && (
        <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-[#2a2e39] bg-[#1e222d]/95 px-3 py-1.5 text-[11px] text-[#b2b5be] shadow-lg backdrop-blur">
          {TOOL_HINTS[drawTool as DrawShape]}
          <span className="ml-2 text-[#787b86]">
            Esc to exit · right-click cancels
          </span>
        </div>
      )}

      {/* zoom / scale controls — draggable / collapsible / fades when idle */}
      <FloatingToolbar
        id="zoom"
        label="Zoom and scale"
        icon={<ZoomIn className="h-4 w-4" />}
        anchorClass="bottom-8 right-2"
      >
        <button type="button" title="Zoom in (+)" aria-label="Zoom in" className={ctlBtn} onClick={zoomIn}>
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" title="Zoom out (−)" aria-label="Zoom out" className={ctlBtn} onClick={zoomOut}>
          <Minus className="h-4 w-4" />
        </button>
        <button type="button" title="Fit content (0)" aria-label="Fit content" className={ctlBtn} onClick={fitAll}>
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <div className="my-0.5 h-px bg-[#2a2e39]" role="separator" />
        <button
          type="button"
          title="Auto price scale (double-click price axis also resets)"
          aria-label="Toggle auto price scale"
          aria-pressed={autoScale}
          className={cn(ctlBtn, autoScale && "text-[#26a69a] hover:text-[#26a69a]")}
          onClick={toggleAutoScale}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Logarithmic price scale"
          aria-label="Toggle logarithmic scale"
          aria-pressed={logScale}
          className={cn(ctlBtn, "font-mono text-[9px] font-bold", logScale && "text-[#26a69a] hover:text-[#26a69a]")}
          onClick={toggleLogScale}
        >
          log
        </button>
      </FloatingToolbar>

      {/* bell marker when this symbol has active alerts */}
      {frameAlerts.length > 0 && (
        <div
          className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-[#f0b90b]/40 bg-[#1e222d]/80 px-2 py-1 text-[11px] font-semibold text-[#f0b90b] backdrop-blur"
          aria-label={`${frameAlerts.length} active price alerts on ${symbol}`}
        >
          <Bell className="h-3.5 w-3.5" />
          {frameAlerts.length}
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#131722]/70">
          <Loader2 className="h-6 w-6 animate-spin text-[#26a69a]" />
          <p className="text-xs text-[#787b86]">
            Loading {symbol} · {timeframe}…
          </p>
        </div>
      )}

      {hasError && (
        <div className="absolute inset-x-0 top-14 z-20 mx-auto flex w-fit items-center gap-2 rounded-md border border-[#ef5350]/40 bg-[#ef5350]/10 px-3 py-2 text-xs text-[#ef5350]">
          <TriangleAlert className="h-4 w-4" />
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 border-[#ef5350]/40 px-2 text-[11px] text-[#ef5350] hover:bg-[#ef5350]/20 hover:text-[#ef5350]"
            onClick={refresh}
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        </div>
      )}

      {isEmpty && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <p className="text-sm text-[#787b86]">No data available for {symbol} on {timeframe}</p>
        </div>
      )}

      {/* right-click context menu: drawings / alert lines / empty space */}
      {menu && !(menu.target.kind === "alert" && !menuAlert) && (
        <ChartContextMenu
          key={`${menu.x}:${menu.y}:${menu.target.kind}`}
          x={menu.x}
          y={menu.y}
          items={menuItems}
          colors={LINE_COLORS}
          activeColor={
            menu.target.kind === "drawing"
              ? menuDrawing?.color ?? null
              : menu.target.kind === "alert"
                ? menuAlert?.color ?? null
                : undefined
          }
          onPickColor={
            menu.target.kind === "drawing" && menuDrawing
              ? (c) =>
                  setDrawState((prev) => ({
                    ...prev,
                    list: prev.list.map((d) => (d.id === menuDrawing.id ? { ...d, color: c } : d)),
                  }))
              : menu.target.kind === "alert" && menuAlert
                ? (c) => void updateAlert(menuAlert.id, { color: c })
                : undefined
          }
          colorLabel={menu.target.kind === "alert" ? "Alert line color" : "Line color"}
          onClose={() => setMenu(null)}
        />
      )}

      <DrawingPropsDialog
        key={`drawing-props-${propsId ?? "closed"}`}
        drawing={propsDrawing}
        onChange={(patch) => {
          const nextPrice = patch.price;
          setDrawState((prev) => ({
            ...prev,
            list: prev.list.map((d) => {
              if (d.id !== propsDrawing?.id) return d;
              const points =
                nextPrice != null
                  ? d.points.map((a, i) => (i === 0 ? { ...a, price: nextPrice } : a))
                  : d.points;
              return { ...d, color: patch.color ?? d.color, points };
            }),
          }));
        }}
        onDelete={() => {
          if (propsDrawing) deleteDrawing(propsDrawing.id);
          setPropsId(null);
        }}
        onClose={() => setPropsId(null)}
      />
      <AlertEditDialog
        key={`alert-edit-${editAlertId ?? "closed"}`}
        alert={editAlert}
        onSave={(patch) => {
          if (editAlert) void updateAlert(editAlert.id, patch);
        }}
        onClose={() => setEditAlertId(null)}
      />
    </section>
  );
}
