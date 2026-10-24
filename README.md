<div align="center">

<img src="public/hero-blackhole.png" alt="BLACKHOLE Terminal" width="840"/>

# BLACKHOLE Terminal

**A self-hostable, TradingView-style trading terminal — charts, watchlists, algo trading, backtesting and live market data in one dark little universe.**

Paper trading · Algo engine · Backtests · Live crypto & US-equity data · Optional 2FA

`Next.js 16` · `TypeScript` · `Tailwind CSS 4` · `shadcn/ui` · `Prisma + SQLite` · `lightweight-charts` · `socket.io`

</div>

---

## What is this?

BLACKHOLE Terminal is a full trading workstation you can run on your own machine:

- **Multi-pane charts** (lightweight-charts) with drawings, symbol search and position markers
- **Watchlists, quotes and news** side panels
- **Order entry** with brackets / OCO / OTO and stop-loss management against **Alpaca** (paper trading recommended)
- **An algo engine** that runs your strategy rules live (start / stop / per-run settings) with Telegram fill notifications
- **Backtesting** — single runs, parameter optimization and "test all strategies" sweeps, plus watchlist-driven *Recommended Setups*
- **Economic calendar with alarms, heat map, positions, strategy orders and a report tab**
- **Real-time streaming** for crypto (Binance, keyless) and US equities (Alpaca), multiplexed over a single websocket per account

Everything is stored locally in a single SQLite file. No cloud, no telemetry, no fabricated prices — symbols without a live upstream simply don't stream.

## Requirements

