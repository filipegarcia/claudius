-- v13: per-session opaque JSON state bag. A small home for mutable
-- per-session flags that upcoming parity features (date-change nudge,
-- stale-TodoWrite turn counter, plan-mode re-entry, etc.) need to track
-- across turns without each feature schema-migrating its own column.
--
-- Stored as opaque JSON so the surface stays tiny — callers go through
-- `getSessionState` / `mergeSessionState` in `sessions-db.ts` and patch
-- whatever keys they own. No app code should reach for `state` directly.
--
-- NOT NULL with a `'{}'` default so:
--   - existing rows backfill to a valid empty object (sqlite applies the
--     constant default during ALTER TABLE);
--   - the goal accessors' `INSERT ... ON CONFLICT` paths can keep omitting
--     `state` and still produce rows whose JSON is well-formed.

ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT '{}';
