export const meta = {
  name: 'cheatsheet-implement',
  description: 'Sequentially implement each UI-worthy cheat-sheet feature: design -> implement -> verify+commit, one feature at a time (shared files forbid parallelism)',
  phases: [
    { title: 'Design', detail: 'read code, produce a precise plan per feature' },
    { title: 'Implement', detail: 'apply the plan using the feature-vertical recipe' },
    { title: 'Test', detail: 'add a focused test where it fits, lint + full next build, then commit' },
  ],
}

// ── Shared conventions handed to every agent ───────────────────────────────
const CONVENTIONS = `
CLAUDIUS CONVENTIONS (Next.js 16 App Router + React 19 + Tailwind v4 + better-sqlite3):
- READ AGENTS.md first: this Next.js has breaking changes vs your training data. Routing
  params/searchParams are Promises (await them). If you touch routing, skim
  node_modules/next/dist/docs/ for the relevant API.
- Feature-vertical recipe (only if a feature needs a NEW page/tile — most of these do NOT):
  * Workspace-scoped page: app/[workspaceId]/<x>/page.tsx, renders <SideNav/>.
  * Bare redirect stub: app/<x>/page.tsx calling redirectToWorkspaceRoute("/<x>", sp).
  * Nav tile: add to items[] in components/nav/SideNav.tsx with a unique nav.<x> actionId,
    AND add navAction("nav.<x>","Open <X>","Key?") to lib/client/shortcuts.ts. Used nav
    letters already: C S F G M I B A K N H L P D T E J W — pick an UNUSED letter and avoid
    collisions (the registry has a collision map).
- API routes: app/api/<x>/route.ts with \`export const runtime = "nodejs"\`, return
  NextResponse.json(...), import server-only code from @/lib/server/ (NEVER from client).
- Server-only code lives in lib/server/, browser-safe hooks/util in lib/client/, shared
  types in lib/shared/.
- DB migrations (only if truly needed): lib/server/db-migrations/NNN_*.sql, next free
  number — check the directory; add a NEW numbered file, never edit an existing one.
- Styling: Tailwind v4 (no config file; theme in app/globals.css). Use CSS vars:
  var(--accent) var(--panel) var(--panel-2) var(--border) var(--muted) var(--foreground).
  Match the existing idiom — app/[workspaceId]/hooks/page.tsx is the canonical example.
- Keep the existing quality bar: no control that 404s, no button with no backend. If during
  implementation you discover the feature can only ship as a NON-FUNCTIONAL STUB (the SDK
  won't honor the config, etc.), STOP, do not fake it — return done:false with an explanation.
- After editing, the commit will run a pre-commit hook that lints staged files and runs
  related unit tests; lint MUST be clean or the commit is rejected.
`.trim()

