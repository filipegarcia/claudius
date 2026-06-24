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

## Regex injection / ReDoS and CodeQL (`js/regex-injection`)

Never pass user-controlled input to the `RegExp` constructor (or `String.prototype.match`/`replace`/`split` with a string-as-regex). CodeQL traces request data → `new RegExp(...)` as a ReDoS sink, and it's a real one: a crafted pattern (e.g. `(a+)+$`) triggers catastrophic backtracking that wedges the Node event loop. **Route handlers are cross-origin reachable** — Next.js doesn't gate request *processing* on CSRF, so another tab can fire the request even if it can't read the response.

1. **Escape, don't compile.** Treat the query as a literal substring and escape every metacharacter before it reaches `new RegExp`:
   ```ts
   const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // MDN canonical escape
   const re = new RegExp(escaped, "gi");
   ```
   This is CodeQL's `MetacharEscapeSanitizer` — the only recognized barrier that needs no extra dependency. See `app/api/sessions/search/route.ts` for the canonical use. (The per-session client-side `TranscriptSearch` may offer real `/regex/` search because it runs in the browser, not on the server event loop.)

2. **`re2` (native) is a verified DEAD END here — do not reintroduce it.** It looks like the textbook fix (linear-time, no backtracking), but its `nan` addon **cannot compile against Electron 42's V8**, which breaks the packaged desktop build. This was tried (commit added re2 for exactly this alert) and had to be fully reverted. If you ever need a real regex engine server-side, evaluate `re2-wasm` (WebAssembly, no native compile) — but confirm both that CodeQL closes the alert with it AND its API matches the call sites before committing.

3. **Insecure / biased randomness (`js/insecure-randomness`, `js/biased-cryptographic-random`):** CodeQL flags `Math.random()` whose value flows into a tracked sink — *even cosmetic picks* (the `/color` accent, the spinner tip). The trap: "hardening" cosmetic randomness with `crypto.getRandomValues` makes it **worse**. CodeQL then flags `js/biased-cryptographic-random` for **both** `crypto…[0] % n` **and** `Math.floor(crypto…[0] / 2**32 * n)` scaling (verified against the CLI — neither satisfies the query), and the crypto value taints downstream modulo (e.g. `nextTipIndex`), spawning *more* alerts. There is no CodeQL-accepted unbiased-integer primitive in the browser (`crypto.randomInt` is Node-only).
   - **Cosmetic randomness → keep `Math.random()` and dismiss the alert** as a false positive ("not a security context"). Don't reach for crypto.
   - **Genuinely security-sensitive randomness (tokens, ids) →** generate it **server-side** with `crypto.randomInt(max)` / `crypto.randomBytes` (CodeQL-accepted), never `Math.random` and never `getRandomValues(...) % n`.
