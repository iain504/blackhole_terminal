# Kronos sidecar service — OHLCV foundation-model forecasting for blackhole_terminal.
#
# Wraps shiyu-coder/Kronos (AAAI 2026) behind a tiny HTTP API:
#   GET  /health   → { ok, ready, loading, model, error }
#   POST /forecast → probabilistic multi-step OHLCV forecast
#
# WHY A SIDECAR: Kronos is PyTorch; the terminal is Next.js/TS. This process owns
# the model (~100MB RAM for Kronos-small) and the CPU-heavy decode loop, the app
# stays a thin client. Port 3030 is LOCAL ONLY (bound to 127.0.0.1) — the Next.js
# backend is the sole caller; browsers never reach this process directly.
#
# HONESTY CONTRACT (this service is used for trading decisions):
#  - never fabricate bars: the caller supplies the REAL context bars; we only
#    reject/clip. No random-walk fallback: if the model isn't ready we say so.
#  - every forecast ships provenance: model id, context bars used, sample count,
#    wall latency. The UI displays them.
#  - the sample axis is PRESERVED (unlike upstream predict() which averages it
#    away) so the UI can draw p10/p50/p90 bands and P(up) from real paths.
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

# keep the HF cache inside the service dir (survives restarts, gitignored)
os.environ.setdefault('HF_HOME', os.path.join(BASE, 'hf-cache'))
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

import numpy as np                       # noqa: E402
import pandas as pd                      # noqa: E402
import torch                             # noqa: E402

MODEL_ID = os.environ.get('KRONOS_MODEL', 'NeoQuasar/Kronos-small')
TOKENIZER_ID = os.environ.get('KRONOS_TOKENIZER', 'NeoQuasar/Kronos-Tokenizer-base')
FAST_MODEL_ID = 'NeoQuasar/Kronos-mini'
FAST_TOKENIZER_ID = 'NeoQuasar/Kronos-Tokenizer-2k'
# CPU latency: decode cost ∝ context × steps. 384 bars of context is plenty of
# signal for a 12-48 bar horizon and keeps a small-model forecast in the
# ~20-40s band on this 2-core box (512 → ~80s, too slow for chart UX).
DEFAULT_CONTEXT = int(os.environ.get('KRONOS_DEFAULT_CONTEXT', '384'))
MAX_HORIZON = 64
MAX_SAMPLES = 16

STATE = {
    'ready': False,
    'loading': False,
    'error': None,
    'model': MODEL_ID,
    'bootedAt': time.time(),
}
LOCK = threading.Lock()      # serializes inference (CPU-only box, one at a time)
JOB_LOCK = threading.Lock()  # guards the job registry

# ---------------------------------------------------------------------------
# Job registry — forecasts can run 30-90s on this CPU, and held HTTP
# connections get reset by aggressive client stacks (observed with bun fetch
# ~70s). So /forecast ACCEPTS the job and returns immediately; the caller
# polls /forecast?job=ID. Results are kept 15min (bounded registry).
# ---------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
JOB_TTL_SEC = 900
JOB_MAX = 40
# primary = quality lane, fast = throughput lane (gate A/B, batches)
MODELS = {
    'small': {'id': MODEL_ID, 'tokenizer_id': TOKENIZER_ID, 'predictor': None, 'tokenizer': None, 'max_context': 512},
    'mini': {'id': FAST_MODEL_ID, 'tokenizer_id': FAST_TOKENIZER_ID, 'predictor': None, 'tokenizer': None, 'max_context': 2048},
}


def load_one(slot):
    from model import Kronos, KronosTokenizer  # vendored from shiyu-coder/Kronos
    t0 = time.time()
    tok = KronosTokenizer.from_pretrained(slot['tokenizer_id'])
    mdl = Kronos.from_pretrained(slot['id'])
    slot['tokenizer'] = tok
    slot['predictor'] = mdl
    print(f'[kronos] {slot["id"]} ready in {time.time() - t0:.1f}s', flush=True)


def load_model():
    STATE['loading'] = True
    try:
        torch.set_num_threads(max(1, (os.cpu_count() or 2)))
        load_one(MODELS['small'])
        STATE['ready'] = True
        try:
            load_one(MODELS['mini'])
        except Exception as e:  # noqa: BLE001 — mini is the fast lane, not critical
            print(f'[kronos] fast lane (mini) unavailable: {e}', flush=True)
            MODELS['mini']['predictor'] = None
        STATE['loading'] = False
        print('[kronos] all lanes loaded', flush=True)
    except Exception as e:  # noqa: BLE001 — the app must see the REAL error
        STATE['loading'] = False
        STATE['error'] = f'{type(e).__name__}: {e}'
        print(f'[kronos] FAILED to load model: {STATE["error"]}', flush=True)


