"use client";

import { useCallback, useEffect, useState } from "react";

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

export function useEditor() {
  const [editor, setEditorState] = useState<EditorId>("vscode");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as EditorId | null;
      if (saved && EDITORS.some((e) => e.id === saved)) setEditorState(saved);
    } catch {
      // ignore
    }
  }, []);

  const setEditor = useCallback((id: EditorId) => {
    setEditorState(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
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
