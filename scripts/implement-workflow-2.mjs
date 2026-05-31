export const meta = {
  name: 'cheatsheet-implement-2',
  description: 'Finish the remaining 10 UI-worthy cheat-sheet features inside an isolated git worktree: design -> implement -> test+build -> commit, one at a time',
  phases: [
    { title: 'Design', detail: 'read code in the worktree, produce a precise plan per feature' },
    { title: 'Implement', detail: 'apply the plan in the worktree' },
    { title: 'Test', detail: 'add a focused test, lint + full next build, then commit --no-verify' },
  ],
}

// ── Isolation: everything happens in a dedicated git worktree so concurrent
// activity in the main working dir can NEVER contaminate these commits again.
const WT = '/Users/filipegarcia/Projects/claudius/.claude/worktrees/cheatsheet-ui'
// The toolchain is NOT on the non-interactive shell PATH; pin it explicitly.
const ENV = 'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"'

const ISOLATION = `
CRITICAL — WORKTREE ISOLATION (read twice):
- ALL work happens in the worktree: ${WT}
- This is a separate working directory on branch feat/cheatsheet-ui. NEVER read, edit, or
  write files under the main repo path /Users/filipegarcia/Projects/claudius/<...> — only
  under ${WT}/<...>. The main dir is on a different branch and has CONCURRENT writers.
- For Read/Edit/Write tools, use ABSOLUTE paths beginning with ${WT}/ .
- For EVERY shell command, start with:  cd ${WT} && ${ENV} &&  ... then your command.
  (bun/node are otherwise "command not found"; git is fine but use \`git -C ${WT}\` to be safe.)
- FIRST THING: run  cd ${WT} && git rev-parse --show-toplevel  — it MUST print ${WT}. If it
  prints anything else, STOP and report; do not edit anything.
`.trim()

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
    letters already: C S F G M I B A K N H L P D T E J W — pick an UNUSED letter, avoid
    collisions (the registry has a collision map).
- API routes: app/api/<x>/route.ts with \`export const runtime = "nodejs"\`, return
  NextResponse.json(...), import server-only code from @/lib/server/ (NEVER from client).
- Server-only code -> lib/server/, browser-safe hooks/util -> lib/client/, shared types -> lib/shared/.
  CLAUDE.md rule: client code must NEVER import from lib/server/ (it pulls in better-sqlite3 and
  fails \`next build\` even though tsc passes). The build gate below catches this.
- DB migrations (only if truly needed): lib/server/db-migrations/NNN_*.sql, next free number
  (check the dir; currently 011 is the last) — add a NEW numbered file, never edit an existing one.
- Styling: Tailwind v4 (no config file). Use CSS vars: var(--accent) var(--panel) var(--panel-2)
  var(--border) var(--muted) var(--foreground). app/[workspaceId]/hooks/page.tsx is the idiom.
- Keep the existing quality bar: no control that 404s, no button with no backend. If you discover
  the feature can only ship as a NON-FUNCTIONAL STUB (SDK won't honor the config, etc.), STOP —
  do not fake it — return feasible:false / done:false with the reason.
`.trim()