# ---------------------------------------------------------------------------
# Sample-preserving inference.
#
# This is upstream's auto_regressive_inference (model/kronos.py @ 2025-11) with
# ONE change: the per-sample axis is NOT averaged away at the end. Upstream
# returns mean(paths); we need the distribution for bands + P(up). The decode
# loop, token buffers and rolling window are byte-for-byte the same logic.
# ---------------------------------------------------------------------------
def predict_samples(tokenizer, model, x, x_stamp, y_stamp, max_context, pred_len,
                    clip=5, T=1.0, top_k=0, top_p=0.9, sample_count=8):
    from model.kronos import sample_from_logits
    with torch.no_grad():
        x = torch.clip(x, -clip, clip)
        x = x.unsqueeze(1).repeat(1, sample_count, 1, 1).reshape(-1, x.size(1), x.size(2))
        x_stamp = x_stamp.unsqueeze(1).repeat(1, sample_count, 1, 1).reshape(-1, x_stamp.size(1), x_stamp.size(2))
        y_stamp = y_stamp.unsqueeze(1).repeat(1, sample_count, 1, 1).reshape(-1, y_stamp.size(1), y_stamp.size(2))

        x_token = tokenizer.encode(x, half=True)
        initial_seq_len = x.size(1)
        batch_size = x_token[0].size(0)
        total_seq_len = initial_seq_len + pred_len
        full_stamp = torch.cat([x_stamp, y_stamp], dim=1)

        generated_pre = x_token[0].new_empty(batch_size, pred_len)
        generated_post = x_token[1].new_empty(batch_size, pred_len)
        pre_buffer = x_token[0].new_zeros(batch_size, max_context)
        post_buffer = x_token[1].new_zeros(batch_size, max_context)
        buffer_len = min(initial_seq_len, max_context)
        if buffer_len > 0:
            start_idx = max(0, initial_seq_len - max_context)
            pre_buffer[:, :buffer_len] = x_token[0][:, start_idx:start_idx + buffer_len]
            post_buffer[:, :buffer_len] = x_token[1][:, start_idx:start_idx + buffer_len]

        for i in range(pred_len):
            current_seq_len = initial_seq_len + i
            window_len = min(current_seq_len, max_context)
            if current_seq_len <= max_context:
                input_tokens = [pre_buffer[:, :window_len], post_buffer[:, :window_len]]
            else:
                input_tokens = [pre_buffer, post_buffer]
            context_end = current_seq_len
            context_start = max(0, context_end - max_context)
            current_stamp = full_stamp[:, context_start:context_end, :].contiguous()

            s1_logits, context = model.decode_s1(input_tokens[0], input_tokens[1], current_stamp)
            s1_logits = s1_logits[:, -1, :]
            sample_pre = sample_from_logits(s1_logits, temperature=T, top_k=top_k, top_p=top_p, sample_logits=True)
            s2_logits = model.decode_s2(context, sample_pre)
            s2_logits = s2_logits[:, -1, :]
            sample_post = sample_from_logits(s2_logits, temperature=T, top_k=top_k, top_p=top_p, sample_logits=True)

            generated_pre[:, i] = sample_pre.squeeze(-1)
            generated_post[:, i] = sample_post.squeeze(-1)
            if current_seq_len < max_context:
                pre_buffer[:, current_seq_len] = sample_pre.squeeze(-1)
                post_buffer[:, current_seq_len] = sample_post.squeeze(-1)
            else:
                pre_buffer.copy_(torch.roll(pre_buffer, shifts=-1, dims=1))
                post_buffer.copy_(torch.roll(post_buffer, shifts=-1, dims=1))
                pre_buffer[:, -1] = sample_pre.squeeze(-1)
                post_buffer[:, -1] = sample_post.squeeze(-1)

        full_pre = torch.cat([x_token[0], generated_pre], dim=1)
        full_post = torch.cat([x_token[1], generated_post], dim=1)
        context_start = max(0, total_seq_len - max_context)
        input_tokens = [
            full_pre[:, context_start:total_seq_len].contiguous(),
            full_post[:, context_start:total_seq_len].contiguous(),
        ]
        # (sample_count, total_len, feat) — SAMPLE AXIS PRESERVED (no mean)
        z = tokenizer.decode(input_tokens, half=True)
        return z[:, -pred_len:, :].cpu().numpy()


