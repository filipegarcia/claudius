/**
 * Claudius version string, surfaced in the UI (workspace-rail footer).
 *
 * The scheme tracks the Claude Agent SDK: `package.json`'s `version` field
 * mirrors the installed `@anthropic-ai/claude-agent-sdk` version (kept in
 * sync by `scripts/sdk-update/orchestrate.ts`), and a trailing `.N` counter
 * is a PER-RELEASE ordinal — `N` is bumped once per release (one push to
 * `main` → one `v<version>.N` tag via `.github/workflows/auto-tag.yml`), NOT
 * once per commit. A push that lands 8 commits is still a single release and
 * bumps `N` by one. Feature branches don't inflate the number; they show
 * whatever the latest release is for the SDK version in their working tree.
 *
 *   SDK 0.3.152, first release of it        → 0.3.152.0
 *   next push to main on the same SDK       → 0.3.152.1
 *   SDK bumps to 0.3.153                    → 0.3.153.0   (reset is automatic)
 *
 * The counter has no stored state: `scripts/claudius-release.mjs` derives it
 * from the release tags (`N` = highest existing `v<version>.N`) at build /
 * dev-server start, and it's baked into the bundle as
 * `NEXT_PUBLIC_CLAUDIUS_RELEASE` via `next.config.ts`. An SDK bump resets the
 * trailing component to .0 automatically — a freshly-bumped version has no
 * `v<new-sdk>.*` tags yet.
 *
 * Why split the SDK part from the counter rather than putting four
 * components in `version`: electron-builder + macOS notarization cap bundle
 * versions at three integers, so `version` stays valid 3-part semver and the
 * 4th component is joined only for display here.
 *
 * Counter falls back to `0` when git history isn't available (no `.git`,
 * shallow clone, or a non-Next runtime like a unit test) — the tag degrades
 * to `v<sdk>.0` rather than crashing.
 */
import pkg from "@/package.json";

const sdkVersion: string = pkg.version;
// `process.env.NEXT_PUBLIC_*` is replaced inline at build time, so this
// resolves in both server and client bundles. `next.config.ts` always sets
// it (defaulting to "0" if the git probe fails), but we double-default here
// for non-Next runtimes (e.g. vitest) where the var is genuinely unset.
const release: string = process.env.NEXT_PUBLIC_CLAUDIUS_RELEASE ?? "0";

/** Bare numeric version, e.g. `"0.3.152.0"`. */
export const CLAUDIUS_VERSION = `${sdkVersion}.${release}`;

/** Display form with the leading `v`, e.g. `"v0.3.152.0"`. */
export const CLAUDIUS_VERSION_DISPLAY = `v${CLAUDIUS_VERSION}`;
