import { describe, expect, it } from "vitest";
import { buildSessionSnapshot } from "@/lib/server/session";

/**
 * `session_snapshot` carries the state that lives UPSTREAM of the tail-replay
 * window, so a client reconnecting to a long session gets back what the
 * window sliced off. The `init` field is the newest member: `system:init` is
 * broadcast once at session start and sits at buffer index ~1, so every
 * session with more turns than `tail=20` loses its slash commands, subagents,
 * skills and cwd on reconnect without it.
 */
describe("buildSessionSnapshot", () => {
  const INIT = { slashCommands: ["deploy"], agents: ["reviewer"], skills: [], cwd: "/work" };
  const PROMPT = { uuid: "u1", text: "what time is it?", at: 1_700_000_000_000 };

  it("returns null when there is nothing upstream to rehydrate", () => {
    // A fresh session whose whole life fits inside the replay window needs no
    // snapshot — emitting an empty one would be pure noise on every connect.
    expect(buildSessionSnapshot({})).toBeNull();
  });

  it("fires for init alone", () => {
    // The regression this guards: the gate used to test only todos and the
    // last prompt, so a session with init chrome but neither of those got no
    // snapshot at all and the client's slash picker stayed empty.
    const snap = buildSessionSnapshot({ init: INIT });
    expect(snap).not.toBeNull();
    expect(snap?.init).toEqual(INIT);
    // Absent fields must stay absent rather than serialize as nulls — the
    // client treats "missing" as "unchanged".
    expect(snap).not.toHaveProperty("todos");
    expect(snap).not.toHaveProperty("lastUserPrompt");
  });

  it("fires for a prompt alone, and for todos alone", () => {
    expect(buildSessionSnapshot({ lastUserPrompt: PROMPT })?.lastUserPrompt).toEqual(PROMPT);
    expect(buildSessionSnapshot({ todos: [] })).not.toBeNull();
  });

  it("treats an empty todo list as a payload, not as absence", () => {
    // An explicit [] means "the list was cleared" and has to reach the client
    // to override the list it rebuilt from replayed TodoWrites. Truthiness
    // checking here would silently drop exactly that case.
    const snap = buildSessionSnapshot({ todos: [], todosStale: false });
    expect(snap?.todos).toEqual([]);
    expect(snap?.todosStale).toBe(false);
  });

  it("carries every field at once", () => {
    const snap = buildSessionSnapshot({
      todos: [{ content: "ship it", status: "pending" }],
      todosStale: true,
      lastUserPrompt: PROMPT,
      init: INIT,
    });
    expect(snap).toMatchObject({
      type: "session_snapshot",
      todosStale: true,
      lastUserPrompt: PROMPT,
      init: INIT,
    });
    expect(snap?.todos).toHaveLength(1);
  });
});
