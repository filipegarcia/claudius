import { describe, expect, test } from "vitest";
import { taskNotificationNotice } from "@/lib/client/task-notification-notice";

/**
 * CC 2.1.332 — "[VSCode] Fixed the chat showing no notice when a background
 * command, agent, workflow or monitor finished while Claude was idle".
 * Fixtures follow real `<task-notification>` wrappers from session JSONLs.
 */
const wrap = (inner: string) => `<task-notification>\n<task-id>b720wy810</task-id>\n${inner}\n</task-notification>`;

describe("taskNotificationNotice", () => {
  test("a finished background command: summary verbatim, entities decoded", () => {
    const content = wrap(
      [
        "<tool-use-id>toolu_013kXcVgJDarZ1Rz2ZMJcu1G</tool-use-id>",
        "<output-file>/private/tmp/claude-501/x/tasks/b720wy810.output</output-file>",
        "<status>completed</status>",
        '<summary>Background command "bun run test:e2e &gt; /tmp/e2e.log 2&gt;&amp;1" completed (exit code 0)</summary>',
      ].join("\n"),
    );
    expect(taskNotificationNotice(content)).toBe(
      'Background command "bun run test:e2e > /tmp/e2e.log 2>&1" completed (exit code 0)',
    );
  });

  test("agents, workflows and monitors that finished", () => {
    expect(taskNotificationNotice(wrap('<status>completed</status>\n<summary>Agent "Audit the cron reducer" finished</summary>'))).toBe(
      'Agent "Audit the cron reducer" finished',
    );
    expect(
      taskNotificationNotice(wrap('<status>completed</status>\n<summary>Dynamic workflow "Read-only audit" completed</summary>')),
    ).toBe('Dynamic workflow "Read-only audit" completed');
    expect(taskNotificationNotice(wrap('<status>failed</status>\n<summary>Monitor "e2e" script failed (exit 144)</summary>'))).toBe(
      'Monitor "e2e" script failed (exit 144)',
    );
  });

  test("a monitor's per-event notification (no status) stays silent", () => {
    expect(taskNotificationNotice(wrap('<summary>Monitor event: "23:21 updater firing"</summary>'))).toBeNull();
  });

  test("array content, and a finish without a summary", () => {
    expect(taskNotificationNotice([{ type: "text", text: wrap("<status>stopped</status>") }])).toBe("Background task stopped");
  });

  test("anything that isn't a wrapper", () => {
    expect(taskNotificationNotice("Please check <status>completed</status>")).toBeNull();
    expect(taskNotificationNotice(undefined)).toBeNull();
    expect(taskNotificationNotice([{ type: "tool_result", content: "x" }])).toBeNull();
  });
});
