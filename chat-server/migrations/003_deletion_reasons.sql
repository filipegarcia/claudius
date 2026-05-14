-- v3: track *why* a message was soft-deleted.
--
-- The wire format treats per-message admin deletions and ban-purges
-- as "show a [deleted by admin] placeholder," but bulk clear/compact
-- operations as "hide entirely (the room looks empty / trimmed)." We
-- need a column to discriminate so recentMessages / messagesBefore
-- can filter correctly. The rows themselves stay in the table either
-- way — that's the whole point of soft-delete — but they don't all
-- reach the client.
--
-- Reasons:
--   'admin'      one-off admin delete from the UI / message_id endpoint
--   'banned'     ban-and-purge (a user's full message history)
--   'cleared'    bulk clear of a channel
--   'compacted'  bulk compact (trimmed the older end of a channel)
--
-- The column is nullable for the bootstrap case: all existing
-- soft-deleted rows pre-migration are treated as 'admin' — that
-- matches the only deletion path the server had before this column
-- existed (per-message admin delete from /admin/messages/:id/delete).

ALTER TABLE messages ADD COLUMN deletion_reason TEXT;

UPDATE messages
   SET deletion_reason = 'admin'
 WHERE deleted_at IS NOT NULL AND deletion_reason IS NULL;
