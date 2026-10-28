'use client';

import { useSyncExternalStore } from 'react';

// Task 28 — UI theme (appearance): 'default' (Midnight — the original zinc
// dark) | 'christmas' (pine-green surfaces, holly-red accents, landing snow)
// | 'day' (v1.88.0 — light daylight skin: paper surfaces, dark ink, white
// chart canvas).
//
// How it works:
//  - <html class="theme-christmas|theme-day"> is the single DOM switch.
//    globals.css redefines the Tailwind color variables (and the shadcn
//    tokens) under those classes, so every zinc-* utility across the app
//    re-tints at once (the day theme INVERTS the zinc ramp to light).
//  - Preference lives in localStorage (instant boot, works pre-login on the
//    landing page) AND in user.settings.uiTheme via /api/settings (per-user,
//    survives new devices). layout.tsx injects a pre-paint script that
//    applies the localStorage choice before hydration — no theme flash.
//  - Login sync: TerminalRoot applies the server value after /api/auth/me
//    (server wins only when it has an explicit preference saved).
//  - applyUiTheme() dispatches UI_THEME_CHANGE_EVENT; ChartPanel listens to
//    re-create the canvas with the themed colors (charts take their colors
//    as JS strings, they cannot follow CSS variables on their own) and
//    keeps the mobile browser chrome in sync via the meta theme-color.

export type UiTheme = 'default' | 'christmas' | 'day';

export const UI_THEME_STORAGE_KEY = 'tt_ui_theme';
export const UI_THEME_CHANGE_EVENT = 'tt:ui-theme-changed';
export const THEME_CLASS = 'theme-christmas';
export const THEME_CLASS_DAY = 'theme-day';

export interface UiThemeDef {
  id: UiTheme;
  label: string;
  hint: string;
  /** mini swatch shown on the Settings cards (surfaces … accent) */
  swatch: string[];
}

export const UI_THEMES: UiThemeDef[] = [
  {
    id: 'default',
    label: 'Midnight',
    hint: 'The classic zinc-dark terminal.',
    swatch: ['#09090b', '#18181b', '#3f3f46', '#a1a1aa', '#10b981'],
  },
  {
    id: 'day',
    label: 'Day',
    hint: 'Bright daylight skin — paper surfaces, dark ink, white chart.',
    swatch: ['#edf0f3', '#f7f9fa', '#c6cdd6', '#5a6273', '#059669'],
  },
  {
    id: 'christmas',
    label: 'Christmas',
    hint: 'Pine surfaces, holly-red accents, landing snow. 🎄',
    swatch: ['#06110b', '#0b1d13', '#1e4a33', '#dc2626', '#22c55e'],
  },
];

/** Mobile browser chrome (address bar) tint follows the active theme. */
const META_THEME_COLOR: Record<UiTheme, string> = {
  default: '#09090b',
  christmas: '#07150d',
  day: '#edf0f3',
};

// ---- tiny external store (useSyncExternalStore-friendly) -------------------

let current: UiTheme = 'default';
let inited = false;
let cachedChartBg: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function normalize(v: unknown): UiTheme {
  return v === 'christmas' ? 'christmas' : v === 'day' ? 'day' : 'default';
}

export function readLocalUiTheme(): UiTheme {
  if (typeof window === 'undefined') return 'default';
  try {
    return normalize(window.localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

function ensureInit() {
  if (!inited && typeof window !== 'undefined') {
    inited = true;
    // boot script already set the DOM class pre-paint; adopt its value here
    current = readLocalUiTheme();
  }
}

export function getUiTheme(): UiTheme {
  ensureInit();
  return current;
}

/** Apply a theme NOW: DOM class + localStorage + change event. Never throws. */
export function applyUiTheme(t: UiTheme): void {
  if (typeof window === 'undefined') return;
  ensureInit();
  current = normalize(t);
  cachedChartBg = null; // chartBg() re-reads the themed CSS variable
  chartVarCache.clear(); // chartVar() re-reads the themed CSS variables
  document.documentElement.classList.toggle(THEME_CLASS, current === 'christmas');
  document.documentElement.classList.toggle(THEME_CLASS_DAY, current === 'day');
  // keep the mobile browser chrome (address bar) on the themed color
  try {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', META_THEME_COLOR[current]);
  } catch {
    /* cosmetic only */
  }
  try {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, current);
  } catch {
    /* storage unavailable — DOM class still applied for this visit */
  }
  window.dispatchEvent(new CustomEvent(UI_THEME_CHANGE_EVENT));
  notify();
}

/** Persist to the account (Settings → Appearance). Fire-and-forget; the
 * caller owns UX feedback. Returns false when the request failed. */
export async function saveUiThemeToServer(t: UiTheme): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiTheme: t }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Server preference from GET /api/settings (null = nothing saved yet). */
export async function fetchServerUiTheme(): Promise<UiTheme | null> {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return null;
    const data = (await res.json()) as { uiTheme?: unknown };
    if (data?.uiTheme === 'christmas' || data?.uiTheme === 'day' || data?.uiTheme === 'default') {
      return data.uiTheme as UiTheme;
    }
    return null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): UiTheme {
  ensureInit();
  return current;
}

function getServerSnapshot(): UiTheme {
  return 'default';
}

export function useUiTheme(): UiTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True only after hydration (client snapshot true, server snapshot false).
 * Gate decorative theme DOM (snow, festive chips) on this so SSR/hydration
 * always render the default tree — no mismatch, no setState-in-effect. */
const noopSubscribe = () => () => {};
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// ---- chart helpers ---------------------------------------------------------
// The chart canvas takes colors as JS strings — it cannot follow CSS vars.

export const CHART_BG_FALLBACK = '#09090b';

export function chartBg(fallback: string = CHART_BG_FALLBACK): string {
  if (cachedChartBg) return cachedChartBg;
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--chart-bg').trim();
  cachedChartBg = v || fallback;
  return cachedChartBg;
}

// v1.88.0 — same idea as chartBg() but for ANY themed chart variable (grid
// lines, axis text, scale borders, crosshair …). Values are defined per theme
// in globals.css (:root dark defaults, html.theme-day light overrides) and
// read ONCE per theme (applyUiTheme clears the cache) so per-frame redraws
// never pay for getComputedStyle.
const chartVarCache = new Map<string, string>();

export function chartVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const hit = chartVarCache.get(name);
  if (hit) return hit;
  let v = '';
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    /* keep fallback */
  }
  const val = v || fallback;
  chartVarCache.set(name, val);
  return val;
}
