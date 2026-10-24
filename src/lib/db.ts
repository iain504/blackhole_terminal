import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  // Per-query logging floods dev.log — enable explicitly with DEBUG_DB=1.
  const client = new PrismaClient({
    log: process.env.DEBUG_DB === '1' ? ['query'] : ['error', 'warn'],
  })
  // SQLite tuning (once per client): WAL = concurrent readers don't block the
  // writer; busy_timeout avoids spurious "database is locked" errors under the
  // multi-tab terminal. Non-fatal: if the pragma fails (e.g. locked file at
  // boot) we continue with SQLite defaults. Uses $queryRawUnsafe because
  // PRAGMA journal_mode returns a result row ($executeRawUnsafe rejects it).
  try {
    client.$queryRawUnsafe('PRAGMA journal_mode=WAL;').catch(() => {})
    client.$queryRawUnsafe('PRAGMA busy_timeout=5000;').catch(() => {})
  } catch {
    // ignore — pragmas are best-effort
  }
  return client
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
