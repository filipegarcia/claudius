import { describe, expect, test } from "vitest";
import { resolveSessionTitle } from "@/lib/server/session";

/**
 * Regression coverage for the session-title precedence in
 * `lib/server/session.ts`. `resolveSessionTitle` is called from
 * `Session.start()` (initial bind) and `Session.sendFreshTitle()`
 * (every SSE subscribe) to pick what `this.title` and the broadcast
 * `session_title` event should carry.
 *
 * Bug history:
 *
 *   2026-05-12  — Sessions whose name had been set were getting
 *                 overwritten with prompt text on reload. Root cause:
 *                 the SDK's `info.summary` falls back to lastPrompt /
 *                 firstPrompt when no customTitle/aiTitle is set, so
 *                 using it as a "fresh title" fallback made the name
 *                 morph every turn. The initial fix gated the fallback
 *                 on `current` being empty.
 *
 *   2026-05-12 (b) — The user reported that even the gated fallback was
 *                 wrong: prompt-derived titles are confusing in the tab
 *                 strip and they'd rather see the id prefix. Per their
 *                 explicit instruction we DROPPED the summary fallback
 *                 entirely. The resolver now returns either a trusted
 *                 title (DB local or SDK customTitle, which already
 *                 folds in aiTitle) or null — and `tabLabelFor` renders
 *                 the id prefix in the null case.
 *
 * These tests pin down both the precedence and the "never derive from
 * prompts" invariant.
 */

