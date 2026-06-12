import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// When Claudius is packaged inside Electron (electron-builder sets
// CLAUDIUS_PACKAGED=1 on the `electron:build` script), emit a
// standalone server tree so the main process can require Next from
// inside the .asar without dragging the entire node_modules along.
// Default web builds stay unchanged.
const packaged = process.env.CLAUDIUS_PACKAGED === "1";

// Claudius "release" counter — the per-release ordinal for the current SDK
// version: the highest `.N` among the `v<version>.N` release tags (one tag is
// minted per push to main by auto-tag.yml), see scripts/claudius-release.mjs.
// Computed once at build / dev-server start and baked into the bundle as
// NEXT_PUBLIC_CLAUDIUS_RELEASE; the UI joins it with `version` to render the
// version tag, e.g. v0.3.152.7 (lib/shared/version.ts). An SDK bump changes
// `version` (no `v<new-sdk>.*` tags yet), which resets this to 0 with no
// stored state. Falls back to "0" when git/tags aren't available so the build
// never fails over a cosmetic tag.
//
// Precedence (env-var first):
//   1. If NEXT_PUBLIC_CLAUDIUS_RELEASE is already set in the build env, use
//      it verbatim. This is the path .github/workflows/release.yml takes
//      when triggered by auto-tag.yml — it passes the tag's `.N` component
//      as a workflow input, so the in-app footer of the SHIPPED binary
//      matches the GitHub release tag exactly. Without this, release.yml's
//      shallow `actions/checkout@v5` would starve the script (no release
//      tags fetched → max is none → returns 0) and produce v<version>.0
//      in-app for every .N>0 release — the exact mismatch this whole
//      machinery was built to prevent.
//   2. Otherwise, run the tag-reading script (dev server, local
//      production builds, anywhere with the release tags fetched).
//   3. Script failure (no .git, no `node`, etc.) → "0".
//
// Empty-string env var (e.g. `NEXT_PUBLIC_CLAUDIUS_RELEASE=` from a workflow
// that conditionally sets it) is treated as unset — `||` falls through.
const claudiusRelease =
  process.env.NEXT_PUBLIC_CLAUDIUS_RELEASE ||
  (() => {
    try {
      return (
        execFileSync("node", [join(process.cwd(), "scripts/claudius-release.mjs")], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim() || "0"
      );
    } catch {
      return "0";
    }
  })();

const nextConfig: NextConfig = {
  // Allow the e2e Playwright server to opt into its own dist dir
  // (`.next-e2e/`) so it can run alongside the user's own `next dev`
  // against the same project root without tripping the exclusive
  // lockfile under `<project>/.next/dev/lock`. Next 16 dropped the CLI
  // `--dist-dir` flag for `next dev`, so the only way to override is
  // here. Default stays `.next` for every other invocation.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Next 16 blocks cross-origin requests to dev-only assets and endpoints
  // (HMR socket, SSE streams under /api/*) unless the requesting origin is
  // explicitly allow-listed. Localhost works out of the box, but the moment
  // the user opens the dev URL from another device on the LAN (laptop ↔
  // phone, or two machines on the same Wi-Fi) every dev resource gets
  // silently dropped — the page shell loads but the API/SSE traffic that
  // drives the Activity rail and chat stream never makes it through, so
  // the UI hangs on "Starting…". The patterns below cover the RFC1918
  // private ranges (the only addresses a LAN device would ever have here),
  // so `bun run dev` is reachable from any device on the same Wi-Fi.
  // Production builds are unaffected — `allowedDevOrigins` is dev-only.
  allowedDevOrigins: [
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  // The dev-only on-screen indicator (Next.js logo badge) defaults to
  // bottom-left, where it collides with the "claudius / vX.Y.Z" footer at
  // the bottom of the workspace rail. Park it bottom-right instead. Dev
  // only — it never renders in a production build.
  devIndicators: {
    position: "bottom-right",
  },
  // Standalone output for Electron — Next traces every required file
  // and copies them under `.next/standalone/`, which the Electron build
  // ships verbatim as an extraResource.
  ...(packaged ? { output: "standalone" as const } : {}),
  // Dynamic `fs`/`path` operations in some route handlers make Next's
  // file tracer conservatively pull the ENTIRE project root into the
  // standalone output (it warns: "the whole project was traced
  // unintentionally"). Left unchecked that copies `chat-server/` (which
  // imports `bun:sqlite` and breaks the production type-check), the
  // `release/` output dir (recursive nesting → multi-GB bundles), test
  // fixtures, docs, and worktrees into the shipped app. None of these are
  // runtime dependencies, so prune them from the trace for every route.
  // Keys are route globs (picomatch); values are globs resolved from the
  // project root. See next.config docs `outputFileTracingExcludes`.
  outputFileTracingExcludes: {
    "**": [
      "./release/**/*",
      "./chat-server/**/*",
      "./.claude/**/*",
      "./tests/**/*",
      "./site/**/*",
      "./docs/**/*",
      "./playwright-report/**/*",
      "./test-results/**/*",
      "./.next-e2e/**/*",
      "./.next-buildtest/**/*",
    ],
  },
  env: {
    // Default community chat-server URL. Baked into the client bundle
    // at build time so a fresh `bun run build` ships a working
    // /community page out of the box — no extra env setup required for
    // anyone running Claudius against the canonical community.
    //
    // Override by setting NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL in
    // `.env.local` (dev) or your deployment env (prod). Setting it to
    // an empty string disables /community (renders the "not configured"
    // empty state) — useful for forks that don't want a community.
    NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL:
      process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ??
      "https://chat.claudius.network",
    // See `claudiusRelease` above — surfaced to the client bundle for the
    // version tag in the workspace-rail footer.
    NEXT_PUBLIC_CLAUDIUS_RELEASE: claudiusRelease,
  },
};

export default nextConfig;
