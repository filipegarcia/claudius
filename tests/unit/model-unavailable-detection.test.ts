import { describe, expect, it } from "vitest";
import {
  MODEL_UNAVAILABLE_MESSAGE,
  isModelNotFoundText,
  modelUnavailableMessage,
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
    expect(out).toEqual(text(modelUnavailableMessage("(claude-fable-5)")));
  });

  it("replaces prose on the replay path (no error field) via text detection", () => {
    const out = rewriteModelUnavailableBlocks(
      text(
        "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
      ),
    );
    expect(out).toEqual(text(modelUnavailableMessage("(claude-fable-5)")));
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

describe("modelUnavailableMessage (CC 2.1.321)", () => {
  it("names the Fable the prose names, not a fixed generation", () => {
    expect(modelUnavailableMessage("selected model (claude-fable-5-1)")).toMatch(/^Claude Fable 5\.1 is currently unavailable\./);
    expect(modelUnavailableMessage("selected model (claude-fable-5)")).toMatch(/^Claude Fable 5 is currently unavailable\./);
    expect(modelUnavailableMessage("The model claude-fable-5-2[1m] is not available")).toMatch(/^Claude Fable 5\.2 /);
  });

  it("falls back to the current default (Fable 5.2) for the bare alias", () => {
    expect(modelUnavailableMessage("selected model (fable)")).toBe(MODEL_UNAVAILABLE_MESSAGE);
    expect(MODEL_UNAVAILABLE_MESSAGE).toMatch(/^Claude Fable 5\.2 is currently unavailable\. Please use Opus 5\.5/);
  });
});
