/**
 * Bundled snapshot of the upstream Claude Code CHANGELOG.md, plus the
 * versions of `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk`
 * that this Claudius build was compiled against.
 *
 * Claudius does NOT hand-author its own release notes — the agent and
 * tool behavior come from the Claude Agent SDK and Claude Code itself.
 * The user chose a "bundle a static copy" content source over a live
 * fetch (see /release-notes) so this file is the source of truth.
 *
 * To refresh:
 *   curl -sL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md \
 *     > /tmp/cc.md
 * then update `CLAUDE_CODE_CHANGELOG_SNAPSHOT` below from that file's
 * `## X.Y.Z` sections. Keep entries newest-first.
 *
 * Server-only because the SDK version reads from `node_modules` via
 * `createRequire` — never import from a client component.
 */

import { createRequire } from "node:module";

export type ChangelogVersion = {
  /** Version string as printed in the upstream `## X.Y.Z` heading. */
  version: string;
  /** Markdown bullet bodies, in upstream order, without the leading "- ". */
  bullets: string[];
};

/**
 * Snapshot captured from https://github.com/anthropics/claude-code on
 * the date this file was last touched. Versions whose only bullet was
 * "Bug fixes and reliability improvements" are folded into a sibling
 * comment line on the previous substantive version to keep this list
 * readable.
 */