const BUILD = [
  {
    id: 'fast-mode',
    name: 'Fast mode session toggle',
    md: 'docs/cheatsheet-features/recent-changes/03-fast-mode-on-opus-4-8.md',
    note: 'Add a Fast mode toggle in the ModelPicker parallel to the existing ultracode toggle (gated on a supportsFastMode capability) + a thin /api/sessions/[id]/fast route that calls applyFlagSettings({ fastMode }). Mirror the existing ultracode/effort session-flag pattern exactly. VERIFY applyFlagSettings + a fast-mode capability actually exist before building; if the flag is not supported by the session manager, return done:false.',
  },
  {
    id: 'stop-all-agents',
    name: 'Stop all background agents',
    md: 'docs/cheatsheet-features/keyboard-shortcuts/09-kill-all-background-agents.md',
    note: 'Add a "Stop all" button (with a confirm) to the Activity rail header in BackgroundTasksPanel.tsx that fans out the existing POST /api/sessions/[id]/stop-task over every currently-running task. No new backend.',
  },
  {
    id: 'conditional-hooks',
    name: 'Conditional hooks (hooks: if)',
    md: 'docs/cheatsheet-features/config-settings/09-conditional-hooks-if.md',
    note: 'The HookGroup type + server already support an "if" rule filter. Add an "If (rule filter)" input to AddHookForm (app/[workspaceId]/hooks/page.tsx) and render the value in EventRow. No backend changes.',
  },
  {
    id: 'continue-on-block',
    name: 'continueOnBlock hook option',
    md: 'docs/cheatsheet-features/config-settings/16-continue-on-block.md',
    note: 'Extend the prompt/agent HookHandler variants in lib/shared/hook-events.ts with an optional continueOnBlock flag, add a toggle in AddHookForm, and render it in EventRow. No DB work.',
  },
  {
    id: 'mention-agents',
    name: 'Mention @agent-name in composer',
    md: 'docs/cheatsheet-features/skills-agents/29-mention-named-subagents.md',
    note: 'Extend AtMentionPicker (currently files-only) so typing "@agent-" offers the loaded subagents from the agents endpoint (/api/agents or /api/sessions/[id]/agents). Inserting one writes @agent-<name> into the composer.',
  },
  {
    id: 'managed-policy-memory',
    name: 'Managed-policy CLAUDE.md row',
    md: 'docs/cheatsheet-features/memory-files/04-managed-policy-claude-md.md',
    note: 'Add /etc/claude-code/CLAUDE.md (Linux/WSL managed policy) as a READ-ONLY top-precedence row in the resolved CLAUDE.md hierarchy on /memory. Small extension to lib/server/claudemd.ts + its API + the /memory page. Read-only (managed by org).',
  },
  {
    id: 'agent-worktree',
    name: 'Agent isolation:worktree control',
    md: 'docs/cheatsheet-features/workflows-tips/09-agent-in-own-worktree.md',
    note: 'Add an "Run in isolated git worktree (isolation: worktree)" control to the agent editor on /agents. The agent frontmatter persists generically and the SDK honors the key — this is a thin UI shell over existing persistence. Verify how agent frontmatter is read/written before wiring.',
  },
  {
    id: 'model-overrides',
    name: 'modelOverrides settings editor',
    md: 'docs/cheatsheet-features/config-settings/07-model-overrides.md',
    note: 'Add an alias -> custom-model-ID key/value editor to the Settings "Model & UI" card (app/settings/page.tsx), persisting a modelOverrides object to settings.json via the existing settings API. Pure settings.json; no backend logic. Confirm the settings read/write path supports an arbitrary nested object.',
  },
  {
    id: 'cache-doctor-check',
    name: 'DISABLE_PROMPT_CACHING doctor check',
    md: 'docs/cheatsheet-features/config-settings/10-disable-prompt-caching-warning.md',
    note: 'Add a warn-level check to app/api/doctor/route.ts that flags when the DISABLE_PROMPT_CACHING env var is set (caching off hurts cost/latency). It renders for free in the existing Doctor checks list. Match the existing check shape exactly.',
  },
  {
    id: 'statusline-refresh',
    name: 'Status line refreshInterval (+ key-preserve fix)',
    md: 'docs/cheatsheet-features/config-settings/18-status-line-refresh-interval.md',
    note: 'The Settings status-line input currently writes only {type,command} and CLOBBERS sibling keys (refreshInterval/padding/hideVimModeIndicator). Fix it to merge into the existing statusLine object and add a "refresh interval (ms)" number input. This is also a clobbering bugfix.',
  },
  {
    id: 'sparse-paths',
    name: 'Worktree sparsePaths settings',
    md: 'docs/cheatsheet-features/workflows-tips/10-sparse-checkout.md',
    note: 'Add a worktree settings section to app/settings/page.tsx with a list editor for worktree.sparsePaths (and worktree.symlinkedDirs if the SDK supports it), persisted as a nested "worktree" object in settings.json via the existing settings API. The SDK supports worktree.sparsePaths; settings currently omit the nested object. Confirm the settings read/write path round-trips a nested object before wiring; if it flattens/drops nested keys, extend it minimally.',
  },
  {
    id: 'rules-editor',
    name: 'Project & user rules editor',
    md: 'docs/cheatsheet-features/memory-files/05-project-rules.md',
    note: 'Add a rules-editor section/tab on /memory for project rules (<cwd>/.claude/rules/*.md) and user rules (~/.claude/rules/*.md): list / create / edit / delete files. New lib/server/rules.ts (server-only fs CRUD, path-safe) + an API route (e.g. app/api/memory/rules/route.ts) + UI on the /memory page. SCOPE: build the editor only; the SDK does not auto-inject these at runtime (the Claude Code CLI consumes them) — state that clearly in the MD, do not pretend runtime injection. This single feature also satisfies docs/cheatsheet-features/memory-files/06-user-rules.md — update BOTH MD files Status to IMPLEMENTED.',
  },
  {
    id: 'project-purge',
    name: 'Purge project state (danger zone)',
    md: 'docs/cheatsheet-features/cli-flags/12-claude-project-purge.md',
    note: 'Workspace delete currently only forgets the entry. Add a danger-zone "Purge project state" action on the workspace page (app/[workspaceId]/workspace/page.tsx) that deletes the project\'s local state (transcripts/memory/.claudius.db scoped to that project) behind an explicit type-to-confirm dialog, plus a DELETE purge API route. Be conservative about WHAT gets deleted — verify the exact state locations first and never touch the user\'s source files.',
  },
  {
    id: 'shell-bg-session',
    name: 'Shell background session (! cmd)',
    md: 'docs/cheatsheet-features/workflows-tips/27-shell-as-background-session.md',
    note: 'A user typing "! <cmd>" in the composer is not intercepted today. Add a leading-"!" intercept in the composer/PromptInput that runs the command as a session-bound background shell and surfaces it in the existing BackgroundTasksPanel/BashViewer. Thin route over lib/server/shell.ts (there is already app/api/workspaces/[id]/shell). VERIFY the shell.ts API + how background tasks are registered/streamed before wiring; if it requires deep new streaming plumbing, scope down to a minimal run-and-show or return done:false.',
  },
  {
    id: 'create-worktree',
    name: 'Create worktree action',
    md: 'docs/cheatsheet-features/workflows-tips/12-auto-create-worktrees.md',
    note: 'Add a "New worktree" action to WorktreesOverlay. The current /api/worktrees route is GET-only; add a POST that runs "git worktree add" via a createWorktree helper (new branch + path), with validation. Verify the existing worktrees listing/util before adding the helper so shapes line up.',
  },
]

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    feasible: { type: 'boolean', description: 'false if it can only ship as a non-functional stub or needs backend that is out of scope' },
    reason: { type: 'string', description: 'if not feasible, why' },
    summary: { type: 'string' },
    plan: { type: 'string', description: 'concrete ordered steps: exact files + what changes in each' },
    files: { type: 'array', items: { type: 'string' }, description: 'files to create or edit' },
    needsMigration: { type: 'boolean' },
    needsNavTile: { type: 'boolean' },
  },
  required: ['feasible', 'summary', 'plan', 'files', 'needsMigration', 'needsNavTile'],
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    done: { type: 'boolean', description: 'true only if fully implemented as a real, working surface' },
    touchedFiles: { type: 'array', items: { type: 'string' }, description: 'every file created or modified (relative paths), INCLUDING the MD spec(s) you updated' },
    summary: { type: 'string' },
    notes: { type: 'string', description: 'anything notable; if done:false, why' },
  },
  required: ['done', 'touchedFiles', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    committed: { type: 'boolean' },
    sha: { type: 'string', description: 'short sha if committed, else empty' },
    lintClean: { type: 'boolean' },
    buildClean: { type: 'boolean', description: 'bun run build (next build) exited 0' },
    testAdded: { type: 'boolean', description: 'true if you added/extended a focused unit test for this feature' },
    testResult: { type: 'string', description: 'what behavioral check you ran and its result' },
    commitMessage: { type: 'string' },
    reason: { type: 'string', description: 'if not committed, why' },
  },
  required: ['committed', 'lintClean', 'buildClean', 'testAdded', 'testResult'],
}