def bars_to_df(bars, market):
    """[{t,o,h,l,c,v}] unix-sec → (df[x 6cols], x_ts naive-datetime, ctx_len).

    Time features (minute/hour/weekday/…) are LOCAL-NAIVE: stocks get
    America/New_York (the trading-session clock the bars actually live on),
    crypto gets UTC (24h market). """
    cols = ['open', 'high', 'low', 'close', 'volume', 'amount']
    n = len(bars)
    tz = 'UTC' if market == 'crypto' else 'America/New_York'
    ts_naive = pd.to_datetime([b['t'] for b in bars], unit='s', utc=True).tz_convert(tz).tz_localize(None)
    arr = np.zeros((n, 6), dtype=np.float64)
    for i, b in enumerate(bars):
        arr[i] = [b['o'], b['h'], b['l'], b['c'], max(0.0, float(b.get('v') or 0)), 0.0]
    df = pd.DataFrame(arr, columns=cols)
    # amount ≈ volume × typical price (upstream fills it the same way when absent)
    df['amount'] = df['volume'] * df[['open', 'high', 'low', 'close']].mean(axis=1)
    # sanitize: the tokenizer requires finite values
    df = df.replace([np.inf, -np.inf], 0.0).fillna(0.0)
    return df, ts_naive, n


