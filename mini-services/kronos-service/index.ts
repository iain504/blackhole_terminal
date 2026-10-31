// kronos-service process supervisor (bun) — mini-services contract:
// independent project, own port (3030), `bun run dev` entry, auto-restart.
//
// The actual service is Python (PyTorch — Kronos cannot run in TS). This
// wrapper spawns `python3 server.py`, streams its stdout/stderr into the
// console, restarts it with backoff if it dies, and forwards SIGINT/SIGTERM.
const CHILD = 'python3'
const SCRIPT = new URL('./server.py', import.meta.url).pathname

let child: ReturnType<typeof Bun.spawn> | null = null
let restarting = false
let backoffMs = 1500

function spawn(): void {
  console.log(`[kronos-supervisor] starting ${CHILD} ${SCRIPT}`)
  child = Bun.spawn([CHILD, SCRIPT], {
    cwd: new URL('.', import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  child.exited.then((code) => {
    if (restarting) return
    console.error(`[kronos-supervisor] service exited (code ${code}) — restarting in ${backoffMs}ms`)
    setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, 15000)
      spawn()
    }, backoffMs)
  })
}

function shutdown(): void {
  restarting = true
  try { child?.kill('SIGTERM') } catch { /* already gone */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

spawn()
// keep the event loop alive
setInterval(() => {}, 60_000)
