---
name: db-migration
description: Author a new SQLite migration for the per-project `.claudius.db`. Picks the next id, writes the SQL with the project's house style, and updates the loader if needed. Use when the user says "add a column" / "we need to track X in the DB" / "new migration".
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash
---

# DB migration

Migrations live at `lib/server/db-migrations/<id>_<slug>.sql` and run automatically on `openDb()` in numeric order. Ids are unique — pick the next free one. Never edit a migration that's already shipped.

## Steps

1. **Find the next id.**

   ```bash
   ls lib/server/db-migrations/ | sort
   ```

   Take the highest existing id, add one. If two MRs are open at the same time, the second to merge has to renumber.

2. **Write the migration.**

   `lib/server/db-migrations/<id>_<slug>.sql` — keep the file small and focused. House style:

   - Always `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. Migrations should be idempotent so a partial-apply doesn't wedge the DB.
   - Comment the *why* at the top. The migration is a public artifact; the comment is the only context a future reader gets.
   - Foreign keys: `REFERENCES <other> ON DELETE CASCADE` is fine for child rows; otherwise leave it off.
   - Don't `ALTER TABLE … DROP COLUMN` — SQLite's support is fragile across versions. Add a new column, migrate readers, deprecate later.

3. **Touch the loader if needed.**

   `lib/server/db.ts` discovers migrations from disk and runs unseen ones. New tables don't need code changes here. New schema-meta keys do — see how `last_jsonl_scan_<sessionId>` is used as precedent.

4. **Open the DB once locally.**

   ```bash
   bun run dev   # boot the server so openDb() runs
   sqlite3 ~/.claude/projects/<encoded-cwd>/.claudius.db ".schema"
   ```

   Confirm the new table is there. If `db.ts` errored, the migration is invalid — fix and retry.

5. **Add a server module.**

   Don't query SQLite from route handlers directly. Put queries in `lib/server/<feature>-db.ts` next to the existing `sessions-db.ts` / `commit-drafts.ts`. Keep them tiny, one prepared statement per export.

## What to NOT do

- Don't number two new migrations the same. The loader applies in lexicographic order; collisions silently skip.
- Don't backfill data inside the migration SQL. Backfills go in a separate one-off script under `scripts/`. Migrations should be schema-only and fast.
- Don't add tables that duplicate state the SDK's JSONL store already has (sessions, messages). Our DB is an *index*, not a source of truth.
