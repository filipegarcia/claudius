export const meta = {
  name: 'cheatsheet-triage',
  description: 'Triage every Claude Code cheat-sheet feature against the Claudius codebase; write one MD spec per feature and return a structured UI-worthy implement-queue',
  phases: [{ title: 'Triage', detail: 'one agent per cheat-sheet section, parallel' }],
}

// Existing Claudius surfaces — embedded so triage agents judge "already exists"
// fast without re-discovering the whole app. They should still verify with
// Grep/Read before declaring a status, but this is the map.
const SURFACES = `
EXISTING WORKSPACE-SCOPED PAGES (app/[workspaceId]/<x>/page.tsx, each in SideNav):
  chat (workspace root), sessions, files, git, memory, assets, cost, agents,
  skills, mcp, hooks, schedule, permissions, docker, tracker, database,
  notebooks, workspace.
EXISTING GLOBAL PAGES (app/<x>/page.tsx): plugins, settings, usage, customize,
  community, doctor, updater, release-notes, welcome, keybindings.
EXISTING SESSION/CHAT CONTROLS (API under app/api/sessions/[id]/...):
  model switch, effort level, permission mode, session goal (/goal),
  ultracode toggle, interrupt/stop, rewind, fork, export, transcript view,
  search, suggested-messages, background-task, context grid, plan mode,
  pending-prompts, notification-prefs, ask-answer.
EXISTING API GROUPS (app/api/<x>): account, agents, assets, claudemd,
  community, cost, customize(+izations), docker, doctor, feedback, fs, hooks,
  keybindings, limits, mcp, memory, models, notifications, plugins, schedule
  (+ session-loops + run-now + runs), sessions(many), settings(+import/export/
  permissions/additional-dirs), skills, updater, workspaces(+git/files/shell/
  icon), worktrees.
EXISTING CLIENT KEYBOARD REGISTRY: lib/client/shortcuts.ts (web-app shortcuts,
  nav.*, tab.*, workspace.* — user-remappable in Settings). Separate from the
  CLI keybindings.json edited by app/keybindings.
`.trim()

const MD_TEMPLATE = `
Each MD file MUST follow this exact structure:

# <Feature name>

**Source:** Claude Code cheat sheet — <section>
**Status:** <ALREADY_EXISTS | NOT_APPLICABLE | UI_WORTHY>

## What it is
<1-3 sentences describing the Claude Code feature.>

## Claudius today
<Where this lives in Claudius already (file/route), OR why it has no surface yet.>

## Decision
<For ALREADY_EXISTS: point at the route/component that covers it.>
<For NOT_APPLICABLE: why there is no browser surface (terminal-only chord, pure
 env var with no UI value, CLI-only flag, etc.).>
<For UI_WORTHY: what UI to add, where it should live (new SideNav tile? a tab on
 an existing page? a settings section? a chat control?), what backend/API is
 needed, and a rough effort note. If it needs deep SDK plumbing beyond a UI
 shell, say "deferred — needs backend" and explain.>
`.trim()

