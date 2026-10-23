// Task 83 research round 2: ORB mechanics + day trade plan/checklist structure
import ZAI from 'z-ai-web-dev-sdk'

const queries = [
  'opening range breakout 5 minute 15 minute strategy win rate first 30 minutes',
  'previous day high low pivot points day trading levels importance',
  'day trading plan checklist entry stop take profit risk reward rules',
]

const zai = await ZAI.create()
for (const q of queries) {
  try {
    const r = await zai.functions.invoke('web_search', { query: q, num: 6 })
    console.log('\n=== QUERY:', q, '===')
    for (const it of r ?? []) {
      console.log(`- [${it.host_name}] ${it.name}`)
      console.log(`  ${String(it.snippet || '').replace(/\s+/g, ' ').slice(0, 260)}`)
    }
  } catch (e) {
    console.log('SEARCH FAILED:', q, e?.message ?? e)
  }
}
