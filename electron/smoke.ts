/**
 * Embedded-server smoke test for Phase 1 of
 * docs/electron-conversion/PLAN.md.
 *
 * Boots `startEmbeddedNextServer` exactly the same way Electron does,
 * fetches `/api/heartbeat`, and exits 0 / 1 based on whether the
 * server responded with a 200. The whole script runs in Node, no
 * display server required, so CI can call it to catch the class of
 * runtime bugs that `tsc --noEmit` misses (e.g. wrong `defaultAppDir`,
 * unresolved `require("next")`, port collision, missing `.next/`).
 *
 * Prerequisites:
 *   - `bun run build`           → produces `.next/`
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

/**
 * Next 16 + Turbopack skips `prerender-manifest.json` in the regular
 * production build (it only appears in dev and inside the standalone
 * bundle). The embedded server's `app.prepare()` still requires the
 * file to exist. We write a minimal stub when missing so the smoke
 * works against any successful `next build`.
 */
function ensurePrerenderManifest(appDir: string): void {
  const dest = path.join(appDir, ".next", "prerender-manifest.json");
  if (fs.existsSync(dest)) return;
  // Try the dev copy first; fall back to a hard-coded minimal stub.
  const devCopy = path.join(appDir, ".next", "dev", "prerender-manifest.json");
  if (fs.existsSync(devCopy)) {
    fs.copyFileSync(devCopy, dest);
    console.log(`[smoke] seeded prerender-manifest.json from .next/dev/`);
    return;
  }
  const stub = {
    version: 4,
    routes: {},
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: {
      previewModeId: "smoke-stub",
      previewModeSigningKey: "smoke-stub",
      previewModeEncryptionKey: "smoke-stub",
    },
  };
  fs.writeFileSync(dest, JSON.stringify(stub));
  console.log(`[smoke] wrote prerender-manifest.json stub`);
}

async function main(): Promise<void> {
  const appDir = process.env.CLAUDIUS_SMOKE_APP_DIR ?? defaultAppDir();
  // Sanity-check the resolved path so a typo in `defaultAppDir` fails
  // here instead of inside Next with a less actionable error.
  const nextDir = path.join(appDir, ".next");
  console.log(`[smoke] appDir=${appDir}`);
  console.log(`[smoke] expected .next dir=${nextDir}`);
  if (!fs.existsSync(nextDir)) {
    throw new Error(`.next not found at ${nextDir} — run \`bun run build\` first`);
  }
  ensurePrerenderManifest(appDir);

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
