import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { DEFAULT_ENABLED_KINDS } from "@/lib/shared/notifications";

/**
 * Smoke checks for the bun-test harness:
 *   1. The `@/` path alias from tsconfig resolves under `bun test`.
 *   2. The `better-sqlite3` native module loads without recompile.
 *
 * If either fails, every other unit test in this directory will fail too —
 * fix this before chasing downstream errors.
 */

describe("harness", () => {
  test("tsconfig @/ path alias resolves shared types", () => {
    expect(DEFAULT_ENABLED_KINDS).toContain("session_error");
  });

  test("better-sqlite3 opens an in-memory database", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    db.prepare("INSERT INTO t(n) VALUES (?)").run(42);
    const row = db.prepare<[], { n: number }>("SELECT n FROM t").get();
    expect(row?.n).toBe(42);
    db.close();
  });
});
