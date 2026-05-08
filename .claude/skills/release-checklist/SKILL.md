---
name: release-checklist
description: Walk through the pre-release checklist for Claudius — version bump, changelog, screenshots, build smoke, tag and push. Use whenever the user says "let's cut a release" or "ship it" without further specifics.
allowed-tools:
  - Read
  - Edit
  - Bash
  - Grep
---

# Release checklist

The same boring list, every time. Don't skip steps just because the diff is small.

## 1. Sync the version

- Bump `package.json#version` (semver: patch for fixes, minor for features, major for breaking).
- Update `CHANGELOG.md`. Group entries under **Added / Changed / Fixed / Removed**, newest first. One line per change, link to the MR.

## 2. Verify the build

```bash
npm run lint
npm run build
npm run test:e2e   # full suite, must be green
```

If `test:e2e` flakes on agent-driven specs, retry once. A flake-then-pass is acceptable; two flakes in a row is a regression.

## 3. Refresh marketing screenshots

Only if surfaces visible on the landing page changed:

```bash
make screenshots          # cheap shots only
make screenshots-full     # includes chat states (uses real API, costs cents)
```

Diff `site/screenshots/*.png`. Kept changes only — don't commit cosmetic drift.

## 4. Tag and push

```bash
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

Wait for GitLab CI to go green. The `pages` job redeploys the marketing site automatically — verify <https://filipegarcia.gitlab.io/claudius/> serves the new version's setup script.

## 5. Smoke the install

Fresh shell, fresh dir:

```bash
curl -fsSL https://filipegarcia.gitlab.io/claudius/setup.sh | bash -s -- --prefix=/tmp/claudius-smoke
cd /tmp/claudius-smoke && npm run dev
```

Open <http://localhost:3000>, send one prompt, confirm the response renders. Then `rm -rf /tmp/claudius-smoke`.

## What to do if step N fails

- **Step 2 (build/test):** stop. Fix and re-run from step 2. Don't tag a broken commit.
- **Step 4 (CI):** if the pages job times out, re-trigger from the GitLab UI. If it fails twice with the same error, dig — don't keep retrying.
- **Step 5 (smoke):** the released version is broken. Open a hotfix branch, bump patch, repeat from step 1.
