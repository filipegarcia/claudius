/**
 * Pure-builder coverage for `electron/ipc/context-menu.ts`.
 *
 * The native `Menu.popup()` site lives behind `registerContextMenu`, which
 * can only be exercised under a real Electron `webContents` — Playwright
 * can't drive popups. The builder split lets us pin the menu *shape* (link
 * items vs selection vs editable vs spelling suggestions) under vitest,
 * which is the part that actually has branching logic. The popup wrapper
 * is a thin call to `Menu.buildFromTemplate(template).popup(...)`.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  // Pure-builder import path only touches type-only re-exports, but we
  // mock the whole module so the import doesn't reach the real Electron
  // binary loader under vitest.
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import {
  buildContextMenuTemplate,
  type ContextMenuCallbacks,
  type ContextMenuParamsLike,
} from "@/electron/ipc/context-menu";

/** Minimal `editFlags` defaults — all true unless a test overrides. */
function flags(overrides: Partial<ContextMenuParamsLike["editFlags"]> = {}): ContextMenuParamsLike["editFlags"] {
  return {
    canUndo: true,
    canRedo: true,
    canCut: true,
    canCopy: true,
    canPaste: true,
    canDelete: true,
    canSelectAll: true,
    canEditRichly: true,
    ...overrides,
  };
}

function makeParams(overrides: Partial<ContextMenuParamsLike> = {}): ContextMenuParamsLike {
  return {
    x: 0,
    y: 0,
    linkURL: "",
    selectionText: "",
    isEditable: false,
    editFlags: flags(),
    misspelledWord: "",
    dictionarySuggestions: [],
    mediaType: "none",
    ...overrides,
  };
}

function makeCallbacks(): ContextMenuCallbacks {
  return {
    openExternal: vi.fn(),
    copyText: vi.fn(),
    startNewChatWithText: vi.fn(),
    replaceMisspelling: vi.fn(),
    inspectElement: vi.fn(),
    reload: vi.fn(),
  };
}

describe("buildContextMenuTemplate", () => {
  test("non-editable, no selection, no link → fallback (Reload + Inspect)", () => {
    const template = buildContextMenuTemplate(makeParams(), makeCallbacks());
    const labels = template.map((it) => it.label ?? `<${it.role ?? it.type}>`);
    expect(labels).toContain("Reload");
    expect(labels).toContain("Inspect Element");
    // No copy/cut/paste — nothing selected, not editable.
    expect(template.find((it) => it.role === "copy")).toBeUndefined();
    expect(template.find((it) => it.role === "cut")).toBeUndefined();
  });

  test("selection present (non-editable) → Copy + Select All + 'Start New Chat With …'", () => {
    const template = buildContextMenuTemplate(
      makeParams({ selectionText: "hello world" }),
      makeCallbacks(),
    );
    expect(template.find((it) => it.role === "copy")).toBeDefined();
    expect(template.find((it) => it.role === "selectAll")).toBeDefined();
    const newChat = template.find((it) => typeof it.label === "string" && it.label.startsWith("Start New Chat With"));
    expect(newChat).toBeDefined();
    expect(newChat?.label).toContain("hello world");
    // No Cut/Paste — not editable.
    expect(template.find((it) => it.role === "cut")).toBeUndefined();
    expect(template.find((it) => it.role === "paste")).toBeUndefined();
  });

  test("Start-new-chat label truncates long selections", () => {
    const long = "a".repeat(200);
    const template = buildContextMenuTemplate(
      makeParams({ selectionText: long }),
      makeCallbacks(),
    );
    const item = template.find((it) => typeof it.label === "string" && it.label.startsWith("Start New Chat With"));
    expect(item?.label?.length).toBeLessThan(60);
    expect(item?.label).toMatch(/…/);
  });

  test("Start-new-chat click forwards the FULL selection (not the truncated label)", () => {
    const cb = makeCallbacks();
    const long = "important context ".repeat(50).trim();
    const template = buildContextMenuTemplate(
      makeParams({ selectionText: long }),
      cb,
    );
    const item = template.find((it) => typeof it.label === "string" && it.label.startsWith("Start New Chat With"));
    expect(item).toBeDefined();
    // Synthesize a click — Electron passes the click handler the menu item;
    // we don't care about that arg, only that the callback gets the raw text.
    (item?.click as () => void)();
    expect(cb.startNewChatWithText).toHaveBeenCalledWith(long);
  });

  test("link-clicked → Open + Copy address surface before selection items", () => {
    const template = buildContextMenuTemplate(
      makeParams({ linkURL: "https://example.com/foo", selectionText: "link label" }),
      makeCallbacks(),
    );
    const openIdx = template.findIndex((it) => it.label === "Open Link in Browser");
    const copyIdx = template.findIndex((it) => it.role === "copy");
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThan(openIdx); // link items come first
    expect(template.find((it) => it.label === "Copy Link Address")).toBeDefined();
  });

  test("editable field → Cut/Copy/Paste/SelectAll with editFlags respected", () => {
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        editFlags: flags({ canCut: false, canCopy: false, canPaste: true }),
      }),
      makeCallbacks(),
    );
    const cut = template.find((it) => it.role === "cut");
    const copy = template.find((it) => it.role === "copy");
    const paste = template.find((it) => it.role === "paste");
    expect(cut?.enabled).toBe(false);
    expect(copy?.enabled).toBe(false);
    expect(paste?.enabled).toBe(true);
  });

  test("misspelt word in editable → suggestion items + replaceMisspelling callback", () => {
    const cb = makeCallbacks();
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "ten", "tea"],
      }),
      cb,
    );
    const sugLabels = template.slice(0, 3).map((it) => it.label);
    expect(sugLabels).toEqual(["the", "ten", "tea"]);
    (template[0].click as () => void)();
    expect(cb.replaceMisspelling).toHaveBeenCalledWith("the");
  });

  test("misspelt word with no suggestions → 'No spelling suggestions' (disabled)", () => {
    const template = buildContextMenuTemplate(
      makeParams({ isEditable: true, misspelledWord: "asdjkl", dictionarySuggestions: [] }),
      makeCallbacks(),
    );
    const noneItem = template.find((it) => it.label === "No spelling suggestions");
    expect(noneItem).toBeDefined();
    expect(noneItem?.enabled).toBe(false);
  });

  test("image mediaType (no selection, no link) → falls back to Reload + Inspect (no Copy Image yet)", () => {
    // "Copy Image" is a deliberate V1 omission — Electron has no `copyImage`
    // role and we haven't wired the click-handler equivalent yet. The test
    // pins the current behavior so a future addition is intentional.
    const template = buildContextMenuTemplate(
      makeParams({ mediaType: "image" }),
      makeCallbacks(),
    );
    expect(template.find((it) => it.label === "Reload")).toBeDefined();
    expect(template.find((it) => it.label === "Inspect Element")).toBeDefined();
  });

  test("template always ends with Inspect Element", () => {
    for (const params of [
      makeParams(),
      makeParams({ selectionText: "x" }),
      makeParams({ isEditable: true }),
      makeParams({ linkURL: "https://x" }),
    ]) {
      const template = buildContextMenuTemplate(params, makeCallbacks());
      expect(template[template.length - 1].label).toBe("Inspect Element");
    }
  });
});
