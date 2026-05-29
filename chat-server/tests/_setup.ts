// Preload for `bun test`. Runs before any test file imports so the db
// module opens its singleton connection against an in-memory database
// instead of writing to ./data/chat.db. The setting is process-global
// (every test file in the run shares the same connection).
//
// Each test in db.test.ts truncates the tables it cares about in
// `beforeEach`, so the in-memory db serves as a clean slate for every
// case while sparing us a per-test reconnect.

process.env["CHAT_DB_PATH"] = ":memory:";
