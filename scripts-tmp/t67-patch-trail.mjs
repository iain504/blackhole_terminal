// Task 67 — test replaceExitOrderSmart on a real trailing_stop order
// (NVDA sell trail 2%): PATCH 2% -> 2.5% -> back to 2%.
const { replaceExitOrderSmart } = await import('../src/lib/trading.ts')
const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const ID = '3daf6405-88dc-4f0f-8cfe-26233f087ab9' // NVDA trailing_stop, trail 2%

console.log('--- PATCH trail 2.5% ---')
const r1 = await replaceExitOrderSmart(UID, 'paper', ID, { trail_percent: 2.5, crypto: false })
console.log(JSON.stringify({ ok: !!r1.data, status: r1.status, method: r1.method, mode: r1.mode, note: r1.note, error: r1.error, trail: r1.data?.trail_percent, newId: r1.data?.id, stop: r1.data?.stop_price }, null, 1))

const newId = r1.data?.id ?? ID
console.log('--- revert trail 2% ---')
const r2 = await replaceExitOrderSmart(UID, 'paper', newId, { trail_percent: 2, crypto: false })
console.log(JSON.stringify({ ok: !!r2.data, status: r2.status, method: r2.method, note: r2.note, error: r2.error, trail: r2.data?.trail_percent, newId: r2.data?.id, stop: r2.data?.stop_price }, null, 1))
