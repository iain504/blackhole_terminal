# Database migration guide — SQLite → PostgreSQL / Turso

Current state: Prisma 6 (`prisma/schema.prisma`, `provider = "sqlite"`, `url = env("DATABASE_URL")`), ~17 models — `User`, `Watchlist`, `Layout`, `Drawing`, `Alert`, `StrategyRule`, `StrategyFireLog`, `CalendarAlarm`, `NotifyState`, `AlgoRun`, `AlgoLog`, `Bar`, `AlgoRecoCache`, `GridTrade`, `GridFill`, `AppSecret`, `RateLimitBucket`. Audited facts that shape both paths: only scalar types (`String`/`Int`/`Float`/`Boolean`/`DateTime`/`Json`), **no Prisma enums**, no native `@db.*` attributes, and **no `@relation` FKs** — `userId` / `runId` / `gridTradeId` / `ruleId` are plain indexed string columns.

## When to migrate

| Situation | Verdict |
| --- | --- |
| Personal, single-user terminal (the designed mode) | **Stay on SQLite** — it is the tested default; one file, zero ops |
| Several users / concurrent writers on one install | PostgreSQL — SQLite serializes writes; contention shows up as engine-tick latency |
| Long-lived crypto bar history (`Bar` is the main grower) | PostgreSQL worth it |
| Managed, off-box storage without running a PG server | Turso (libSQL) |

## Path A — PostgreSQL

1. Spin up PG 15+, set `DATABASE_URL=postgresql://user:pass@host:5432/blackhole`.
2. `prisma/schema.prisma`: `provider = "postgresql"`.
3. Column-type audit (done against this schema): `Json → jsonb`, `DateTime → timestamp(3)`, `Float → double precision`, `Int` stays integer; composite PKs (`Bar`, `NotifyState`) and `@@unique` map cleanly. **Nothing SQLite-only found — no schema edits needed.**
4. Create the schema:

   ```bash
   bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > init.sql
   # review init.sql, then apply to the new DATABASE_URL:
   bunx prisma db push
   ```

5. Data — pick one:
   - **(a) Fresh start (recommended for most users):** empty PG; on first boot the app bootstrap-registers the first account — re-enroll TOTP, re-enter Alpaca keys/Telegram token. Simplest and safest; grids/watches/layouts are cheap to recreate.
   - **(b) Per-table ETL:** keep one client per provider — leave the sqlite schema in `prisma/schema.sqlite.prisma` (`bunx prisma generate --schema prisma/schema.sqlite.prisma`, output `src/generated/sqlite-client`) while the main client targets PG. Sketch:

     ```ts
     // scripts-tmp/etl-sqlite-to-pg.ts — bun run scripts-tmp/etl-sqlite-to-pg.ts
     import { PrismaClient as Sqlite } from '../src/generated/sqlite-client'
     import { PrismaClient as Pg } from '@prisma/client'
     const src = new Sqlite({ datasources: { db: { url: `file:${process.env.OLD_DB}` } } })
     const dst = new Pg()
     // order: AppSecret first (decryption key), User, then user-scoped tables, then globals
     const tables = ['appSecret','user','watchlist','layout','drawing','alert','strategyRule',
       'strategyFireLog','calendarAlarm','notifyState','algoRun','algoLog','gridTrade',
       'gridFill','bar','algoRecoCache','rateLimitBucket'] as const
     for (const t of tables) {
       const rows = await (src as any)[t].findMany()          // chunk Bar: take: 50_000
       if (rows.length) await (dst as any)[t].createMany({ data: rows, skipDuplicates: true })
       console.log(t, rows.length)
     }
     ```

     `Json` columns pass through as JS values, `DateTime` rows arrive as `Date` objects — no manual conversion.

6. Caveats:
   - `bun run db:push` is wired with `--accept-data-loss` (see `package.json`) — it silently drops columns/tables that left the schema. On a production PG, run `bunx prisma db push` bare and read the warning.
   - `$transaction` isolation: SQLite effectively serializes writers; PG defaults to READ COMMITTED. The algo/grid engines re-read their row every cycle (DB as source of truth) so they cope — but don't add long transactions assuming serializable semantics.
   - The old `db/*.db` files become obsolete — archive them, never point `DATABASE_URL` at a stale one.
   - `Bar` volume: this is the table that grows forever (crypto cache); PG + autovacuum handles it far better than a single SQLite file.

## Path B — Turso (libSQL)

