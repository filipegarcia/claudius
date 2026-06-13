import { describe, expect, it } from "vitest";
import {
  MODEL_UNAVAILABLE_MESSAGE,
  isModelNotFoundText,
  rewriteModelUnavailableBlocks,
} from "@/lib/client/use-session";
import type { DisplayBlock } from "@/lib/client/types";

const text = (t: string): DisplayBlock[] => [{ kind: "text", text: t }];

describe("isModelNotFoundText", () => {
  it("matches the CLI's model-not-found prose templates", () => {
    // Literal strings from the Claude Code binary (error: "model_not_found").
    expect(
      isModelNotFoundText(
        text(
          "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
        ),
      ),
    ).toBe(true);
    // Curly apostrophe variant.
    expect(
      isModelNotFoundText(text("There’s an issue with the selected model (claude-fable-5).")),
    ).toBe(true);
    // Deployment-specific template.
    expect(
      isModelNotFoundText(
        text("The model claude-fable-5 is not available on your firstParty deployment."),
      ),
    ).toBe(true);
  });

  it("does not match normal prose that mentions a model", () => {
    expect(isModelNotFoundText(text("Claude Fable 5 is a great model for this task."))).toBe(false);
    expect(isModelNotFoundText(text("Switch to /model to pick a different model."))).toBe(false);
  });

  it("requires a pure-text message", () => {
    const mixed: DisplayBlock[] = [
      { kind: "text", text: "There's an issue with the selected model (claude-fable-5)." },
      { kind: "tool_use", id: "t1", name: "Bash", input: {} },
    ];
    expect(isModelNotFoundText(mixed)).toBe(false);
    expect(isModelNotFoundText([])).toBe(false);
  });
});

describe("rewriteModelUnavailableBlocks", () => {
  it("replaces prose with the actionable message on the structured signal", () => {
    const out = rewriteModelUnavailableBlocks(
      text("There's an issue with the selected model (claude-fable-5)."),
      "model_not_found",
    );
    expect(out).toEqual(text(MODEL_UNAVAILABLE_MESSAGE));
  });

  it("replaces prose on the replay path (no error field) via text detection", () => {
    const out = rewriteModelUnavailableBlocks(
      text(
        "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
      ),
    );
    expect(out).toEqual(text(MODEL_UNAVAILABLE_MESSAGE));
  });

  it("leaves ordinary assistant turns untouched", () => {
    const blocks = text("Here's the plan for the refactor.");
    expect(rewriteModelUnavailableBlocks(blocks)).toBe(blocks);
    expect(rewriteModelUnavailableBlocks(blocks, "rate_limit")).toBe(blocks);
  });

  it("only rewrites Fable — other unavailable models keep the SDK's prose", () => {
    // A non-Fable model that 404s: the learn-more link is Fable-specific, so
    // we leave the SDK's own (model-named) prose intact.
    const opus = text(
      "There's an issue with the selected model (claude-opus-4-8). It may not exist or you may not have access to it.",
    );
    expect(rewriteModelUnavailableBlocks(opus, "model_not_found")).toBe(opus);
    expect(rewriteModelUnavailableBlocks(opus)).toBe(opus);
  });
});
