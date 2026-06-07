# claudius — marketing site

Static `index.html` + assets published to GitHub Pages from `.github/workflows/`'s
`pages` job (every push to `main`). No build step.

Live: <https://claudius.network/>

## Adding content

See **[AGENTS.md](./AGENTS.md)** for the full checklist (new section, new
screenshot, new install flag, new external link) and the tests that guard
each one.

## Tests

Two specs guard the site before `pages` deploys; both run in the `test`
stage, so a failure stops the deploy automatically.

| File | Runner | Covers |
| --- | --- | --- |
| `tests/unit/site-static.test.ts` | vitest | Anchors resolve, screenshots exist, ids unique, `index.html` ↔ `setup.sh` URLs/repo match |
| `tests/e2e/site-marketing.spec.ts` | Playwright | Page renders, lightbox opens, install-copy button toggles, anchors update the URL hash |
| `site/test/test-in-docker.sh` | Docker | `setup.sh` writes the right shell-rc lines and is idempotent across bash/zsh/fish — run via `make test-setup-docker` (not on CI) |

Run them:

```bash
bunx vitest run tests/unit/site-static.test.ts
CLAUDIUS_E2E_PORT=3000 bunx playwright test tests/e2e/site-marketing.spec.ts --project=chromium
make test-setup-docker  # optional, needs Docker
```
