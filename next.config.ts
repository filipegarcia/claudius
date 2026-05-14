import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the e2e Playwright server to opt into its own dist dir
  // (`.next-e2e/`) so it can run alongside the user's own `next dev`
  // against the same project root without tripping the exclusive
  // lockfile under `<project>/.next/dev/lock`. Next 16 dropped the CLI
  // `--dist-dir` flag for `next dev`, so the only way to override is
  // here. Default stays `.next` for every other invocation.
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
  },
};

export default nextConfig;
