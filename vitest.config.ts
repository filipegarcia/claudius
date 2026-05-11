import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest config for the Node-side unit/integration suite.
 *
 * We deliberately do NOT run Playwright specs here — `tests/e2e/**` belongs to
 * `bun run test:e2e`. Vitest covers the cheap layers: pure logic, SQLite
 * round-trips, and the in-process notification bus.
 *
 * `bun test` was the first pick (zero deps, matches the rest of the
 * toolchain) but `better-sqlite3` doesn't load under bun yet
 * (oven-sh/bun#4290). Vitest on node is the workable alternative.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig `@/*` path so source imports keep working under
      // vitest. We resolve to the repo root (where this config lives).
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // Explicit so nobody flips us to jsdom for a stray DOM-touching test —
    // the unit suite is server-side only. UI work belongs in Playwright.
    environment: "node",
    // Each test file gets a clean module graph, which matters for the
    // notification-bus singleton on globalThis — without this, two files
    // sharing the same worker would see each other's bus state.
    isolate: true,
  },
});
