-- v4: server-enforced word filter for channels.
--
-- Admin curates a list of substrings that any channel POST is matched
-- against (case-insensitive) before insert/broadcast. A hit means the
-- post is rejected with 400; the bus never sees the message and no
-- one downstream needs to think about it.
--
-- Applies to channels only — DMs are private moderation territory
-- (the recipient can block / report; centrally banning words in
-- private 1:1s is overreach).
--
-- COLLATE NOCASE on the column lets us PRIMARY KEY on the lowercase
-- form without uppercasing at every check; the LIKE comparison in
-- src/db.ts still works because LIKE is case-insensitive on TEXT
-- columns with NOCASE collation. Storing the original form in
-- `display` keeps the admin UI honest ("Fuck" vs "fuck").

CREATE TABLE IF NOT EXISTS banned_words (
  word_lc    TEXT PRIMARY KEY COLLATE NOCASE,
  display    TEXT NOT NULL,
  added_at   INTEGER NOT NULL
);