phase('Design')

const outcomes = []

for (const f of BUILD) {
  try {
    // ── 1. DESIGN (read-only) ──────────────────────────────────────────
    const design = await agent(
      `Design the implementation for this Claudius feature. READ the relevant code first — do not trust the note blindly; verify every backend assumption it makes.

${CONVENTIONS}

FEATURE: ${f.name}
SPEC FILE (read it): ${f.md}
IMPLEMENTATION NOTE FROM TRIAGE: ${f.note}

Produce a concrete plan: the exact files to create/edit and what changes in each, the API shape if any, and whether a DB migration or new nav tile is genuinely required (usually NOT — most of these extend existing surfaces). If, after reading the code, this can only ship as a non-functional stub or needs backend that's out of scope, set feasible=false with a clear reason. Otherwise feasible=true.`,
      { label: `design:${f.id}`, phase: 'Design', schema: DESIGN_SCHEMA, agentType: 'general-purpose' },
    )

    if (!design || !design.feasible) {
      log(`SKIP ${f.id}: ${design?.reason ?? 'design failed/null'}`)
      outcomes.push({ id: f.id, name: f.name, status: 'skipped', reason: design?.reason ?? 'design null/infeasible' })
      continue
    }

    // ── 2. IMPLEMENT (mutates shared files — strictly sequential) ───────
    const impl = await agent(
      `Implement this Claudius feature end-to-end following the approved design. Make ALL code edits. Do NOT commit (a later step commits). Match the existing component/styling idiom exactly.

${CONVENTIONS}

FEATURE: ${f.name}
SPEC FILE: ${f.md}

APPROVED DESIGN:
${design.plan}

FILES IN PLAN: ${design.files.join(', ')}

After implementing, UPDATE the MD spec file(s) Status to IMPLEMENTED with a one-line "Implemented:" note pointing at the real files. Return done:true only if it is a real, working surface (not a stub). List EVERY touched file (code + MD) in touchedFiles. If you hit a blocker that forces a stub, revert your edits with git and return done:false.`,
      { label: `build:${f.id}`, phase: 'Implement', schema: IMPLEMENT_SCHEMA, agentType: 'general-purpose' },
    )

    if (!impl || !impl.done) {
      log(`FAIL impl ${f.id}: ${impl?.notes ?? 'null/not-done'}`)
      // Clean the tree so the next feature starts from a known-good state.
      await agent(
        `The implementation of "${f.name}" did not complete. Restore the git working tree to a clean state: discard ALL uncommitted changes (git checkout -- . ; git clean -fd for any new untracked files you can identify as belonging to this attempt), but DO NOT touch anything already committed. Confirm \`git status\` is clean afterward.`,
        { label: `revert:${f.id}`, phase: 'Implement', agentType: 'general-purpose' },
      )
      outcomes.push({ id: f.id, name: f.name, status: 'impl-failed', reason: impl?.notes ?? 'not done' })
      continue
    }

    // ── 3. TEST + BUILD + COMMIT ───────────────────────────────────────
    const verify = await agent(
      `Test, build-verify, and commit the just-implemented feature "${f.name}". The working tree currently contains ONLY this feature's changes (the loop is sequential and the previous feature was committed).

STEPS (in order):
1. TEST — add real behavioral verification, not just "it compiled":
   - If the feature has any testable pure logic (a server lib like rules.ts, an API route handler,
     a path-safety helper, a settings merge, the doctor check, a parser/intercept) WRITE OR EXTEND a
     focused vitest in tests/unit/**/*.test.ts that asserts the behavior. Keep it small and real.
   - The pre-commit hook auto-runs \`vitest related\` on staged files, so a colocated test runs for free.
   - For UI-only surfaces where a unit test adds nothing, do the lightest meaningful check you can
     (e.g. assert the component renders / the new control is present) and record what you did in testResult.
   - Do NOT rely on injected-keystroke Playwright for composer features (the app re-grabs focus and
     Playwright bypasses before-input-event) — prefer unit tests there.
   Run your test(s) with: bun run test (or scope to your file). They must pass.
2. LINT — run: bun run lint ${impl.touchedFiles.filter((p) => /\.(ts|tsx|mjs|js)$/.test(p)).join(' ') || '<touched code files>'}
   Fix every lint error in touched files (repo policy: do not dismiss as pre-existing). Re-run until clean.
3. BUILD — run: bun run build   (this is \`next build\`; it catches RSC server/client boundary errors,
   route-export problems, and type errors that \`tsc\` alone misses — CLAUDE.md: client code must NEVER
   import from lib/server). It MUST exit 0. Fix anything you introduced and re-run until green.
4. COMMIT — only if test + lint + build are all green. The tree holds only this feature's work, so:
   git add -A
   git commit -m "<concise conventional message: feat:/fix:, describe the WHY>"
   The pre-commit hook re-lints staged files + runs related tests; if it rejects, fix and retry.
   Then capture the short SHA: git rev-parse --short HEAD.

If test, lint, or build cannot be made green, DO NOT commit: discard the changes
(git checkout -- . ; git clean -fd for new files from this feature) and report committed:false with the reason.
Report committed, sha, lintClean, buildClean, testAdded, testResult, and the commitMessage.`,
      { label: `test:${f.id}`, phase: 'Test', schema: VERIFY_SCHEMA, agentType: 'general-purpose' },
    )

    const status = verify?.committed ? 'committed' : 'verify-failed'
    outcomes.push({ id: f.id, name: f.name, status, sha: verify?.sha ?? '', reason: verify?.reason ?? '' })
    log(`${verify?.committed ? '✓ committed' : '✗ NOT committed'} ${f.id}${verify?.sha ? ` (${verify.sha})` : ''}`)
  } catch (e) {
    log(`ERROR ${f.id}: ${String(e).slice(0, 200)}`)
    outcomes.push({ id: f.id, name: f.name, status: 'error', reason: String(e).slice(0, 300) })
    // Best-effort cleanup so one explosion doesn't poison the rest.
    try {
      await agent(
        `An error interrupted work on "${f.name}". Restore a clean git working tree: discard uncommitted changes (git checkout -- . ; git clean -fd new files from this attempt) WITHOUT touching committed history. Confirm git status is clean.`,
        { label: `recover:${f.id}`, phase: 'Test', agentType: 'general-purpose' },
      )
    } catch {}
  }
}

const committed = outcomes.filter((o) => o.status === 'committed')
log(`Implementation loop done: ${committed.length}/${BUILD.length} committed`)

return {
  committed: committed.length,
  total: BUILD.length,
  outcomes,
}
