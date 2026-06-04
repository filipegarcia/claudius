/**
 * Embedded-server smoke test for Phase 1 of
 * docs/electron-conversion/PLAN.md.
 *
 * Boots `startEmbeddedNextServer` exactly the same way Electron does,
 * fetches `/api/heartbeat`, and exits 0 / 1 based on whether the
 * server responded with a 200. The whole script runs in Node, no
 * display server required, so CI can call it to catch the class of
 * runtime bugs that `tsc --noEmit` misses (wrong `defaultAppDir`,
 * missing standalone `server.js`, port collision).
 *
 * Prerequisites:
 *   - `bun run build` with output:'standalone' → produces
 *     `.next/standalone/server.js`
 *   - `bun run electron:compile` → produces `dist-electron/smoke.js`
 *
 * Then:
 *   `node dist-electron/smoke.js`
 *
 * Times out after 30s so a hung server can never wedge the loop.
 */
import fs from "node:fs";
import path from "node:path";

import { defaultAppDir, startEmbeddedNextServer } from "./server";

const TIMEOUT_MS = 30_000;
const HEARTBEAT_PATH = "/api/heartbeat";

async function main(): Promise<void> {
  const appDir = process.env.CLAUDIUS_SMOKE_APP_DIR ?? defaultAppDir();
  // Sanity-check the resolved path so a typo in `defaultAppDir` fails
  // here instead of inside the child-spawn with a less actionable error.
  // The standalone tree must contain `server.js` (the entry we spawn)
  // and its own `.next/` (the trimmed build output the entry reads).
  const serverJs = path.join(appDir, "server.js");
  const nextDir = path.join(appDir, ".next");
  console.log(`[smoke] appDir=${appDir}`);
  console.log(`[smoke] expected server.js=${serverJs}`);
  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `server.js not found at ${serverJs} — run \`bun run build\` first`,
    );
  }
  if (!fs.existsSync(nextDir)) {
    throw new Error(
      `.next not found at ${nextDir} — standalone tree is incomplete`,
    );
  }

  const startedAt = Date.now();
  const server = await startEmbeddedNextServer(appDir);
  console.log(`[smoke] embedded server up at ${server.url} (${Date.now() - startedAt}ms)`);

  // Race the heartbeat fetch against a hard timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(server.url + HEARTBEAT_PATH, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`[smoke] heartbeat returned ${res.status} ${res.statusText}`);
      throw new Error(`unexpected status ${res.status}`);
    }

    const body = (await res.json()) as { status?: string };
    if (body.status !== "ok") {
      console.error(`[smoke] heartbeat body unexpected: ${JSON.stringify(body)}`);
      throw new Error("heartbeat body did not include status: ok");
    }

    console.log(`[smoke] OK — ${HEARTBEAT_PATH} 200 in ${Date.now() - startedAt}ms total`);
  } finally {
    clearTimeout(timer);
    try {
      await server.close();
      console.log("[smoke] server closed");
    } catch (err) {
      console.error("[smoke] failed to close server:", err);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke] FAILED:", err);
    process.exit(1);
  });
