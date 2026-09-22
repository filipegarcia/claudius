import { describe, expect, test, vi } from "vitest";

/**
 * SDK 0.3.280 added `verbatimPrompts` to `Options`: when set, the CLI
 * delivers the prompt exactly as written — no `@path` expansion, no
 * slash-command dispatch. Claudius's one-shot, host-composed, tool-less
 * query() calls embed raw diff/transcript text a user never typed as that
 * literal prompt, so a `@file`- or `/command`-looking substring inside that
 * embedded text could otherwise be misinterpreted. This test asserts the
 * flag is actually threaded through to `query()`'s options for the two
 * lightest-weight call sites (`generateCommitMessage`, `generateRecap`);
 * `describeCustomization` in `lib/server/customization-description.ts` gets
 * the identical one-line addition but pulls in the full customization-store
 * dependency chain (getCustomization/computeSyncStatus/collectUserIntent),
 * so it's covered by direct code inspection rather than a mock-heavy unit
 * test here — see the run-notes' "Code changes" section for that call site.
 */

const capturedOptions: Record<string, unknown>[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    capturedOptions.push(args.options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          result: "generated text",
        };
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "generated text" }] },
        };
      },
    };
  },
}));

describe("SDK 0.3.280 verbatimPrompts on host-composed one-shot prompts", () => {
  test("generateCommitMessage sets options.verbatimPrompts = true", async () => {
    capturedOptions.length = 0;
    const { generateCommitMessage } = await import("@/lib/server/commit-message");
    const result = await generateCommitMessage("/tmp/repo", "diff --git a/x b/x\n+line");
    expect(result.ok).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.verbatimPrompts).toBe(true);
  });

  test("generateRecap sets options.verbatimPrompts = true", async () => {
    capturedOptions.length = 0;
    const { generateRecap } = await import("@/lib/server/session-recap");
    const result = await generateRecap({ cwd: "/tmp/repo", transcriptTail: "user: hi\nassistant: hello" });
    expect(result.ok).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.verbatimPrompts).toBe(true);
  });
});
