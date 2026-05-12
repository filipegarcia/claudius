import { describe, expect, test } from "vitest";
import { resolveSessionTitle } from "@/lib/server/session";

/**
 * Regression coverage for the session-title precedence in
 * `lib/server/session.ts`. `resolveSessionTitle` is called from
 * `Session.start()` (initial bind) and `Session.sendFreshTitle()`
 * (every SSE subscribe) to pick what `this.title` and the broadcast
 * `session_title` event should carry.
 *
 * Bug we're guarding against (2026-05-12 — reported on a hard-to-repro
 * subset of sessions): the SDK's `info.summary` field is computed
 * `customTitle || aiTitle || lastPrompt || summaryHint || firstPrompt`.
 * If neither customTitle nor aiTitle ever appeared, `summary` is the
 * user's most recent prompt. Subscribing re-runs the resolver, so a
 * user-renamed session was getting its name silently overwritten with
 * the last message every time a tab reconnected.
 *
 * The fix: never use `summary` to OVERWRITE an existing title. Allow it
 * only as a first-time fallback when nothing has set a title yet (so a
 * never-renamed session still shows something useful in the tab strip
 * instead of a raw UUID).
 */

describe("resolveSessionTitle", () => {
  test("DB local wins over everything", () => {
    expect(
      resolveSessionTitle({
        local: "user title",
        info: { customTitle: "sdk title", summary: "last message" },
        current: "stale",
      }),
    ).toBe("user title");
  });

  test("falls back to SDK customTitle when DB local is null", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "sdk title", summary: "last message" },
        current: undefined,
      }),
    ).toBe("sdk title");
  });

  test("falls back to SDK customTitle even when current is set (TUI rename should propagate)", () => {
    // If the user typed /rename in the CLI, the SDK now has a customTitle
    // that's authoritative. Our in-memory `this.title` may still be the
    // older value; let the trusted SDK source through.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "renamed in tui", summary: "last message" },
        current: "old in-memory title",
      }),
    ).toBe("renamed in tui");
  });

  test("THE BUG: does NOT overwrite an existing title with summary (= last prompt)", () => {
    // The exact failure mode the user reported: title was set in a prior
    // boot, but our DB has no row for it AND the SDK's `customTitle` is
    // missing (only `summary` is populated, which equals the last user
    // prompt). The resolver must keep the existing title — returning
    // null tells the caller "leave this.title alone".
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "fix the login bug pls" },
        current: "weekly planning",
      }),
    ).toBeNull();
  });

  test("first-time fallback: uses summary when no title has been set yet", () => {
    // Fresh session with no DB row, no SDK customTitle, but a summary
    // derived from the first prompt. We allow this so the tab strip
    // shows something readable instead of the raw UUID.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "fix the login bug pls" },
        current: undefined,
      }),
    ).toBe("fix the login bug pls");
  });

  test("first-time fallback also applies when current is an empty string", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "hello" },
        current: "",
      }),
    ).toBe("hello");
  });

  test("returns null when no source has a title at all", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: undefined },
        current: undefined,
      }),
    ).toBeNull();
  });

  test("returns null when info itself is missing (network/SDK error path)", () => {
    expect(
      resolveSessionTitle({ local: null, info: null, current: undefined }),
    ).toBeNull();
  });

  test("trims whitespace on every source", () => {
    expect(
      resolveSessionTitle({
        local: "  spaced  ",
        info: null,
        current: undefined,
      }),
    ).toBe("spaced");
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "  sdk  " },
        current: undefined,
      }),
    ).toBe("sdk");
    expect(
      resolveSessionTitle({
        local: null,
        info: { summary: "   summary  " },
        current: undefined,
      }),
    ).toBe("summary");
  });

  test("whitespace-only local does not count as set — falls through", () => {
    // Bug fence: a row that somehow ended up with title="   " must not
    // pre-empt the SDK customTitle.
    expect(
      resolveSessionTitle({
        local: "   ",
        info: { customTitle: "real" },
        current: undefined,
      }),
    ).toBe("real");
  });

  test("whitespace-only current does not block first-time summary fallback", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { summary: "hi" },
        current: "   ",
      }),
    ).toBe("hi");
  });

  test("undefined and null inputs are interchangeable", () => {
    // Loose typing at the call site (the Session class uses
    // `string | undefined`, the DB returns `string | null`) — both must
    // behave the same.
    expect(
      resolveSessionTitle({
        local: undefined,
        info: { customTitle: null, summary: null },
        current: null,
      }),
    ).toBeNull();
  });

  test("regression scenario end-to-end: reload after user rename keeps the name", () => {
    // Walk the actual sequence:
    //   1. User renames in Claudius → DB has "weekly planning",
    //      `this.title = "weekly planning"`, SDK's renameSession also
    //      succeeded so customTitle = "weekly planning" too.
    //   2. Sometime later the DB row gets cleared (legacy migration,
    //      cwd mismatch, anything that returns null from getSessionTitle).
    //      `customTitle` is also somehow missing now (the case the user
    //      hit — possibly a worktree cwd that doesn't see the JSONL).
    //   3. The user sends a new message: "let's pick up tomorrow's tasks".
    //   4. A new tab subscribes → sendFreshTitle runs → local=null,
    //      info.summary = lastPrompt = "let's pick up tomorrow's tasks".
    // The pre-fix code would overwrite `this.title` with the prompt.
    // The fix returns null, so the existing in-memory title survives.
    expect(
      resolveSessionTitle({
        local: null,
        info: {
          customTitle: undefined,
          summary: "let's pick up tomorrow's tasks",
        },
        current: "weekly planning",
      }),
    ).toBeNull();
  });

  // ── Source-precedence permutations ──────────────────────────────────
  // The truth table is small but easy to break with a typo. Pin each
  // combination of "which sources are populated" + the expected winner.

  test("customTitle wins over summary when DB local is absent (both populated)", () => {
    // Both SDK fields are set; the user-set customTitle must take
    // precedence over the auto-derived summary. This is the only
    // ordering check in the SDK-only branch that the bug fix relies on.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "named", summary: "last message" },
        current: undefined,
      }),
    ).toBe("named");
  });

  test("only DB local populated → returns local (info ignored entirely)", () => {
    expect(
      resolveSessionTitle({
        local: "from db",
        info: null,
        current: undefined,
      }),
    ).toBe("from db");
  });

  test("only summary populated, no current → first-time fallback uses summary", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { summary: "auto-derived" },
        current: undefined,
      }),
    ).toBe("auto-derived");
  });

  test("only current populated → returns null (nothing trustworthy, keep what's in memory)", () => {
    // No DB local, no SDK info, but we already have a title in memory
    // — the resolver returns null to signal "leave this.title alone".
    expect(
      resolveSessionTitle({
        local: null,
        info: null,
        current: "in-memory title",
      }),
    ).toBeNull();
  });

  // ── Edge-case input shapes ──────────────────────────────────────────

  test("empty-string sources are treated as unset", () => {
    // Empty strings come back from the SDK occasionally (decoded but
    // never written). They must not pre-empt a real source further
    // down the precedence chain.
    expect(
      resolveSessionTitle({
        local: "",
        info: { customTitle: "", summary: "real" },
        current: undefined,
      }),
    ).toBe("real");
  });

  test("info object with no fields at all → behaves like info: null", () => {
    // Defensive: some SDK builds return `{}` when the JSONL exists but
    // hasn't accumulated a summary yet.
    expect(
      resolveSessionTitle({ local: null, info: {}, current: undefined }),
    ).toBeNull();
    expect(
      resolveSessionTitle({ local: null, info: {}, current: "keep me" }),
    ).toBeNull();
  });

  test("idempotency: trimmed local matches existing current, still returns local", () => {
    // Even when nothing has *changed* (local == current after trim),
    // the resolver returns the trimmed value rather than null — the
    // caller does its own `next !== this.title` comparison, so we
    // shouldn't signal "leave it alone" here.
    const out = resolveSessionTitle({
      local: "weekly planning",
      info: null,
      current: "weekly planning",
    });
    expect(out).toBe("weekly planning");
  });

  test("preserves whitespace inside the title (only edges are trimmed)", () => {
    // Internal double-spaces, tabs, newlines mid-title are user intent
    // — don't collapse them.
    expect(
      resolveSessionTitle({
        local: "  multi  word\ttitle  ",
        info: null,
        current: undefined,
      }),
    ).toBe("multi  word\ttitle");
  });

  test("trims tabs and newlines around the edges, not just spaces", () => {
    expect(
      resolveSessionTitle({
        local: "\n\thello\r\n",
        info: null,
        current: undefined,
      }),
    ).toBe("hello");
  });

  test("falsy-looking-but-non-empty strings are valid titles", () => {
    // "0", "false", "null" are all valid title strings the user might
    // have picked. The guard is "trimmed length > 0", not truthiness.
    expect(
      resolveSessionTitle({ local: "0", info: null, current: undefined }),
    ).toBe("0");
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "false" },
        current: undefined,
      }),
    ).toBe("false");
  });

  test("does not mutate the input object", () => {
    // Pure function — must leave caller-owned objects untouched even
    // for fields it never reads. Easy invariant to break with an
    // ill-placed `delete` or normalization.
    const info = { customTitle: "  named  ", summary: "  last  " };
    const before = JSON.stringify(info);
    resolveSessionTitle({ local: null, info, current: undefined });
    expect(JSON.stringify(info)).toBe(before);
  });

  test("repeated calls with identical inputs return identical outputs (no hidden state)", () => {
    const args = {
      local: null,
      info: { customTitle: undefined, summary: "first prompt" },
      current: undefined,
    } as const;
    const a = resolveSessionTitle({ ...args });
    const b = resolveSessionTitle({ ...args });
    const c = resolveSessionTitle({ ...args });
    expect(a).toBe("first prompt");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  // ── Real-world cwd / multi-client scenarios ─────────────────────────

  test("scenario: TUI `/rename` after Claudius bind — SDK customTitle propagates", () => {
    // 1. Session created in Claudius, never renamed → DB local = null.
    // 2. User runs `claude --resume <id>` and `/rename foo` in TUI.
    //    The SDK persists customTitle = "foo" in the JSONL header.
    // 3. A Claudius tab refreshes → sendFreshTitle re-runs.
    // We want "foo" to surface even though our DB never saw it.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "foo", summary: "foo" },
        current: undefined,
      }),
    ).toBe("foo");
  });

  test("scenario: TUI rename overrides a stale in-memory title", () => {
    // Continuation of the above — the Claudius session was bound
    // BEFORE the TUI rename, so `this.title` may already be set to
    // the old summary-derived label ("hello there"). When the SDK
    // surfaces a real customTitle, it must replace the stale one.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "new name", summary: "hello there" },
        current: "hello there",
      }),
    ).toBe("new name");
  });

  test("scenario: cwd mismatch (worktree) — DB miss, but customTitle preserves the name", () => {
    // User renamed in workspace A; the cwd-keyed DB has it there.
    // Resuming via workspace B opens a different `.claudius.db`, so
    // `getSessionTitle(B, id)` returns null. But the rename also went
    // to the SDK's JSONL, so `customTitle` is still set. We pick that
    // up instead of falling through to `summary` (the last message).
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "project plan", summary: "fix the bug" },
        current: undefined,
      }),
    ).toBe("project plan");
  });

  test("scenario: worst case — DB miss AND SDK customTitle never persisted", () => {
    // The combination that produced the original bug report. Title
    // exists in memory from start() (set when the session was first
    // created), but neither persistent source can confirm it. The
    // resolver MUST refuse to "refresh" the title from summary.
    // Without the in-memory guard the user would see their name
    // flip to "let's check the logs" on the very next reload.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "let's check the logs" },
        current: "Tuesday planning",
      }),
    ).toBeNull();
  });

  test("scenario: brand-new session, no JSONL yet → all sources null → returns null", () => {
    // The very first instant of a Session.start() call: the JSONL
    // hasn't been written, the DB row was just inserted with title=null
    // (upsertSession with `title: this.title` where this.title is
    // undefined). Resolver must NOT invent a title; start() falls
    // through and the tab strip shows the id prefix until the first
    // turn lands and the SDK fills in a summary.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: undefined },
        current: undefined,
      }),
    ).toBeNull();
  });
});
