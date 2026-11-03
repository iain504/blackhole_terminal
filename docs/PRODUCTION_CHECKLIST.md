# Production checklist — BLACKHOLE Terminal

Pre-launch gates for a self-hosted deployment. Stack: Next.js 16 standalone (Bun), Prisma 6 + SQLite (`db/custom.db`), socket.io stream sidecar (`mini-services/stream-service`, :3030). Switching databases? Read [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md) first.

## 1. Secrets

- [ ] Generate two independent 32-byte hex secrets (run the command twice):

  ```bash
  bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- [ ] `AUTH_SECRET` — HMAC session-signing key. Required; boot refuses without it.
- [ ] `APP_ENCRYPTION_SECRET` — AES-256-GCM key for credentials at rest. **Set once and keep stable**: it protects `User.totpSecret` and the `*Enc` fields inside `User.settings` JSON (`alpacaKeyIdEnc`, `alpacaSecretEnc`, `telegramTokenEnc`).
- [ ] Both backed up offline (password manager / encrypted note). Losing the encryption secret = losing every stored credential.
- [ ] Rotation — only when actually needed (`bun scripts/rotate-secrets.mjs`):

  | Flag | What it does |
  | --- | --- |
  | `--auth` | New `AUTH_SECRET` in `.env` → invalidates all sessions |
  | `--encryption` | New key + re-encrypts **every** stored credential (`totpSecret` + `*Enc` settings fields) under AES-256-GCM; updates the `AppSecret` `master` row and the `.env` line |
  | `--all` | Both of the above |
  | `--force` | Proceed even if some rows are undecryptable (data loss). Default: abort |

- [ ] Rotate with the app **stopped** — no engine tick may run between the key change and re-encryption.
- [ ] Sessions are stateless HMAC cookies signed with the resolved app secret (`APP_ENCRYPTION_SECRET`, falling back to `AUTH_SECRET`, then the DB `master` row) — any rotation logs every user out.

## 2. Environment variables

| Variable | Production guidance |
| --- | --- |
| `DATABASE_URL` | **required** — `file:<absolute path>/db/custom.db` (absolute; relative `file:` URLs resolve against `prisma/`, not the repo root) |
| `AUTH_SECRET` / `APP_ENCRYPTION_SECRET` | **required** (see §1) |
| `ALLOW_REGISTRATION` | keep `false` — the first bootstrap account works on an empty user table regardless; after that, signups stay closed |
| `ALLOW_SHARED_BROKER` | `false` unless you deliberately share the env Alpaca keys with keyless users |
| `ENABLE_METRICS` | leave **off** unless a scraper pulls `GET /api/metrics` (Prometheus text format); `1` enables it |
| `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` | optional shared (paper) keys, only relevant with `ALLOW_SHARED_BROKER=true` |
| `PORT` | `bun run start` listen port (default 3000) |

- [ ] `.env` in place from `.env.example`; never committed (`.gitignore` already excludes it).

## 3. Database

- [ ] Schema applied: `bun run db:push`.
- [ ] Know the semantics: `db:push` is wired as `prisma db push --accept-data-loss` in `package.json` — pushes can drop columns/tables that left the schema. In production, back up first (below) or run `bunx prisma db push` bare to preview what would change.
- [ ] File permissions: `chmod 700 db && chmod 600 db/custom.db*`.
- [ ] Backup story: stop app (and stream) → copy the file. SQLite keeps uncheckpointed frames in WAL sidecars — copy all of `custom.db`, `custom.db-wal`, `custom.db-shm`, or checkpoint first with `sqlite3 db/custom.db 'PRAGMA wal_checkpoint(TRUNCATE);'`. Restore = stop → copy back → start. Schedule it (cron) and test one restore.

### 3b. Disk pressure & "Docker created a 20 GB file" (v2.8.4)

The in-app **Server storage → Reclaim space (VACUUM)** only rebuilds `custom.db` **inside the container**. It can never shrink these host-side files — find which one is big before blaming the db:

- [ ] **Identify the hog** (run on the docker host):
  - Linux: `docker system df -v` · `du -ah /var/lib/docker 2>/dev/null | sort -rh | head -20`
  - macOS Docker Desktop: `~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` (sparse — compare with `du -h`, not `ls -lh`)
  - Windows/WSL2: `%LOCALAPPDATA%\Docker\wsl\*\ext4.vhdx`
- [ ] **Container stdout log** (`/var/lib/docker/containers/<id>/<id>-json.log`): unbounded when the container was started with plain `docker run` (compose caps it at 3×10 MB since v2.5.1). A disk-full write-storm spams prisma errors and can eat gigabytes fast. Immediate relief: `truncate -s 0 <…>-json.log`. Permanent: recreate via `docker compose up -d --build` (or add the same `logging:` block to your `docker run`).
- [ ] **Docker VM disk image** (Docker.raw / ext4.vhdx): grows to the high-water mark of everything ever written and **never shrinks from inside** — even after VACUUM or `docker system prune`. Reclaim: Docker Desktop → Troubleshoot → **Clean / Purge data** (or newer builds compact automatically); WSL2: `wsl --shutdown` then `Optimize-VHD -Path … -Mode Full` (admin PowerShell) or `diskpart` → `compact vdisk`.
- [ ] **Build cache**: every `--build` leaves layers — `docker builder prune -f` routinely frees tens of GB on a machine that rebuilds often.
- [ ] Then, in-app: FSD tab → Server storage → the card shows **free disk, db/WAL sizes and the reclaimable freelist**. VACUUM pre-flights and refuses with exact numbers (HTTP 507) when the volume is too full to rebuild safely; purge buttons drop the bar cache / old logs / old forecasts first.

## 4. Build & run

- [ ] `bun run build` — standalone output (`.next/standalone` + static/public copy); `bun run start` — serves it (`PORT` env to override). systemd unit pair in the README.
- [ ] Or Docker Compose: `docker compose up -d --build`. Services: `app` on :3000 (volume `./db:/app/db`), `stream` (socket.io sidecar from `mini-services/stream-service`) on :3030; both `restart: unless-stopped`. Stream auto-starts with compose — **intentional** (per review) so the health `stream: up` check works out of the box.
- [ ] **After EVERY build, clean the build cache** — `scripts/docker-clean-cache.sh` (v2.9.0). Every `--build` leaves BuildKit layer cache that accumulates forever: **15.48 GB** of build cache was measured on a host whose active images totalled just 3.7 GB (db volume 39 MB). The script prunes cache only — images, containers and volumes are kept (`docker builder prune -f --keep-storage=2gb`; pass `full` to drop everything). Set-and-forget alternative: a GC policy in `/etc/docker/daemon.json` → `{"builder":{"gc":{"enabled":true,"defaultKeepStorage":"2GB"}}}`.

## 5. Reverse proxy

- [ ] TLS termination in front (Caddy auto-HTTPS, or nginx + certbot).
- [ ] WebSocket forwarding for socket.io (service path `/socket.io`, pass `Upgrade`/`Connection` headers).
- [ ] Two reachability conventions — document which one you run:
  1. **Same-origin gateway query** (sandbox convention; the repo `Caddyfile` on :81): browser connects to `/?XTransformPort=3030` on the app origin and the proxy routes that query to :3030.
  2. **Plain deployment**: browser reaches the stream service directly on :3030 (compose) or a domain proxy maps a path/host to it (README's `handle @stream` Caddyfile example). Use this outside the sandbox gateway.
- [ ] Do **not** expose :3030 publicly unless socket.io is needed externally — every handshake is authenticated against the app session cookie (invalid sockets drop to guest mode: public crypto only).
- No proxy at all also works — the terminal falls back to REST polling (status chip shows *Polling*).

## 6. Health & monitoring

- [ ] `GET /api/health` — unauthenticated probe. `200 {status:'ok'}` (DB reachable) / `503 {status:'degraded'}`; 5s in-process cache dedupes hammering monitors. Non-sensitive fields: `status`, `uptimeSec`, `memoryMB`, `heapMB`, `db`, `algoRuns`, `gridRuns`, `recoAgeMin`, `stream`, `rateLimitStore`, `version`, `sha`, `ts`.
- [ ] `GET /api/metrics` — Prometheus text format; only served when `ENABLE_METRICS=1`.
- [ ] Log monitoring: `journalctl -u blackhole -f` (systemd) or `docker logs -f app` (compose). Server lines are structured JSON — `{t, lvl, evt, …}` from `src/lib/logger.ts` — greppable by `evt` / `lvl`.

## 7. Security hardening

- [ ] TOTP mandatory: registration enrolls 2FA (QR + authenticator); logins need password + 6-digit code.
- [ ] Passwords hashed with scrypt (per-user salt, 64-byte) — never stored plaintext.
- [ ] Credentials at rest are AES-256-GCM (`enc:`-prefixed ciphertext); broker keys / TOTP secrets / Telegram tokens never reach the browser.
- [ ] Sessions are HMAC-signed stateless cookies — no session table to leak.
- [ ] Rate limits are persisted in the DB (`RateLimitBucket` table) — a restart no longer resets brute-force windows.
- [ ] Register endpoint is anti-enumeration: an existing username gets a fake-success response.
- [ ] `ALLOW_REGISTRATION=false` in production (after your own account exists).
- [ ] Site behind TLS; :3030 not publicly reachable (§5).
- [ ] Real `.env` never committed; a leaked provider key gets rotated at the provider, a leaked app secret via §1.

## 8. Trading safety

- [ ] **Alpaca PAPER keys first** (alpaca.markets → Paper Trading → Generate keys). This tool places real orders through whatever keys you configure.
- [ ] Verify the account endpoint matches expectation: `GET /api/trading/account` returns the paper account you intend to trade.
- [ ] Before go-live, review active engines — the algo and grid engines place real (paper) orders and **auto-resume after restarts**:

  ```sql
  SELECT id, userId, symbol, strategy, qty, status FROM AlgoRun  WHERE status='running';
  SELECT id, userId, symbol, qtyPerGrid,  status FROM GridTrade WHERE status='active';
  ```

- [ ] Stop/delete stale rows; sanity-check guards per run: `maxTradesDay` / `flattenEod` (algo), `maxSL` / `maxTP` / `closeOnStop` (grid).

## 9. Upgrade procedure

```bash
git pull && bun install
bun run db:push        # backup db/ first (§3)
bun run build
# restart: systemctl restart blackhole blackhole-stream  — or —  docker compose up -d --build
```

- [ ] Version stamp for support questions: `src/generated/version.ts` (re-stamped by prebuild; `APP_VERSION.display`, e.g. `v1.80.0+138`) — echoed by `/api/health` as `version` + `sha`.

## 10. Rollback

- [ ] Keep the previous artifact: rename the old `.next/standalone` aside before building, or pin the previous image tag.
- [ ] DB backup taken **before** every `db:push` — schema pushes can be destructive and `--accept-data-loss` exists precisely for that; never casual in production.
- [ ] Rollback = stop → restore `db/custom.db` backup → run previous standalone/image → start.
