# Electron e2e coverage loop — Ralph prompt

This file is the canonical prompt for the **electron-e2e** Ralph loop.
It runs locally only (the new specs are excluded from CI) and never
stops — the goal is open-ended growth of e2e coverage for the
Claudius Electron app.

Start the loop by pasting the prompt below into Claude Code's
`/ralph-loop:ralph-loop` slash command, or by running:

```bash
make electron-e2e-loop
```

(which is a thin wrapper that opens the prompt for you to paste into
`/ralph-loop`.)

---

## The prompt to paste into `/ralph-loop`

```
You are running an autonomous e2e-coverage Ralph loop for the Claudius Electron app.

WORKING DIRECTORY: /Users/filipegarcia/Projects/claudius

GOAL
====
Every iteration, design + implement + verify ONE new Playwright Electron
spec that covers a previously-untested aspect of the running app.
Commit and push the spec when it passes green locally. Repeat
forever. Coverage grows monotonically.

NEVER output a completion promise. The loop is unbounded.

ITERATION PROTOCOL
==================

0. READ STATE
   - Read tests/electron/COVERAGE.md — the source of truth for what's
     covered (`- [x]`) and what isn't (`- [ ]`).
   - Read tests/electron/BUGS.md — known app bugs you've already filed.
   - Quickly inspect the last 3 entries in `git log --oneline -- tests/electron/`
     so you don't re-derive a scenario the previous iteration already wrote.

1. DESIGNER PHASE — pick the next scenario
   - Pick the category in COVERAGE.md with the FEWEST `[x]` rows.
     (Tie-break by listed order so categories rotate naturally.)
   - Inside that category, pick the FIRST `- [ ]` row.
   - If no `- [ ]` rows remain in that category, propose ONE new row,
     append it to the category, and use it. The new row must describe
     a behavior a user would actually notice — not a code-line-coverage
     filler.
   - Mark the chosen row "in-progress" by appending ` [in-progress]`
     and commit the COVERAGE.md change before writing the spec, so a
     parallel iteration (if any) doesn't pick the same one.

2. IMPLEMENTOR PHASE — write the spec
   - Filename: tests/electron/<category-slug>-<scenario-slug>.spec.ts
     - category-slug: kebab of the section header ("system-integrations").
     - scenario-slug: kebab of the row text, max 40 chars.
   - Use the shared launcher at tests/electron/launch.ts. Smoke spec at
     tests/electron/smoke.spec.ts is the reference shape.
   - Drive the renderer with REAL clicks / keystrokes / drags via the
     Playwright Page returned from `launched.app.firstWindow()`. Don't
     stub the rendered UI's own state with `page.evaluate(...) -
     setState(...)`.
   - When relevant, assert BOTH:
       (a) DOM signal — the element became visible / aria attribute
           flipped / route URL changed
       (b) server-state signal — `page.request.get(...)` confirms the
           backing write
   - Spec must finish within 30 s under normal conditions. Use the
     `test.setTimeout(60_000)` knob only if Electron cold-start eats
     into the budget.
   - For main-process assertions (badge count, menu state, native
     dialog), use `launched.app.evaluate(({ app, Menu, ... }) => ...)`.
   - For dialog interception: stub `dialog.showOpenDialog` /
     `dialog.showMessageBox` via `launched.app.evaluate(...)` BEFORE
     triggering the renderer click that opens it.

3. VERIFY PHASE — run the spec live
   - Run exactly:
       PLAYWRIGHT_SLOW_MO=300 playwright test \
         tests/electron/<file>.spec.ts \
         --project=chromium-electron \
         --reporter=list
   - GREEN path:
       a. Edit COVERAGE.md: change `- [ ] X [in-progress]` to
          `- [x] X (<file>.spec.ts)`.
       b. Commit + push (see step 4).
   - RED path (test fails):
       a. Inspect the failure (screenshots in test-results/, error
          message, page snapshot in error-context.md).
       b. If the bug is in YOUR SPEC, fix it and re-run. Don't loop
          forever — give yourself max 3 fix attempts per scenario.
       c. If the bug is in the APP (not the spec):
          - Wrap the failing assertion with `test.fail()` so the suite
            stays green overall.
          - Change the COVERAGE.md row to
            `- [ ] X [bug-in-app: <one-line summary>]`.
          - Append a full bug section to BUGS.md (use the template
            shown there).
          - Commit + push the spec + COVERAGE.md + BUGS.md.

4. COMMIT + PUSH
   - Stage ONLY the new spec file, COVERAGE.md, and BUGS.md (if
     touched). Never include unrelated edits.
   - Use a HEREDOC for the commit message to avoid zsh globbing:
       git commit -m "$(cat <<'COMMITEOF'
       test(electron-e2e): <scenario title>
       COMMITEOF
       )"
   - `git pull --rebase origin <branch>` before push to avoid
     conflicts with parallel work.
   - `git push`.

5. POST-COMMIT
   - If lint or typecheck failed during step 3, fix and re-commit
     before push.
   - If push fails for any reason (auth, conflict that rebase didn't
     resolve), leave the local commit, write a one-line note to
     BUGS.md under a "## Loop infrastructure" section, and continue.

NON-NEGOTIABLE RULES
====================
- Do NOT modify production code (app/, lib/, components/, electron/,
  next.config.ts) in this loop. You are an OBSERVER. If the app is
  broken, file the bug and move on.
- Do NOT skip categories. The designer step picks the FEWEST-covered
  category — that's the whole engine of breadth.
- Do NOT call any AskUserQuestion-style tool. Make every decision
  yourself.
- Do NOT mark a row as `[x]` unless `playwright test ...` exited 0.
- Do NOT add the new spec to CI. The chromium-electron project is
  already in playwright.config.ts but the make `ci` target excludes
  it (see Makefile `test:` definition). Keep that boundary.
- Do NOT delete or rewrite existing rows in COVERAGE.md unless the
  underlying spec is also being deleted in the same commit.
- COMMIT MESSAGE BODY MUST NOT mention "Generated with Claude Code"
  or similar attribution lines.

STATE LOGGING
=============
After each iteration, append one line to tests/electron/LOOP.log:

  <ISO date> <iteration#> <category> <scenario-slug> <green|red|bug-in-app>

This is the audit trail. Don't commit it (it's gitignored).
```
