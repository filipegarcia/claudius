/**
 * Right-click context menu for the renderer.
 *
 * Without this Electron suppresses Chromium's built-in context menu and the
 * user has no way to copy selected text with the mouse (Cmd+C still works
 * via the Edit menu, but right-click → Copy is the natural reflex and was
 * dead before this handler landed).
 *
 * The menu is built dynamically from the `params` Chromium hands us so the
 * items match the click target: link items appear on links, spelling
 * suggestions appear in editable fields, and the "Start new chat with
 * selected text" entry only shows up when there *is* selected text.
 *
 * Pure-builder split — `buildContextMenuTemplate(params, cb)` returns the
 * `MenuItemConstructorOptions[]` array without touching `Menu.popup`, so
 * unit tests can pin the menu shape (link vs selection vs editable) without
 * mounting an Electron `webContents`. The popup site (`registerContextMenu`)
 * stays a thin wrapper.
 */
import {
  BrowserWindow,
  clipboard,
  Menu,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

/** TOPIC strings exported so preload + main stay in lockstep. */
export const TOPIC_NEW_WITH_TEXT = "chat:new-with-text";

/**
 * Callbacks the pure builder needs. Kept as a struct (rather than reading
 * Electron globals directly) so vitest can stub each leaf independently.
 */
export type ContextMenuCallbacks = {
  /** Open `url` in the user's default browser. */
  openExternal: (url: string) => void;
  /** Copy raw text to the system clipboard. */
  copyText: (text: string) => void;
  /**
   * Ask the renderer to spawn a brand-new chat session and prefill its
   * composer with `text`. Implemented as a renderer-side reaction to the
   * `chat:new-with-text` push channel.
   */
  startNewChatWithText: (text: string) => void;
  /** Tell the focused webContents to replace its misspelt word. */
  replaceMisspelling: (replacement: string) => void;
  /** Open / focus the dev tools at the click coordinates. */
  inspectElement: (x: number, y: number) => void;
  /** Reload the renderer (only shown when no selection / not editable). */
  reload: () => void;
};

/** A trimmed shape of Electron's `ContextMenuParams` so the builder is testable. */
export type ContextMenuParamsLike = Pick<
  ContextMenuParams,
  | "x"
  | "y"
  | "linkURL"
  | "selectionText"
  | "isEditable"
  | "editFlags"
  | "misspelledWord"
  | "dictionarySuggestions"
  | "mediaType"
>;

/** Soft cap on the selection-text preview shown in the menu label. */
const SELECTION_LABEL_MAX = 30;

/**
 * Build the menu template for the given click. Pure — no Electron globals,
 * no Menu.popup, no clipboard side effects. Items are appended in click-context
 * priority so the most-relevant action sits closest to the cursor.
 */
export function buildContextMenuTemplate(
  params: ContextMenuParamsLike,
  cb: ContextMenuCallbacks,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const hasSelection = params.selectionText.trim().length > 0;
  const isLink = params.linkURL.length > 0;
  const isEditable = params.isEditable === true;
  const editFlags = params.editFlags;
  const suggestions = params.dictionarySuggestions ?? [];
  const misspelled = params.misspelledWord?.length ? params.misspelledWord : "";

  // ── Spelling suggestions (editable + misspelt word) ─────────────────────
  if (isEditable && misspelled && suggestions.length > 0) {
    for (const word of suggestions.slice(0, 5)) {
      items.push({
        label: word,
        click: () => cb.replaceMisspelling(word),
      });
    }
    items.push({ type: "separator" });
  } else if (isEditable && misspelled) {
    items.push({ label: "No spelling suggestions", enabled: false });
    items.push({ type: "separator" });
  }

  // ── Link items (link target trumps selection) ───────────────────────────
  if (isLink) {
    items.push({
      label: "Open Link in Browser",
      click: () => cb.openExternal(params.linkURL),
    });
    items.push({
      label: "Copy Link Address",
      click: () => cb.copyText(params.linkURL),
    });
    items.push({ type: "separator" });
  }

  // ── Standard clipboard ──────────────────────────────────────────────────
  // Editable: full Cut/Copy/Paste/SelectAll. Roles honour `editFlags`
  // automatically so we never hand-roll the disabled state.
  if (isEditable) {
    items.push({ role: "cut", enabled: editFlags?.canCut !== false });
    items.push({ role: "copy", enabled: editFlags?.canCopy !== false });
    items.push({ role: "paste", enabled: editFlags?.canPaste !== false });
    items.push({ role: "selectAll", enabled: editFlags?.canSelectAll !== false });
  } else if (hasSelection) {
    items.push({ role: "copy" });
    items.push({ role: "selectAll" });
  }
  // "Copy Image" is intentionally omitted in V1 — Electron exposes no
  // matching role; we'd need a click handler that calls
  // `webContents.copyImageAt(x, y)`. Cheap follow-up if it lands as a real
  // user need.

  // ── Claudius-specific power moves on selected text ──────────────────────
  if (hasSelection) {
    items.push({ type: "separator" });
    items.push({
      label: `Start New Chat With "${truncatePreview(params.selectionText)}"`,
      click: () => cb.startNewChatWithText(params.selectionText),
    });
  }

  // ── Page-level fallback when there's nothing else to do ─────────────────
  // Reload + Inspect are always useful for power users; keep them last so
  // they don't crowd the common actions.
  if (items.length > 0) items.push({ type: "separator" });

  if (!isEditable && !hasSelection && !isLink) {
    items.push({
      label: "Reload",
      click: () => cb.reload(),
      accelerator: "CommandOrControl+R",
    });
  }
  items.push({
    label: "Inspect Element",
    click: () => cb.inspectElement(params.x, params.y),
  });

  return items;
}

/**
 * Truncate selection text for display in a menu label. Strips newlines and
 * inserts an ellipsis when over `SELECTION_LABEL_MAX` chars.
 */
function truncatePreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SELECTION_LABEL_MAX) return flat;
  return flat.slice(0, SELECTION_LABEL_MAX - 1) + "…";
}

