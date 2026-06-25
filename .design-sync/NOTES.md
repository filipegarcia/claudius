# design-sync notes — Claudius

Claudius is a **Next.js application**, not a published component library. There
is no `dist/`, no shipped `.d.ts`, no Storybook. The converter therefore runs in
**synth-entry mode** (content-scan of `components/` for PascalCase exports).

## How the build is wired (repo-specific)

- **Synth entry via a non-existent `--entry`.** Run from the repo root:
  ```
  node .ds-sync/package-build.mjs --config .design-sync/config.json \
    --node-modules ./node_modules --entry ./.ds-synth-entry.mjs --out ./ds-bundle
  ```
  `./.ds-synth-entry.mjs` is intentionally absent — that forces `PKG_DIR` to the
  repo root (so `srcDir: components` resolves) **and** triggers synth-entry mode
  (so all components are content-scanned). Do not create that file.
- **`tsconfig.dssync.json`** duplicates the `@/*` alias inline (esbuild's paths
  plugin does not follow `extends`) and stubs `shiki` → `.design-sync/shiki-stub.ts`
  to keep `_ds_bundle.js` under the 5 MB upload cap. Code is not syntax-highlighted
  in the design tool as a result (structure/layout/tokens are unaffected).
- **`source-kit.mjs` is forked** (`.design-sync/overrides/`, declared in
  `cfg.libOverrides`) to inject a browser `process` shim as the first import of
  the synth entry. Claudius components pull in `next/link` + `next/navigation`,
  whose bundled framework code reads `process.env.__NEXT_*` / `process.platform`
  at eval/render — without the shim **every** preview throws
  "process is not defined" and renders blank. The fork needs
  `.design-sync/node_modules -> ../.ds-sync/node_modules` (symlink, gitignored,
  recreate on fresh clone) so its bare `ts-morph` import resolves.
- **Component name collisions (`SYNTH_ENTRY_DROP` in the fork).** The synth entry
  does `export *` per src file, and ES `export *` exposes one symbol per NAME, so
  two files exporting the same component name collide into `undefined` on
  `window.Claudius` (the newer converter's `[BUNDLE_EXPORT]` check catches this;
  older converters shipped it silently). Claudius has exactly one such pair:
  `components/chat/MessageList.tsx` (canonical) and
  `components/community/MessageList.tsx`. The fork's `SYNTH_ENTRY_DROP` list drops
  the community file from the synth entry so the chat impl survives on the global
  (CommunityChat still bundles its own `./MessageList` internally — nothing lost).
  `componentSrcMap` is deliberately NOT used for this: in synth mode the full
  142-component list comes from a `deriveComponentsFromSrc` fallback that only
  fires when the name set is empty, so any `componentSrcMap` entry collapses the
  list to just that one entry. **Re-check `SYNTH_ENTRY_DROP` if `components/`
  grows a new same-name pair** (a fresh `[BUNDLE_EXPORT]` is the signal).
- **Grid overflow → `cardMode: column`.** `LoadingBar` and `CollapsibleSection`
  render wider than a grid cell; `cfg.overrides.<Name> = {cardMode: column}` lays
  each story full-width, one per row. Validate emits `[GRID_OVERFLOW]` if removed.

## Styling

- **`compiled.css`** is Tailwind v4 compiled from `app/globals.css`, scanning the
  repo. Regenerate with:
  ```
  node .ds-sync/node_modules/.bin/tailwindcss -i app/globals.css -o .design-sync/compiled.css
  ```
  Install the v4 CLI into `.ds-sync` first: `(cd .ds-sync && npm i @tailwindcss/cli)`.
  **After regenerating, append the dark-surface override** — Claudius is dark-first
  (`:root` tokens default to the dark palette → light text), but the converter's
  card HTML links `styles.css` then a later inline `<style>` hardcoding a LIGHT
  chrome (`body{background:#fff}`, `.ds-cell{border:#e5e7eb}`). Without the
  override, token-driven components render light-on-white. The override is now a
  **committed, durable file** — `.design-sync/preview-surface.css` (was lost twice
  when it lived only inside the gitignored compiled.css). Re-append it every regen:
  ```
  printf '\n/* === design-sync: appended preview-surface override === */\n' >> .design-sync/compiled.css
  cat .design-sync/preview-surface.css >> .design-sync/compiled.css
  ```
  It is scoped to `.ds-cell` / `.ds-single` (preview-card-only selectors, `!important`
  to beat the inline `<style>`) so it CANNOT leak into shipped designs — which is
  why there is no bare `body{}` rule and the card page itself stays white.

## Known render warns / floor cards

- **96 of 142 components are on the typographic floor card** — the honest
  baseline. These are app-feature components (message views, overlays, settings,
  git/files panels) coupled to SQLite / the SSE session stream / the App Router;
  they render without live data, so an authored preview adds little without
  hand-built fixtures. Authorable incrementally on any re-sync.
- **8 authored, graded good:** CodeBlock, CollapsibleSection, SystemPill,
  Markdown, BranchSwitcher, LoadingBar, SpinnerTip, RewindFilesButton.
- **RewindFilesButton** idle is a hover-only affordance (`opacity-0
  group-hover:opacity-100`); its preview injects `.ds-rewind button{opacity:1}`
  to show the idle button statically.
- **`ScheduledLoopsIcon` → `[RENDER_THIN]`** (mounts paint nothing): it's an
  unauthored leaf icon with no size/color context. Accepted as a known warn, not
  a failure — author a preview only if it's wanted in grading.
- **`.d.ts` props are `[key: string]: unknown`** for every component — synth mode
  can't extract real prop types without a build. The design agent gets a weak
  contract; the real signatures live in the component source `Props` types.

## Fonts

- `--font-geist-sans` / `--font-geist-mono` are injected by `next/font` at
  runtime; no `@font-face` ships, so cards fall back to the system sans/mono
  stack (defined in the `body`/`code` rules). To ship Geist, add it via
  `cfg.extraFonts`.

## Re-sync risks

- This whole pipeline is **off the converter's happy path** (no dist). A Next.js
  upgrade can change which `process.env.__NEXT_*` / framework globals the bundle
  references — if previews start throwing again, widen the `source-kit` shim.
- `compiled.css` is **regenerated by hand** (see Styling) and is gitignored. The
  dark-surface override is now durable (`preview-surface.css`, committed), but a
  recompile that forgets to re-append it still drops it and every card goes
  light-on-white — the two-step regen is mandatory.
- **First real upload happened 2026-06-25** into project
  `5e843efd-cc64-4f7f-b4f7-098f0028f1c8` (588 files: 142 components, 8 authored
  graded good, 96 floor cards). The prior session built locally but had no
  claude.ai/design auth. Re-syncs from here are anchored by the uploaded
  `_ds_sync.json` (fetch it to `.design-sync/.cache/remote-sync.json`).
- **Shared-worktree hazard.** This repo is dogfooded with several concurrent
  Claudius agent sessions in the SAME working dir. A mid-run `git checkout` to
  another branch by a sibling agent wiped this run's gitignored build artifacts
  (`ds-bundle/`, `.ds-sync/`, `.design-sync/compiled.css`) and removed the
  committed `.design-sync/` tree (only on `main`). Fix: run design-sync in an
  **isolated `git worktree` off `main`** (detached at main's tip), not the primary
  tree. The 2026-06-25 upload was done from such a worktree.
