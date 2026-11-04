import type { DiffSelection } from "@/components/git/ChangesList";

/** URL of the pop-out page for one changed file (`app/[workspaceId]/git/file`). */
export function gitFileWindowUrl(wsId: string, sel: DiffSelection): string {
  const qs = new URLSearchParams({ path: sel.path, mode: sel.mode });
  return `/${encodeURIComponent(wsId)}/git/file?${qs.toString()}`;
}

/**
 * Open a changed file in its own window. The `popup` feature asks a real
 * browser for a separate window rather than a tab; in the desktop app
 * the same-origin URL hits the `internal-allow` branch of
 * `setWindowOpenHandler` (electron/main.ts) and becomes a child
 * BrowserWindow with the Claudius chrome. Each call opens a fresh window
 * so files can sit side by side.
 */
export function openGitFileWindow(wsId: string, sel: DiffSelection): void {
  window.open(gitFileWindowUrl(wsId, sel), "_blank", "popup,width=1100,height=800");
}