/**
 * Attach the Chromium `context-menu` listener for a single window. Call
 * once per `BrowserWindow` from `createWindow` in `electron/main.ts`.
 *
 * When the user right-clicks "Start New Chat With …" we push the selection
 * text to the renderer over the `chat:new-with-text` channel — the
 * renderer (app/[workspaceId]/page.tsx) listens via `useElectronSubscription`
 * and reacts by creating a session + injecting the text as a composer draft.
 */
export function registerContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const wc = window.webContents;
    const template = buildContextMenuTemplate(params, {
      openExternal: (url) => {
        void shell.openExternal(url).catch((err) => {
          console.error("[electron/context-menu] openExternal failed:", err);
        });
      },
      copyText: (text) => {
        try {
          clipboard.writeText(text);
        } catch (err) {
          console.error("[electron/context-menu] clipboard.writeText failed:", err);
        }
      },
      startNewChatWithText: (text) => {
        sendNewChatWithText(wc, text);
      },
      replaceMisspelling: (replacement) => {
        try {
          wc.replaceMisspelling(replacement);
        } catch (err) {
          console.error("[electron/context-menu] replaceMisspelling failed:", err);
        }
      },
      inspectElement: (x, y) => {
        try {
          wc.inspectElement(x, y);
        } catch (err) {
          console.error("[electron/context-menu] inspectElement failed:", err);
        }
      },
      reload: () => {
        try {
          wc.reload();
        } catch (err) {
          console.error("[electron/context-menu] reload failed:", err);
        }
      },
    });
    if (template.length === 0) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window });
  });
}

/**
 * Push selection text into the focused renderer over the
 * `chat:new-with-text` channel. Exported so a future "Send selection to
 * specific session" entrypoint (e.g. from the system tray) can reuse it.
 */
export function sendNewChatWithText(wc: WebContents, text: string): void {
  if (!text) return;
  try {
    wc.send(TOPIC_NEW_WITH_TEXT, text);
  } catch (err) {
    console.error("[electron/context-menu] send failed:", err);
  }
}
