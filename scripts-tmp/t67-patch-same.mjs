// Task 67 — repeat patch with the SAME value must hit the shortcut (no churn)
const { replaceExitOrderSmart } = await import('../src/lib/trading.ts')
const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const ID = '6dc1ce3a-ac8c-45b6-9931-32abe0e9b8e5' // NVDA trailing_stop, trail 2% (after revert)

const r = await replaceExitOrderSmart(UID, 'paper', ID, { trail_percent: 2, crypto: false })
console.log(JSON.stringify({ ok: !!r.data, method: r.method, note: r.note, trail: r.data?.trail_percent, id: r.data?.id, error: r.error }, null, 1))
// id must be UNCHANGED (no cancel+replace churn happened)
console.log(r.data?.id === ID ? 'PASS · same value → no churn' : 'FAIL · order was replaced')