const SECTIONS = [
  {
    slug: 'recent-changes',
    title: 'Recent Changes',
    features: [
      ['Opus 4.8 default model with high-effort mode', 'Opus 4.8 is the default model; high-effort mode enabled by default. Model picker / effort selection.'],
      ['Dynamic workflows — manage background multi-agent runs', 'A UI to view and manage background multi-agent workflow runs (/workflows).'],
      ['Fast mode on Opus 4.8', 'Toggle fast mode at accelerated rates (Option+O / /fast).'],
      ['Shell command execution as background sessions', 'Run a shell command as a background session (! <cmd>).'],
      ['/simplify cleanup-only review with auto-apply', '/simplify runs cleanup-only review and applies fixes automatically.'],
      ['Opus 4.8 thinking-block fix', 'Bugfix for thinking block modification causing API errors — internal, likely N/A.'],
    ],
  },
  {
    slug: 'keyboard-shortcuts',
    title: 'Keyboard Shortcuts (General / Mode / Input / Prefixes)',
    features: [
      ['Cancel input/generation (Ctrl+C)', 'Terminal control.'],
      ['Exit session (Ctrl+D)', 'Terminal control.'],
      ['Clear prompt + redraw (Ctrl+L)', 'Terminal control.'],
      ['Toggle transcript viewer (Ctrl+O)', 'Transcript viewer with focus cycling.'],
      ['Clear input buffer (Ctrl+U)', 'Terminal input edit.'],
      ['Restore cleared input (Ctrl+Y)', 'Terminal input edit.'],
      ['Open in editor (Ctrl+G)', 'Open composer content in external editor.'],
      ['Reverse search history (Ctrl+R)', 'Search prompt history.'],
      ['Kill all background agents (Ctrl+X Ctrl+K)', 'Kill all background agents with confirmation.'],
      ['Background tasks toggle (Ctrl+B)', 'Toggle background running tasks view.'],
      ['Toggle task list (Ctrl+T)', 'Toggle the to-do/task list.'],
      ['Rewind or summarize (Esc+Esc)', 'Rewind or summarize conversation.'],
      ['Cycle permission modes (Shift+Tab)', 'Normal -> Auto-Accept -> Plan.'],
      ['Switch model (Option+P)', 'Model switcher.'],
      ['Toggle extended thinking (Option+T)', 'Thinking toggle.'],
      ['Toggle fast mode (Option+O)', 'Fast-mode toggle.'],
      ['Newline insertion (Backslash+Enter)', 'Composer newline.'],
      ['Vim visual mode (v) / visual-line (V)', 'Vim editing modes in composer.'],
      ['Slash command prefix (/)', 'Slash-command invocation in composer.'],
      ['Direct bash execution (!)', 'Run bash directly from composer.'],
      ['File mention with autocomplete (@)', 'Mention files with autocomplete.'],
    ],
  },
  {
    slug: 'mcp-servers',
    title: 'MCP Servers',
    features: [
      ['Add server — Remote HTTP transport', 'Add MCP server over remote HTTP (recommended).'],
      ['Add server — Local stdio transport', 'Add MCP server via local process stdio.'],
      ['Add server — Remote SSE transport', 'Add MCP server over SSE.'],
      ['Scope: local (~/.claude.json)', 'Personal-only MCP scope.'],
      ['Scope: project (.mcp.json)', 'Shared/version-controlled MCP scope.'],
      ['Scope: user (global)', 'Global MCP scope.'],
      ['Interactive UI management (/mcp)', 'Manage MCP servers via UI.'],
      ['List servers (claude mcp list)', 'CLI list of servers.'],
      ['alwaysLoad: true', 'Keep server connected across sessions.'],
      ['maxResultSizeChars up to 500K', 'Raise per-tool text threshold.'],
    ],
  },
  {
    slug: 'slash-session',
    title: 'Slash Commands — Session',
    features: [
      ['/clear', 'Clear conversation history.'],
      ['/compact', 'Compact context with optional focus.'],
      ['/branch or /fork', 'Branch conversation with naming.'],
      ['/usage', 'Token usage, cost, and cache breakdown.'],
      ['/context', 'Visualize context in grid format.'],
      ['/diff', 'Interactive diff viewer.'],
      ['/copy', 'Copy last or specified response.'],
      ['/recap', 'Summarize session context on return.'],
      ['/undo', 'Rewind conversation alias.'],
      ['/rewind', 'Rewind conversation or code checkpoint.'],
      ['/export', 'Export conversation.'],
      ['/plan', 'Enter plan mode directly.'],
      ['/resume', 'Resume session by ID or name.'],
      ['/focus', 'Toggle focus view in fullscreen.'],
      ['/goal', 'Set completion goal; Claude works until met with live progress overlay.'],
    ],
  },
  {
    slug: 'slash-config',
    title: 'Slash Commands — Config',
    features: [
      ['/config', 'View/set settings persisting to settings.json.'],
      ['/model', 'Switch model with effort-level control.'],
      ['/fast', 'Toggle fast mode on/off.'],
      ['/theme', 'Create/switch named custom themes incl. Auto (match terminal) dark/light.'],
      ['/permissions', 'View/update permissions.'],
      ['/effort', 'Set effort level with interactive slider (low/medium/high/xhigh/max).'],
      ['/color', 'Set prompt-bar color.'],
      ['/keybindings', 'Customize keyboard shortcuts.'],
      ['/scroll-speed', 'Adjust output scroll speed.'],
      ['/terminal-setup', 'Configure terminal keybindings.'],
    ],
  },
  {
    slug: 'slash-tools',
    title: 'Slash Commands — Tools',
    features: [
      ['/init', 'Create CLAUDE.md.'],
      ['/memory', 'Edit CLAUDE.md files and toggle auto memory.'],
      ['/mcp', 'Manage MCP servers.'],
      ['/hooks', 'Manage hooks.'],
      ['/skills', 'List available skills.'],
      ['/reload-skills', 'Reload skills without restarting.'],
      ['/agents', 'Manage agent configurations.'],
      ['/workflows', 'View and manage background multi-agent workflow runs.'],
      ['/review', 'Review PR locally.'],
      ['/ultrareview', 'Cloud code review with parallel multi-agent analysis.'],
      ['/security-review', 'Scan diff for vulnerabilities.'],
      ['/loop or /proactive', 'Recurring task with interval and prompt.'],
      ['/ide', 'IDE integrations status.'],
      ['/add-dir', 'Add working directory.'],
    ],
  },
  {
    slug: 'slash-special',
    title: 'Slash Commands — Special',
    features: [
      ['/btw', 'Ask side question without adding to conversation.'],
      ['/extra-usage', 'Extra usage when rate limited.'],
      ['/voice', 'Toggle push-to-talk voice dictation.'],
      ['/doctor', 'Diagnose installation.'],
      ['/insights', 'Analyze sessions report.'],
      ['/desktop', 'Continue in Desktop app.'],
      ['/rename', 'Rename current session.'],
      ['/help', 'Show help and commands.'],
      ['/feedback or /bug', 'Submit feedback.'],
    ],
  },
  {
    slug: 'memory-files',
    title: 'Memory & Files',
    features: [
      ['CLAUDE.md project level', './CLAUDE.md or ./.claude/CLAUDE.md (team-shared).'],
      ['CLAUDE.local.md', 'Local personal notes (gitignored).'],
      ['CLAUDE.md personal', '~/.claude/CLAUDE.md (all projects).'],
      ['Managed policy CLAUDE.md', '/etc/claude-code/CLAUDE.md org-wide.'],
      ['Project rules (.claude/rules/*.md)', 'Project-scoped rule files.'],
      ['User rules (~/.claude/rules/*.md)', 'User-scoped rule files.'],
      ['Path-specific rules (paths: frontmatter)', 'Rules scoped by path.'],
      ['Import files (@path syntax)', 'Import other files into CLAUDE.md.'],
      ['Auto-loads MEMORY.md at startup', 'Auto memory loads first 25KB/200 lines.'],
      ['Topic files load on demand', 'Auto-memory topic files.'],
      ['Auto-memory storage location', 'Stored in ~/.claude/projects/<proj>/memory/.'],
    ],
  },
  {
    slug: 'workflows-tips',
    title: 'Workflows & Tips',
    features: [
      ['Plan mode cycle (Shift+Tab)', 'Normal -> Auto-Accept -> Plan.'],
      ['Start in plan mode (--permission-mode plan)', 'Launch flag.'],
      ['Plan files named after prompts', 'e.g. fix-auth-race-snug-otter.md.'],
      ['Toggle thinking (Alt+T)', 'Thinking toggle.'],
      ['ultrathink — max effort for turn', 'Max effort one-shot.'],
      ['Effort levels low/medium/high/max', 'Effort selection.'],
      ['Auto mode denied retry (/permissions Recent Retry)', 'Retry mechanism for denied auto-mode actions.'],
      ['Git worktrees — isolated branch (--worktree)', 'Per-feature worktree.'],
      ['Agent in own worktree (isolation: worktree)', 'Agent worktree isolation.'],
      ['Sparse checkout (sparsePaths)', 'Checkout only needed dirs.'],
      ['Status line worktree path (workspace.git_worktree)', 'Status line JSON field.'],
      ['Auto-create worktrees (/batch)', 'Batch worktree creation.'],
      ['Voice push-to-talk (/voice)', 'Hold space to record.'],
      ['Voice 20 languages', 'Multi-language dictation.'],
      ['Context tips (/context)', 'Usage & optimization.'],
      ['Compact with focus (/compact)', 'Context compression.'],
      ['1M context for Opus', 'Large context window for eligible plans.'],
      ['Continue last conversation (claude -c)', 'Resume last.'],
      ['Resume by name (claude -r)', 'Resume named session.'],
      ['Side question (/btw)', 'Ask without context cost.'],
      ['Non-interactive prompt (claude -p)', 'Headless query.'],
      ['Structured JSON output (--output-format json)', 'Machine-readable output.'],
      ['Cost cap (--max-budget-usd)', 'Budget ceiling.'],
      ['Pipe stdin (cat file | claude -p)', 'Stdin input.'],
      ['Recurring task (/loop 5m)', 'Interval task.'],
      ['Web session (--remote)', 'Run on claude.ai.'],
      ['Shell as background session (! <cmd>)', 'Background shell.'],
    ],
  },
  {
    slug: 'config-settings',
    title: 'Config & Env — Config Files & Key Settings',
    features: [
      ['User settings (~/.claude/settings.json)', 'User settings file.'],
      ['Project settings (.claude/settings.json)', 'Project shared settings.'],
      ['Local settings (.claude/settings.local.json)', 'Local-only settings.'],
      ['OAuth/MCP/state (~/.claude.json)', 'Global state file.'],
      ['Project MCP (.mcp.json)', 'Project MCP servers.'],
      ['Policy fragments (managed-settings.d/)', 'Drop-in policy fragments.'],
      ['modelOverrides', 'Map model picker to custom IDs.'],
      ['autoMode.hard_deny', 'Unconditional auto-mode deny rules.'],
      ['Conditional hooks (hooks: if)', 'Hooks gated by permission rule syntax.'],
      ['DISABLE_PROMPT_CACHING warning', 'Startup warning when caching disabled.'],
      ['Stream events from bg scripts (Monitor tool)', 'Background script event stream.'],
      ['Auto-mode denial hook (PermissionDenied)', 'Hook on denial.'],
      ['showThinkingSummaries', 'Opt-in thinking summaries display.'],
      ['Pause headless & resume (hooks: defer)', 'Defer headless runs.'],
      ['Hook step invokes MCP tool (type: mcp_tool)', 'MCP-tool hook step.'],
      ['continueOnBlock', 'Keep running after blocked tool call.'],
      ['disableSkillShellExec', 'Block shell execution in skills.'],
      ['Status line refreshInterval', 'Re-run status line at interval.'],
    ],
  },
  {
    slug: 'config-env',
    title: 'Config & Env — Environment Variables',
    features: [
      ['ANTHROPIC_API_KEY', 'Authentication.'],
      ['ANTHROPIC_MODEL', 'Default model.'],
      ['ANTHROPIC_BASE_URL', 'Proxy/gateway override.'],
      ['ANTHROPIC_BETAS', 'Beta headers.'],
      ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'Custom /model entry.'],
      ['MAX_THINKING_TOKENS', 'Thinking token cap (0=off).'],
      ['ENABLE_PROMPT_CACHING_1H', '1h prompt cache TTL.'],
      ['FORCE_PROMPT_CACHING_5M', 'Force 5-min cache TTL.'],
      ['CLAUDE_CODE_ENABLE_AWAY_SUMMARY', 'Force recap when telemetry off.'],
      ['CLAUDECODE=1', 'Detect Claude Code shell.'],
      ['CLAUDE_CODE_DISABLE_CRON', 'Disable scheduled tasks.'],
      ['CLAUDE_CODE_FORK_SUBAGENT=1', 'Forked subagents on external builds.'],
      ['DISABLE_UPDATES', 'Block all update paths.'],
      ['API_TIMEOUT_MS', 'API timeout (default 600000).'],
      ['MCP_TIMEOUT', 'MCP startup timeout.'],
      ['CLAUDE_CODE_SESSION_ID', 'Unique session id for hooks/CI.'],
      ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1', 'Opt out of fullscreen rendering.'],
      ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'Disable auto memory.'],
      ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'Disable 1M context.'],
      ['CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE', 'Auto-upgrade via package managers.'],
      ['CLAUDE_CODE_CERT_STORE', 'TLS CA config (bundled/system).'],
    ],
  },
  {
    slug: 'skills-agents',
    title: 'Skills & Agents',
    features: [
      ['Skill tool — discover built-in slash commands', 'Built-in skill discovery.'],
      ['/code-review with optional fix flag', 'Code review skill.'],
      ['/batch — large parallel changes across worktrees', 'Batch worktree changes.'],
      ['/debug — troubleshoot from debug log', 'Debug skill.'],
      ['/loop — recurring scheduled task', 'Loop skill.'],
      ['/claude-api — load API/SDK reference', 'API reference skill.'],
      ['Project skills (.claude/skills/<name>/)', 'Project skill location.'],
      ['Personal skills (~/.claude/skills/<name>/)', 'Personal skill location.'],
      ['Skill frontmatter — description trigger', 'Auto-invocation trigger.'],
      ['Skill frontmatter — allowed-tools', 'Skip permission prompts.'],
      ['Skill frontmatter — disallowed-tools', 'Block tools from skill.'],
      ['Skill frontmatter — model override', 'Override model for skill.'],
      ['Skill frontmatter — effort override', 'Override effort for skill.'],
      ['Skill frontmatter — paths (YAML list)', 'Path-specific skill.'],
      ['Skill frontmatter — context: fork', 'Run skill in subagent.'],
      ['Skill — $ARGUMENTS placeholder', 'User input placeholder.'],
      ['Skill — ${CLAUDE_SKILL_DIR}', 'Skill directory var.'],
      ['Skill — ${CLAUDE_EFFORT}', 'Current effort level var.'],
      ['Skill — dynamic context injection (!`cmd`)', 'Inject command output.'],
      ['Skill — plugin bin/ executables', 'Ship executables for Bash tool.'],
      ['Built-in agents (Explore/Plan/General/Bash)', 'Built-in subagent types.'],
      ['Agent frontmatter — permission mode', 'default/acceptEdits/plan/dontAsk/bypassPermissions.'],
      ['Agent frontmatter — isolation: worktree', 'Run agent in git worktree.'],
      ['Agent frontmatter — memory scope', 'user|project|local memory.'],
      ['Agent frontmatter — background: true', 'Background task execution.'],
      ['Agent frontmatter — maxTurns', 'Limit agentic turns.'],
      ['Agent frontmatter — initialPrompt', 'Auto-submit first turn.'],
      ['Resume agents via SendMessage', 'Replaces resume.'],
      ['Mention named subagents (@agent-name)', 'Mention subagents.'],
    ],
  },
  {
    slug: 'cli-flags',
    title: 'CLI & Flags',
    features: [
      ['claude (interactive)', 'Interactive session.'],
      ['claude "q" (with prompt)', 'Start with prompt.'],
      ['claude -p (headless SDK)', 'Headless mode.'],
      ['claude -c (continue)', 'Continue last session.'],
      ['claude -r (resume)', 'Resume by id/name.'],
      ['claude update', 'Update installation.'],
      ['claude auth login (SSO/console)', 'Sign in.'],
      ['claude agents (list)', 'List agents.'],
      ['claude mcp', 'MCP configuration.'],
      ['claude plugin', 'Plugin management.'],
      ['claude plugin prune', 'Remove unused plugins.'],
      ['claude project purge [path]', 'Delete project state.'],
      ['claude ultrareview [target]', 'Non-interactive code review.'],
      ['--model', 'Set model.'],
      ['-n / --name', 'Session name.'],
      ['--add-dir', 'Add working directory.'],
      ['--agent', 'Use agent.'],
      ['--allowedTools / --disallowedTools', 'Pre-approve / remove tools.'],
      ['--output-format text/json/stream-json', 'Output format.'],
      ['--max-budget-usd', 'Cost cap.'],
      ['--remote', 'Web session on claude.ai.'],
      ['--effort', 'Effort level.'],
      ['--permission-mode', 'Permission mode.'],
      ['--dangerously-skip-permissions', 'Skip all prompts.'],
      ['--debug', 'Debug logging.'],
      ['--settings <file>', 'Load settings from JSON.'],
      ['--from-pr', 'Load PR context (GitHub/GitLab/Bitbucket/GHE).'],
    ],
  },
  {
    slug: 'permission-modes',
    title: 'Permission Modes',
    features: [
      ['default', 'Prompts for confirmation.'],
      ['acceptEdits', 'Automatically accepts edits.'],
      ['plan', 'Read-only mode.'],
      ['dontAsk', 'Deny unless explicitly allowed.'],
      ['bypassPermissions', 'Skip all prompts.'],
      ['--dangerously-skip-permissions', 'CLI flag.'],
    ],
  },
]

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    section: { type: 'string' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          slug: { type: 'string', description: 'kebab-case file slug used in mdPath' },
          mdPath: { type: 'string' },
          status: { type: 'string', enum: ['exists', 'na', 'ui-worthy'] },
          existsAt: { type: 'string', description: 'route/file if status=exists, else empty' },
          uiNote: { type: 'string', description: 'one-line: what UI to add / why N/A / where it lives' },
          priority: { type: 'string', enum: ['high', 'med', 'low'], description: 'only meaningful for ui-worthy' },
        },
        required: ['name', 'slug', 'mdPath', 'status', 'uiNote', 'priority'],
      },
    },
  },
  required: ['section', 'features'],
}

