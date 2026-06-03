@AGENTS.md

# Claudius

Next.js 16 (App Router) + React 19 app that wraps `@anthropic-ai/claude-agent-sdk` to put Claude Code in the browser. Local persistence via `better-sqlite3`. See `README.md` for the longer overview.

## Commands

- `bun run dev` — dev server on :3000
- `bun run lint` — ESLint (pass file paths to scope)
- `bun run test:e2e` — Playwright (`make test` installs the chromium binary first). Marketing screenshots in `site/screenshots/` are **not** overwritten by default — run `bun run test:e2e:update-screenshots` (or set `UPDATE_SCREENSHOTS=1`) when you actually want to refresh them.
- `bun run build` — production build

## Layout

- `app/` — App Router pages + `app/api/` route handlers
- `lib/server/` — **Node-only**, never import from client code (SQLite, scheduler, session manager, MCP, hooks, plugins, asset store)
- `lib/client/` — React hooks and browser-safe utilities
- `lib/shared/` — types and helpers usable from either side
- `tests/e2e/` — Playwright specs

## Conventions

- SQLite migrations live in `lib/server/db-migrations/NNN_*.sql` and run on startup; add a new numbered file rather than editing existing ones.
- Tailwind v4 (no `tailwind.config.*` — config is in `app/globals.css` via `@theme`).
- After changes, run `bun run lint` scoped to the files you touched. Fix lint errors in those files; don't dismiss them as pre-existing.

## Path safety and CodeQL (`js/path-injection`)

When writing code that passes user-controlled input to `fs.*` calls:

1. **Use `path.resolve(base, userInput)`, never `path.join()`** at the sink.  
   `join` produces "normalized" flow state; CodeQL's `StartsWithDirSanitizer` requires "absolute + normalized" — only `resolve` delivers that.

2. **Put the `startsWith` check inline at the sink**, not in a helper function.  
   CodeQL does not propagate `StartsWithDirSanitizer` through call-site boundaries. The check must be visible right above the `fs.*` call:
   ```ts
   const target = resolve(parent, name);
   if (!target.startsWith(BASE + sep)) throw …; // or return 403
   await fs.mkdir(target);
   ```

3. **`assertWithin` from `lib/server/safe-path` works for `lib/server/` internals** (e.g. `mcp.ts`) where the source/sink shape satisfies CodeQL's wrapper handling. It does **not** work for `app/api/` route handlers whose source is `req.json()` — use the inline pattern there instead.

4. **Don't add `!== BASE` to the `startsWith` check at the sink.** The equality short-circuit in a compound `A && !B` prevents the sanitizer from firing on the `A=false` branch. A plain `!target.startsWith(BASE + sep)` guard covering the subdirectory case is enough at the sink; keep the equality check only in the early-return fail-fast guard higher up.
