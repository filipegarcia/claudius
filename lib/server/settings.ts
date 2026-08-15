import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorktreeSettings } from "@/lib/shared/worktree-settings";

import { assertWithin } from "./safe-path";

export type SettingsScope = "user" | "project" | "local";

export type PermissionRules = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  defaultMode?: string;
  additionalDirectories?: string[];
};

export type ClaudeSettings = {
  model?: string;
  theme?: string;
  outputStyle?: string;
  permissions?: PermissionRules;
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  enabledPlugins?: Record<string, boolean>;
  autoMemoryEnabled?: boolean;
  // Predicted next-user-prompt chips (PromptSuggestions). The SDK's canonical
  // settings key: "When false, prompt suggestions are disabled. When absent or
  // true, prompt suggestions are enabled." Read at session start in
  // `session.ts` and forwarded to the SDK's `Options.promptSuggestions`.
  promptSuggestionEnabled?: boolean;
  // `:shortcode:` emoji autocomplete in the prompt composer (Claude Code
  // 2.1.217: "Added emoji shortcode autocomplete in the prompt input: type
  // `:heart:` to insert ❤️, or `:hea` for suggestions — disable with the
  // `emojiCompletionEnabled` setting"). Mirrors the CLI's key name and
  // absent/true = enabled, false = disabled contract exactly. Read client-side
  // by `useEmojiCompletionEnabled` (user scope only — a personal composer
  // preference, same reasoning as `disableAutoMode`); purely a browser-side
  // text-replacement behavior, so there's no server/SDK forwarding involved.
  emojiCompletionEnabled?: boolean;
  // Session recap — the "where were we?" one-liner the client shows when the
  // user returns to a tab after being blurred for ≥5 min. Mirrors the
  // (internal) Claude Code TUI key `awaySummaryEnabled`: `false` disables the
  // banner entirely; omitted/true keeps it on. The generation is server-side
  // (lib/server/session-recap.ts) — there's no SDK option to forward because
  // the SDK's recap is TUI-rendered; Claudius reads this directly.
  sessionRecapEnabled?: boolean;
  // Rotating spinner tips ("Tip: …" under the working spinner). Mirrors the
  // Claude Code CLI keys: `false` disables the rotation entirely, omitted/true
  // leaves it on. Read at session start and forwarded to `selectTips()` via the
  // cached `spinnerTipsConfig` on Session.
  spinnerTipsEnabled?: boolean;
  // Per-user override for the spinner-tip rotation. Mirrors the CLI shape:
  // `{ excludeDefault?: boolean, tips?: string[] }`. When `tips` is a non-empty
  // string list, each entry is mapped to a `custom-tip-${index}` Tip object
  // with no command. When `excludeDefault` is true, the override REPLACES the
  // built-in catalog; otherwise the override entries are appended to it.
  // Unlike built-in tips, custom tips intentionally have no `requires*` gates
  // and (matching the CLI's `cooldownSessions:0` for overrides) ride the same
  // dismiss-weighting as everything else — see DISMISSED_TIP_SHOW_PROBABILITY.
  spinnerTipsOverride?: { excludeDefault?: boolean; tips?: string[] };
  // How the server-side message queue dispatches new user messages
  // typed while the agent is mid-turn (or waiting on a permission/ask
  // prompt). Mirrors the Claude Code TUI's "fast-pipe" affordance: the
  // CLI pushes the new user input into the SDK's input pipe IMMEDIATELY,
  // so the model picks it up as soon as the current turn yields — no
  // queue-strip delay.
  //
  //   • `"wait"` (default) — the message sits visibly in the
  //     QueueIndicator strip; the server drains exactly one item per
  //     `result` / answer transition. Users get edit/cancel/reorder
  //     control before each message dispatches. Best when you often
  //     change your mind mid-turn or want to batch refinements before
  //     they run.
  //
  //   • `"asap"` — the server skips its DB queue entirely and calls
  //     `sendInput()` directly on every send, even mid-turn. The SDK's
  //     inputQueue picks up the message and runs it as the very next
  //     turn. No queue strip; the user bubble appears immediately. Best
  //     when you want TUI parity ("Claude reads my follow-up the
  //     instant this turn finishes").
  //
  // Per-message override: the QueueIndicator strip's "Send now" button
  // forces a single queued message through the asap path on demand,
  // regardless of this setting.
  queueDispatchMode?: "wait" | "asap";
  // Community chat preferences. Persisted at the user scope so the
  // first-visit consent prompt and the nickname picker don't reappear
  // after a Claudius upgrade, an Electron reinstall, or a switch
  // between the desktop app and the browser — they all share the same
  // `~/.claude/settings.json`.
  //   • `communityConsent` — "yes" the user has opted in to opening
  //     an SSE connection to the chat-server; "no" they've opted out.
  //     Undefined means "no decision yet" (show the prompt).
  //   • `communityNick` — the nickname they picked on first connect.
  //     Undefined means "ask them on next connect."
  communityConsent?: "yes" | "no";
  communityNick?: string;
  // Git worktree creation options (the --worktree flag / EnterWorktree).
  // Mirrors the SDK's `Settings.worktree` shape.
  worktree?: WorktreeSettings;
  // Disable Auto mode (the SDK's autonomous permission mode) entirely.
  // Mirrors the SDK's `Settings.disableAutoMode` key exactly: it's a
  // single-literal "flag" rather than a boolean — presence of the string
  // `"disable"` turns Auto mode off; absent (or any other value) leaves it
  // available. Claude Code 2.1.207 made Auto mode available without the
  // `CLAUDE_CODE_ENABLE_AUTO_MODE` opt-in on Bedrock/Vertex/Foundry and
  // shipped this settings escape hatch alongside it; it also stopped
  // reading auto-mode config from the repo-local `.claude/settings.local.json`
  // in favor of `~/.claude/settings.json` only. Both `Session.setPermissionMode`
  // (server-side enforcement) and the `useDisableAutoMode` client hook (hides
  // "Auto" from the ModeSelector / Shift+Tab cycle) read this via
  // `readSettings("user", cwd)` — the "user" scope only, matching upstream.
  disableAutoMode?: "disable";
  // SDK 0.3.219 — advisory size guideline for "ultracode" (Dynamic
  // Workflows): how large a fan-out the model's own Workflow tool should
  // aim for when it plans a run. Mirrors the SDK's `Settings.workflowSizeGuideline`
  // exactly. Read at session start in `session.ts` and forwarded to the SDK's
  // flag layer alongside `advisorModel`/`includeCoAuthoredBy`; surfaced in
  // the Settings page catalog as an enum field next to `advisorModel` and
  // `fastMode` (Model & behavior).
  workflowSizeGuideline?: WorkflowSizeGuideline;
  // Cross-session SendMessage receive policy (Claude Code 2.1.224 —
  // "cross-session SendMessage for agent-to-agent communication"). Governs
  // how inbound peer messages — a `SendMessage` fired from ANOTHER of the
  // same user's sessions (SDK subkind `peer-send-message`) — are handled by
  // this session:
  //   • `"accept"` — deliver them; Claude may act on them.
  //   • `"hold"`   — park them for your review without letting Claude act.
  //   • `"refuse"` — opt this session out of inbound peer messages entirely.
  // Mirrors the SDK's `Settings.crossSessionInbound` key exactly. Absent =
  // the SDK's "mode parity" default (auto-deliver only when the sending
  // session's permission-mode class matches this one). Read at session start
  // in `session.ts` and forwarded to the SDK's flag layer alongside
  // `advisorModel`/`includeCoAuthoredBy`/`workflowSizeGuideline`; surfaced in
  // the Settings page catalog under "Collaboration". The delivered peer turn
  // is itself rendered with a "From <name>" badge (see `extractPeerOrigin` in
  // `lib/client/use-session.ts`).
  crossSessionInbound?: CrossSessionInbound;
  // Catch-all for keys we don't yet know about — we never strip them.
  [key: string]: unknown;
};

