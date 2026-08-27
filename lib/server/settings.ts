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

/**
 * CC 2.1.246 — configuration for Auto mode's server-side risk classifier.
 * Mirrors the SDK's `Settings.autoMode` shape exactly: each key is an array
 * of freeform prose strings (NOT tool-pattern rules like `permissions.*` —
 * the classifier reads them as natural-language guidance, not syntax). The
 * classifier itself runs server-side and is unaffected by Claudius; this
 * type only carries the config a user can hand it.
 *
 * The literal string `"$defaults"` inside any of these arrays means "splice
 * Anthropic's built-in rules for this section in at this position" —
 * omitting it replaces the built-in list entirely for that section. Claudius
 * doesn't interpret `"$defaults"`; it's stored and round-tripped verbatim,
 * same as every other string in these arrays, and it's the SDK/classifier
 * that expands it.
 *
 * Upstream reads `autoMode` from `~/.claude/settings.json` only — never
 * project or project-local scope (a checked-in repo or build step
 * shouldn't be able to widen what the classifier trusts) — so this field is
 * only ever written via `updateAutoMode`, which hardcodes the "user" scope.
 */
export type AutoModeConfig = {
  environment?: string[];
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
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
  // Spellcheck underline in the prompt input (Claude Code 2.1.235: "Added an
  // optional spellcheck setting that underlines misspelled words in the
  // prompt input as you type, using your installed aspell, hunspell, or
  // ispell"). Deliberately NOT named `spellcheck` — the SDK already defines
  // that key as an OBJECT (`{ enabled?, checker?, language?, color? }`, see
  // `sdk.d.ts` ~L7280) read from the same `~/.claude/settings.json` this
  // file writes. Reusing the name would let toggling this row silently wipe
  // (or misread) a user's real CLI spellcheck config the next time they run
  // `claude` — a boolean here would shadow/clobber that object. `xxxEnabled`
  // also matches every other composer preference in this file
  // (`emojiCompletionEnabled`, `promptSuggestionEnabled`, …).
  //
  // Also NOT the CLI's default — the CLI defaults its (differently-shaped)
  // setting OFF because a terminal has no native spellcheck to fall back on;
  // Claudius's composer is a real `<textarea>`, which browsers already
  // spellcheck for free with no code at all. Defaulting this to off would be
  // a silent regression for every existing user, so here absent/true =
  // enabled (browser-native spellcheck), false = disabled.
  //
  // Read client-side by `useSpellcheckEnabled` (user scope only — a personal
  // composer preference, same reasoning as `emojiCompletionEnabled`); purely
  // a browser-native attribute toggle, no server/SDK forwarding involved.
  spellcheckEnabled?: boolean;
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
  // Claude Code 2.1.232 — "/config rows: Dialog expiry". SDK settings key the
  // bundled `claude` binary reads from `~/.claude/settings.json` (the same file
  // the Settings page catalog edits), so surfacing it as a catalog row is all
  // Claudius needs — there's no per-session SDK forwarding to add.
  //
  // `dialogExpiry`: max time a permission/user dialog forwarded to a remote
  // client stays parked awaiting an answer, and how long a HELD cross-session
  // message awaits approval, before either resolves to its safe no-action
  // default (cancelled / dropped-with-denial). Defaults to 5m; "never" disables
  // the deadline. Local-only permission prompts are unaffected. The
  // CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS env var, when set, overrides this. Read
  // from trusted sources only (never a checked-in repo settings file).
  dialogExpiry?: "60s" | "5m" | "10m" | "never";
  // SDK 0.3.245 — prompt-cache TTL. Neither key appears in the upstream
  // prose changelog for the 0.3.241 → 0.3.245 window; both were found by
  // diffing `sdk.d.ts` (see `scripts/sdk-update/prompt.md`, "The third
  // failure mode"). The bundled `claude` binary reads them straight from
  // `~/.claude/settings.json` — the same file this module writes — so
  // surfacing them as catalog rows is all Claudius needs; there is no
  // per-session SDK forwarding to add.
  //
  // `promptCacheTtl`: TTL for the main conversation (interactive, -p and
  // SDK turns, plus the helpers that run inline with it). Unset =
  // automatic: 1 hour on a Claude subscription within its usage limits,
  // 5 minutes on an API key, Bedrock, Vertex or Foundry. 1-hour cache
  // writes bill at a higher rate but stay warm across longer breaks.
  // `CLAUDE_CODE_PROMPT_CACHE_TTL` takes precedence over this.
  promptCacheTtl?: PromptCacheTtl;
  // `subagentPromptCacheTtl`: TTL for everything OUTSIDE the main
  // conversation — subagents, workflows, background and helper requests.
  // Unset = automatic (5 minutes unless `ENABLE_PROMPT_CACHING_1H=1`).
  // `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` takes precedence over this.
  subagentPromptCacheTtl?: PromptCacheTtl;
  // SDK 0.3.246 — set to false to stop syncing plugins enabled on
  // claude.ai. Mirrors the SDK's `Settings.syncClaudeAiPlugins` key
  // exactly: "only false is honored" (the feature is enabled server-side
  // for the account; setting true doesn't turn it on early), and it's
  // read directly by the bundled `claude` binary from this same
  // `~/.claude/settings.json` — so surfacing it as a catalog row is all
  // Claudius needs; there is no per-session SDK forwarding to add. See
  // the sibling `syncClaudeAiSkills` key (pre-existing, not yet
  // surfaced — tracked as a follow-up in the 0.3.246 run notes).
  syncClaudeAiPlugins?: boolean;
  // Claude Code 2.1.238 — set to "readline" to make Ctrl+W in the CLI's own
  // prompt delete back to the previous whitespace, as in Bash; the default
  // ("classic") is unchanged. Config-passthrough only: it's read by the
  // bundled `claude` binary straight from this same `~/.claude/settings.json`,
  // not by Claudius's own browser composer — browsers reserve Ctrl+W to close
  // the tab and refuse to let page JavaScript intercept/preventDefault it, so
  // there's no browser-side behavior to build here. Surfacing it as a
  // catalog row (same treatment as `defaultShell`, `promptCacheTtl`) is all
  // Claudius needs.
  keybindingFlavor?: "classic" | "readline";
  // Claude Code 2.1.243 — "Added a modelPicker setting: curate the /model
  // picker with an ordered, labeled list of models (any id spelling,
  // including Vertex/Bedrock ids), appended to or replacing the built-in
  // lineup." Read at request time by `lib/server/model-picker-curation.ts`
  // and applied to the model lists `/api/models` and
  // `/api/sessions/[id]/model` already return — see that module for the
  // curation logic. `mode: "append"` (default/absent) adds `entries` after
  // the SDK's own list; `"replace"` shows ONLY the curated entries.
  modelPicker?: ModelPickerSettings;
  // Claude Code 2.1.243 — "Added modelPricing managed setting so an
  // organization's contracted per-model rates and discount multiplier are
  // used for /cost, the status line, and telemetry cost figures instead of
  // list price." Read by `lib/server/cost-aggregate.ts` via
  // `lib/server/model-pricing-override.ts` and applied to the Cost page's
  // computed spend — see that module for scoping notes (not applied to the
  // StatusLine's live per-turn estimate, which reconciles to the SDK's own
  // authoritative `total_cost_usd`).
  modelPricing?: ModelPricingSettings;
  // CC 2.1.246 — Auto mode classifier configuration. See `AutoModeConfig`.
  autoMode?: AutoModeConfig;
  // Claude Code 2.1.247 — the model-drafted `SendFeedback` tool. When
  // something goes wrong in a session, Claude can draft a feedback report
  // for the user to review and send from `/feedback`; this setting controls
  // how loudly that's surfaced: "notify" (default/absent) shows a one-line
  // notice when a draft is queued, "quiet" shows only the footer counter,
  // "off" disables the tool entirely so drafts are never queued. Mirrors the
  // SDK's `Settings.feedbackDrafts` key exactly. Same treatment as
  // `keybindingFlavor` / `syncClaudeAiPlugins` / `promptCacheTtl`: the tool
  // itself and its queueing behavior are entirely engine-side, and the
  // engine reads this key directly from this same `~/.claude/settings.json`
  // — surfacing it as a catalog row (Settings → Storage & sessions, next to
  // the sibling `feedbackSurveyRate`) is all Claudius needs; there is no
  // per-session SDK forwarding to add. The drafted tool call itself renders
  // with a dedicated "Feedback draft" label in the transcript (see
  // `ToolCall.tsx`'s `SendFeedback` special-case) instead of the generic
  // tool-call JSON dump.
  feedbackDrafts?: "notify" | "quiet" | "off";
  // Catch-all for keys we don't yet know about — we never strip them.
  [key: string]: unknown;
};

