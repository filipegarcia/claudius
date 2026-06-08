/**
 * Lock the wire shape of `?client=…` sent to the community chat-server.
 * The chat-server treats unknown query params as advisory, so the
 * format is the contract — operators read it in logs to distinguish
 * web vs packaged installs by platform + Claudius build version.
 *
 * We re-import the module fresh under each environment so the
 * `isElectron` branch (which reads `window`/`process`) reflects the
 * stubbed globals. `vi.resetModules()` between cases prevents stale
 * resolution across tests.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { CLAUDIUS_VERSION } from "@/lib/shared/version";

type WindowWithClaudius = Window & {
  claudius?: { isElectron: boolean; platform: string };
};

const origWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (origWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = origWindow;
});

async function loadModule() {
  return await import("@/lib/shared/community-client");
}

describe("community-client identifier", () => {
  beforeEach(() => {
    vi.resetModules();
    // Drop the CLAUDIUS_ELECTRON env flag so the node-realm branch in
    // isElectron() resolves to the web answer unless a test sets it.
    vi.stubEnv("CLAUDIUS_ELECTRON", "");
  });

  test("web build (no window.claudius, no env flag) reports claudius/web", async () => {
    delete (globalThis as { window?: unknown }).window;
    const { getCommunityClient } = await loadModule();
    expect(getCommunityClient()).toBe(`claudius/web:${CLAUDIUS_VERSION}`);
  });

  test("electron renderer on darwin reports electron-mac", async () => {
    (globalThis as { window?: WindowWithClaudius }).window = {
      claudius: { isElectron: true, platform: "darwin" },
    } as WindowWithClaudius;
    const { getCommunityClient } = await loadModule();
    expect(getCommunityClient()).toBe(
      `claudius/electron-mac:${CLAUDIUS_VERSION}`,
    );
  });

  test("electron renderer on win32 reports electron-windows", async () => {
    (globalThis as { window?: WindowWithClaudius }).window = {
      claudius: { isElectron: true, platform: "win32" },
    } as WindowWithClaudius;
    const { getCommunityClient } = await loadModule();
    expect(getCommunityClient()).toBe(
      `claudius/electron-windows:${CLAUDIUS_VERSION}`,
    );
  });

  test("electron renderer on linux reports electron-linux", async () => {
    (globalThis as { window?: WindowWithClaudius }).window = {
      claudius: { isElectron: true, platform: "linux" },
    } as WindowWithClaudius;
    const { getCommunityClient } = await loadModule();
    expect(getCommunityClient()).toBe(
      `claudius/electron-linux:${CLAUDIUS_VERSION}`,
    );
  });

  test("unmapped electron platform falls back to the raw label", async () => {
    (globalThis as { window?: WindowWithClaudius }).window = {
      claudius: { isElectron: true, platform: "freebsd" },
    } as WindowWithClaudius;
    const { getCommunityClient } = await loadModule();
    expect(getCommunityClient()).toBe(
      `claudius/electron-freebsd:${CLAUDIUS_VERSION}`,
    );
  });
});

describe("withCommunityClientParam URL helper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CLAUDIUS_ELECTRON", "");
    delete (globalThis as { window?: unknown }).window;
  });

  test("appends with ? when the URL has no query string", async () => {
    const { withCommunityClientParam } = await loadModule();
    const out = withCommunityClientParam("https://chat.example.com/rooms");
    expect(out).toBe(
      `https://chat.example.com/rooms?client=${encodeURIComponent(`claudius/web:${CLAUDIUS_VERSION}`)}`,
    );
  });

  test("appends with & when the URL already has a query string", async () => {
    const { withCommunityClientParam } = await loadModule();
    const out = withCommunityClientParam(
      "https://chat.example.com/rooms/x/stream?nick=alice",
    );
    expect(out).toBe(
      `https://chat.example.com/rooms/x/stream?nick=alice&client=${encodeURIComponent(`claudius/web:${CLAUDIUS_VERSION}`)}`,
    );
  });

  test("identifier value is URL-percent-encoded so '/' and ':' survive", async () => {
    const { withCommunityClientParam } = await loadModule();
    const out = withCommunityClientParam("https://chat.example.com/x");
    // Decoding the value brings the original product token back —
    // confirms we don't ship a raw `/` that intermediaries might rewrite.
    const value = new URL(out).searchParams.get("client");
    expect(value).toBe(`claudius/web:${CLAUDIUS_VERSION}`);
  });
});