/** The SDK's `Settings.workflowSizeGuideline` literal union (0.3.219). */
export type WorkflowSizeGuideline = "unrestricted" | "small" | "medium" | "large";

/** The SDK's `Settings.crossSessionInbound` literal union (Claude Code 2.1.224). */
export type CrossSessionInbound = "accept" | "hold" | "refuse";

/** Runtime-checkable mirror of `WorkflowSizeGuideline`, for validating hand-edited settings.json values before forwarding them to the SDK. */
export const WORKFLOW_SIZE_GUIDELINE_VALUES: readonly WorkflowSizeGuideline[] = [
  "unrestricted",
  "small",
  "medium",
  "large",
];

/** Type guard: is `v` one of the SDK's four `workflowSizeGuideline` literals? */
export function isWorkflowSizeGuideline(v: unknown): v is WorkflowSizeGuideline {
  return (
    typeof v === "string" && (WORKFLOW_SIZE_GUIDELINE_VALUES as readonly string[]).includes(v)
  );
}

/** Runtime-checkable mirror of `CrossSessionInbound`, for validating hand-edited settings.json values before forwarding them to the SDK. */
export const CROSS_SESSION_INBOUND_VALUES: readonly CrossSessionInbound[] = [
  "accept",
  "hold",
  "refuse",
];

