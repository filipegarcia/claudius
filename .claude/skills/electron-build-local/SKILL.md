---
name: electron-build-local
description: Build a locally-installable Claudius.app (or DMG) on the dev machine. Handles the x64/arm64 mismatch that silently produces a broken bundle when `make electron-app` is run on Apple Silicon. Use whenever the user asks to build, package, rebuild, or DMG-up the desktop app locally — anything that isn't "push a tag and let CI release."
allowed-tools:
  - Read
  - Edit
  - Bash
---

# Building Claudius locally

## The traps (three of them, all bite silently)

### Trap 1 — host/target arch mismatch

`electron-builder.yml` declares `mac.target.arch`. If it doesn't match the host architecture you're building on, you get a **broken chimera**:

- Electron container: target arch (runs under Rosetta if it doesn't match)
- `better_sqlite3.node`: host arch (the rebuild script targets host — no `--arch` flag)
- `@anthropic-ai/claude-agent-sdk-darwin-<target>` CLI: missing (npm only installed the host's optional dep)

Symptom: app opens, renderer loads, then every SQLite-touching API throws `ERR_DLOPEN_FAILED` and every new-session attempt fails with "Native CLI binary for darwin-`<target>` not found." User sees sessions not listing, new tab failing, app feels slow (Rosetta + retry storms).

Current YAML state: `mac.target.arch: [arm64]` for zip + dmg. So on Apple Silicon, no swap needed. On Intel Mac, you'd need to swap to `[x64]`. **Always run Step 1 to confirm.**

### Trap 2 — `electron:rebuild-native` kills the running dev server

The rebuild script swaps `node_modules/better-sqlite3/.../better_sqlite3.node` from Node ABI 127 to Electron ABI 146 **in place**. If a `bun run dev` is on :3000 with the old module already loaded in memory, the next hot-reload that touches SQLite throws `ERR_DLOPEN_FAILED` and the dev server starts returning 500s.

The script refuses to run when it sees a listener on :3000. There's an env-var bypass (`CLAUDIUS_REBUILD_IGNORE_DEV=1`) but **don't use it in the main repo** — the safety check is right. Use the isolated-build recipe below instead.

This matters especially when a user is talking to Claudius through that exact dev server. Killing :3000 kills the page hosting the conversation. The build-in-place path is the wrong default for an agent.

### Trap 3 — `ELECTRON_RUN_AS_NODE` poisons CLI flag parsing

When you launch the built `.app` from a shell that has `ELECTRON_RUN_AS_NODE=1` exported, the binary runs as plain Node (not Electron) and rejects every Chromium switch with `bad option: --enable-logging` / `bad option: --user-data-dir`. **No window opens.**

This bites whenever the agent runs `Claudius.app/Contents/MacOS/Claudius` from a Bash tool whose process tree includes Claudius's embedded server (the embedded server sets this var so it can use the Electron binary as a Node runtime — perfectly correct for ITS use, but inherited by child shells). Always `env -u ELECTRON_RUN_AS_NODE` when launching the freshly built app for verification.

## When to use this skill

Trigger on any of: "build the app", "build Claudius", "build a local DMG", "package the electron app", "rebuild the desktop app", "make electron-app", "make me a local build". Also use it when the user reports a freshly built app misbehaving — verify they didn't fall into a trap before assuming a real bug.

**Do NOT use this skill** when the user wants a signed/notarized build for distribution. That requires CI signing creds that don't exist locally — push a tag and let `release.yml` handle it (`git tag vX.Y.Z && git push origin vX.Y.Z`).

## Default to the isolated recipe

When the user is talking to Claudius via a running `bun run dev` (or the desktop app is running and they're using it), the in-place build at the bottom of this file will kill their session.

**Use the isolated recipe below unless the user explicitly says "build in-place, I've stopped the dev server."** It costs ~1.2 GB of disk and ~10 seconds of rsync, and it's a strict superset of safety with no downside to verification quality.

## Isolated recipe (recommended default)

### Step 1 — rsync the working tree to a sibling dir

```bash
BUILD_DIR=/Users/$(whoami)/Projects/claudius-build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a \
  --exclude='/.next/' \
  --exclude='/.next-e2e/' \
  --exclude='/dist-electron/' \
  --exclude='/release/' \
  --exclude='/.claude/worktrees/' \
  --exclude='/test-results/' \
  --exclude='/playwright-report/' \
  --exclude='/blob-report/' \
  --exclude='/playwright/.cache/' \
  /Users/$(whoami)/Projects/claudius/ "$BUILD_DIR/"
```

**Critical**: every exclude is **anchored with a leading `/`**. An unanchored `--exclude='release/'` matches `node_modules/bluebird/js/release/` (and every other nested `release/` dir under node_modules) and silently corrupts the dep graph — electron-builder then dies with `Cannot find module 'bluebird/js/release/promise'` halfway through the build.

The rsync copies `node_modules/` verbatim. Don't try to skip it and `bun install` in the build dir — the install is slower than the rsync (3-5 min vs 15 sec) and the result is identical.

### Step 2 — build with the dev-server safety bypass

```bash
cd "$BUILD_DIR"
CLAUDIUS_REBUILD_IGNORE_DEV=1 bun run electron:app
```

The `CLAUDIUS_REBUILD_IGNORE_DEV=1` is **safe here** because the build dir's `node_modules/better-sqlite3` is independent of the main repo's — swapping ABI in the build dir doesn't touch what the dev server has dlopen'd. The override exists precisely for this case.

Output lands at `$BUILD_DIR/release/mac-arm64/Claudius.app` (or `mac/` on Intel — same arch-derived dir).

### Step 3 — launch isolated so it doesn't trample running state

```bash
APP="$BUILD_DIR/release/mac-arm64/Claudius.app"   # or mac/ on Intel
HOME_ISO=$(mktemp -d -t claudius-iso-home)
USERDATA_ISO=$(mktemp -d -t claudius-iso-userdata)
env -u ELECTRON_RUN_AS_NODE HOME="$HOME_ISO" NEXT_TELEMETRY_DISABLED=1 \
  nohup "$APP/Contents/MacOS/Claudius" --user-data-dir="$USERDATA_ISO" \
  > /tmp/claudius-iso.log 2>&1 &
```

Three things matter here, all non-obvious:

1. **`env -u ELECTRON_RUN_AS_NODE`** — see Trap 3 above. Without this, the binary runs as Node and rejects `--user-data-dir` with "bad option," no window appears, and the user sees nothing.
2. **`--user-data-dir=<temp>`** — `electron/main.ts` checks `process.argv` for this switch and skips its own `app.setPath("userData", …)`, so the isolated dir actually takes effect. Also: Electron's single-instance lock lives **inside userData**, so a separate `userData` lets the new instance coexist with whatever Claudius the user already had open.
3. **`HOME=<temp>`** — full sandbox: no `~/.claude/`, no accounts, no DB. Treat it as a faithful "fresh user, first launch" environment.

### Step 4 — verify and hand off

```bash
sleep 5
ps -p <launched-pid> -o command=          # confirm it's still alive
head /tmp/claudius-iso.log                # confirm embedded server bound
ls "$USERDATA_ISO" | head -3              # blob_storage / Cache / Cookies appearing means Electron is writing
```

Tell the user:
- The isolated window is **PID `<pid>`**; their main Claudius is unaffected and remains at the same PID.
- Profile is **clean** — no workspaces, no auth. To test a workspace pre-flight or session creation they'll need to add a workspace pointing at a real folder.
- Logs: `/tmp/claudius-iso.log` (tail it if anything looks off).
- Cleanup later: quit via Cmd+Q (or `kill <pid>`), then `rm -rf "$HOME_ISO" "$USERDATA_ISO" "$BUILD_DIR"`.

### Bundle-consistency verify (same as in-place)

```bash
APP="$BUILD_DIR/release/mac-arm64/Claudius.app"
lipo -archs "$APP/Contents/MacOS/Claudius"
lipo -archs "$(find "$APP" -name better_sqlite3.node | head -1)"
file "$(find "$APP/Contents/Resources" -path "*claude-agent-sdk-darwin-*" -name claude | head -1)"
```

All three must read the host arch (`arm64` on Apple Silicon, `x86_64` on Intel). A mismatch means Trap 1 — see the in-place recipe's Step 2 to swap the yaml.

## In-place recipe (fallback only)

Use this **only** when the user has explicitly stopped their dev server AND has no concurrently-running Claudius they care about. Otherwise prefer the isolated recipe above.

### Step 1: Detect host arch and compare to YAML

```bash
uname -m                                                # host arch
grep -nE "arch: \[" electron-builder.yml | head -4      # YAML's targets
```

The current YAML default is `arch: [arm64]` for both zip + dmg. Cross-reference:

- Host `arm64`, YAML `[arm64]` → **no swap needed** (jump to Step 3).
- Host `x86_64`, YAML `[arm64]` → **swap to `[x64]`** (Step 2).
- Anything else → swap to whatever matches the host.

### Step 2: Temporarily swap mac arch (only if host ≠ YAML)

Edit `electron-builder.yml`. Find the `mac.target` block:

```yaml
  target:
    - target: zip
      arch: [arm64]
    - target: dmg
      arch: [arm64]
  icon: build/icons/icon.icns
```

Flip both `arch:` lines to match host arch (`[x64]` on Intel, `[arm64]` on Apple Silicon).

**Do not commit this swap.** Revert before declaring the task done (Step 4 below). The release pipeline runs split per-arch jobs that don't need the swap; a stray committed flip would change which arch CI ships.

If the user has other uncommitted changes to `electron-builder.yml`, use `Edit` with enough surrounding context so only the arch lines flip. Keep their other diffs intact.

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

### Step 4: Revert the yaml edit (if Step 2 ran)

If you flipped the arch in Step 2, flip it back to the YAML's committed value now. **Always do this** before declaring the task done — otherwise a stray commit ships the wrong arch to release CI. Verify with:

```bash
git diff electron-builder.yml
```

The diff should show only the user's pre-existing changes (if any), not the arch swap. If you skipped Step 2 (host already matched YAML), there's nothing to revert.

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
- **App boots, sessions still don't load**: run it from a terminal so stderr is visible — `env -u ELECTRON_RUN_AS_NODE "$APP/Contents/MacOS/Claudius" 2>&1 | tee /tmp/claudius.log` — and grep for `ERR_DLOPEN_FAILED` / `darwin-` to confirm whether arch or something else is at fault. (Always `env -u ELECTRON_RUN_AS_NODE` — see Trap 3.)
- **Isolated build dies with `Cannot find module 'bluebird/js/release/promise'` (or similar nested-dir module-not-found)**: your rsync excludes weren't anchored. `--exclude='release/'` matches `node_modules/<pkg>/js/release/` and silently corrupts the dep graph. Re-rsync with leading-slash anchored excludes (`--exclude='/release/'`), or just blow away `$BUILD_DIR/node_modules` and re-rsync that one tree with no excludes at all.
- **Launched binary prints `bad option: --user-data-dir` / `bad option: --enable-logging` and exits**: `ELECTRON_RUN_AS_NODE=1` is exported in the launching shell — Trap 3. Re-launch with `env -u ELECTRON_RUN_AS_NODE …`. Verify with `echo $ELECTRON_RUN_AS_NODE` before relaunch.
- **`open -n -a Claudius.app` silently no-ops** (no second window appears, ps shows only the original PID): macOS LaunchServices folded the launch into the existing instance because the bundle id matched and `userData` defaulted to the same dir. Use direct `Contents/MacOS/Claudius` exec with `--user-data-dir=<temp>` instead; that bypasses LaunchServices and gives Electron a separate single-instance lock dir.
- **Build dir already exists with stale node_modules from a previous run**: blow it away (`rm -rf "$BUILD_DIR"`) and re-rsync. Trying to repair in place with `bun install --frozen-lockfile` is a trap — bun's content-addressed cache sees `node_modules/<pkg>` already present and reports "no changes," but the actual file tree is missing whatever the broken rsync dropped.

## Why we don't just fix the rebuild script to cross-build

Cross-building from arm64 → x64 (or vice versa) locally is non-trivial — the rebuild script needs `--arch=<target>` plumbing, the SDK's optional-dep CLI tarball needs to be fetched the way commit `5b493bb` does for swc, etc. The release CI does this in a dedicated cross-compile job (`macos-x64` in `.github/workflows/release.yml`); re-implementing the same plumbing locally just to avoid the yaml swap is more code than the swap costs.

Revisit if local cross-arch builds become a daily need.

## Why we default to a separate build dir instead of `git worktree`

A worktree shares the main repo's `.git` but has its own working tree. That solves the file-isolation half cleanly. But it doesn't share `node_modules` — you'd have to run a full `bun install` (~3–5 min) before the build can start. The rsync recipe trades that for a 15-second working-tree-plus-node_modules copy: faster overall, simpler to reason about (it's just files), and any "stale install" risk doesn't matter for a one-shot verification build.

If the build dir grows stale across many edits, `rm -rf "$BUILD_DIR"` and re-rsync. Don't try to update it incrementally — bun's cache assumptions about its own `node_modules/.bun/` layout mean a partial re-sync silently corrupts the dep graph (the same trap as Trap 1 in "What to do if a step fails").
