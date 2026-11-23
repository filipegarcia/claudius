# Server components and server-side routing in `app/` (N01)

Audit of every file under `app/` except `app/api/**`, plus `proxy.ts` and `lib/server/redirect-to-workspace.ts`. Taken 2026-11-01 against Next 16.4.3. Feeds N02 (redirects into axum), N03 (client data) and N04 (static export).

- 73 TS/TSX files: 26 server components, 47 `"use client"`.
- 14 client files import `lib/server`, all `import type` (erased at build).
- 33 client files touch neither `lib/server` nor any server-only API.
- No server actions, `headers()`, `notFound()`, `generateStaticParams`, `generateMetadata` or segment config (`dynamic`, `revalidate`, `runtime`, …) anywhere outside `app/api`. `cookies()` is reached only through `lib/server/active-workspace.ts`.
- In-flight work: `app/[workspaceId]/git/file/` is untracked WIP. `rust/ROUTES.md` predates `crates/claudius-server/src/customizations.rs`, which now serves `GET /api/customizations`, `GET/PATCH/DELETE /api/customizations/{id}`, `select`, `publishes` and `diff` → rerun `rust/scripts/route-coverage.sh`.

## 1. Inventory

| File | Kind | Reads / redirects on | `lib/server` calls | API route that already serves it |
|---|---|---|---|---|
| `proxy.ts` | redirect + cookie write (Next Proxy) | First path segment and the `claudius.workspace` cookie. (a) segment ~ `^wks_[a-f0-9]{12}$` and ≠ cookie → pass through + `Set-Cookie` (1 y, `Path=/`, `SameSite=lax`, not HttpOnly). (b) segment ∈ the 20 scoped names (§ 3) and cookie ~ that regex → 307 `/<cookie><path><query>`. Matcher `/((?!api/\|_next/\|.*\.).*)` | none | n/a → axum R2/R3 |
| `lib/server/redirect-to-workspace.ts` | redirect helper (only used by the 20 stubs) | `redirectToWorkspaceRoute(route, sp)`: active workspace → `/<id><route>?<sp>`, none → `/?<sp>` | `resolveActiveWorkspace()` | `GET /api/workspaces` → `activeId` is the same resolution (Rust) |
| `app/page.tsx` | redirect-only | `searchParams`, cookie, store → `/<active id>?<qs>`, else `/<workspaces[0].id>?<qs>`, else `/welcome` (qs dropped) | `resolveActiveWorkspace()` (`readActiveCookie()`→`cookies()`, `ensureBootstrap()`, `getActiveIdHint()`), `listWorkspaces()` | `GET /api/workspaces` → `{workspaces, activeId}` (Rust `workspaces.rs`) |
| `app/[workspaceId]/layout.tsx` | redirect-only | `params.workspaceId` not in the store → `/` (query dropped); else pass-through | `getWorkspace(id)` | `GET /api/workspaces/{id}` (Rust; 404 `{"error":"not found"}`) |
| `app/welcome/page.tsx` | redirect-only, else static shell | ≥ 1 workspace → `/`; else `<WelcomeSplash />` (client, no props) | `listWorkspaces()` | `GET /api/workspaces` (Rust) |
| `app/customize/[id]/chat/page.tsx` | client page (N03a) | `params.id` not in `customizations/index.json` → `/customize`; else `<ChatSurface kind="customization" id={id} cwd={srcDir} />` | `getCustomization(id)`, `customizationSrcDir(id)` (= `~/.claude/.claudius/customizations/<id>/src`) | Existence: `GET /api/customizations/{id}` (Rust; 404 `{"error":"not found"}`). `srcDir`: on that GET since N03a (Rust `customizations::get_one`) |
| `app/[workspaceId]/git/file/page.tsx` | client page (N03a) | `params.workspaceId`, `searchParams.path`, `searchParams.mode` (`staged`/`worktree`/`untracked`) → `<GitFileWindow>` props | none | n/a (the child already fetches `GET /api/workspaces/{id}/git/status`, Rust) |
| `app/layout.tsx` | static shell | Static `metadata`; `next/font/google` (build time); `next/script` `beforeInteractive` theme bootstrap; client providers and `children` inside `<Suspense fallback={null}>` | none | n/a; export-safe as is |
| `app/{agents,assets,cost,database,docker,files,git,hooks,keybindings,mcp,memory,notebooks,permissions,pipeline,schedule,skills,tracker,workspace}/page.tsx` (18) | redirect-only | `searchParams` → `redirectToWorkspaceRoute("/<name>", sp)`. Reached only when proxy (b) didn't fire (no `wks_`-shaped cookie); exact path only | helper | `GET /api/workspaces` `activeId` (Rust) |
| `app/sessions/[[...rest]]/page.tsx`, `app/dev/[[...rest]]/page.tsx` | redirect-only | `params.rest` + `searchParams` → `redirectToWorkspaceRoute("/<name>/<rest…>", sp)` | helper | same |
| `app/[workspaceId]/agents/page.tsx` | type-only | — | `AgentFile`, `AgentScope` ← `agents` | n/a |
| `app/[workspaceId]/assets/page.tsx` | type-only | — | `AssetRow`, `Scope`, `TypeFilter` ← `asset-list` | n/a |
| `app/[workspaceId]/cost/page.tsx` | type-only | — | `PriceRefreshResult`, `PricingStatus` ← `litellm-pricing` | n/a |
| `app/[workspaceId]/git/page.tsx` | type-only | — | `GitFileChange` ← `git` | n/a |
| `app/[workspaceId]/hooks/page.tsx` | type-only | — | `SettingsScope` ← `settings` | n/a |
| `app/[workspaceId]/keybindings/page.tsx` | type-only | — | `Keybinding`, `KeybindingsFile` ← `keybindings` | n/a |
| `app/[workspaceId]/mcp/page.tsx` | type-only | — | `McpScope`, `McpServerConfig` ← `mcp` | n/a |
| `app/[workspaceId]/schedule/page.tsx` | type-only | — | `Job`, `Run`, `RunStatus` ← `scheduler-store` | n/a |
| `app/[workspaceId]/skills/page.tsx` | type-only | — | `SkillFile`, `SkillScope` ← `skills` | n/a |
| `app/[workspaceId]/workspace/page.tsx` | type-only | — | `Icon` ← `workspaces-store` | n/a |
| `app/customize/page.tsx` | type-only | — | `Customization`, `PublishRecord` ← `customizations-store` | n/a |
| `app/customize/[id]/page.tsx` | type-only | — (but reads `use(params)`, § 2) | `Customization` ← `customizations-store`, `PreviewState` ← `preview-server` | n/a |
| `app/plugins/page.tsx` | type-only | — | `AvailablePlugin` ← `plugins`, `SettingsScope` ← `settings` | n/a |
| `app/settings/page.tsx` | type-only | — | `ClaudeSettings`, `ModelPickerSettings`, `ModelPricingSettings`, `SettingsScope` ← `settings` | n/a |

