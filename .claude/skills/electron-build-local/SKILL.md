---
name: electron-build-local
description: Build a locally-installable Claudius.app (or DMG) on the dev machine. Handles the x64/arm64 mismatch that silently produces a broken bundle when `make electron-app` is run on Apple Silicon. Use whenever the user asks to build, package, rebuild, or DMG-up the desktop app locally — anything that isn't "push a tag and let CI release."
allowed-tools:
  - Read
  - Edit
  - Bash
---

# Building Claudius locally

## The trap

`electron-builder.yml` pins `mac.target.arch` to `[x64]`. The release CI cross-builds x64 on an arm64 runner — locally on Apple Silicon, that same config produces a **broken chimera**:

- Electron binary: x86_64 (per the config, runs under Rosetta)
- `better_sqlite3.node`: arm64 (the rebuild script targets host arch — no `--arch` flag)
- `@anthropic-ai/claude-agent-sdk-darwin-x64` CLI: missing (npm only installed the host's `-arm64` optional dep)

The app boots, the renderer loads, then every API call that touches SQLite throws `ERR_DLOPEN_FAILED` and every new-session attempt fails with "Native CLI binary for darwin-x64 not found." Symptom the user sees: app opens, **sessions don't list, new tab can't be created, app feels slow** (Rosetta + thrown-error retry storms).

This skill exists because a prior session ran `make electron-app` blindly and shipped exactly that broken bundle.

## When to use this skill

Trigger on any of: "build the app", "build Claudius", "build a local DMG", "package the electron app", "rebuild the desktop app", "make electron-app", "make me a local build". Also use it when the user reports a freshly built app misbehaving — verify they didn't fall into the trap before assuming a real bug.

**Do NOT use this skill** when the user wants a signed/notarized build for distribution. That requires CI signing creds and cross-build plumbing that don't exist locally — push a tag and let `release.yml` handle it (`git tag vX.Y.Z && git push origin vX.Y.Z`).

## The recipe

### Step 1: Detect host arch

```bash
uname -m
```

- `arm64` → Apple Silicon → **need the swap** (continue to step 2)
- `x86_64` → Intel Mac → **no swap needed** (jump to step 3, the existing config already matches host)

### Step 2: Temporarily swap to arm64 (Apple Silicon only)

Edit `electron-builder.yml`. Find:

```yaml
  target:
    - target: zip
      arch: [x64]
  icon: build/icons/icon.icns
```

Change `[x64]` → `[arm64]`. **Do not commit this** — the release pipeline still needs x64.

If the user has other uncommitted changes to `electron-builder.yml` (e.g. an in-flight `extendInfo` block), use `Edit` with enough surrounding context so only the arch line flips. Keep their other diffs intact.

### Step 3: Build

For an unpacked launchable `.app` (fastest, ~5–8 min):

```bash
rm -rf release/mac release/mac-arm64 2>/dev/null
bun run electron:app
```

For a DMG you can install + uninstall like a real app (~1 min slower):

```bash
rm -rf release/mac release/mac-arm64 2>/dev/null
bun run electron:dist:mac
```

Both flow through `electron:build` first, which:
1. `electron:rebuild-native` — `@electron/rebuild --force` for the host's Electron ABI; verifies by loading `better-sqlite3` in real Electron.
2. `next build` — production Next.js standalone.
3. `electron-stage-standalone.mjs` — copies standalone into the package tree.
4. `electron:compile` — `tsc` for `electron/`.

Then `electron-builder -m` packages it. The DMG variant additionally runs `scripts/make-dmg.mjs` (create-dmg → branded DMG).

### Step 4: Revert the yaml edit

Flip `[arm64]` back to `[x64]`. **Always do this** before declaring the task done — otherwise a stray commit ships the wrong arch to release CI. Verify with:

```bash
git diff electron-builder.yml
```

The diff should show only the user's pre-existing changes (if any), not the arch swap.

### Step 5: Verify the bundle is internally consistent

Pick the right output path — `release/mac-arm64/Claudius.app` on Apple Silicon, `release/mac/Claudius.app` on Intel.

```bash
APP="release/mac-arm64/Claudius.app"   # or release/mac on Intel
HOST_ARCH=$(uname -m)
lipo -archs "$APP/Contents/MacOS/Claudius"
lipo -archs "$(find "$APP" -name better_sqlite3.node | head -1)"
find "$APP/Contents/Resources" -path "*claude-agent-sdk-darwin-*" -name claude | head -3
```

All three must match host arch (`arm64` on Apple Silicon, `x86_64` on Intel). If they don't, the swap step was skipped or didn't apply — go back to step 2.

### Step 6: Hand off to the user

```bash
open "$APP"
```

For a DMG variant, point them at `release/Claudius-<version>-mac-arm64.dmg` (or `-x64.dmg` on Intel).

Tell them explicitly:
- **Unsigned + unnotarized** — Gatekeeper will warn on first open. Right-click → Open, or `xattr -d com.apple.quarantine <path>`.
- **arm64-only**, not for distribution. The signed x64 DMG comes from CI.
- **Includes whatever was uncommitted at build time** — that's usually the point, but call it out so the user knows what they're testing.

## What to do if a step fails

- **Rebuild fails with `NODE_MODULE_VERSION` mismatch**: the verify caught a real ABI bug. Don't paper over it — the prebuilt for this Electron version is missing or wrong. Check `node_modules/electron/package.json` version vs. `package.json#devDependencies.electron`.
- **`next build` fails on type errors in `lib/server/*`**: server-only code leaked into a client component or a route changed shape. Fix at the source — don't `// @ts-expect-error` it through.
- **`electron-builder` fails with "code signing"**: macOS asked for the keychain. `CSC_IDENTITY_AUTO_DISCOVERY=false` should already be set in `electron:app`. If you switched to `electron:dist:mac`, you may need it too.
- **App boots, sessions still don't load**: run it from a terminal so stderr is visible — `"$APP/Contents/MacOS/Claudius" 2>&1 | tee /tmp/claudius.log` — and grep for `ERR_DLOPEN_FAILED` / `darwin-` to confirm whether arch or something else is at fault.

## Why we don't just fix the rebuild script to cross-build

Because cross-building x64 native modules and SDK CLIs from arm64 is non-trivial (the rebuild script needs `--arch=x64` plumbing, the SDK's optional-dep CLI tarball needs to be fetched the way commit `5b493bb` does for swc, etc.). The release CI runs on arm64 and already does this — re-implementing the same plumbing locally just to avoid the yaml swap is more code than the swap costs. Revisit if local x64 builds become a daily need.