// The remaining 10 features (features 1-5 already shipped on this branch:
// fast-mode, stop-all-agents, conditional-hooks, continueOnBlock, mention-agents).
const BUILD = [
  {
    id: 'managed-policy-memory',
    name: 'Managed-policy CLAUDE.md row',
    md: 'docs/cheatsheet-features/memory-files/04-managed-policy-claude-md.md',
    note: 'Add /etc/claude-code/CLAUDE.md (Linux/WSL managed policy) as a READ-ONLY top-precedence row in the resolved CLAUDE.md hierarchy on /memory. Small extension to lib/server/claudemd.ts + its API + the /memory page. Read-only (managed by org); render gracefully when the file is absent.',
  },
  {
    id: 'agent-worktree',
    name: 'Agent isolation:worktree control',
    md: 'docs/cheatsheet-features/workflows-tips/09-agent-in-own-worktree.md',
    note: 'Add a "Run in isolated git worktree (isolation: worktree)" control to the agent editor on /agents. Agent frontmatter persists generically and the SDK honors the key — thin UI shell over existing persistence. Verify how agent frontmatter is read/written (lib/server/agents*) before wiring.',
  },
  {
    id: 'model-overrides',
    name: 'modelOverrides settings editor',
    md: 'docs/cheatsheet-features/config-settings/07-model-overrides.md',
    note: 'Add an alias -> custom-model-ID key/value editor to the Settings "Model & UI" card (app/settings/page.tsx), persisting a modelOverrides object to settings.json via the existing settings API. Pure settings.json. Confirm the settings read/write path round-trips an arbitrary nested object; if it flattens/drops it, extend minimally.',
  },
  {
    id: 'cache-doctor-check',
    name: 'DISABLE_PROMPT_CACHING doctor check',
    md: 'docs/cheatsheet-features/config-settings/10-disable-prompt-caching-warning.md',
    note: 'Add a warn-level check to app/api/doctor/route.ts that flags when the DISABLE_PROMPT_CACHING env var is set (caching off hurts cost/latency). Renders for free in the existing Doctor checks list. Match the existing check shape exactly.',
  },
  {
    id: 'statusline-refresh',
    name: 'Status line refreshInterval (+ key-preserve fix)',
    md: 'docs/cheatsheet-features/config-settings/18-status-line-refresh-interval.md',
    note: 'The Settings status-line input writes only {type,command} and CLOBBERS sibling keys (refreshInterval/padding/hideVimModeIndicator). Fix it to MERGE into the existing statusLine object and add a "refresh interval (ms)" number input. Also a clobbering bugfix — assert the merge in a unit test.',
  },
  {
    id: 'sparse-paths',
    name: 'Worktree sparsePaths settings',
    md: 'docs/cheatsheet-features/workflows-tips/10-sparse-checkout.md',
    note: 'Add a worktree settings section to app/settings/page.tsx with a list editor for worktree.sparsePaths (and worktree.symlinkedDirs if the SDK supports it), persisted as a nested "worktree" object in settings.json via the existing settings API. Confirm the settings path round-trips a nested object before wiring; extend minimally if not.',
  },
  {
    id: 'rules-editor',
    name: 'Project & user rules editor',
    md: 'docs/cheatsheet-features/memory-files/05-project-rules.md',
    altMd: 'docs/cheatsheet-features/memory-files/06-user-rules.md',
    note: 'Add a rules-editor section/tab on /memory for project rules (<cwd>/.claude/rules/*.md) and user rules (~/.claude/rules/*.md): list / create / edit / delete files. New lib/server/rules.ts (server-only, PATH-SAFE fs CRUD — reject traversal) + an API route (app/api/memory/rules/route.ts) + UI on /memory. SCOPE: build the editor only; the SDK does not auto-inject these at runtime (the Claude Code CLI consumes them) — state that clearly in the MD, do not pretend runtime injection. Add unit tests for the path-safety + CRUD in rules.ts. Update BOTH MD files Status to IMPLEMENTED.',
  },
  {
    id: 'project-purge',
    name: 'Purge project state (danger zone)',
    md: 'docs/cheatsheet-features/cli-flags/12-claude-project-purge.md',
    note: 'Workspace delete currently only forgets the entry. Add a danger-zone "Purge project state" action on the workspace page (app/[workspaceId]/workspace/page.tsx) that deletes the project\'s LOCAL claudius state (transcripts/memory scoped to that project) behind an explicit type-to-confirm dialog, plus a DELETE purge API route. Be CONSERVATIVE: verify exact state locations first, NEVER touch the user\'s source files or git. Unit-test the path resolution / guard logic.',
  },
  {
    id: 'shell-bg-session',
    name: 'Shell background session (! cmd)',
    md: 'docs/cheatsheet-features/workflows-tips/27-shell-as-background-session.md',
    note: 'A user typing "! <cmd>" in the composer is not intercepted today. Add a leading-"!" intercept in the composer/PromptInput that runs the command as a session-bound background shell, surfaced in the existing BackgroundTasksPanel/BashViewer. Thin route over lib/server/shell.ts (see app/api/workspaces/[id]/shell). VERIFY the shell.ts API + how background tasks register/stream first; if it needs deep new streaming plumbing, scope down to a minimal run-and-show or return feasible:false. Unit-test the "!"-intercept parser.',
  },
  {
    id: 'create-worktree',
    name: 'Create worktree action',
    md: 'docs/cheatsheet-features/workflows-tips/12-auto-create-worktrees.md',
    note: 'Add a "New worktree" action to WorktreesOverlay. The current /api/worktrees route is GET-only; add a POST that runs "git worktree add" via a createWorktree helper (new branch + path) with validation. Verify the existing worktrees listing/util shapes first. Unit-test the validation/arg-building.',
  },
]

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    feasible: { type: 'boolean' },
    reason: { type: 'string' },
    summary: { type: 'string' },
    plan: { type: 'string', description: 'concrete ordered steps: exact files (absolute, under the worktree) + what changes in each' },
    files: { type: 'array', items: { type: 'string' } },
    needsMigration: { type: 'boolean' },
    needsNavTile: { type: 'boolean' },
  },
  required: ['feasible', 'summary', 'plan', 'files', 'needsMigration', 'needsNavTile'],
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    done: { type: 'boolean' },
    touchedFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['done', 'touchedFiles', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    committed: { type: 'boolean' },
    sha: { type: 'string' },
    lintClean: { type: 'boolean' },
    buildClean: { type: 'boolean' },
    testAdded: { type: 'boolean' },
    testResult: { type: 'string' },
    commitMessage: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['committed', 'lintClean', 'buildClean', 'testAdded', 'testResult'],
}