The 33 client files that need no change for this task (apart from the param readers in § 2):
- `app/[workspaceId]/page.tsx` and `app/[workspaceId]/{database,docker,files,memory,notebooks,permissions,pipeline,sessions,sessions/[id],tracker}/page.tsx`
- `app/[workspaceId]/dev/*/page.tsx` (14) and `dev/_chat-chrome/PreviewChrome.tsx`
- `app/{community,doctor,release-notes,updater,usage}/page.tsx`, `app/customize/settings/page.tsx`, `app/global-error.tsx`

About 45 more files in `components/`, `lib/client/` and `lib/shared/` hold `import type … from "@/lib/server/…"`. They're harmless for the export, but those types have to move to `lib/shared` before `lib/server` is deleted.

## 2. Dynamic segments for `output: "export"`

Export mode rejects any dynamic page without `generateStaticParams()` (`next/dist/build/index.js`). That export can't come from a `"use client"` file, so each segment needs a server layout to host it. Plan: one sentinel param per segment (e.g. `__ws__`); axum maps real ids onto the sentinel's files (N04/N05).

- **`[workspaceId]`** (layout + 36 pages).
  - Today, server side: the layout validates the id and proxy (a) copies it into the cookie.
  - Today, client side: most pages ignore the URL and read the cookie. `useWorkspaces` picks `claudius.workspace` if it's in the list, else `/api/workspaces` `activeId`, else the first workspace; `useActiveCwd` returns that workspace's `rootPath`. So the cookie sync is load-bearing: without it a page shows the cookie's workspace under another workspace's URL.
  - URL readers: before N03a, `useParams()` in `[workspaceId]/page.tsx` (the chat `id`), `[workspaceId]/sessions/page.tsx` (list scope) and `components/chat/SystemPill.tsx` (cost link). Pathname regexes in `SideNav`, `CommandPalette` (`extractWorkspaceId`), `WorkspaceSwitcher`, `workspace-route-memory.ts`, `use-session.ts` (chat-root test) and `useWorkspaces.select()`.
  - Export: `generateStaticParams` → `[{ workspaceId: "__ws__" }]` plus `dynamicParams = false` in the (server) layout; a parent's params cover every child. Serve `__ws__/<rest>` for `/wks_<12 hex>/<rest>` after R3/R4.