| Tool | Version | Why |
| --- | --- | --- |
| [Bun](https://bun.sh) | ≥ 1.1 | Runtime + package manager (scripts call `bun` directly) |
| OS | Linux / macOS / WSL2 | `sqlite`, `bash` and a Caddy/nginx reverse proxy (optional) |

> Node.js is *not* required — Bun alone runs the app, the DB tooling and the streaming service.

## Quick start (≈ 5 minutes)

```bash
# 1 — clone & install
git clone https://github.com/iain504/blackhole_terminal.git
cd blackhole_terminal
bun install

# 2 — create the DB directory and configure the environment
mkdir -p db
cp .env.example .env

# generate two secrets (print each twice, paste into .env)
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

#   Minimum .env for local use:
#   DATABASE_URL=file:$PWD/db/custom.db      ← absolute path!
#   AUTH_SECRET=<32-byte hex from above>
#   APP_ENCRYPTION_SECRET=<32-byte hex from above>

# 3 — create the SQLite schema
bun run db:push

# 4 — run it
bun run dev                       # → http://localhost:3000
```

> **Why an absolute `DATABASE_URL`?** Prisma resolves relative `file:` URLs against `prisma/schema.prisma`, not the repo root — an absolute path avoids the classic "database file appears in the wrong folder" trap.

Open **http://localhost:3000** — the landing page's **Login** button takes you to the terminal.

## First run

1. **Create the first account** — a fresh install with an empty user table always allows the *first* registration (bootstrap), even with registration closed. After that, new signups are controlled by `ALLOW_REGISTRATION` (default: **off**).
2. **Enroll 2FA** — you'll be asked to scan a QR code with any TOTP authenticator (Google Authenticator, Aegis, 1Password…). Logins then require a 6-digit code.
3. **Add your Alpaca keys** — *Settings → Alpaca API keys*. Keys are validated with a live request and stored **encrypted at rest** (AES-256-GCM). They never reach the browser; the streaming service resolves them server-side from your session.

## Connecting market data & a broker

| Market | Data source | Keys needed |
| --- | --- | --- |
| Crypto (`BTC/USD`, `ETH/USD`, `SOL/USD`…) | Binance public REST + WebSocket | **None** — works out of the box |
| US equities & ETFs (`AAPL`, `TSLA`, `SPY`…) | Alpaca data API | Alpaca keys (the free IEX plan is enough) |
| Order execution | Alpaca trade API | Alpaca keys — **paper keys recommended** |

- Get free paper-trading keys at [alpaca.markets](https://alpaca.markets) → *Paper Trading* → *Generate keys*.
- Without Alpaca keys, equity charts fall back to clearly-labeled demo data; crypto keeps working fully.
- Alternatively, provide shared keys via env (`APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`) and set `ALLOW_SHARED_BROKER=true` so users *without* their own keys can trade on them.

## Environment variables (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — (**required**) | SQLite path, e.g. `file:/abs/path/db/custom.db` |
| `AUTH_SECRET` | — (**required**, boot refuses without it) | HMAC-SHA256 session-cookie signing key (32-byte hex) |
| `APP_ENCRYPTION_SECRET` | falls back to `AUTH_SECRET`, then an auto-generated DB master | AES-256-GCM key for credentials at rest (Alpaca keys, TOTP secrets, Telegram tokens). **Set once and keep stable** — rotating it makes stored credentials undecryptable |
| `ALLOW_REGISTRATION` | `false` | Allow new signups after the first bootstrap account |
| `ALLOW_SHARED_BROKER` | `false` | Permit trading with the env-configured shared Alpaca keys when a user has none of their own |
| `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` | — | Optional *shared* Alpaca keys (paper recommended) |
| `DEBUG_DB` | — | Set to `1` to log Prisma queries |

Full template with comments: [`.env.example`](.env.example).

## Real-time streaming (optional but nice)

The terminal streams live ticks through a small sidecar service (`mini-services/stream-service`, socket.io on **port 3030**) that multiplexes **one** Binance websocket and **one** Alpaca iex websocket per account (Alpaca allows only one market-data connection per key). Without it the terminal still works — the status chip shows **Polling** (REST fallback) instead of **Live**.

```bash
cd mini-services/stream-service
bun install
bun index.ts        # listens on :3030, pairs with the app on :3000
```

The browser connects to `/?XTransformPort=3030` **on the same origin** — so a reverse proxy must route that query to port 3030. The repo ships a matching [Caddyfile](Caddyfile); for a real domain it looks like this:

```caddyfile
your.domain.com {
    @stream query XTransformPort=3030
    handle @stream {
        reverse_proxy 127.0.0.1:3030
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

No proxy at all? Everything works — you just get REST polling instead of live ticks.

## Production deployment

```bash
bun run build        # next build (standalone output) + static asset copy
bun run start        # serves .next/standalone on :3000 (PORT env to override)
```

A minimal systemd unit pair:

```ini
# /etc/systemd/system/blackhole.service
[Unit]
Description=BLACKHOLE Terminal (Next.js)
After=network.target

[Service]
WorkingDirectory=/opt/blackhole_terminal
ExecStart=/usr/local/bin/bun run start
Restart=always
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target

# /etc/systemd/system/blackhole-stream.service
[Service]
WorkingDirectory=/opt/blackhole_terminal/mini-services/stream-service
ExecStart=/usr/local/bin/bun index.ts
Restart=always
```

Then `systemctl enable --now blackhole blackhole-stream` and put Caddy/nginx in front (see above).

## Useful scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev server on `:3000` (logs to `dev.log`) |
| `bun run build` / `bun run start` | Production build / serve (standalone) |
| `bun run db:push` | Apply `prisma/schema.prisma` to the SQLite file |
| `bun run db:generate` | Regenerate the Prisma client |
| `bun run lint` | ESLint |

## Troubleshooting

- **App refuses to boot** → `AUTH_SECRET` is missing from `.env`.
- **Equity charts show demo data / "no historical data"** → no Alpaca keys configured (crypto still works keyless).
- **Status chip says *Polling* instead of *Live*** → `stream-service` isn't running, or your reverse proxy doesn't map `?XTransformPort=3030` to port 3030.
- **SQLite file created in the wrong place** → `DATABASE_URL` must be an absolute `file:` path (see Quick start).
- **Heavy backtest sweeps on a small VPS** → sweeps are heap-guarded and will return a polite *503 / retry* rather than die; give the Node process ~2 GB (`NODE_OPTIONS=--max-old-space-size=1800`) for comfortable use. Recommended-setups refresh sweeps **your watchlist** (max 10 symbols × 3 timeframes).
- **Port 3000 busy** → `PORT=3001 bun run dev` won't help the dev script (it pins 3000); stop the other process or edit `package.json`.

## Security notes

- **Use paper-trading keys first.** This is a personal trading tool, not an audited exchange.
- Per-user broker keys, TOTP secrets and Telegram tokens are encrypted at rest with `APP_ENCRYPTION_SECRET`; session cookies are HMAC-signed.
- The streaming sidecar authenticates every socket handshake against the app's session cookie — invalid sockets drop to a restricted guest mode (public crypto only).
- Never commit your real `.env` (`.gitignore` already excludes it). If a key ever leaks into git history, **rotate it** at the provider.

## Project structure

```
src/app/            Next.js App Router (terminal page + /api routes)
src/components/     terminal UI (tabs, chart, sidebar, mobile shell), shadcn/ui, landing
src/lib/            domain logic: algo engine, backtest, indicators, alpaca/binance
                    clients, auth + TOTP, crypto-at-rest, memory guards
mini-services/      stream-service (socket.io live ticks, port 3030)
prisma/             schema.prisma (SQLite)
db/                 custom.db (created by db:push, git-ignored)
```

## Disclaimer

This project is for **personal, educational use**. Nothing in it is financial advice. Trading involves risk — run it against Alpaca **paper** accounts until you fully trust your configurations.

---

<div align="center">
<sub>Built with Next.js 16, TypeScript, Tailwind CSS 4, shadcn/ui, Prisma, lightweight-charts and socket.io.</sub>
</div>