phase('Triage')

const results = await parallel(
  SECTIONS.map((sec) => () =>
    agent(
      `You are triaging Claude Code cheat-sheet features against the Claudius codebase (a Next.js browser wrapper around the Claude Agent SDK).

PROJECT MAP (verify with Grep/Glob/Read before trusting):
${SURFACES}

YOUR SECTION: "${sec.title}" (slug: ${sec.slug})

FEATURES TO TRIAGE (name :: description):
${sec.features.map(([n, d], i) => `${i + 1}. ${n} :: ${d}`).join('\n')}

FOR EACH feature:
1. Investigate the repo (Grep/Glob/Read under app/, lib/, components/) to decide ONE status:
   - "exists"     -> already has a working browser surface in Claudius. Record existsAt (route or file).
   - "na"          -> no meaningful browser surface (terminal-only chord like Ctrl+L/Ctrl+C/vim mode, pure
                      env var with no UI value, CLI-only flag, internal bugfix). Explain why in uiNote.
   - "ui-worthy"  -> a browser UI SHOULD be added and does not exist yet (or exists only partially in a way
                      that clearly warrants a new surface). Give a crisp uiNote: what to add + where it lives
                      (new SideNav tile? tab on an existing page? settings section? chat control?). Set priority.
   Be honest and conservative: most of this list already exists or is N/A. Do NOT manufacture UI for terminal
   shortcuts. Only mark "ui-worthy" when there is a real, buildable browser surface that adds value and matches
   the existing quality bar (no tile that 404s, no page with no backend). If it needs deep SDK plumbing beyond a
   UI shell, still mark the honest status and note "deferred — needs backend" in uiNote.

2. Write ONE markdown file per feature to: docs/cheatsheet-features/${sec.slug}/<NN>-<slug>.md
   where <NN> is a zero-padded index (01, 02, ...) and <slug> is kebab-case of the feature.
   ${MD_TEMPLATE}

Use the Write tool for every MD file. Then RETURN the structured triage (the StructuredOutput tool) listing
every feature with its mdPath (the path you wrote), status, existsAt, a one-line uiNote, and priority
(use "low" for exists/na). Return ALL ${sec.features.length} features.`,
      { label: `triage:${sec.slug}`, phase: 'Triage', schema: TRIAGE_SCHEMA, agentType: 'general-purpose' },
    ),
  ),
)