phase('Design')
log(`Worktree: ${WT} — finishing ${BUILD.length} remaining features (5 already shipped on feat/cheatsheet-ui)`)

const outcomes = []

for (const f of BUILD) {
  try {
    // ── 1. DESIGN ──────────────────────────────────────────────────────
    const design = await agent(
      `Design the implementation for this Claudius feature. READ the relevant code FIRST (in the worktree) — do not trust the note blindly; verify every backend assumption it makes.

${ISOLATION}

${CONVENTIONS}

FEATURE: ${f.name}
SPEC FILE (read it, in the worktree): ${WT}/${f.md}
TRIAGE NOTE: ${f.note}

Produce a concrete plan: exact files (absolute paths under the worktree) to create/edit and what changes in each, the API shape if any, and whether a DB migration or new nav tile is genuinely required (usually NOT). If after reading the code this can only ship as a non-functional stub or needs out-of-scope backend, set feasible=false with a clear reason. Otherwise feasible=true.`,
      { label: `design:${f.id}`, phase: 'Design', schema: DESIGN_SCHEMA, agentType: 'general-purpose' },
    )

    if (!design || !design.feasible) {
      log(`SKIP ${f.id}: ${design?.reason ?? 'design failed/null'}`)
      outcomes.push({ id: f.id, name: f.name, status: 'skipped', reason: design?.reason ?? 'design null/infeasible' })
      continue
    }

    // ── 2. IMPLEMENT ───────────────────────────────────────────────────
    const impl = await agent(
      `Implement this Claudius feature end-to-end in the worktree, following the approved design. Make ALL code edits. Do NOT commit (a later step commits). Match the existing component/styling idiom exactly.

${ISOLATION}

${CONVENTIONS}

FEATURE: ${f.name}
SPEC FILE: ${WT}/${f.md}${f.altMd ? `\nSECOND SPEC FILE (same feature, also update): ${WT}/${f.altMd}` : ''}

APPROVED DESIGN:
${design.plan}

FILES IN PLAN: ${design.files.join(', ')}

After implementing, UPDATE the MD spec file(s) Status to IMPLEMENTED with a one-line "Implemented:" note pointing at the real files. Return done:true only if it is a real, working surface (not a stub). List EVERY touched file (code + MD) in touchedFiles as paths relative to the worktree root. If a blocker forces a stub, revert your edits (cd ${WT} && ${ENV} && git checkout -- . && git clean -fd) and return done:false.`,
      { label: `build:${f.id}`, phase: 'Implement', schema: IMPLEMENT_SCHEMA, agentType: 'general-purpose' },
    )

    if (!impl || !impl.done) {
      log(`FAIL impl ${f.id}: ${impl?.notes ?? 'null/not-done'}`)
      await agent(
        `Implementation of "${f.name}" did not complete. In the worktree ${WT}, restore a clean tree: cd ${WT} && ${ENV} && git checkout -- . && git clean -fd (only files from this attempt). Confirm \`git -C ${WT} status\` is clean. Do NOT touch committed history.`,
        { label: `revert:${f.id}`, phase: 'Implement', agentType: 'general-purpose' },
      )
      outcomes.push({ id: f.id, name: f.name, status: 'impl-failed', reason: impl?.notes ?? 'not done' })
      continue
    }

    // ── 3. TEST + BUILD + COMMIT ───────────────────────────────────────
    const verify = await agent(
      `Test, build-verify, and commit the just-implemented feature "${f.name}" IN THE WORKTREE. The worktree tree contains only this feature's changes (sequential loop; previous feature committed).

${ISOLATION}

STEPS (run each shell command as: cd ${WT} && ${ENV} && <cmd>):
1. TEST — add real behavioral verification, not just "it compiled":
   - If there is any testable pure logic (a server lib, an API handler, a path-safety helper, a
     settings merge, the doctor check, the "!"-parser) WRITE OR EXTEND a focused vitest in
     tests/unit/**/*.test.ts asserting the behavior. Keep it small and real.
   - Run it: bun run test (or scope to your file). It MUST pass.
   - For UI-only surfaces where a unit test adds nothing, do the lightest meaningful check and
     record it in testResult. Do NOT use injected-keystroke Playwright for composer features.
2. LINT — bun run lint <the touched .ts/.tsx/.mjs files>. Fix every error in touched files
   (repo policy: don't dismiss as pre-existing). Re-run until clean.
3. BUILD — bun run build  (full next build; catches RSC server/client boundary + route-export +
   type errors tsc misses). MUST exit 0. Fix anything you introduced; re-run until green.
4. COMMIT — only if test+lint+build are all green. The worktree holds only this feature's work:
     git -C ${WT} add -A
     git -C ${WT} commit --no-verify -m "<concise conventional message: feat:/fix:, the WHY>"
   (--no-verify because the repo pre-commit hook can't find bun on this PATH; your gate above is
    stricter than the hook.) Then capture: git -C ${WT} rev-parse --short HEAD.

If test/lint/build cannot be made green, DO NOT commit: restore clean (git -C ${WT} checkout -- . ; git -C ${WT} clean -fd new files) and report committed:false with the reason.
Report committed, sha, lintClean, buildClean, testAdded, testResult, commitMessage.`,
      { label: `test:${f.id}`, phase: 'Test', schema: VERIFY_SCHEMA, agentType: 'general-purpose' },
    )

    const status = verify?.committed ? 'committed' : 'verify-failed'
    outcomes.push({ id: f.id, name: f.name, status, sha: verify?.sha ?? '', reason: verify?.reason ?? '' })
    log(`${verify?.committed ? '✓ committed' : '✗ NOT committed'} ${f.id}${verify?.sha ? ` (${verify.sha})` : ''}`)
  } catch (e) {
    log(`ERROR ${f.id}: ${String(e).slice(0, 200)}`)
    outcomes.push({ id: f.id, name: f.name, status: 'error', reason: String(e).slice(0, 300) })
    try {
      await agent(
        `An error interrupted work on "${f.name}". In the worktree ${WT}, restore a clean tree (cd ${WT} && ${ENV} && git checkout -- . && git clean -fd this attempt's files) WITHOUT touching committed history. Confirm git -C ${WT} status is clean.`,
        { label: `recover:${f.id}`, phase: 'Test', agentType: 'general-purpose' },
      )
    } catch {}
  }
}

const committed = outcomes.filter((o) => o.status === 'committed')
log(`Remaining-features loop done: ${committed.length}/${BUILD.length} committed`)

return { committed: committed.length, total: BUILD.length, outcomes }
