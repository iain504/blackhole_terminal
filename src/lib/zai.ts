// v2.12.51 — shared z-ai-web-dev-sdk bootstrap (AI credentials, server-side only).
//
// WHY THIS EXISTS: the SDK resolves its credentials ONLY from files —
// `.z-ai-config` in the process cwd, the user home dir, or /etc (valid = JSON
// with non-empty baseUrl + apiKey). This dev sandbox ships /etc/.z-ai-config,
// but production containers (Render / Railway / Fly) never have the file: it
// carries a session token and is gitignored on purpose. Every LLM feature —
// sentiment scoring, the pre-trade veto gate, the post-trade auditor — died
// on those hosts with "Configuration file not found or invalid. Please create
// .z-ai-config …" per batch (v2.12.50 and earlier).
//
// FIX: the deployment provides the SAME JSON via the ZAI_CONFIG_JSON env var
// (Render Dashboard → Environment; `sync: false` in render.yaml — never in
// git, same discipline as the Alpaca keys). It is materialized to a real
// config file at two layers:
//   1. boot    — docker-entrypoint.sh writes /app/.z-ai-config before the
//                standalone server starts (primary path on Render).
//   2. runtime — ensureZaiConfig() below, for hosts where the entrypoint
//                didn't run or the boot write failed (read-only fs, bare
//                `bun server.js`, env added without a rebuild).
//
// Call sites MUST go through getZai() (memoized client) instead of importing
// the SDK directly, and LLM routes should pre-flight with ensureZaiConfig()
// so a misconfigured deployment fails fast with one actionable message.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILENAME = '.z-ai-config'

/** The exact search order the SDK itself uses (cwd → home → /etc). */
const CONFIG_SEARCH_PATHS = [
  path.join(process.cwd(), CONFIG_FILENAME),
  path.join(os.homedir(), CONFIG_FILENAME),
  path.join('/etc', CONFIG_FILENAME),
]

/** Where the runtime materialization may write (first writable one wins). */
const CONFIG_WRITE_DIRS = [process.cwd(), os.homedir(), '/etc']

export interface ZaiStatus {
  /** true = the SDK will find a valid config file. */
  configured: boolean
  /** where the config came from (null when unconfigured). */
  source: 'file' | 'env' | null
  /** non-null only when ZAI_CONFIG_JSON is set but unusable. */
  error: string | null
}

function isValidConfig(value: unknown): value is { baseUrl: string; apiKey: string } {
  if (typeof value !== 'object' || value === null) return false
  const c = value as { baseUrl?: unknown; apiKey?: unknown }
  return typeof c.baseUrl === 'string' && c.baseUrl.length > 0
    && typeof c.apiKey === 'string' && c.apiKey.length > 0
}

/** First search path holding a VALID config file, or null. */
async function findConfigFile(): Promise<string | null> {
  for (const p of CONFIG_SEARCH_PATHS) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      if (isValidConfig(JSON.parse(raw))) return p
    } catch {
      // ENOENT or invalid JSON — try the next location (same as the SDK)
    }
  }
  return null
}

// --- runtime materialization (memoized; a hard failure is retried next call) -
let ensurePromise: Promise<ZaiStatus> | null = null

/** Ensure the SDK will find its config: probe the file paths, and if none
 *  exist but ZAI_CONFIG_JSON is set, write the JSON to the first writable
 *  location. Cheap when already configured (memoized); re-probes after a
 *  genuine failure so a fixed environment is picked up without a restart. */
export function ensureZaiConfig(): Promise<ZaiStatus> {
  if (!ensurePromise) {
    ensurePromise = (async (): Promise<ZaiStatus> => {
      const file = await findConfigFile()
      if (file) return { configured: true, source: 'file', error: null }

      const raw = process.env.ZAI_CONFIG_JSON?.trim() ?? ''
      if (!raw) return { configured: false, source: null, error: null }

      let cfg: unknown
      try {
        cfg = JSON.parse(raw)
      } catch {
        return { configured: false, source: null, error: 'ZAI_CONFIG_JSON is set but is not valid JSON' }
      }
      if (!isValidConfig(cfg)) {
        return { configured: false, source: null, error: 'ZAI_CONFIG_JSON is missing required fields (baseUrl, apiKey)' }
      }
      for (const dir of CONFIG_WRITE_DIRS) {
        try {
          await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify(cfg), { mode: 0o600 })
          return { configured: true, source: 'env', error: null }
        } catch {
          // read-only dir (e.g. /etc as non-root) — try the next location
        }
      }
      return { configured: false, source: null, error: 'ZAI_CONFIG_JSON is valid but no writable location for .z-ai-config (cwd, home, /etc)' }
    })()
    ensurePromise.catch(() => { ensurePromise = null })
  }
  return ensurePromise
}

/** One actionable sentence for 4xx/5xx bodies when the deployment lacks
 *  Z.AI credentials — shown verbatim in the UI (toasts / run notes). */
export function zaiSetupHint(status: ZaiStatus): string {
  const fix = 'Fix: Render Dashboard → Environment → add ZAI_CONFIG_JSON with the .z-ai-config JSON from the dev sandbox (/etc/.z-ai-config), then redeploy.'
  return status.error
    ? `${status.error}. ${fix}`
    : `No .z-ai-config credential file on this deployment and ZAI_CONFIG_JSON is not set. ${fix}`
}

// --- memoized SDK client -----------------------------------------------------

let clientPromise: Promise<unknown> | null = null

/** The shared z-ai-web-dev-sdk client. Materializes the config first, then
 *  creates the client once per process. A failed init is not cached — the
 *  next call retries (a crashed create() must not poison the route forever). */
export async function getZai(): Promise<unknown> {
  const status = await ensureZaiConfig()
  if (!status.configured) {
    throw new Error(`Z.AI credentials not configured — ${zaiSetupHint(status)}`)
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      const mod = await import('z-ai-web-dev-sdk')
      const ZAI = (mod as unknown as { default: unknown }).default ?? (mod as unknown)
      return await (ZAI as { create(): Promise<unknown> }).create()
    })()
    clientPromise.catch(() => { clientPromise = null })
  }
  return clientPromise
}
