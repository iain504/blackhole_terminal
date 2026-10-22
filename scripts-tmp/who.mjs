const { db } = await import('../src/lib/db.ts')
const users = await db.user.findMany({ select: { id: true, username: true } })
console.log(JSON.stringify(users))
process.exit(0)
