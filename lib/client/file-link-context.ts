"use client";

import { createContext, useContext } from "react";

/**
 * Workspace coordinates needed to turn a project file reference into a link
 * to the in-app Files browser. Computed once near the chat root (MessageList)
 * and shared via context so individual `ToolCall` rows and inline-code spans
 * don't each spin up a `useWorkspaces()` fetch.
 *
 * `null` means "we don't know the workspace yet" (still loading, or none
 * active) — consumers should fall back to rendering plain, non-clickable text.
 */
export type FileLinkBase = {
  /** Active workspace id, e.g. `wks_94c…` — the `/<id>/files` route prefix. */
  workspaceId: string;
  /** Absolute workspace root, used to relativize absolute file paths. */
  cwd: string;
};

const FileLinkContext = createContext<FileLinkBase | null>(null);

export const FileLinkProvider = FileLinkContext.Provider;

export function useFileLink(): FileLinkBase | null {
  return useContext(FileLinkContext);
}
