import { describe, expect, test } from "vitest";

import { memoryUpdateReminderBody } from "@/lib/server/session";

/**
 * Memory-update staleness reminder (Claude Code TUI parity, feature 36).
 *
 * Pure-helper coverage. The Session-side integration (queueing the reminder
 * from `Session.notifyMemoryUpdate` after a write/patch/delete through the
 * `/api/memory/auto` route) lives in `lib/server/session.ts` and the route
 * handler; what we pin here is the literal prose the model receives. The
 * CLI's "your loaded copy is now stale relative to disk — Read it again"
 * clause is load-bearing — without it the agent keeps quoting from its
 * in-context copy even after the user edited the file on disk. The clause
 * MUST be conditional on a non-empty `inContextPaths` to mirror the CLI's
 * `if(H.inContextPaths.length>0)` gate.
 */
describe("memoryUpdateReminderBody", () => {
  test("returns null when no updates are supplied", () => {
    expect(memoryUpdateReminderBody([], [])).toBeNull();
  });

  test("drops empty-path updates that would otherwise emit a no-op line", () => {
    // Defence-in-depth: the route caller filters on `result.path` already,
    // but a future caller could pass through a hand-built MemoryUpdate.
    expect(memoryUpdateReminderBody([{ op: "created", path: "" }], [])).toBeNull();
  });

  test("names the source, summarises the op, and lists the changed paths", () => {
    const body = memoryUpdateReminderBody(
      [{ op: "created", path: "/Users/x/.claude/projects/p/memory/topic.md" }],
      [],
    );
    expect(body).not.toBeNull();
    const text = body as string;
    // Source label — Claudius has one write path (the route + UI), so
    // we use "The user" rather than fabricating a background-writer enum.
    expect(text).toContain("The user updated your memory directory");
    expect(text).toContain("created topic.md");
    expect(text).toContain("Files changed: /Users/x/.claude/projects/p/memory/topic.md");
  });

  test("omits the staleness clause when no in-context overlap exists", () => {
    // CLI's `if(H.inContextPaths.length>0)` gate — the reminder still
    // fires (the model should know about disk changes regardless), but
    // we don't lie about an in-context copy that the model never Read.
    const body = memoryUpdateReminderBody(
      [{ op: "updated", path: "/m/topic.md" }],
      [],
    );
    expect(body).not.toBeNull();
    expect(body as string).not.toMatch(/loaded copy/i);
    expect(body as string).not.toMatch(/stale relative to disk/i);
  });

  test("adds the staleness clause when at least one changed path is in-context", () => {
    const body = memoryUpdateReminderBody(
      [{ op: "updated", path: "/m/topic.md" }],
      ["/m/topic.md"],
    );
    expect(body).not.toBeNull();
    const text = body as string;
    // The load-bearing clause — without this the agent keeps quoting
    // from its in-context copy after a mid-session disk edit.
    expect(text).toContain("Your loaded copy of /m/topic.md is now stale");
    expect(text).toMatch(/Read it again/i);
  });

  test("preserves order across multiple ops in a single batch", () => {
    const body = memoryUpdateReminderBody(
      [
        { op: "created", path: "/m/a.md" },
        { op: "deleted", path: "/m/b.md" },
      ],
      [],
    );
    const text = body as string;
    expect(text.indexOf("created a.md")).toBeLessThan(text.indexOf("deleted b.md"));
    expect(text).toContain("Files changed: /m/a.md, /m/b.md");
  });
});
