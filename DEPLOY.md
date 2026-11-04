# Hosted deployment — Fly.io / Render / Railway (v2.12.0)

One container, one port, persistent volume. Since **v2.12.0** the repo ships
`Dockerfile.hosted`: a single-container build that fuses the whole docker-compose
stack into one routable service — exactly the shape PaaS platforms want:

```
              ┌──────────────────────── container ────────────────────────┐
Internet ────▶│  Caddy edge  :$EDGE_PORT   ← the platform routes here     │
   (TLS at    │    ├─ /*            →  Next app        :3000              │
    the edge) │    └─ /socket.io/*  →  stream sidecar  :3030 (live ticks) │
              │  SQLite volume  /app/db   (prisma db push on every boot)  │
              └───────────────────────────────────────────────────────────┘
```

What this fixes vs the old attempts:

| Problem on Vercel/serverless | Hosted image |
| --- | --- |
| No persistent SQLite filesystem | Real VM/container + mounted volume |
| Socket.io sidecar can't deploy | Baked into the same container |
| Grid/algo engines killed between requests | Long-lived process, platform restart policy |
| Second port for the stream | One port; Caddy path-splits internally |

The grid and algo engines tick **in-process** — pick a platform/plan that keeps
the container always-on (all three below support this; free tiers that sleep
will pause your engines, flagged per platform).

---

## Secrets you will need (generate once, keep stable)

```bash
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # AUTH_SECRET
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # APP_ENCRYPTION_SECRET
```

`APP_ENCRYPTION_SECRET` encrypts stored Alpaca keys / Telegram tokens / TOTP
secrets (AES-256-GCM). **Never rotate it after credentials are stored** — those
rows become undecryptable. If omitted the app falls back to `AUTH_SECRET`, then
to a generated per-install master persisted in the DB.

Full env reference: `README.md → Environment variables`. The hosted image needs
no `DATABASE_URL` (defaults to `file:/app/db/custom.db` on the volume).

---

## Option 1 — Fly.io (recommended)

A real always-on VM, persistent volume, WebSockets at the edge. ~£4–6/mo.

```bash
# 0. install flyctl → https://fly.io/docs/flyctl/install/
fly auth login

# 1. from a full clone of this repo:
fly launch --no-deploy --copy-config     # reads fly.toml; set your app name
#    → edit fly.toml: primary_region (default lhr=London) BEFORE the volume step

# 2. persistent volume (same region as the app!)
fly volumes create blackhole_db --size 1 --region lhr

# 3. secrets (generate with the one-liner above)
fly secrets set AUTH_SECRET=<hex> APP_ENCRYPTION_SECRET=<hex> ALLOW_REGISTRATION=true

# 4. build + ship (build takes a few minutes the first time)
fly deploy

# 5. watch it come up
fly logs          # entrypoint: prisma db push → "database ready" → 3 processes
fly status
```

Then open `https://<app-name>.fly.dev` and create your account (first-run
bootstrap: an empty user table always allows the first signup). Optionally set
`ALLOW_REGISTRATION=false` afterwards via `fly secrets set`.

**Updating:** `git pull && fly deploy`. **Backing up:** `fly ssh sftp get /app/db/custom.db custom.db` (stop writes first, or use the in-app backup endpoint).

---

## Option 2 — Render.com (Blueprint, already in the repo)

`render.yaml` is a Render Blueprint. Free tier works for trying it, with two
hard caveats (also documented at the top of `render.yaml`):

1. **Free = ephemeral disk** — DB resets on every deploy/restart. Persistence
   needs **starter** + the `disks:` block (already written, commented).
2. **Free = spin-down** after 15 min idle → engines pause, ~50s cold start.

Steps: Dashboard → **New + → Blueprint** → pick `iain504/blackhole-terminal` →
Apply. Render reads `render.yaml`, builds `Dockerfile.hosted`, injects `PORT`
(the Caddy edge binds it), mints `AUTH_SECRET`/`APP_ENCRYPTION_SECRET` once via
`generateValue`, and probes `/api/health`.

For persistence, switch `plan: free` → `plan: starter` and uncomment the
`disks:` block (`mountPath: /app/db`) before your first real data lands.

---

## Option 3 — Railway

1. New Project → **Deploy from GitHub repo** → pick the repo.
2. Railway reads `railway.json` → builds `Dockerfile.hosted`, healthchecks
   `/api/health`, restarts on failure. It injects `PORT` — the edge binds it.
3. Add a volume: Service → **Volumes** → mount path **`/app/db`**.
4. Variables tab → add `AUTH_SECRET`, `APP_ENCRYPTION_SECRET`,
   `ALLOW_REGISTRATION=true` (generated with the one-liner above).
5. Deploy. Settings → Networking → Generate Domain.

Railway bills per-second usage; an always-on shared vCPU lands around $5/mo.

---

## First run + broker keys

1. Open the URL → **Register** the first account (2FA/TOTP enrolment is part of
   signup; store the secret in your authenticator).
2. Settings → paste **Alpaca paper keys** (per-user, encrypted at rest) — or
   set shared env keys `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` +
   `ALLOW_SHARED_BROKER=true` for users without their own.
3. The status chip should show **Live** — that's the in-container stream
   reaching the browser through the Caddy edge (crypto streams keylessly;
   stocks stream through your Alpaca key's single iex websocket).

## Ops notes

- **Health:** `/api/health` rides the edge and reports app + stream state.
- **Logs:** `fly logs` / Render Logs tab / `railway logs` — entrypoint prints
  `DATABASE_URL`, db-push result, and each process start.
- **DB care:** the SQLite file is the only state. The app prunes stale rows
  (6h maintenance) and truncates WAL; still, snapshot the volume or hit
  `/api/user/backup` periodically.
- **Schema changes on upgrade:** boot runs `prisma db push` (non-destructive by
  default). A knowingly destructive change needs `DB_PUSH_ACCEPT_DATA_LOSS=1`.
- **Memory:** `MEM_RSS_CEILING_MB` (default unset on Fly; Render Blueprint sets
  460 for its 512MB free plan) makes heavy endpoints 503-and-retry instead of
  being kernel-OOM-killed. On the 1GB Fly machine you can leave it unset.
- **Why not Vercel/Netlify?** Serverless has no persistent filesystem, no
  long-lived process for the engines, and no socket.io — this app is stateful
  by design (see the table at the top).
