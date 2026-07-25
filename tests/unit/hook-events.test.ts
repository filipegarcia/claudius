import { describe, expect, test } from "vitest";
import { HOOK_EVENT_NAMES, HOOK_EVENTS, CATEGORY_ORDER, CATEGORY_LABELS } from "@/lib/shared/hook-events";

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
