-- v26: mark queued messages the user stopped behind.
--
-- CC 2.1.316 parity — "Self-hosted runner: Fixed a message sent while Claude
-- was working being answered after a Stop, once the session's process had
-- been replaced".
--
-- A message queued mid-turn waits in `queued_messages` (v14). Stop leaves it
-- there, and the live Session only drains the queue after a turn that ends in
-- success — so in-process, Stop means "don't answer it yet". But a REPLACED
-- Session (dead-process restart, account switch, idle-reaper revival, server
-- restart) drained the persisted queue at the end of `start()`, answering a
-- message the user had stopped behind.
--
-- `held_by_stop = 1` is set on every row still queued when the user hits Stop
-- on a working turn. `start()`'s drain leaves a held head in place; the next
-- successful turn clears the holds so the queue drains exactly as it would
-- have in-process. A fresh message queues behind held rows without clearing
-- them; Send now / send-all still send a held row.

ALTER TABLE queued_messages ADD COLUMN held_by_stop INTEGER NOT NULL DEFAULT 0;
