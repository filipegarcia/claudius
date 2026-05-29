/**
 * Pin the pure logic behind the `@`-mention picker's agent-completion source
 * (the "Mention @agent-name in composer" feature). These contracts break
 * silently — `next build` type-checks but won't catch token/parse drift — and
 * the SDK `@agent-name` directed-delegation syntax depends on them exactly.
 *
 * We import the REAL symbols from `components/chat/at-mention.ts` (a React-free
 * module split out of `AtMentionPicker.tsx` precisely so the node-only vitest
 * suite can reach them without pulling in React / lucide-react).
 */
import { describe, expect, test } from "vitest";
import {
  AGENT_PREFIX,
  PICKER_LIMIT,
  type Agent,
  filterAgents,
  itemToken,
  parseAtMentionQuery,
} from "@/components/chat/at-mention";

describe("parseAtMentionQuery (the `@` is already stripped upstream)", () => {
  test("an `agent-` prefix flips to agent mode and exposes the trailing filter", () => {
    expect(parseAtMentionQuery("agent-rev")).toEqual({ agentMode: true, filter: "rev" });
  });

  test("a bare `agent-` is agent mode with an empty filter (shows the full list)", () => {
    expect(parseAtMentionQuery(AGENT_PREFIX)).toEqual({ agentMode: true, filter: "" });
  });

  test("`agent` without a hyphen stays in file mode", () => {
    expect(parseAtMentionQuery("agent")).toEqual({ agentMode: false, filter: "" });
  });

  test("an ordinary path token stays in file mode", () => {
    expect(parseAtMentionQuery("src/index")).toEqual({ agentMode: false, filter: "" });
  });

  test("the empty token is file mode (the picker's default `@` state)", () => {
    expect(parseAtMentionQuery("")).toEqual({ agentMode: false, filter: "" });
  });
});

describe("itemToken — the body handed to onSelect (no leading `@`)", () => {
  test("an agent row becomes `agent-<name>`", () => {
    expect(itemToken({ kind: "agent", name: "reviewer" })).toBe("agent-reviewer");
  });

  test("a file row keeps its relative path verbatim", () => {
    expect(itemToken({ kind: "file", relPath: "lib/server/session.ts", type: "file" })).toBe(
      "lib/server/session.ts",
    );
  });

  test("composed with PromptInput's insert (`@<body> `), an agent yields the documented `@agent-name ` syntax", () => {
    // Mirror of PromptInput.insertAtMention: replace the active `@token` with
    // `@<tokenBody> `. We only assert the body→inserted-text contract here.
    const inserted = `@${itemToken({ kind: "agent", name: "rev" })} `;
    expect(inserted).toBe("@agent-rev ");
  });
});

describe("filterAgents", () => {
  const agents: Agent[] = [
    { name: "reviewer", description: "Reviews diffs for bugs" },
    { name: "explorer", description: "Searches the codebase", model: "haiku" },
    { name: "Architect", description: "Plans big refactors" },
  ];

  test("matches on name, case-insensitively", () => {
    const out = filterAgents(agents, "REV");
    expect(out.map((i) => i.kind === "agent" && i.name)).toEqual(["reviewer"]);
  });

  test("matches on description too", () => {
    const out = filterAgents(agents, "codebase");
    expect(out.map((i) => i.kind === "agent" && i.name)).toEqual(["explorer"]);
  });

  test("an empty filter returns every agent, sorted by name (locale order)", () => {
    const out = filterAgents(agents, "");
    expect(out.map((i) => i.kind === "agent" && i.name)).toEqual([
      "Architect",
      "explorer",
      "reviewer",
    ]);
  });

  test("carries name + description + model onto the row (used for the aside)", () => {
    const [explorer] = filterAgents(agents, "explorer");
    expect(explorer).toEqual({
      kind: "agent",
      name: "explorer",
      description: "Searches the codebase",
      model: "haiku",
    });
  });

  test("a non-match yields nothing", () => {
    expect(filterAgents(agents, "zzz")).toEqual([]);
  });

  test(`caps the result at PICKER_LIMIT (${PICKER_LIMIT})`, () => {
    const many: Agent[] = Array.from({ length: PICKER_LIMIT + 5 }, (_, i) => ({
      // zero-pad so localeCompare order is stable and predictable
      name: `agent-${String(i).padStart(2, "0")}`,
    }));
    const out = filterAgents(many, "");
    expect(out).toHaveLength(PICKER_LIMIT);
    expect(out[0].kind === "agent" && out[0].name).toBe("agent-00");
  });
});
