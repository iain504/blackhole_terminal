'use client';

import { useSyncExternalStore } from 'react';

// Task 28 — UI theme (appearance): 'default' (Midnight — the original zinc
// dark) | 'christmas' (pine-green surfaces, holly-red accents, landing snow).
//
// How it works:
//  - <html class="theme-christmas"> is the single DOM switch. globals.css
//    redefines the Tailwind color variables (and the shadcn tokens) under
//    that class, so every zinc-* utility across the app re-tints at once.
//  - Preference lives in localStorage (instant boot, works pre-login on the
//    landing page) AND in user.settings.uiTheme via /api/settings (per-user,
//    survives new devices). layout.tsx injects a pre-paint script that
//    applies the localStorage choice before hydration — no theme flash.
//  - Login sync: TerminalRoot applies the server value after /api/auth/me
//    (server wins only when it has an explicit preference saved).
//  - applyUiTheme() dispatches UI_THEME_CHANGE_EVENT; ChartPanel listens to
//    re-create the canvas with the themed background (charts take their
//    colors as JS strings, they cannot follow CSS variables on their own).

export type UiTheme = 'default' | 'christmas';

export const UI_THEME_STORAGE_KEY = 'tt_ui_theme';
export const UI_THEME_CHANGE_EVENT = 'tt:ui-theme-changed';
export const THEME_CLASS = 'theme-christmas';

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
    id: 'christmas',
    label: 'Christmas',
    hint: 'Pine surfaces, holly-red accents, landing snow. 🎄',
    swatch: ['#06110b', '#0b1d13', '#1e4a33', '#dc2626', '#22c55e'],
  },
];

// ---- tiny external store (useSyncExternalStore-friendly) -------------------

let current: UiTheme = 'default';
let inited = false;
let cachedChartBg: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function normalize(v: unknown): UiTheme {
  return v === 'christmas' ? 'christmas' : 'default';
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
  document.documentElement.classList.toggle(THEME_CLASS, current === 'christmas');
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
    if (data?.uiTheme === 'christmas' || data?.uiTheme === 'default') {
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

// ---- chart helper -----------------------------------------------------------
// The chart canvas takes colors as JS strings — it cannot follow CSS vars.
// This reads the themed background ONCE per theme (cached; applyUiTheme
// clears the cache) so redraws stay cheap.

export const CHART_BG_FALLBACK = '#09090b';

export function chartBg(fallback: string = CHART_BG_FALLBACK): string {
  if (cachedChartBg) return cachedChartBg;
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--chart-bg').trim();
  cachedChartBg = v || fallback;
  return cachedChartBg;
}
