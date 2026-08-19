import { describe, expect, test } from "vitest";
import { TODO_TASK_TOOL_NAMES } from "@/lib/server/session";

/**
 * SDK 0.3.233 regression guard: TodoWrite/TaskCreate/TaskGet/TaskUpdate/
 * TaskList dropped out of the *default* tool surface on Opus 4.8, Sonnet 5,
 * Fable 5, Mythos 5, and newer models. `Session`'s `query()` options builder
 * forwards `TODO_TASK_TOOL_NAMES` as `allowedTools` specifically to keep
 * them present (see the constant's doc comment in lib/server/session.ts) —
 * losing any one of these silently breaks the todos rail (TodosBanner,
 * BackgroundTasksPanel, the TaskCreate/TaskList/TaskUpdate machinery in
 * `captureSnapshotState`) on newer models with no visible error.
 *
 * This pins the exact tool-name set rather than exercising the full
 * `Session.start()` → `query()` options plumbing, which requires mocking
 * disk I/O, DB reads, and the notification sweep for no extra signal — the
 * constant is the single point `start()` reads from, so pinning it here
 * catches a dropped or misspelled tool name just as reliably.
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
