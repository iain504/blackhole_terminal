// v2.4.0 — Nebula Autopilot scan universe.
//
// AGENT_US_100: the 100 most-notable, high-volume US names — mega-cap tech,
// semis, AI/quantum movers, EVs, finance, energy, consumer, industrials and
// the liquid leveraged ETFs — curated for the autopilot scanner. Every ticker
// resolves on the Alpaca iex feed and trades through the existing algo engine.
// Crypto rides the app's CRYPTO_UNIVERSE (Alpaca v1beta3 crypto/us majors,
// traded BTC/USD-style through the same broker path).

import { CRYPTO_UNIVERSE } from '@/lib/market-types'

export const AGENT_US_100: string[] = [
  // Mega-Cap Tech (12)
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'NFLX', 'AMD', 'INTC', 'MU',
  // Semiconductors (8)
  'QCOM', 'TXN', 'AMAT', 'MRVL', 'LRCX', 'ADI', 'ON', 'TSM',
  // Software & Internet (10)
  'ORCL', 'CRM', 'ADBE', 'UBER', 'ABNB', 'SQ', 'PYPL', 'SHOP', 'SNOW', 'DDOG',
  // AI / Quantum / High-VOL movers (12)
  'PLTR', 'SMCI', 'COIN', 'HOOD', 'MSTR', 'SOFI', 'AI', 'SOUN', 'BBAI', 'IONQ', 'RGTI', 'QBTS',
  // EV & Future Mobility (8)
  'F', 'GM', 'RIVN', 'LCID', 'NIO', 'ACHR', 'JOBY', 'RKLB',
  // Space & Defense (4)
  'LUNR', 'ASTS', 'RTX', 'LMT',
  // Finance (8)
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'V', 'MA',
  // Healthcare (6)
  'UNH', 'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV',
  // Energy (5)
  'XOM', 'CVX', 'COP', 'OXY', 'SLB',
  // Consumer (9)
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'DIS',
  // Industrials (6)
  'BA', 'CAT', 'DE', 'GE', 'HON', 'UPS',
  // Telecom (4)
  'T', 'VZ', 'TMUS', 'CMCSA',
  // Liquid ETFs (8)
  'SPY', 'QQQ', 'IWM', 'TQQQ', 'SOXL', 'SQQQ', 'UVXY', 'ARKK',
]

/** Exactly 100 — the autopilot's headline number, asserted by a probe test. */
export const AGENT_US_100_COUNT = AGENT_US_100.length

export function agentUniverse(includeCrypto: boolean): { symbol: string; isCrypto: boolean }[] {
  const out = AGENT_US_100.map((s) => ({ symbol: s, isCrypto: false }))
  if (includeCrypto) {
    out.push(...CRYPTO_UNIVERSE.map((s) => ({ symbol: s, isCrypto: true })))
  }
  return out
}