describe("resolveSessionTitle", () => {
  // ── Precedence basics ───────────────────────────────────────────────

  test("DB local wins over everything", () => {
    expect(
      resolveSessionTitle({
        local: "user title",
        info: { customTitle: "sdk title", summary: "last message" },
      }),
    ).toBe("user title");
  });

  test("falls back to SDK customTitle when DB local is null", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "sdk title", summary: "last message" },
      }),
    ).toBe("sdk title");
  });

  test("customTitle wins over summary even when both are populated", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "named", summary: "last message" },
      }),
    ).toBe("named");
  });

  // ── The core invariant: never derive a title from prompt text ───────

  test("returns null when only summary is set — does NOT promote it to a title", () => {
    // The reported bug: summary = lastPrompt = "cool, it worked, lets quickly fix..."
    // is NOT a session name. Caller leaves this.title empty and the UI
    // renders the id prefix instead.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "cool, it worked, lets quickly fix something" },
      }),
    ).toBeNull();
  });

  test("ignores summary even when DB local is empty/null", () => {
    expect(
      resolveSessionTitle({
        local: "",
        info: { customTitle: null, summary: "fix the login bug pls" },
      }),
    ).toBeNull();
  });

  test("ignores summary on a fresh session with no other source", () => {
    // Replaces the old "first-time summary fallback" test — the user
    // explicitly asked us to stop populating titles from prompts.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "first prompt text" },
      }),
    ).toBeNull();
  });

  // ── Null/missing-source edge cases ──────────────────────────────────

  test("returns null when no source has a title at all", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: undefined },
      }),
    ).toBeNull();
  });

  test("returns null when info itself is missing (network/SDK error path)", () => {
    expect(resolveSessionTitle({ local: null, info: null })).toBeNull();
  });

  test("returns null when info is an empty object", () => {
    expect(resolveSessionTitle({ local: null, info: {} })).toBeNull();
  });

  test("undefined and null inputs are interchangeable", () => {
    expect(
      resolveSessionTitle({
        local: undefined,
        info: { customTitle: null, summary: null },
      }),
    ).toBeNull();
  });

  // ── Trim / whitespace handling ──────────────────────────────────────

  test("trims whitespace on local", () => {
    expect(resolveSessionTitle({ local: "  spaced  ", info: null })).toBe("spaced");
  });

  test("trims whitespace on customTitle", () => {
    expect(
      resolveSessionTitle({ local: null, info: { customTitle: "  sdk  " } }),
    ).toBe("sdk");
  });

  test("whitespace-only local falls through to customTitle", () => {
    expect(
      resolveSessionTitle({ local: "   ", info: { customTitle: "real" } }),
    ).toBe("real");
  });

  test("whitespace-only customTitle falls through to null (summary still ignored)", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "   ", summary: "would-have-been-this" },
      }),
    ).toBeNull();
  });

  test("empty strings are treated as unset", () => {
    expect(
      resolveSessionTitle({ local: "", info: { customTitle: "", summary: "real" } }),
    ).toBeNull();
  });

  test("preserves whitespace inside the title (only edges are trimmed)", () => {
    expect(
      resolveSessionTitle({ local: "  multi  word\ttitle  ", info: null }),
    ).toBe("multi  word\ttitle");
  });

  test("trims tabs and newlines, not just spaces", () => {
    expect(resolveSessionTitle({ local: "\n\thello\r\n", info: null })).toBe("hello");
  });

  test("falsy-looking-but-non-empty strings are valid titles", () => {
    // "0", "false" are legitimate user choices.
    expect(resolveSessionTitle({ local: "0", info: null })).toBe("0");
    expect(
      resolveSessionTitle({ local: null, info: { customTitle: "false" } }),
    ).toBe("false");
  });

  // ── Purity / referential transparency ───────────────────────────────

  test("does not mutate the input object", () => {
    const info = { customTitle: "  named  ", summary: "  last  " };
    const before = JSON.stringify(info);
    resolveSessionTitle({ local: null, info });
    expect(JSON.stringify(info)).toBe(before);
  });

  test("repeated calls with identical inputs return identical outputs", () => {
    const args = { local: null, info: { customTitle: "x" } } as const;
    expect(resolveSessionTitle({ ...args })).toBe("x");
    expect(resolveSessionTitle({ ...args })).toBe("x");
    expect(resolveSessionTitle({ ...args })).toBe("x");
  });

  // ── Real-world cwd / multi-client scenarios ─────────────────────────

  test("scenario: TUI `/rename` after Claudius bind — SDK customTitle propagates", () => {
    // Session created in Claudius (DB local = null), renamed via the TUI
    // (`claude --resume <id>` + `/rename`). The SDK writes customTitle
    // into the JSONL. We surface it.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "foo", summary: "foo" },
      }),
    ).toBe("foo");
  });

  test("scenario: cwd mismatch (worktree) — DB miss, but customTitle preserves the name", () => {
    // User renamed in workspace A; that cwd-keyed DB has the title.
    // Resuming via workspace B opens a different `.claudius.db`, so
    // `getSessionTitle(B, id)` returns null. The rename also went to the
    // SDK's JSONL though, so customTitle is still set — we pick it up.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: "project plan", summary: "fix the bug" },
      }),
    ).toBe("project plan");
  });

  test("scenario: worst case — DB miss AND SDK customTitle never persisted", () => {
    // The combination that produced the original bug report. No trusted
    // source survives. Resolver returns null — caller leaves `this.title`
    // empty and the UI falls back to the id prefix label.
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: "let's check the logs" },
      }),
    ).toBeNull();
  });

  test("scenario: brand-new session, no JSONL yet → returns null (UI shows id prefix)", () => {
    expect(
      resolveSessionTitle({
        local: null,
        info: { customTitle: undefined, summary: undefined },
      }),
    ).toBeNull();
  });

  test("scenario: a long prompt as summary is not a title (the exact reported bug shape)", () => {
    // Pulled from the screenshot the user attached. Even though this is
    // the only "title-like" field the SDK has, we refuse to render it.
    expect(
      resolveSessionTitle({
        local: null,
        info: {
          customTitle: undefined,
          summary:
            "cool, it worked, lets quickly fix something, when I click in a workspace, I should go to the previous url",
        },
      }),
    ).toBeNull();
  });
});