- **`[workspaceId]/sessions/[id]`** (client page).
  - Today: `useParams().id` and `useSearchParams().get("dir")`; it fetches `/api/sessions/info/{id}` and `/api/sessions/transcript/{id}`.
  - Export: a new server `sessions/[id]/layout.tsx` with gSP `[{ id: "__sid__" }]`.
- **`customize/[id]`** (client `page`, server `chat/page`).
  - Today: the detail page reads `use(params).id`, fetches `/api/customizations` (finds the id) and `/api/customizations/{id}/preview`, and shows "Customization not found." for an unknown id (no redirect). The chat page: R6 + N03.
  - Export: a new server `customize/[id]/layout.tsx` with gSP `[{ id: "__cust__" }]`; it covers `/chat` too. `customize/settings` is a static sibling and wins.
- **`sessions/[[...rest]]`, `dev/[[...rest]]`** (bare stubs).
  - Today: server-only, reached when there's no `wks_` cookie.
  - Export: delete them. R2 answers before any file lookup, so no gSP. (`/<ws>/dev` alone has no page, so 404.)

Caveats:
1. **Sentinels leak into params.**
   - Next 16 hydrates `useParams()` and page `params` from the prerendered tree (`client/components/app-router.js`: `getSelectedParams(tree)`). It fills params from the URL only for PPR client-resume shells (`client/app-index.js`), which aren't used here.
   - `usePathname()` and `useSearchParams()` come from `location.href` (`router-reducer/create-initial-router-state.js`).
   - So the 5 `useParams` / `use(params)` readers would get `__ws__` / `__sid__` / `__cust__` → N03 row 7.
2. **Every exported HTML is the same empty shell.** `NotificationsProvider → useActiveSessionId → useSearchParams()` sits under the root `<Suspense fallback={null}>`, so the whole body renders client-side and no per-id markup is baked.
3. **Router payload URLs.**
   - In export mode, navigations fetch `<path>.txt`, or `/index.txt` for `/` (`router-reducer/fetch-server-response.js`). Prefetches fetch `<path>/__next.<segments>.txt` (`segment-cache/cache.js`).
   - The sentinel mapping and R1–R6 must cover these.
   - A non-OK answer makes the router do a full document load (`doMpaNavigation`). That's correct, just slower.
