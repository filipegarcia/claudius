import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Importing the base config also runs its top-level setup: it creates (or
// reuses) the isolated CLAUDIUS_E2E_HOME tempdir and writes it back into
// process.env, so both servers below and global-setup/teardown share it.
import base from "./playwright.config";

/**
 * Parity run: the unchanged e2e suite against the **Rust backend**.
 *
 *   browser ─► claudius (Rust, :RUST_PORT) ─┬─► ported /api routes (Rust)
 *                                           └─► everything else ─► next dev (:NEXT_PORT)
 *
 * `bun run test:e2e:rust [-- <spec…>]` builds the Rust binary first, then
 * runs this config. Results are tracked in rust/parity/e2e-status.md.
 *
 * Differences from playwright.config.ts, all deliberate:
 *   - two web servers instead of one; specs talk to the Rust port
 *   - headless by default even outside CI (it's a batch parity run; pass
 *     --headed to watch)
 *   - CLAUDIUS_UPDATER_DISABLED=1 on the Next server, so its updater can never
 *     touch the working tree mid-run
 *   - CLAUDIUS_RUST_SCHEDULER=1 on the Next server: the Rust binary runs the
 *     scheduled jobs (it does by default), so Next must not run them too
 *   - CLAUDE_CONFIG_DIR pinned to the e2e HOME on both servers. A value
 *     inherited from a parent Claude session would otherwise send every
 *     transcript (and the SDK's session listing) to the real ~/.claude.
 *     `test:e2e:rust` also strips the rest of that env (rust/scripts/clean-env.sh).
 *
 * Shares `.next-e2e` with the normal e2e run, so don't run both at once.
 */
const RUST_PORT = Number(process.env.CLAUDIUS_E2E_RUST_PORT ?? 3179);
const NEXT_PORT = Number(process.env.CLAUDIUS_E2E_NEXT_PORT ?? 3178);
const E2E_HOME = process.env.CLAUDIUS_E2E_HOME!;
const E2E_CLAUDE_CONFIG_DIR = join(E2E_HOME, ".claude");
const RUST_BIN = process.env.CLAUDIUS_RS_BIN ?? "rust/target/debug/claudius";

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: `http://localhost:${RUST_PORT}`, headless: true },
  projects: (base.projects ?? []).filter((p) => p.name === "chromium"),
  webServer: [
    {
      command: `next dev -p ${NEXT_PORT}`,
      url: `http://localhost:${NEXT_PORT}`,
      reuseExistingServer: false,
      // A cold Turbopack compile of `/` can take minutes on a loaded machine
      // (e.g. a parallel cargo build), and the 120 s default times the run out
      // before the first spec runs.
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NEXT_DIST_DIR: ".next-e2e",
        HOME: E2E_HOME,
        CLAUDE_CONFIG_DIR: E2E_CLAUDE_CONFIG_DIR,
        NEXT_TELEMETRY_DISABLED: "1",
        CLAUDIUS_UPDATER_DISABLED: "1",
        CLAUDIUS_RUST_SCHEDULER: "1",
        NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL:
          process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "http://localhost:8787",
      },
    },
    {
      command: `${RUST_BIN} --port ${RUST_PORT} --next http://127.0.0.1:${NEXT_PORT}`,
      url: `http://localhost:${RUST_PORT}/api/rust/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // Same isolated home as Next: Claudius state and the CLI's config both
        // live there, exactly like the TS backend in the normal e2e run.
        HOME: E2E_HOME,
        CLAUDE_CONFIG_DIR: E2E_CLAUDE_CONFIG_DIR,
        CLAUDIUS_UPDATER_DISABLED: "1",
        // The suite drives the dev-only `dev-*` routes, which the normal run
        // gets from `next dev`. Force them on so CLAUDIUS_RS_BIN can point at
        // a release build, and an inherited NODE_ENV=production can't turn
        // them off.
        CLAUDIUS_DEV: "1",
        // Rust serves /api/community/* (D24) and reads this at request time,
        // where Next inlines it at build. Without it the Rust server would
        // report the config default rather than the suite's chat server.
        NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL:
          process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "http://localhost:8787",
        RUST_LOG: process.env.RUST_LOG ?? "claudius=info,claudius_core=info",
      },
    },
  ],
});