libSQL is SQLite-compatible → `provider` stays `"sqlite"`. Use a Prisma **driver adapter** (GA in Prisma ≥ 6.6; on older 6.x add `previewFeatures = ["driverAdapters"]` to the generator. Exact package/API names can drift between Prisma 6 minors — verify against the current [driver-adapter docs](https://www.prisma.io/docs/orm/overview/databases/database-drivers#libsql)):

```bash
bun add @prisma/adapter-libsql @libsql/client
```

```ts
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { createClient } from '@libsql/client'

const factory = () => {
  const adapter = new PrismaLibSQL(createClient({
    url: process.env.TURSO_DATABASE_URL!,    // libsql://…
    authToken: process.env.TURSO_AUTH_TOKEN!,
  }))
  return new PrismaClient({ adapter })
}
```

- Env: `TURSO_DATABASE_URL` (`libsql://…`) + `TURSO_AUTH_TOKEN`. At that point `DATABASE_URL` in the schema is only consumed by the CLI (`generate`, `diff`) — keep it pointing at a local scratch file.
- Schema:

  ```bash
  bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > turso-init.sql
  turso db shell "$TURSO_DATABASE_URL" < turso-init.sql
  ```

- Data: dump + replay (strip `PRAGMA` lines if the shell rejects them), or reuse the Path A(b) ETL with the libsql client:

  ```bash
  sqlite3 db/custom.db .dump > data.sql
  turso db shell "$TURSO_DATABASE_URL" < data.sql
  ```

- Caveats:
  - Health check uses `db.$queryRaw`SELECT 1`` — works identically through the adapter.
  - The file-based WAL backup story (`db/*.db-wal/-shm`) no longer applies — Turso handles replication/backup; verify the schedule in the Turso dashboard.
  - Every engine tick now pays network RTT (engines re-read their row per cycle) — keep the DB region close to the app host.

## Verify the migration

- [ ] Row counts per table match before/after — run against both DBs:

  ```sql
  SELECT 'User',COUNT(*) FROM User UNION ALL SELECT 'Watchlist',COUNT(*) FROM Watchlist
  UNION ALL SELECT 'Layout',COUNT(*) FROM Layout UNION ALL SELECT 'Drawing',COUNT(*) FROM Drawing
  UNION ALL SELECT 'Alert',COUNT(*) FROM Alert UNION ALL SELECT 'StrategyRule',COUNT(*) FROM StrategyRule
  UNION ALL SELECT 'StrategyFireLog',COUNT(*) FROM StrategyFireLog UNION ALL SELECT 'CalendarAlarm',COUNT(*) FROM CalendarAlarm
  UNION ALL SELECT 'NotifyState',COUNT(*) FROM NotifyState UNION ALL SELECT 'AlgoRun',COUNT(*) FROM AlgoRun
  UNION ALL SELECT 'AlgoLog',COUNT(*) FROM AlgoLog UNION ALL SELECT 'Bar',COUNT(*) FROM Bar
  UNION ALL SELECT 'AlgoRecoCache',COUNT(*) FROM AlgoRecoCache UNION ALL SELECT 'GridTrade',COUNT(*) FROM GridTrade
  UNION ALL SELECT 'GridFill',COUNT(*) FROM GridFill UNION ALL SELECT 'AppSecret',COUNT(*) FROM AppSecret
  UNION ALL SELECT 'RateLimitBucket',COUNT(*) FROM RateLimitBucket;
  ```

- [ ] Login + TOTP work — the scrypt password hash and encrypted `totpSecret` are rows like any other and migrate as-is.
- [ ] Broker keys still decrypt: credentials are AES-256-GCM sealed with the resolved app secret — the key travels with the data, **unchanged by the DB migration**, as long as either the `AppSecret` `master` row was carried over (ETL order puts it first) or `APP_ENCRYPTION_SECRET` is set in the new environment. Fresh start = keys were re-entered (§ Path A 5a). Settings → Alpaca keys → validate with a live request.
- [ ] Algo/grid engines restart safe: rows with status `running` / `active` auto-resume on boot; confirm only intended ones survived and that `AlgoRun.state` / `GridTrade.state` JSON (engine working memory) arrived intact.
- [ ] Bars re-hydrate: open a crypto chart, confirm cached history renders.
- [ ] `GET /api/health` → `status:'ok'`, `algoRuns`/`gridRuns` counts match pre-migration.

## What does NOT migrate (and why that's fine)

| Thing | Why |
| --- | --- |
| Sessions | HMAC-signed **stateless cookies** — no session table. Secrets unchanged → sessions survive the migration; rotated → everyone just logs in again |
| In-process caches | Health 5s probe cache, engine in-memory snapshots, reco warm state — warm up fresh on first request/cycle |
| stream-service | Stateless — keys are resolved server-side per handshake from the session cookie; nothing stored |
| `RateLimitBucket` contents | Operational brute-force windows — optional to carry; they rebuild as traffic arrives |
