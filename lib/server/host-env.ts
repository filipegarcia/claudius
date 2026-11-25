/**
 * Environment variables that describe how the Claudius server process itself
 * runs, and must never reach the commands, hooks and MCP servers Claude
 * starts.
 *
 * CC 2.1.331 — "Fixed Electron apps and extension tests failing to start from
 * Claude, a hook or an MCP server; a wrapper, hook or server that runs VS Code
 * as Node must now set `ELECTRON_RUN_AS_NODE=1`". Claudius's desktop app has
 * the same bug: `electron/server.ts` runs the Next server as the Electron
 * binary in Node mode (`ELECTRON_RUN_AS_NODE=1`). That env was handed whole to
 * the engine and to `!` bash mode, so `npx electron .`, an Electron project's
 * `npm start`, `@vscode/test-electron` and Playwright's `_electron.launch`
 * all started as plain Node. The engine itself is a native binary and doesn't
 * need the flag. Claudius's own children that do (`customization-revert.ts`)
 * keep inheriting `process.env` directly.
 */
export const HOST_ONLY_ENV_KEYS = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "ELECTRON_NO_ATTACH_CONSOLE"] as const;

/** A copy of `env` without the host-only keys. Never mutates `env`. */
export function scrubHostEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const key of HOST_ONLY_ENV_KEYS) delete out[key];
  return out;
}
