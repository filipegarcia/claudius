/**
 * Preload ↔ main parity for the updater IPC surface.
 *
 * `electron/preload.ts` hardcodes its own copy of both the channel names and
 * the `ClaudiusUpdaterStatus` union (it can't import from `lib/shared` — the
 * preload bundle is built standalone under contextIsolation). That duplication
 * drifts silently: a mistyped channel makes the button a no-op, and a status
 * variant missing from the preload copy type-errors the renderer for a state
 * the main process really does emit.
 *
 * Both files are read as source text so this runs under plain Node with no
 * Electron and no bundler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");
const preload = readFileSync(join(ROOT, "electron", "preload.ts"), "utf8");
const main = readFileSync(join(ROOT, "electron", "ipc", "updater.ts"), "utf8");
const shared = readFileSync(join(ROOT, "lib", "shared", "electron.d.ts"), "utf8");

/** `kind: "foo"` variants inside the ClaudiusUpdaterStatus union in a file. */
function statusKinds(src: string, marker: string): Set<string> {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  // The union ends at the first line that closes it (`;` for the type alias,
  // `) => void` for the preload callback signature).
  const rest = src.slice(start);
  const end = rest.search(/\n\s*(?:\) => void|;)\s*\n/);
  const block = rest.slice(0, end === -1 ? undefined : end);
  return new Set([...block.matchAll(/kind:\s*"([a-z-]+)"/g)].map((m) => m[1]));
}

describe("updater IPC channel parity", () => {
  test("every updater channel the preload sends on is registered in main", () => {
    const preloadChannels = [...preload.matchAll(/"(updater:[a-z-]+)"/g)].map((m) => m[1]);
    expect(preloadChannels.length).toBeGreaterThan(0);
    for (const channel of new Set(preloadChannels)) {
      expect(main, `main never declares ${channel}`).toContain(`"${channel}"`);
    }
  });

  test("the consent-gated download channel exists on both sides", () => {
    // Regression guard: downloads are user-initiated, so this channel is the
    // only thing standing between "update available" and a stalled UI.
    expect(preload).toContain('updaterDownload: "updater:download"');
    expect(main).toContain('const TOPIC_DOWNLOAD = "updater:download"');
    expect(preload).toContain("download: () => ipcRenderer.send(TOPICS.updaterDownload)");
  });
});

describe("updater status union parity", () => {
  const sharedKinds = statusKinds(shared, "export type ClaudiusUpdaterStatus =");
  const mainKinds = statusKinds(main, "type Status =");
  const preloadKinds = statusKinds(preload, "status:\n");

  test("shared type and main-process type agree", () => {
    expect([...mainKinds].sort()).toEqual([...sharedKinds].sort());
  });

  test("preload's inline copy covers every status main can emit", () => {
    const missing = [...mainKinds].filter((k) => !preloadKinds.has(k));
    expect(missing, `preload union is missing: ${missing.join(", ")}`).toEqual([]);
  });

  test("the stepped-progress states are present", () => {
    // The update modal renders Download → Install → Restart off these three.
    for (const kind of ["downloading", "installing", "downloaded"]) {
      expect(sharedKinds).toContain(kind);
      expect(mainKinds).toContain(kind);
      expect(preloadKinds).toContain(kind);
    }
  });
});