def run_forecast(payload):
    t0 = time.time()
    bars = payload.get('bars') or []
    if len(bars) < 64:
        return {'ok': False, 'error': f'need >= 64 context bars, got {len(bars)}'}
    horizon = max(1, min(int(payload.get('horizon') or 24), MAX_HORIZON))
    samples = max(2, min(int(payload.get('samples') or 8), MAX_SAMPLES))
    market = payload.get('market') or 'stock'
    tf_sec = int(payload.get('tfSec') or 300)
    temperature = float(payload.get('temperature') or 0.7)
    top_p = float(payload.get('topP') or 0.9)
    ctx = int(payload.get('context') or DEFAULT_CONTEXT)
    lane = 'mini' if payload.get('model') == 'mini' else 'small'
    if MODELS[lane]['predictor'] is None:
        lane = 'small'
        if MODELS['small']['predictor'] is None:
            return {'ok': False, 'error': STATE['error'] or 'model not ready yet'}
    slot = MODELS[lane]

    bars = bars[-slot['max_context']:]
    if ctx:
        bars = bars[-ctx:]
    df, x_ts, n = bars_to_df(bars, market)
    # future timestamps: step tf_sec from the last bar (display-only; the model
    # only consumes the calendar features minute/hour/weekday/day/month)
    last_t = bars[-1]['t']
    tz = 'UTC' if market == 'crypto' else 'America/New_York'
    y_ts = pd.to_datetime([last_t + tf_sec * (i + 1) for i in range(horizon)], unit='s', utc=True).tz_convert(tz).tz_localize(None)

    with LOCK:
        if not STATE['ready']:
            return {'ok': False, 'error': 'model not ready'}
        x = df[['open', 'high', 'low', 'close', 'volume', 'amount']].values.astype(np.float32)
        x_mean, x_std = np.mean(x, axis=0), np.std(x, axis=0)
        xn = np.clip((x - x_mean) / (x_std + 1e-5), -5, 5)
        xt = torch.from_numpy(xn[np.newaxis, :])
        xst = torch.from_numpy(np.stack([
            x_ts.minute.values, x_ts.hour.values, x_ts.day_of_week.values,  # day_of_week: .weekday was removed in pandas 4 (same values, Mon=0)
            x_ts.day.values, x_ts.month.values], axis=1).astype(np.float32)[np.newaxis, :])
        yst = torch.from_numpy(np.stack([
            y_ts.minute.values, y_ts.hour.values, y_ts.day_of_week.values,
            y_ts.day.values, y_ts.month.values], axis=1).astype(np.float32)[np.newaxis, :])

        max_ctx = slot['max_context']
        # temperature/top_p feed the token-sampling step — see vendored
        # predict_samples() (mirrors upstream auto_regressive_inference)
        raw = predict_samples(
            slot['tokenizer'], slot['predictor'], xt, xst, yst,
            max_ctx, horizon, clip=5, T=temperature, top_k=0, top_p=top_p,
            sample_count=samples)
        # (samples, horizon, 6) in NORMALIZED space → denormalize per-sample
        raw = raw * (x_std + 1e-5) + x_mean

    last_close = float(bars[-1]['c'])
    closes = raw[:, :, 3]                       # (samples, horizon)
    p10 = np.percentile(closes, 10, axis=0)
    p50 = np.percentile(closes, 50, axis=0)
    p90 = np.percentile(closes, 90, axis=0)
    up_prob = float(np.mean(closes[:, -1] > last_close))
    # median sample = the path whose FINAL close is the median → consistent OHLC
    order = np.argsort(closes[:, -1])
    med_idx = int(order[len(order) // 2])
    med_path = raw[med_idx]                      # (horizon, 6)
    # per-sample ATR-ish volatility measure of the horizon-end spread (in %)
    band_pct = float(np.mean((p90 - p10) / np.maximum(p50, 1e-9)) * 100)

    return {
        'ok': True,
        'model': slot['id'],
        'maxContext': max_ctx,
        'contextBars': n,
        'horizon': horizon,
        'samples': samples,
        'tfSec': tf_sec,
        'market': market,
        'lastClose': last_close,
        'lastTime': int(last_t),
        'times': [int(last_t + tf_sec * (i + 1)) for i in range(horizon)],
        'closeP10': [round(float(v), 6) for v in p10],
        'closeP50': [round(float(v), 6) for v in p50],
        'closeP90': [round(float(v), 6) for v in p90],
        'pathOpen': [round(float(v), 6) for v in med_path[:, 0]],
        'pathHigh': [round(float(v), 6) for v in med_path[:, 1]],
        'pathLow': [round(float(v), 6) for v in med_path[:, 2]],
        'pathClose': [round(float(v), 6) for v in med_path[:, 3]],
        'upProb': round(up_prob, 4),
        'bandPct': round(band_pct, 3),
        'latencyMs': int((time.time() - t0) * 1000),
    }


def gc_jobs():
    now = time.time()
    with JOB_LOCK:
        for jid in [j for j, v in JOBS.items() if now - v['created'] > JOB_TTL_SEC]:
            JOBS.pop(jid, None)
        while len(JOBS) > JOB_MAX:
            oldest = min(JOBS, key=lambda j: JOBS[j]['created'])
            JOBS.pop(oldest, None)


def start_forecast_job(payload):
    gc_jobs()
    jid = f'kf_{int(time.time() * 1000):x}_{os.getpid() % 97}'
    job = {'id': jid, 'created': time.time(), 'done': False, 'result': None, 'startedAt': None}
    with JOB_LOCK:
        JOBS[jid] = job

    def work():
        job['startedAt'] = time.time()
        try:
            job['result'] = run_forecast(payload)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job['result'] = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
        job['done'] = True

    threading.Thread(target=work, daemon=True).start()
    return {'ok': True, 'jobId': jid, 'queued': True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet default access log
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/health', '/'):
            lanes = {k: bool(v['predictor'] is not None) for k, v in MODELS.items()}
            self._json(200, {'ok': True, **STATE, 'lanes': lanes,
                             'uptimeSec': int(time.time() - STATE['bootedAt'])})
            return
        if self.path.startswith('/forecast'):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            jid = (qs.get('job') or [None])[0]  # type: ignore[list-item]
            if not jid or jid not in JOBS:
                return self._json(404, {'ok': False, 'error': 'unknown job'})
            job = JOBS[jid]
            out = {'ok': True, 'done': job['done'], 'jobId': jid,
                   'waitedSec': round(time.time() - job['created'], 1)}
            if job['done']:
                out['result'] = job['result']
            return self._json(200, out)
        self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if self.path != '/forecast':
            return self._json(404, {'ok': False, 'error': 'not found'})
        try:
            n = int(self.headers.get('content-length') or 0)
            payload = json.loads(self.rfile.read(n) or b'{}')
            self._json(200, start_forecast_job(payload))
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {'ok': False, 'error': f'{type(e).__name__}: {e}'})


def main():
    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', 3030), Handler)
    print('[kronos] sidecar listening on 127.0.0.1:3030 (model loading in background)', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
