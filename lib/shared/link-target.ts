/**
 * Where outbound links should land when the user clicks them inside the
 * Electron app.
 *
 *   - `"external"` — default browser via `shell.openExternal`. Matches the
 *     historical behavior shipped in `electron/main.ts`.
 *   - `"in-app"` — a NEW, sandboxed `BrowserWindow` owned by Claudius
 *     (separate from the main renderer; no preload, fresh session
 *     partition). See `electron/ipc/in-app-browser.ts`.
 *
 * Renderer-only file. The Electron `main` process keeps its own copy of
 * the type + a `resolveLinkAction` function next to its IPC wiring (the
 * codebase keeps `electron/` and `lib/` strictly separate — see
 * `electron/tsconfig.json`'s `rootDir: "."`). If you change the union
 * here, mirror it in `electron/ipc/link-target.ts`.
 *
 * The preference lives in browser localStorage on the renderer side
 * (`lib/client/link-target.ts`) and is pushed to the Electron main
 * process over the `link-target:set` IPC channel so
 * `setWindowOpenHandler` can branch without having to reach back into
 * the renderer on every click.
 */
export type LinkTarget = "external" | "in-app";

/** Default when the preference hasn't been set / pushed yet. */
export const DEFAULT_LINK_TARGET: LinkTarget = "external";

/** All values, in display order. Exported so the settings UI stays terse. */
export const LINK_TARGETS: ReadonlyArray<{
  id: LinkTarget;
  label: string;
  description: string;
}> = [
  {
    id: "external",
    label: "Default browser",
    description:
      "Open links in your system browser (Safari, Chrome, Firefox, …).",
  },
  {
    id: "in-app",
    label: "In-app viewer",
    description:
      "Open links in a sandboxed window inside Claudius — handy when you want to keep the chat side-by-side.",
  },
];
