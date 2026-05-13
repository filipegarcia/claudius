import { describe, expect, test } from "vitest";
import {
  isSdkSlashUserMessage,
  isSyntheticTaskNotification,
  parseSyntheticCliWrapper,
} from "@/lib/client/sdk-message-filters";

/**
 * The Claude Code subprocess wraps a slash-command run in three synthetic
 * user-role messages on the SDK stream:
 *
 *   1. just the slash text (`/compact`) — only present on certain paths;
 *      caught by isSdkSlashUserMessage
 *   2. `<command-name>/compact</command-name><command-message>compact</command-message>
 *      <command-args></command-args>` — caught by parseSyntheticCliWrapper
 *   3. `<local-command-stdout>Compacted </local-command-stdout>` (or stderr) —
 *      caught by parseSyntheticCliWrapper
 *
 * Rendering any of these as a user bubble surfaces XML the user didn't write
 * and looked-like-they-typed-it. The hook lifts each to a small assistant-
 * side system pill instead. These tests pin down what counts as a hit so we
 * don't accidentally swallow real user prose later.
 */

describe("isSdkSlashUserMessage", () => {
  test("recognizes a plain `/compact` string", () => {
    expect(isSdkSlashUserMessage("/compact")).toEqual({ command: "/compact", args: "" });
  });

  test("recognizes `/compact` with trailing args", () => {
    expect(isSdkSlashUserMessage("/compact focus on plumbing")).toEqual({
      command: "/compact",
      args: "focus on plumbing",
    });
  });

  test("recognizes `/compact` inside a content array", () => {
    expect(isSdkSlashUserMessage([{ type: "text", text: "/compact" }])).toEqual({
      command: "/compact",
      args: "",
    });
  });

  test("ignores plain prose that doesn't start with a slash", () => {
    expect(isSdkSlashUserMessage("compact this please")).toBeNull();
  });

  test("ignores a slash that isn't registered as an SDK handler", () => {
    // /tasks is registered but with a non-sdk handler; an unknown command
    // returns null too. Pick a clearly-fake slash to be unambiguous.
    expect(isSdkSlashUserMessage("/this-is-not-a-real-command")).toBeNull();
  });

  test("ignores content arrays with non-text blocks", () => {
    // A real /compact user message is plain text; a content array that
    // contains a tool_use means this isn't a pure slash echo.
    expect(
      isSdkSlashUserMessage([
        { type: "text", text: "/compact" },
        { type: "tool_use" } as unknown as { type: "text"; text: string },
      ]),
    ).toBeNull();
  });

  test("ignores non-string, non-array content", () => {
    expect(isSdkSlashUserMessage(null)).toBeNull();
    expect(isSdkSlashUserMessage(undefined)).toBeNull();
    expect(isSdkSlashUserMessage(42)).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(isSdkSlashUserMessage("  /compact  ")).toEqual({ command: "/compact", args: "" });
  });
});

describe("parseSyntheticCliWrapper", () => {
  test("recognizes the `<command-name>` block emitted around /compact", () => {
    const content =
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>";
    expect(parseSyntheticCliWrapper(content)).toEqual({
      kind: "command",
      command: "/compact",
      args: "",
    });
  });

  test("captures non-empty <command-args>", () => {
    const content =
      "<command-name>/recap</command-name>\n<command-message>recap</command-message>\n<command-args>last 3 turns</command-args>";
    expect(parseSyntheticCliWrapper(content)).toEqual({
      kind: "command",
      command: "/recap",
      args: "last 3 turns",
    });
  });

  test("recognizes <local-command-stdout>", () => {
    expect(parseSyntheticCliWrapper("<local-command-stdout>Compacted </local-command-stdout>")).toEqual({
      kind: "stdout",
      text: "Compacted",
    });
  });

  test("recognizes <local-command-stderr>", () => {
    expect(parseSyntheticCliWrapper("<local-command-stderr>boom</local-command-stderr>")).toEqual({
      kind: "stderr",
      text: "boom",
    });
  });

  test("recognizes empty stdout as stdout (no text)", () => {
    expect(parseSyntheticCliWrapper("<local-command-stdout></local-command-stdout>")).toEqual({
      kind: "stdout",
      text: "",
    });
  });

  test("recognizes wrappers wrapped in a content array of text blocks", () => {
    expect(
      parseSyntheticCliWrapper([
        { type: "text", text: "<command-name>/compact</command-name>" },
        { type: "text", text: "<command-args></command-args>" },
      ]),
    ).toEqual({ kind: "command", command: "/compact", args: "" });
  });

  test("returns null for plain user prose", () => {
    expect(parseSyntheticCliWrapper("hello world")).toBeNull();
  });

  test("returns null for prose that just mentions the tag mid-sentence", () => {
    // The wrapper must be at the start of the content — quoting it in prose
    // shouldn't false-positive into a hidden pill.
    expect(parseSyntheticCliWrapper("here is the format: <command-name>/compact</command-name>")).toBeNull();
  });

  test("returns null for empty / whitespace content", () => {
    expect(parseSyntheticCliWrapper("")).toBeNull();
    expect(parseSyntheticCliWrapper("   \n  ")).toBeNull();
  });

  test("returns null for non-string, non-array content", () => {
    expect(parseSyntheticCliWrapper(null)).toBeNull();
    expect(parseSyntheticCliWrapper(undefined)).toBeNull();
    expect(parseSyntheticCliWrapper({ foo: "bar" })).toBeNull();
  });

  test("disjoint from isSdkSlashUserMessage — wrapper text doesn't start with /", () => {
    // Regression: if both matched the same input we'd render two pills.
    const wrapper =
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>";
    expect(parseSyntheticCliWrapper(wrapper)).not.toBeNull();
    expect(isSdkSlashUserMessage(wrapper)).toBeNull();
  });
});

describe("isSyntheticTaskNotification", () => {
  test("recognizes a leading <task-notification> tag", () => {
    expect(isSyntheticTaskNotification("<task-notification id=\"t1\">done</task-notification>")).toBe(true);
  });

  test("tolerates leading whitespace", () => {
    expect(isSyntheticTaskNotification("  \n<task-notification>x</task-notification>")).toBe(true);
  });

  test("does not match prose that quotes the tag mid-string", () => {
    expect(isSyntheticTaskNotification("here is a <task-notification> tag")).toBe(false);
  });

  test("returns false for non-string, non-array content", () => {
    expect(isSyntheticTaskNotification(null)).toBe(false);
    expect(isSyntheticTaskNotification(undefined)).toBe(false);
    expect(isSyntheticTaskNotification(42)).toBe(false);
  });

  test("inspects text-typed entries in a content array", () => {
    expect(
      isSyntheticTaskNotification([{ type: "text", text: "<task-notification>x</task-notification>" }]),
    ).toBe(true);
  });
});
