import { describe, expect, test } from "vitest";
import { buildSubagentMessages } from "@/lib/client/use-session";

/**
 * CC 2.1.327 parity — when a subagent's background task finishes, the engine
 * wakes the subagent with a `<task-notification>` user message carrying the
 * parent Task tool_use id. The top-level transcript already drops these; the
 * replayed subagent trail (`task_snapshot` → `buildSubagentMessages`) must too,
 * so the card never shows raw XML as a "→ subagent" row.
 */

const PARENT = "toolu_parent";

const NOTIFICATION =
  "<task-notification>\n<task-id>bg-7f3a</task-id>\n<status>completed</status>\n" +
  "<summary>Background command finished</summary>\n</task-notification>";

function user(uuid: string, content: unknown, at?: number) {
  return { at, message: { type: "user", uuid, message: { content } } };
}

describe("buildSubagentMessages drops task notifications", () => {
  test("string-content notification is skipped, the real prompt stays", () => {
    const out = buildSubagentMessages(
      [user("u1", "Map the session store.", 1000), user("u2", NOTIFICATION, 2000)],
      PARENT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "user",
      parentToolUseId: PARENT,
      blocks: [{ kind: "text", text: "Map the session store." }],
    });
  });

  test("array-content notification (with leading whitespace) is skipped", () => {
    const out = buildSubagentMessages(
      [
        user("u1", [{ type: "text", text: "Map the session store." }]),
        user("u2", [{ type: "text", text: `\n  ${NOTIFICATION}` }]),
      ],
      PARENT,
    );
    expect(out.map((m) => m.uuid)).toEqual(["u1"]);
  });

  test("a prompt that merely mentions the tag mid-text is kept", () => {
    const text = "Explain what a <task-notification> message is.";
    const out = buildSubagentMessages([user("u1", text)], PARENT);
    expect(out).toHaveLength(1);
    expect(out[0].blocks).toEqual([{ kind: "text", text }]);
  });
});
