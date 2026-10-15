import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findSlashCommand, resolveFastCommandArgs } from "@/lib/shared/slash-commands";
import { isSdkSlashUserMessage } from "@/lib/client/sdk-message-filters";
import { parseEffortArgs } from "@/lib/shared/effort-flags";
import {
  OPEN_ADVISOR_PICKER_EVENT,
  OPEN_MODEL_PICKER_EVENT,
  requestOpenModelPicker,
} from "@/lib/client/model-picker-events";

/**
 * CC 2.1.299 — "a bare /model, /effort or /fast there now opens a picker".
 * In Claudius the chat composer (`runNative` for `/model` / `/effort`,
 * `handleSend` for `/fast`) dispatches `OPEN_MODEL_PICKER_EVENT` for a bare
 * `/model`, `/effort` or `/fast`; the
 * SessionCard claims it (preventDefault) and opens its ModelPicker. When no
 * card claims it, the commands fall back to their pre-2.1.299 behaviour.
 */

describe("slash registry", () => {
  test("/fast is native so its bare form can open the picker", () => {
    const fast = findSlashCommand("fast");
    expect(fast?.handler).toBe("native");
    expect(fast?.argsHint).toBe("[on|off]");
    expect(fast?.description).toMatch(/picker/i);
  });

  test("/fast is flagged as still forwarding to the SDK; /model and /effort aren't", () => {
    expect(findSlashCommand("fast")?.forwardsArgsToSdk).toBe(true);
    expect(findSlashCommand("model")?.forwardsArgsToSdk).toBeUndefined();
    expect(findSlashCommand("effort")?.forwardsArgsToSdk).toBeUndefined();
  });

  test("/model and /effort stay native and advertise the bare-picker form", () => {
    for (const name of ["model", "effort"]) {
      const cmd = findSlashCommand(name);
      expect(cmd?.handler).toBe("native");
      expect(cmd?.description).toMatch(/picker/i);
    }
  });
});

describe("isSdkSlashUserMessage — forwarded /fast on disk", () => {
  test("a forwarded `/fast on` (or bare `/fast`) record is a slash pill, not a user bubble", () => {
    expect(isSdkSlashUserMessage("/fast on")).toEqual({ command: "/fast", args: "on" });
    expect(isSdkSlashUserMessage([{ type: "text", text: "/fast" }])).toEqual({ command: "/fast", args: "" });
  });

  test("purely native commands are still not matched", () => {
    expect(isSdkSlashUserMessage("/model claude-sonnet-4-6")).toBeNull();
    expect(isSdkSlashUserMessage("/effort high")).toBeNull();
  });
});

describe("resolveFastCommandArgs", () => {
  test("no args (or whitespace) opens the picker", () => {
    expect(resolveFastCommandArgs("")).toEqual({ action: "open-picker" });
    expect(resolveFastCommandArgs("   ")).toEqual({ action: "open-picker" });
  });

  test("any args are forwarded to the SDK verbatim", () => {
    expect(resolveFastCommandArgs("on")).toEqual({ action: "forward", text: "/fast on" });
    expect(resolveFastCommandArgs(" off ")).toEqual({ action: "forward", text: "/fast off" });
  });
});

describe("bare /effort", () => {
  test("parses to the show case that now opens the picker", () => {
    expect(parseEffortArgs("")).toMatchObject({ kind: "show" });
    // `/effort <level>` is unchanged.
    expect(parseEffortArgs("high")).toMatchObject({ kind: "level", level: "high" });
  });
});

describe("requestOpenModelPicker", () => {
  const g = globalThis as { window?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = g.window;
    g.window = new EventTarget();
  });
  afterEach(() => {
    g.window = saved;
  });

  test("event names are distinct", () => {
    expect(OPEN_MODEL_PICKER_EVENT).toBe("claudius:open-model-picker");
    expect(OPEN_ADVISOR_PICKER_EVENT).toBe("claudius:open-advisor-picker");
  });

  test("returns false when no picker listener is mounted", () => {
    expect(requestOpenModelPicker()).toBe(false);
  });

  test("returns false when a listener sees but doesn't claim the event", () => {
    let seen = 0;
    (g.window as EventTarget).addEventListener(OPEN_MODEL_PICKER_EVENT, () => {
      seen += 1;
    });
    expect(requestOpenModelPicker()).toBe(false);
    expect(seen).toBe(1);
  });

  test("returns true when a listener claims it via preventDefault", () => {
    (g.window as EventTarget).addEventListener(OPEN_MODEL_PICKER_EVENT, (e) => e.preventDefault());
    expect(requestOpenModelPicker()).toBe(true);
  });

  test("a bare /fast carries focus: \"fast\" so a card can decline it", () => {
    const seen: unknown[] = [];
    (g.window as EventTarget).addEventListener(OPEN_MODEL_PICKER_EVENT, (e) => {
      const detail = (e as CustomEvent<{ focus?: string }>).detail;
      seen.push(detail);
      // Mirrors SessionCard: decline `/fast` when the model has no fast row.
      if (detail?.focus !== "fast") e.preventDefault();
    });
    expect(requestOpenModelPicker({ focus: "fast" })).toBe(false);
    expect(requestOpenModelPicker()).toBe(true);
    expect(seen).toEqual([{ focus: "fast" }, {}]);
  });

  test("returns false without a window (SSR)", () => {
    g.window = undefined;
    expect(requestOpenModelPicker()).toBe(false);
  });
});