export const CLAUDE_CODE_CHANGELOG_SNAPSHOT: ChangelogVersion[] = [
  {
    version: "2.1.169",
    bullets: [
      "Added `--safe-mode` flag (and `CLAUDE_CODE_SAFE_MODE`) to start Claude Code with all customizations (CLAUDE.md, plugins, skills, hooks, MCP servers) disabled for troubleshooting",
      "Added `/cd` command to move a session to a new working directory without breaking the prompt cache mid-session",
      "Added a `disableBundledSkills` setting and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` environment variable to hide bundled skills, workflows, and built-in slash commands from the model",
      "Fixed Up/Down arrows jumping to command history past the wrapped rows of a long input line — they now move through each visual row first, and history recall enters at the near edge",
      "Fixed enterprise managed MCP policies (`allowedMcpServers`/`deniedMcpServers`) not being enforced on reconnect, IDE-typed configs, `--mcp-config` servers during the first session after install, or before remote settings loaded; also fixed slow cold starts for orgs without remote settings",
      "Fixed a ~30-50ms UI stall at the start of each turn for macOS users logged in with claude.ai credentials",
      "Fixed `claude -p` being slow or appearing to hang on Windows while waiting for the slash-command/skill scan (regression in 2.1.161)",
      "Fixed Remote Control getting stuck on \"reconnecting\" after resuming a session when an OAuth token refresh happened at the same time",
      "Fixed Git Credential Manager's \"Connect to GitHub\" popup appearing on Windows at startup when background git commands ran without cached credentials",
      "Fixed footer hints (e.g. \"esc to interrupt\") not showing for users with a custom statusline",
      "Fixed stale permission and dialog prompts reappearing every time you reattached to a remote session whose worker had died while waiting on them",
      "Fixed `claude agents --json` omitting blocked and just-dispatched background sessions; added `--all` to include completed sessions, plus new `id` and `state` fields",
      "Fixed background agents ignoring project-level settings `env` values (e.g. `ANTHROPIC_MODEL`) when dispatched onto a pre-warmed worker",
      "Fixed untrusted project settings being able to set OTEL client-certificate paths without trust confirmation",
      "`/workflows` now opens immediately even while a turn is in progress",
      "Improved `TaskCreate` reliability: malformed inputs are repaired automatically and validation errors for unloaded tools include the schema",
      "Reduced CPU usage while responses stream and during spinner animations",
      "Restored a default 5-minute idle timeout on Vertex/Foundry so a stalled stream aborts instead of hanging indefinitely; set `API_FORCE_IDLE_TIMEOUT=0` to opt out",
      "Background sessions now preserve `--ide`, `--chrome`, `--bare`, `--remote-control`, and other flags across retire→wake, and respawn state validation was hardened",
      "The \"CLAUDE.md is too long\" warning threshold now scales with the model's context window",
      "Added a tip suggesting `claude agents` when running multiple concurrent sessions",
    ],
  },
  // 2.1.168, 2.1.167 — Bug fixes and reliability improvements.
  {
    version: "2.1.166",
    bullets: [
      "Added `fallbackModel` setting to configure up to three fallback models tried in order when the primary model is overloaded or unavailable; `--fallback-model` now also applies to interactive sessions",
      "Added glob pattern support in deny rule tool-name position (`\"*\"` denies all tools); allow rules reject non-MCP globs, and unknown tool names in deny rules warn at startup",
      "Hardened cross-session messaging: messages relayed via `SendMessage` from other Claude sessions no longer carry user authority — receivers refuse relayed permission requests, and auto mode blocks them",
      "`MAX_THINKING_TOKENS=0`, `--thinking disabled`, and the per-model thinking toggle now disable thinking on models that think by default via the Claude API (3P providers unchanged)",
      "Claude Code now retries a turn once on the fallback model when the API rejects an unexpected non-retryable error; auth, rate-limit, request-size, and transport errors still surface immediately",
      "`claude update` now announces the target version before downloading instead of going silent",
      "`claude agents`: typing a URL into the list now filters to the session whose first prompt contained it",
      "Fixed a recurring \"image could not be processed\" error and extra token usage when an unprocessable image was sent in a session",
      "Fixed remote sessions becoming permanently stuck when a brief backend disruption occurred during worker registration at startup",
      "Fixed flickering in JetBrains IDE terminals (IntelliJ, PyCharm, WebStorm, etc.) on 2026.1+ by enabling synchronized output",
      "Fixed Shift+non-ASCII characters (e.g. Shift+ä → Ä) being dropped in terminals using the Kitty keyboard protocol (WezTerm, Ghostty, kitty)",
      "Fixed voice mode requiring `/login` to clear a stale auth check after toggling `/voice`",
      "Fixed managed-settings `allowedMcpServers`/`deniedMcpServers` predicates not matching when they use `${VAR}` references",
      "Fixed background agent sessions that entered a git worktree crash-looping with \"No conversation found\" when reopened from `claude agents`",
      "Fixed duplicated thinking text in the Ctrl+O transcript view while streaming",
      "Fixed `/doctor` showing a contradictory failed \"Not inside a remote session\" check when run inside a remote session",
    ],
  },
  // 2.1.165 — Bug fixes and reliability improvements.
  {
    version: "2.1.163",
    bullets: [
      "Added `requiredMinimumVersion` and `requiredMaximumVersion` managed settings — Claude Code refuses to start if its version is outside the allowed range and directs the user to an approved version",
      "Added `/plugin list` command to list installed plugins, with `--enabled`/`--disabled` filters",
      "Added a \"c to copy\" shortcut to `/btw` that copies the raw markdown answer to the clipboard, preserving formatting when pasted elsewhere",
      "Hooks: Stop and SubagentStop hooks can now return `hookSpecificOutput.additionalContext` to give Claude feedback and keep the turn going without being labeled a hook error",
      "Skills: added `\\$` escape syntax to include a literal `$` before a digit in command bodies",
      "stdio MCP servers now receive the same `CLAUDE_CODE_SESSION_ID` as hooks/Bash on `--resume`",
      "Fixed `claude -p` hanging forever after its final result when a backgrounded command never exits — background shells are now stopped ~5s after the result once stdin closes",
      "Fixed deny rules on home-directory paths (e.g. `Read(~/Desktop/**)`) not blocking Bash commands that reference the path via `$HOME`",
      "Fixed hook `if: \"Bash(...)\"` conditions firing on every Bash command containing `$()` or `$VAR`; the pattern now matches against commands inside subshells and backticks too",
      "Background agent sessions now update to a new Claude Code version in the background, so opening a session after an update no longer waits on a cold restart",
      "Clearer descriptions for built-in commands and skills in the / menu",
    ],
  },
  {
    version: "2.1.162",
    bullets: [
      "`claude agents --json` now includes `waitingFor` showing what a waiting session is blocked on (e.g. permission prompt)",
      "`--tools`: explicitly listing Grep/Glob now provides the dedicated search tools on native builds with embedded search (previously these names were silently ignored)",
      "`/effort` now confirms when your chosen level will persist as the default for new sessions",
      "Clicking a slash command in the autocomplete menu now fills it into your prompt instead of running it immediately; press Enter to run",
      "Remote Control now shows as a persistent footer pill (with a link to the session) instead of a startup message",
      "Fixed a silent startup hang when the config directory is read-only or unwritable — Claude Code now starts with in-memory config and surfaces startup errors instead of showing a blank screen",
      "Fixed WebFetch permission rules not being applied to built-in preapproved domains; explicit `WebFetch(domain:...)` deny/ask/allow rules now take precedence over the preapproved-host auto-allow",
      "Fixed an interrupt (Esc) sent at the very start of a turn being silently dropped in stream-json/SDK sessions, leaving the turn running with no \"Interrupted\" feedback",
      "Fixed MCP per-server `timeout` config values below 1000 ms being floored to a 1-second watchdog that aborted every tool call",
      "Quieter startup: notices group by severity, and session info and announcements share a single line per launch",
    ],
  },
  {
    version: "2.1.161",
    bullets: [
      "`OTEL_RESOURCE_ATTRIBUTES` values are now included as labels on metric datapoints, so you can slice usage metrics by custom dimensions like team or repo",
      "`claude agents` rows now show `done/total` before the detail when work is fanned out; peek shows the longest-running item",
      "`/mcp` now collapses claude.ai connectors you've never signed in to behind a \"Show unused connectors\" row",
      "Parallel tool calls: a failed Bash command no longer cancels other calls in the same batch — each tool returns its own result independently",
      "Fixed `forceLoginOrgUUID`/`forceLoginMethod` managed-settings policies blocking third-party provider sessions (Bedrock, Vertex, Foundry, Mantle) alongside the org pin (regression in 2.1.146)",
      "Fixed background subagent output corrupting `claude -p` stdout when using `--output-format text` or `json`",
      "Fixed `claude mcp` list/get/add printing secrets to the terminal: `${VAR}` references are no longer expanded, and credential headers and URL secrets are redacted",
      "Improved terminal rendering performance by stabilizing the layout engine's JIT compilation profile",
    ],
  },
  {
    version: "2.1.160",
    bullets: [
      "Added a prompt before writing to shell startup files (`.zshenv`, `.zlogin`, `.bash_login`) and `~/.config/git/`, which could otherwise lead to unintended command execution",
      "`acceptEdits` mode now prompts before writing build-tool config files that grant code execution (`.npmrc`, `.yarnrc*`, `bunfig.toml`, `.bazelrc`, `.pre-commit-config.yaml`, `.devcontainer/`, etc.)",
      "Edit no longer requires a separate Read after viewing a file with `grep`: single-file `grep`/`egrep`/`fgrep` commands now satisfy the read-before-edit check",
      "Fixed restoring a completed session from `claude agents` dropping chat history and re-running the original prompt",
      "Fixed background sessions re-attached after overnight retire losing their conversation and re-running the original prompt",
      "Improved performance of opening recently-inactive background agent sessions in `claude agents`",
      "Improved auto mode classifier latency by reducing reasoning on routine actions, lowering the chance of \"could not evaluate this action\" blocks",
      "Renamed the dynamic-workflow trigger keyword from `workflow` to `ultracode`. The word \"workflow\" no longer triggers a run; asking for one in your own words still works",
    ],
  },
  {
    version: "2.1.154",
    bullets: [
      "Opus 4.8 is here! Now defaults to high effort · /effort xhigh for your hardest tasks",
      "Introducing dynamic workflows: ask Claude to create a workflow and it orchestrates work across tens to hundreds of agents in the background, so you can take on larger, more complex tasks. Run `/workflows` to view your runs",
      "Fast mode on Opus 4.8 is now available at a fraction of its previous cost: 2x the standard rate for 2.5x the speed",
      "The lean system prompt is now the default for all models except Haiku, Sonnet, and Opus 4.7 and earlier",
      "Claude now reserves the multiple-choice question prompt for decisions it genuinely cannot make itself, instead of asking when it already has enough context to proceed",
      "`/simplify` now runs a cleanup-only review (reuse, simplification, efficiency, altitude) and applies the fixes, instead of running the full `/code-review --fix` bug-hunting review",
      "`claude agents`: type `! <command>` to run a shell command as a background session you can attach to and detach from. Also available as `claude --bg --exec '<command>'`",
      "Streaming tool execution is now always enabled, including when telemetry is disabled or on Bedrock/Vertex/Foundry (previously behind a feature flag)",
      "Added Claude Opus 4.8 support and 4.7 → 4.8 migration guidance to the `/claude-api` skill",
    ],
  },
];

