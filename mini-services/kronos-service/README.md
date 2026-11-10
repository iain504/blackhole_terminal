# kronos-service — the PyTorch sidecar (deploy guide)

OHLCV foundation-model forecasting for BLACKHOLE Terminal
([shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos), AAAI 2026) behind
a tiny HTTP API:

```
GET  /health    → { ok, ready, loading, model, error, lanes, uptimeSec }
POST /forecast  → { ok, jobId }           (submit; returns immediately)
GET  /forecast?job=ID → { ok, done, result | error }
```

The terminal's server (`src/lib/kronos.ts`) is the reference client: it
submits real bars, polls the job, journals every forecast and grades it later
against the bar that actually printed. **The browser never talks to this
process directly** — it goes through `/api/kronos/*`.

## Why it is a separate service

Kronos is PyTorch; the terminal is Next.js/Bun. The sidecar owns the models
(Kronos-small 24.7M + Kronos-mini 4.1M) and the CPU decode loop. A forecast
costs ~8–50s of CPU — hence the job API (no held connections).

> **Hosted note (Render free tier):** the 512 MB web container CANNOT run
> torch in-process — that is why the chart shows "Not part of this deployment"
> there. Deploy this sidecar on any PyTorch-capable host and point the app at
> it with `KRONOS_URL`.

## Run it (dev box)

```bash
cd mini-services/kronos-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
HOST=127.0.0.1 PORT=3030 .venv/bin/python server.py
# default bind is 127.0.0.1:3030 — loopback only, the app is the sole caller
```

First boot downloads the tokenizer + model weights from Hugging Face into
`./hf-cache` (gitignored) and reports `loading: true` until ready.

## Run it anywhere else

The server binds `HOST`/`PORT` env (PaaS platforms inject `PORT`):

```bash
HOST=0.0.0.0 PORT=7860 python server.py
```

**Hugging Face Space (free CPU, recommended):** create a Docker Space, push
this folder as the repo root with a `Dockerfile` like:

```dockerfile
FROM python:3.12-slim
WORKDIR /svc
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV HOST=0.0.0.0 PORT=7860
EXPOSE 7860
CMD ["python", "server.py"]
```

Then in the terminal deployment (Render → Environment) set:

```
KRONOS_URL=https://<your-space>.hf.space
```

The app probes `<KRONOS_URL>/health`; the chart popover flips to the live
state once weights are loaded. Any other host works the same way (Fly.io,
Railway, a home box with `HOST=0.0.0.0` behind a tunnel, …).

## Honesty contract (this feeds trading decisions)

- Never fabricates bars: the caller supplies REAL context bars; demo data is
  refused upstream.
- No random-walk fallback: if the model isn't ready, callers get
  `{ available: false }` and the UI says so.
- Every forecast ships provenance (model id, context bars, samples, latency)
  and is journaled + later GRADED against the realized bar — the chart's
  "realized accuracy" line is the model's actual track record, per lane
  (mini vs small).