4. **Soft navigation between two workspace ids keeps the same `__ws__` segment**, so React reuses the layout/page instead of remounting. Today's switcher does full loads (`useWorkspaces.select` → `window.location.href`); keep it that way.
5. **Leftover server components fail unsafely.** Export forces `dynamic = "error"` (`server/app-render/create-component-tree.js`):
   - `await searchParams` fails the build (`app/page.tsx`, the 20 stubs).
   - `cookies()` throws a bailout that `readActiveCookie()`'s `try/catch` swallows.
   - Plain store reads (`[workspaceId]/layout.tsx`, `welcome`) run once on the build host, and a `redirect()` there is baked into the HTML as `<meta http-equiv="refresh" content="1;url=…">` (`server/app-render/make-get-server-inserted-html.js`). For example, `getWorkspace("__ws__")` would bake `→ /` into every workspace page. Convert them; don't leave them "inert".
6. **Other export blockers, outside this audit:**
   - `proxy.ts` (Proxy is unsupported in export).
   - `app/api/**`: 183 handlers, 78 of them `force-dynamic`, 123 with non-GET methods, 20 dynamic dirs. They must be kept out of the export build.
   - `next.config.ts`'s packaged `output: "standalone"`.
   - The `instrumentation.ts` boot tasks (tracked by G07d/G12).
   - Export-safe already: static `metadata`, `next/font/google`, `next/script` `beforeInteractive`, `app/icon.svg`, `app/apple-icon.png`. There is no `next/image`.

## 3. Conversion plan

### N02 — page rules in axum

