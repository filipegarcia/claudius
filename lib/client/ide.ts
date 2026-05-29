"use client";

import { useCallback, useSyncExternalStore } from "react";

export type EditorId = "vscode" | "cursor" | "windsurf" | "zed" | "jetbrains" | "system";

export const EDITORS: { id: EditorId; label: string; hint: string }[] = [
  { id: "vscode", label: "VS Code", hint: "vscode://file/<path>:<line>" },
  { id: "cursor", label: "Cursor", hint: "cursor://file/<path>:<line>" },
  { id: "windsurf", label: "Windsurf", hint: "windsurf://file/<path>:<line>" },
  { id: "zed", label: "Zed", hint: "zed://file/<path>:<line>" },
  { id: "jetbrains", label: "JetBrains", hint: "jetbrains://idea/navigate/reference?path=<path>&line=<line>" },
  { id: "system", label: "System default", hint: "file://<path>" },
];

const STORAGE_KEY = "claudius.editor";
const DEFAULT: EditorId = "vscode";
const SAME_TAB_EVENT = "claudius.editor.changed";

export function buildEditorUrl(absPath: string, line: number | undefined, ide: EditorId): string {
  const safe = absPath.replace(/^~\//, ""); // unlikely but tidy
  const lineSuffix = typeof line === "number" && line > 0 ? `:${line}` : "";
  switch (ide) {
    case "vscode":
      return `vscode://file/${encodeURI(safe)}${lineSuffix}`;
    case "cursor":
      return `cursor://file/${encodeURI(safe)}${lineSuffix}`;
    case "windsurf":
      return `windsurf://file/${encodeURI(safe)}${lineSuffix}`;
    case "zed":
      return `zed://file/${encodeURI(safe)}${lineSuffix}`;
    case "jetbrains": {
      const params = new URLSearchParams({ path: safe });
      if (typeof line === "number" && line > 0) params.set("line", String(line));
      return `jetbrains://idea/navigate/reference?${params}`;
    }
    case "system":
    default:
      return `file://${encodeURI(safe)}`;
  }
}

function readSnapshot(): EditorId {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) as EditorId | null;
    if (saved && EDITORS.some((e) => e.id === saved)) return saved;
  } catch {
    // ignore
  }
  return DEFAULT;
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  window.addEventListener(SAME_TAB_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(SAME_TAB_EVENT, cb);
  };
}

/**
 * IDE preference sourced from localStorage via `useSyncExternalStore` —
 * same pattern as `useTheme`. See that hook's docstring for the why.
 */
export function useEditor() {
  const editor = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT);

  const setEditor = useCallback((id: EditorId) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { editor, setEditor };
}

/**
 * Pluck the file path + optional line offset from a tool_use input.
 * Tries the keys Claude Code's built-in tools use: file_path, path, filePath,
 * with line/offset fields. Returns null when no path can be derived.
 */
export function pathFromToolInput(
  input: Record<string, unknown> | undefined,
): { path: string; line?: number } | null {
  if (!input || typeof input !== "object") return null;
  const raw =
    (input.file_path as string | undefined) ??
    (input.filePath as string | undefined) ??
    (input.path as string | undefined) ??
    (input.notebook_path as string | undefined);
  if (typeof raw !== "string" || !raw) return null;
  const lineRaw = (input.line as number | undefined) ?? (input.offset as number | undefined);
  const line = typeof lineRaw === "number" && lineRaw > 0 ? lineRaw : undefined;
  return { path: raw, line };
}