/** Type guard: is `v` one of the SDK's three `crossSessionInbound` literals? */
export function isCrossSessionInbound(v: unknown): v is CrossSessionInbound {
  return (
    typeof v === "string" && (CROSS_SESSION_INBOUND_VALUES as readonly string[]).includes(v)
  );
}

/**
 * Monotonic suffix for `writeSettings`'s temp files. `Date.now()` alone is not
 * enough: two writes landing in the same millisecond inside this process would
 * pick the same temp name and interleave into it, reintroducing exactly the
 * torn write the rename is there to prevent.
 */
let writeSeq = 0;

export function pathFor(scope: SettingsScope, projectCwd: string): string {
  // assertWithin acts as the path-injection barrier on the projectCwd →
  // fs.* flow. The relative segment is always a constant string, so this
  // is effectively a "stays inside the workspace's .claude dir" guard.
  if (scope === "user") return assertWithin(join(homedir(), ".claude"), "settings.json");
  if (scope === "project") return assertWithin(projectCwd, join(".claude", "settings.json"));
  return assertWithin(projectCwd, join(".claude", "settings.local.json"));
}

export async function readSettings(scope: SettingsScope, projectCwd: string): Promise<ClaudeSettings> {
  const path = pathFor(scope, projectCwd);
  try {
    const buf = await fs.readFile(path, "utf8");
    return JSON.parse(buf) as ClaudeSettings;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw err;
  }
}

export async function writeSettings(
  scope: SettingsScope,
  projectCwd: string,
  next: ClaudeSettings,
): Promise<void> {
  const path = pathFor(scope, projectCwd);
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const body = JSON.stringify(next, null, 2) + "\n";
  // `lstat`, not `stat` — we need to know whether the destination is itself a
  // symlink before deciding how to write it.
  const st = await fs.lstat(path).catch(() => null);
  if (st?.isSymbolicLink()) {
    // `~/.claude/settings.json` symlinked into a dotfiles repo is a common
    // setup, and `rename` would replace the link with a regular file —
    // quietly severing it, so the user's dotfiles stop tracking their
    // settings. Write through the link instead. That gives up atomicity for
    // this one case, but it's the behavior these users already had, and a
    // broken symlink is far worse than the rare torn read.
    await fs.writeFile(path, body, "utf8");
    return;
  }
  // Write to a sibling temp file and rename into place instead of writing
  // `path` directly. `fs.writeFile` truncates the target before writing its
  // content, so a concurrent readSettings() racing a writeSettings() call
  // (e.g. two API requests landing close together) could observe a
  // zero-byte or partially-written file and throw `SyntaxError: Unexpected
  // end of JSON input` out of JSON.parse. `rename` is atomic on the same
  // filesystem, so readers only ever see the old complete file or the new
  // complete file, never a torn write.
  //
  // The temp name goes back through `assertWithin` rather than being built by
  // string concatenation off `path`: concatenating onto a sanitized path
  // produces a fresh value that CodeQL no longer considers sanitized, and
  // `js/path-injection` fires on the writeFile/rename sinks below. The
  // relative segment here is entirely constant-shaped (basename + pid +
  // counter), so this is the same "stays inside the .claude dir" guard
  // `pathFor` applies.
  const tmpPath = assertWithin(dir, `.${basename(path)}.tmp-${process.pid}-${writeSeq++}`);
  // Preserve the mode of an existing settings.json — rename replaces the
  // inode, so without this a user who chmod'd the file (it can hold
  // `apiKeyHelper` and `env` secrets) would silently get default 0644 back.
  const mode = st ? st.mode & 0o777 : undefined;
  try {
    // Pretty-print with 2 spaces, matches Claude Code conventions.
    await fs.writeFile(tmpPath, body, "utf8");
    if (mode !== undefined) await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, path);
  } catch (err) {
    // Don't leave a stray temp file behind in the user's .claude dir if the
    // write or the rename failed.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function updatePermissions(
  scope: SettingsScope,
  projectCwd: string,
  patch: Partial<PermissionRules>,
): Promise<ClaudeSettings> {
  const current = await readSettings(scope, projectCwd);
  const next: ClaudeSettings = {
    ...current,
    permissions: {
      ...(current.permissions ?? {}),
      ...patch,
    },
  };
  await writeSettings(scope, projectCwd, next);
  return next;
}