Put a `pages` handler in place of `.fallback(proxy::handler)` in `claudius-server/src/lib.rs`. It handles GET/HEAD requests not under `/api/` or `/_next/`, with no `.` in the path (proxy.ts's matcher), plus the payload URLs below. After the rules it calls `proxy::forward` (Next upstream), and from N05 the static files.

Inputs:
- `C`: the `claudius.workspace` cookie as Next parses it, empty = absent (`claudius_server::workspaces::read_active_cookie`).
- `ID`: `^wks_[a-f0-9]{12}$`.
- `S`: `~/.claude/.claudius/workspaces.json`.
- `resolve(C)` = `claudius_core::workspaces::resolve_active(C)`: the entry with id `C`, else the entry with id `S.activeId ?? S.workspaces[0].id`, else none (= `resolveActiveWorkspace`).
- `first` = `path.split("/")[1]`.
- `Q` = the raw query, verbatim.
- `SCOPED`: `agents assets cost database dev docker files git hooks keybindings mcp memory notebooks permissions pipeline schedule sessions skills tracker workspace`. These must equal the dirs under `app/[workspaceId]/`; add a Rust test.
- `STATIC`: `SCOPED` plus `community customize doctor plugins release-notes settings updater usage welcome`.

| # | Request | Output | Replaces |
|---|---|---|---|
| R1 | `/` | `resolve(C)` → 307 `/<id>Q`; else `S.workspaces[0]` → 307 `/<id>Q`; else 307 `/welcome` (Q dropped). Never served from a file. | `app/page.tsx` |
| R2 | `first ∈ SCOPED` | `C ∈ ID` → 307 `/<C><path>Q` (no store check, any depth). Else `resolve(C)` → 307 `/<id><path>Q`: today only for an exact `/<name>` and for `/sessions/**`, `/dev/**`; deeper paths 404 (parity) or redirect too (optional). Else 307 `/Q`, which then hits R1. | proxy (b), 20 stubs, `redirect-to-workspace.ts` |
| R3 | `first ∈ ID` and `C ≠ first` | Add `Set-Cookie: claudius.workspace=<first>; Path=/; Expires=<now + 365 d, UTC>; Max-Age=31536000; SameSite=lax`, the string `workspaces.rs::select` builds, to whatever response follows (R4's 307, a 404, the page). Unlike `POST …/select`, it doesn't delete `claudius.customization` or write the store. | proxy (a) |
| R4 | `first ∉ STATIC` and the rest of the path names a `[workspaceId]` route | `first` not in `S` → 307 `/` (Q dropped; R3's cookie is still sent, and R1 then falls through to the hint, so no loop). Else serve. An unknown sub-route → 404. | `[workspaceId]/layout.tsx` |
| R5 | `/welcome` | `S.workspaces` non-empty → 307 `/` (Q dropped). Else serve. | `welcome/page.tsx` |
| R6 | `/customize/<id>/chat` | `claudius_core::customizations::get_customization(id)` is none → 307 `/customize` (Q dropped). Else serve. `/customize/<id>` itself never redirects. | `customize/[id]/chat/page.tsx` |

A store read error is a 500 in every rule; the TS throws there too.

- **Status.**
  - Proxy (b) is a real HTTP 307 today. The `redirect()`s are under the root `<Suspense>`, and Next only sends a 307 + `Location` when a redirect escapes the HTML shell (`server/app-render/app-render.js`, errorRecovery).
  - So on document loads they most likely arrive as 200 + meta refresh (1 s) + a client-side replace. On router fetches they come back as flight redirects.
  - Answer a plain 307 everywhere; no test pins the page status.
- **Router payload requests.**
  - The same rules, R3 included, apply to `RSC: 1` requests while Next is upstream.
  - Keep `_rsc` in the `Location` even when a rule drops the rest of `Q`. Next 16 checks it by default (`experimental.validateRSCRequestHeaders: true`), and a missing value costs an extra 307 (`server/base-server.js`).
  - From N04, evaluate `<p>.txt`, `/index.txt` and `<p>/__next.*.txt` on `<p>` and re-append the suffix: `/index.txt?session=X` → `/<id>.txt?session=X`, `/sessions.txt` → `/<id>/sessions.txt`. The router adopts the redirected URL (`res.redirected`).
  - About 29 call sites push or link bare paths (`ChatSurface` ×15: `/?session=`, `/sessions`, `/mcp`, …; `sessions/[id]` ×5; `sessions` ×2; one each in `SessionPicker`, `ShortcutsSection`, `CostOverlay`, `SessionCostTable`, `LoopsBreakdown`, `FileDetail` and `useDeepLinks`), and about 10 `href="/"` / `push("/")`. Each becomes a full reload if the payload rules are skipped.
- **Trailing slash.** Next's built-in 308 (`/x/` → `/x`) runs before `proxy.ts`. axum must do it once Next is gone (N05).
- **Optional deviation (needs the user's OK; not parity).** Check `C` against `S` in R2. Today a stale `wks_` cookie on `/git` ends at `/<hint>` and loses `/git`.
- **Callers that rely on R1:** Electron's start URL `/` (`electron/main.ts` `resolveStartUrl`), the 136 e2e specs that `goto("/")`, and `activateClaudiusWorkspace` (cookie set by `POST …/select`).
- **Delete once every entry point goes through Rust** (`bun run dev`, e2e, Electron; running both until then is harmless). Until T03, Next must keep working without Rust in front (the user, 2026-11-22), so N03 turned these into client-side equivalents rather than deleting them (N03a, N03b):
  - `proxy.ts` and the 20 stubs (now `<BareRouteRedirect />`, `components/nav/WorkspaceRedirects.tsx`). `lib/server/redirect-to-workspace.ts` is gone (N03b): nothing used it any more.
  - The client redirects in `app/page.tsx` (delete the file), `[workspaceId]/layout.tsx` (keep the file as a pass-through for N04's gSP), `welcome/page.tsx` and `customize/[id]/chat/page.tsx`.
  - Change the "bare redirect stub" recipe in `scripts/implement-workflow.mjs` and `scripts/implement-workflow-2.mjs` to "add the name to `SCOPED`". Today it says to add a `<BareRouteRedirect />` stub plus the name in both `SCOPED` lists (`proxy.ts`, `pages.rs`).
  - `lib/server/active-workspace.ts` stays while API routes use it.
- **Tests.**
  - Rust HTTP tests per rule: zero workspaces, a stale cookie, a stale `activeId`, a malformed cookie, `Q` kept or dropped, the exact `Set-Cookie` text, `_rsc` kept, and the `.txt` forms.
  - e2e: `workspace-route-memory`, `workspace-cwd-binding`, `cc-parity-2.1.193-recent-denials` (bare `/permissions`), `community-nav` (`/` → `/<active id>`), `customizations-drawer`, `customization-description`, `tests/electron/web-parity-workspace-created-elsewhere-appears`.
  - Gaps: no spec covers R1's `/welcome` branch, R5 or R6 (`global-setup.ts` seeds `workspaces.json`). Add them.

### N03 — replace server reads with client fetches

| # | Component | Replace with |
|---|---|---|
| 1 | `customize/[id]/chat/page.tsx` | **Done (N03a, 2026-11-22).** A `"use client"` page:<br>• `id` comes from `usePathname()`.<br>• `GET /api/customizations/{id}` → 404 → `router.replace("/customize")`, which mirrors R6 for soft navigations.<br>• `cwd` comes from the new `srcDir` (§ 1).<br>• Mount `ChatSurface` only once `srcDir` is known: the mount-time boot effect in `use-session.ts` reads `defaultCwdRef` after an async open-tabs lookup, so a late or `null` cwd races into the cookie's context.<br>Don't use bootstrap JSON: soft navigations (`router.push` in `customize/[id]/page.tsx` and `CustomizationsDrawer`) fetch the payload, not the HTML. |
| 2 | `welcome/page.tsx` | **Done (N03b, 2026-11-23).** A static shell, `<WelcomeGate><WelcomeSplash /></WelcomeGate>`. The gate reads `GET /api/workspaces` once and goes to `/` if a workspace exists, else shows the splash (R5 behind Rust). Nothing renders until then, so the splash never flashes. |
| 3 | `[workspaceId]/layout.tsx` | **Done (N03b).** A server component that reads nothing, rendering `<WorkspaceIdGuard>` (N04 adds gSP here). The guard renders an id found in the shared `useWorkspaces` list at once (no extra request). An id missing from it is checked with `GET /api/workspaces/<id>`; only a 404 → `router.replace("/")` (R4 behind Rust). It renders nothing until then, so a stale id mounts no chat (and starts no session). |
| 4 | `app/page.tsx` | **Done (N03b).** Kept as the client fallback, `<RootRedirect />`: `GET /api/workspaces` → `activeId ?? workspaces[0]?.id` → `router.replace("/<id>" + query + hash)`, else `/welcome`. Delete it (R1) once Next no longer runs without Rust in front. |
| 5 | `[workspaceId]/git/file/page.tsx` | **Done (N03a, 2026-11-22).** `"use client"`. Read `path` and `mode` from `useSearchParams()` and the workspace id from `usePathname()`. The data is already fetched client-side (`useGitStatus`). |
| 6 | The 20 bare stubs | **Done (N03b).** Each renders `<BareRouteRedirect />`: `GET /api/workspaces` → `activeId` → `/<id><path><query><hash>`, else `/` + query (R2 behind Rust). Delete them (R2) with `proxy.ts`. |
| 7 | `useParams()` / `use(params)` readers: `[workspaceId]/page.tsx`, `[workspaceId]/sessions/page.tsx`, `[workspaceId]/sessions/[id]/page.tsx`, `customize/[id]/page.tsx`, `components/chat/SystemPill.tsx` | **Done (N03a, 2026-11-22).** Parse `usePathname()` instead; `CommandPalette.extractWorkspaceId` and `CustomizationBanner`'s `customizeIdFromUrl` already do this. Not a data fetch, but it must land before N04's sentinels (§ 2, caveat 1). |

Only row 1 needs a new API (`srcDir`, added to `GET /api/customizations/{id}` on both backends in N03a). Verify N03 with the N02 e2e list plus the new `/customize/<id>/chat` spec. N03b added `workspace-redirects.spec.ts`, covering rows 2, 3, 4 and 6 on both backends. A zero-workspace install is still uncovered, because global-setup seeds `workspaces.json` and the Rust rules read that file.