/** Captured ISO date for the snapshot above (UTC). Shown in the UI so the
 * user knows how fresh it is and can compare against the upstream link. */
export const CLAUDE_CODE_CHANGELOG_CAPTURED_AT = "2026-06-09";

/** Upstream source-of-truth URL for the "see more" link. */
export const CLAUDE_CODE_CHANGELOG_URL =
  "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

/**
 * Read the bundled SDK versions from `node_modules` at request time so a
 * dependency bump shows up immediately without touching this file.
 * Server-only: uses CJS `require` against package manifests on disk.
 *
 * Returns null fields when a package isn't installed (e.g. the agent SDK
 * was removed in a refactor) so the UI can gracefully omit the row
 * instead of crashing the page.
 */
export function readBundledSdkVersions(): {
  agentSdk: string | null;
  anthropicSdk: string | null;
} {
  // `createRequire(import.meta.url)` lets a server component (ESM) resolve
  // CommonJS package.json files without depending on a node-resolve
  // bundler plugin. This is the canonical Node 22 pattern.
  const req = createRequire(import.meta.url);
  let agentSdk: string | null = null;
  let anthropicSdk: string | null = null;
  try {
    agentSdk =
      (req("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string })
        .version ?? null;
  } catch {
    agentSdk = null;
  }
  try {
    anthropicSdk =
      (req("@anthropic-ai/sdk/package.json") as { version?: string }).version ??
      null;
  } catch {
    anthropicSdk = null;
  }
  return { agentSdk, anthropicSdk };
}