/** The SDK's `Settings.modelPicker` shape (Claude Code 2.1.243). */
export type ModelPickerSettings = {
  /** "append" (default) adds `entries` after the built-in lineup; "replace" shows ONLY `entries`. */
  mode?: "append" | "replace";
  entries?: { id: string; label?: string }[];
};

/** The SDK's `Settings.modelPricing` shape (Claude Code 2.1.243). */
export type ModelPricingSettings = {
  discountMultiplier?: number;
  rates?: Record<
    string,
    {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite5m?: number;
      cacheWrite1h?: number;
    }
  >;
};

/** The SDK's `Settings.workflowSizeGuideline` literal union (0.3.219). */
export type WorkflowSizeGuideline = "unrestricted" | "small" | "medium" | "large";

/** The SDK's `Settings.crossSessionInbound` literal union (Claude Code 2.1.224). */
export type CrossSessionInbound = "accept" | "hold" | "refuse";

/**
 * The SDK's `Settings.promptCacheTtl` / `Settings.subagentPromptCacheTtl`
 * literal union (SDK 0.3.245). Shared by both keys — they take the same
 * two values and differ only in which requests they apply to.
 */
export type PromptCacheTtl = "5m" | "1h";

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

/**
 * Patch the Auto mode classifier config (CC 2.1.246). Unlike
 * `updatePermissions`, the scope is hardcoded to `"user"` — upstream reads
 * `autoMode` only from `~/.claude/settings.json`, never project or
 * project-local scope (see `AutoModeConfig`'s doc comment), so there's no
 * caller-supplied scope to accept.
 */
export async function updateAutoMode(
  projectCwd: string,
  patch: Partial<AutoModeConfig>,
): Promise<ClaudeSettings> {
  const current = await readSettings("user", projectCwd);
  const next: ClaudeSettings = {
    ...current,
    autoMode: {
      ...(current.autoMode ?? {}),
      ...patch,
    },
  };
  await writeSettings("user", projectCwd, next);
  return next;
}
