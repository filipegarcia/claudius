# site/

The marketing surface. A single static `index.html` plus assets, published
to GitHub Pages from the `pages` job on every push to `main`. Plain
Tailwind via CDN, vanilla JS for the lightbox + copy button — no build
step.

## Layout

```
site/
├── index.html           # the one page — hero, install, features, desktop, gallery, customize, meta, footer
├── claudius.svg         # logo (referenced in hero + footer + favicon)
├── icon.svg             # browser favicon
├── apple-icon.png       # iOS home-screen icon
├── setup.sh             # the curl-pipe-to-bash installer
├── screenshots/         # PNGs the gallery and customize section reference (+ a _placeholder.svg fallback)
└── test/                # Docker rig that exercises setup.sh on bash/zsh/fish (see test/test-in-docker.sh)
```

## What the test suite enforces

Two specs guard the site. Both run before the `pages` deploy via the
`test → deploy` stage ordering in `.github/workflows/`.

1. **`tests/unit/site-static.test.ts`** — vitest, runs in the `unit` job.
   - Every `id` is unique.
   - Every required section is present: `top`, `install`, `features`,
     `gallery`, `customize`, `meta`, `legal`.
   - Every `href="#…"` resolves to an existing `id`.
   - Every local asset reference (`src="screenshots/x.png"`,
     `href="./setup.sh"`, `src="claudius.svg"`, …) resolves to a file on
     disk.
   - Every `screenshots/*.png` reference points at a non-zero-byte file.
   - The `screenshots/_placeholder.svg` fallback exists (the gallery's
     `onerror` handlers depend on it).
   - The install one-liner in `<code id="install-cmd">` matches the URL
     baked into `setup.sh`'s own usage docs.
   - The repo URL the site advertises matches `DEFAULT_REPO` in
     `setup.sh`.

2. **`tests/e2e/site-marketing.spec.ts`** — Playwright, runs in the `e2e`
   job, loaded via `file://` so no HTTP server is needed.
   - Page loads with no fatal console errors (Tailwind Play's "don't use
     in production" warning is filtered).
   - All advertised sections are visible after first paint.
   - The `#install-copy` button changes label on click (`Copied` or, when
     `navigator.clipboard.writeText` is unavailable in the test browser,
     `Press ⌘/Ctrl-C` from the fallback path).
   - Clicking a gallery `figure.shot` opens the `<dialog id="lightbox">`,
     populates `#lightbox-img`, and closes on `Esc`.
   - Each top-nav link updates the URL hash to its target id.

3. **`site/test/test-in-docker.sh`** — in-container assertions for
   `setup.sh`. Runs via `make test-setup-docker` locally and as the
   `setup-script` job on GitHub Actions (`.github/workflows/ci.yml`),
   which provisions an `ubuntu:24.04` runner with bash/zsh/fish and
   executes this same script.

## Adding things

### A new section

1. Add `<section id="newthing">…</section>` to `index.html`.
2. Add a `<a href="#newthing">…</a>` link in the top nav (header → nav).
3. Add `"newthing"` to the `REQUIRED` list in
   `tests/unit/site-static.test.ts` if it should be a permanent fixture
   (i.e. you'd want CI to scream if someone removed it). Skip this for
   experimental sections.
4. Add the label to the `navTargets` array in
   `tests/e2e/site-marketing.spec.ts` so anchor navigation gets exercised.
5. Verify locally: `bunx vitest run tests/unit/site-static.test.ts`.

### A new screenshot

1. Capture it. The easy path: add a snapshot block to
   `tests/e2e/site-screenshots.spec.ts` and run
   `make screenshots` (cheap routes) or `make screenshots-full` (chat
   surfaces, needs `ANTHROPIC_API_KEY`). The PNG lands in
   `site/screenshots/`.
2. Reference it from `index.html` inside a `<figure class="shot">` —
   copy an existing entry to get the lightbox plumbing for free
   (`role="button" tabindex="0"`, `onerror` fallback to
   `_placeholder.svg`, the figcaption shape).
3. The static test will fail until step 1 produces a non-zero-byte file
   at the path you referenced — that's the guard.
4. Commit the PNG; the repo intentionally ships screenshots so the Pages
   build doesn't need a browser.

### A new install option / setup.sh flag

1. Edit `setup.sh` (add the flag, document it in the header comment).
2. Update `index.html`'s "Customize the install" pre/code block so the
   advertised flags match.
3. If you're moving `DEFAULT_REPO` or the canonical hosted URL, the
   static test will catch the drift between `setup.sh` and `index.html`
   automatically. Update both in the same commit.
4. Run `make test-setup-docker` locally to exercise the script across
   bash/zsh/fish.

### A new external link

1. Add the `<a href="https://…">` wherever it belongs.
2. The static test ignores externals on purpose — verifying them needs
   the network and adds flake. If the link is load-bearing for the user
   journey (e.g. the "Repo" link), add a Playwright assertion in
   `site-marketing.spec.ts` that verifies the anchor's `href` attribute
   matches the expected URL.

## Running the tests locally

```bash
# Fast structural check (≈150 ms):
bunx vitest run tests/unit/site-static.test.ts

# Runtime smoke in a real browser (≈4 s; uses file://, no dev server
# needed but Playwright will spin one up incidentally — set
# CLAUDIUS_E2E_PORT=3000 to reuse a running one):
CLAUDIUS_E2E_PORT=3000 bunx playwright test tests/e2e/site-marketing.spec.ts --project=chromium

# setup.sh shell-rc + idempotency checks (≈30 s, needs Docker):
make test-setup-docker
```

## Deploy flow

```
push to main
   └─ test stage   (lint, unit, e2e, sast, secret-detection)
         └─ deploy stage
              └─ pages   (bundles site/ as-is — no build step)
                    └─ https://filipegarcia.github.io/claudius/
```

If any `test`-stage job fails the `pages` job doesn't run, so the live
site stays on the last green commit. That's the test → deploy gate; no
extra `needs:` wiring is required.
