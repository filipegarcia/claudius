import { describe, expect, test } from "vitest";
import {
  HOOK_EVENT_NAMES,
  HOOK_EVENTS,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  agentHandlerAllowed,
  AGENT_HANDLER_DISALLOWED_EVENTS,
  hookEventGetsDurablePill,
} from "@/lib/shared/hook-events";

describe("hookEventGetsDurablePill (CC 2.1.271 — B5)", () => {
  test("one-time lifecycle hooks get a durable pill", () => {
    expect(hookEventGetsDurablePill("SessionStart", false)).toBe(true);
    expect(hookEventGetsDurablePill("Setup", false)).toBe(true);
    expect(hookEventGetsDurablePill("SessionEnd", false)).toBe(true);
  });

  test("frequent hooks get no pill on success (shown as a transient status instead)", () => {
    expect(hookEventGetsDurablePill("PreToolUse", false)).toBe(false);
    expect(hookEventGetsDurablePill("UserPromptSubmit", false)).toBe(false);
    expect(hookEventGetsDurablePill("PostToolUse", false)).toBe(false);
  });

  test("ANY failed hook keeps a pill so the error stays visible", () => {
    expect(hookEventGetsDurablePill("PreToolUse", true)).toBe(true);
    expect(hookEventGetsDurablePill("UserPromptSubmit", true)).toBe(true);
  });
});

describe("agentHandlerAllowed (CC 2.1.280)", () => {
  test("agent hooks are disallowed on PermissionRequest", () => {
    expect(agentHandlerAllowed("PermissionRequest")).toBe(false);
    expect(AGENT_HANDLER_DISALLOWED_EVENTS).toContain("PermissionRequest");
  });

  test("agent hooks are allowed on ordinary events", () => {
    expect(agentHandlerAllowed("PreToolUse")).toBe(true);
    expect(agentHandlerAllowed("SessionStart")).toBe(true);
    expect(agentHandlerAllowed("Stop")).toBe(true);
  });

  test("every disallowed event is a real hook event", () => {
    for (const e of AGENT_HANDLER_DISALLOWED_EVENTS) {
      expect(HOOK_EVENT_NAMES).toContain(e);
    }
  });
});

/**
 * `lib/shared/hook-events.ts` mirrors the SDK's `HOOK_EVENTS` const
 * (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) with our own
 * display metadata for the `/hooks` editor. SDK 0.3.219 added the
 * `DirectoryAdded` lifecycle event; these tests both pin that addition and
 * guard the general contract — every name in `HOOK_EVENT_NAMES` needs a
 * matching `HOOK_EVENTS` display-metadata row, and vice versa, so the two
 * lists can't silently drift on a future SDK bump.
 */
describe("hook-events", () => {
  test("HOOK_EVENT_NAMES includes DirectoryAdded (SDK 0.3.219)", () => {
    expect(HOOK_EVENT_NAMES).toContain("DirectoryAdded");
  });

  test("HOOK_EVENTS has a display-metadata row for DirectoryAdded", () => {
    const spec = HOOK_EVENTS.find((e) => e.name === "DirectoryAdded");
    expect(spec).toBeDefined();
    expect(spec?.category).toBe("fs");
    expect(spec?.description.length).toBeGreaterThan(0);
  });

  test("PostToolUse documents classifierContext for the auto-mode permission classifier (SDK 0.3.236)", () => {
    const spec = HOOK_EVENTS.find((e) => e.name === "PostToolUse");
    expect(spec).toBeDefined();
    expect(spec?.description).toMatch(/classifierContext/i);
  });

  test("HOOK_EVENT_NAMES includes PreModelSwitch and PostModelSwitch (SDK 0.3.251)", () => {
    expect(HOOK_EVENT_NAMES).toContain("PreModelSwitch");
    expect(HOOK_EVENT_NAMES).toContain("PostModelSwitch");
  });

  test("HOOK_EVENTS has display-metadata rows for PreModelSwitch and PostModelSwitch under a new 'model' category", () => {
    const pre = HOOK_EVENTS.find((e) => e.name === "PreModelSwitch");
    const post = HOOK_EVENTS.find((e) => e.name === "PostModelSwitch");
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    expect(pre?.category).toBe("model");
    expect(post?.category).toBe("model");
    expect(pre?.canBlock).toBe(true);
    expect(post?.description.length).toBeGreaterThan(0);
  });

  test("HOOK_EVENT_NAMES and HOOK_EVENTS stay in sync (no silent drift)", () => {
    const namesInEvents = HOOK_EVENTS.map((e) => e.name).sort();
    expect(namesInEvents).toEqual([...HOOK_EVENT_NAMES].sort());
  });

  test("every HOOK_EVENTS category is covered by CATEGORY_ORDER / CATEGORY_LABELS", () => {
    const usedCategories = new Set(HOOK_EVENTS.map((e) => e.category));
    for (const category of usedCategories) {
      expect(CATEGORY_ORDER).toContain(category);
      expect(CATEGORY_LABELS[category]).toBeTruthy();
    }
  });
});
