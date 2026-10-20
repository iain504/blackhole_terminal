// READ-ONLY baseline dump for Task 51 E2E restore (watchlists + drawings count)
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
try {
  const users = await db.user.findMany({ select: { id: true, username: true } })
  console.log('users:', JSON.stringify(users))
  const lists = await db.watchlist.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
  console.log('watchlists:', JSON.stringify(lists, null, 1))
  const drawings = await db.drawing.findMany({ orderBy: { createdAt: 'asc' } })
  console.log('drawings count:', drawings.length)
  for (const d of drawings) {
    console.log(`  drawing ${d.id} ${d.symbol} ${d.kind} color=${d.color} points=${JSON.stringify(d.points)} meta=${JSON.stringify(d.meta)}`)
  }
} finally {
  await db.$disconnect()
}