const ok = results.filter(Boolean)
const allFeatures = ok.flatMap((r) => r.features.map((f) => ({ ...f, section: r.section })))
const uiWorthy = allFeatures.filter((f) => f.status === 'ui-worthy')

log(`Triage complete: ${allFeatures.length} features across ${ok.length}/${SECTIONS.length} sections`)
log(`exists=${allFeatures.filter((f) => f.status === 'exists').length} na=${allFeatures.filter((f) => f.status === 'na').length} ui-worthy=${uiWorthy.length}`)

return {
  totals: {
    sections: ok.length,
    features: allFeatures.length,
    exists: allFeatures.filter((f) => f.status === 'exists').length,
    na: allFeatures.filter((f) => f.status === 'na').length,
    uiWorthy: uiWorthy.length,
  },
  uiWorthy: uiWorthy
    .sort((a, b) => ({ high: 0, med: 1, low: 2 }[a.priority] - { high: 0, med: 1, low: 2 }[b.priority]))
    .map((f) => ({ name: f.name, section: f.section, slug: f.slug, mdPath: f.mdPath, priority: f.priority, uiNote: f.uiNote })),
  allFeatures: allFeatures.map((f) => ({ name: f.name, status: f.status, existsAt: f.existsAt ?? '', section: f.section })),
}
