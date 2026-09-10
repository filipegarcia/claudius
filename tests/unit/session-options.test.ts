import { describe, expect, test } from "vitest";
import { buildQueryEnv, TODO_TASK_TOOL_NAMES } from "@/lib/server/session";

/**
 * SDK 0.3.233 regression guard: TodoWrite/TaskCreate/TaskGet/TaskUpdate/
 * TaskList dropped out of the *default* tool surface on Opus 4.8, Sonnet 5,
 * Fable 5, Mythos 5, and newer models — losing any one of these silently
 * breaks the todos rail (TodosBanner, BackgroundTasksPanel, the
 * TaskCreate/TaskList/TaskUpdate machinery in `captureSnapshotState`) on
 * newer models with no visible error.
 *
 * CORRECTION (CC 2.1.268 parity audit): an earlier revision of this comment
 * claimed `Session`'s `query()` options builder keeps these tools present
 * by forwarding `TODO_TASK_TOOL_NAMES` as `allowedTools`. Verified against
 * the compiled SDK binary's tool-gate: `allowedTools` never enters the
 * gate check at all (model tier + `CLAUDE_CODE_ENABLE_TODO_TOOLS` +
 * a remote flag are the only inputs) — it only auto-approves a tool
 * that's already registered. `buildQueryEnv()` is the actual fix: it always
 * sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the env passed to `query()`.
 * `allowedTools: TODO_TASK_TOOL_NAMES` is still forwarded too (harmless
 * auto-approve), so this constant's exact contents still matter — pinning
 * it here rather than exercising the full `Session.start()` → `query()`
 * options plumbing (heavy: disk I/O, DB reads, notification sweep) catches
 * a dropped or misspelled tool name just as reliably.
 */
describe("TODO_TASK_TOOL_NAMES (SDK 0.3.233 default-tool-surface regression)", () => {
  test("includes exactly the five todo/task tools the SDK changelog names", () => {
    expect([...TODO_TASK_TOOL_NAMES].sort()).toEqual(
      ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite"].sort(),
    );
  });

  test("every entry is a non-empty exact SDK tool name (no accidental whitespace/casing drift)", () => {
    for (const name of TODO_TASK_TOOL_NAMES) {
      expect(name).toMatch(/^[A-Za-z]+$/);
    }
  });
});

/**
 * CC 2.1.268 parity: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is what actually
 * keeps the todo/task tools registered on Opus 4.8+/Sonnet 5+/Fable 5+/
 * Mythos 5+ — Claudius's own default/top-picker model (`claude-sonnet-5`,
 * see `lib/shared/advisor.ts`) sits exactly at that cutoff, so without this
 * the todos rail goes silently empty on Claudius's own default model.
 */
describe("buildQueryEnv (CC 2.1.268 parity — CLAUDE_CODE_ENABLE_TODO_TOOLS)", () => {
  test("sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1 on top of process.env when no profile is active", () => {
    const env = buildQueryEnv(null);
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
    // Still a full copy of process.env, not a bare `{ CLAUDE_CODE_ENABLE_TODO_TOOLS }`
    // — Options.env REPLACES the subprocess env wholesale when set.
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  test("sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1 on top of an account-switcher profile env, without dropping its keys", () => {
    const profileEnv = { CLAUDE_CONFIG_DIR: "/tmp/profile-a", SOME_OTHER_VAR: "x" };
    const env = buildQueryEnv(profileEnv);
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/profile-a");
    expect(env.SOME_OTHER_VAR).toBe("x");
  });

  test("an explicit CLAUDE_CODE_ENABLE_TODO_TOOLS in the source env is overridden to \"1\"", () => {
    const env = buildQueryEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" });
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
  });
});
