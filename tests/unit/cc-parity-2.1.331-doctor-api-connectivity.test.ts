import { describe, expect, test, vi } from "vitest";
import {
  apiConnectivitySkipReason,
  runApiConnectivity,
  type ConnectivityProbe,
} from "@/lib/server/api-connectivity";

/**
 * CC 2.1.331 — "Added an API connectivity section to `claude doctor` that
 * reports whether the API can be reached, with the HTTP status or the error,
 * or says why it wasn't tested".
 *
 * Claudius's /doctor never sent a request, so a proxy, firewall or a wrong
 * ANTHROPIC_BASE_URL still showed all green. The section ports the engine's
 * test and lines; the probe is injected so no request leaves the machine.
 */

const NO_POLICY = { managedSettingsDidNotLoad: false };
const SETTINGS_LINE =
  "ANTHROPIC_BASE_URL: not set · NODE_EXTRA_CA_CERTS: not set · CLAUDE_CODE_CLIENT_CERT: not set";
const HINT =
  "A proxy, firewall, VPN or security software between this machine and the host can cause these results. See https://code.claude.com/docs/en/network-config";

/** A clock that advances `step` ms per read. */
function clock(step: number) {
  let t = 1000;
  return () => (t += step) - step;
}

function answering(status: number, seen?: string[]): ConnectivityProbe {
  return async (url) => {
    seen?.push(url);
    return { status };
  };
}

function failing(err: unknown): ConnectivityProbe {
  return async () => {
    throw err;
  };
}

describe("why it isn't tested", () => {
  test("the engine's reasons, in its order", () => {
    expect(apiConnectivitySkipReason({ CLAUDE_CODE_USE_BEDROCK: "1" }, NO_POLICY)).toBe(
      "Not tested: this session uses a cloud provider or a gateway, or your settings name a gateway, not the Anthropic API",
    );
    expect(apiConnectivitySkipReason({ CLAUDE_CODE_USE_VERTEX: "true" }, NO_POLICY)).toMatch(/cloud provider/);
    expect(apiConnectivitySkipReason({ CLAUDE_CODE_USE_FOUNDRY: "1" }, NO_POLICY)).toMatch(/cloud provider/);
    expect(apiConnectivitySkipReason({}, { managedSettingsDidNotLoad: true })).toBe(
      "Not tested: a managed settings source did not load, so Claude Code sends no test request",
    );
    expect(apiConnectivitySkipReason({ ANTHROPIC_UNIX_SOCKET: "/tmp/a.sock" }, NO_POLICY)).toBe(
      "Not tested: API requests go through ANTHROPIC_UNIX_SOCKET, which this test does not use",
    );
    expect(apiConnectivitySkipReason({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, NO_POLICY)).toBe(
      "Not tested: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set",
    );
  });

  test("a proxy Node's fetch wouldn't use is named, unless NODE_USE_ENV_PROXY=1", () => {
    expect(apiConnectivitySkipReason({ HTTPS_PROXY: "http://proxy:8080" }, NO_POLICY)).toBe(
      "Not tested: API requests go through HTTPS_PROXY, which this test does not use",
    );
    expect(apiConnectivitySkipReason({ http_proxy: "http://proxy:8080" }, NO_POLICY)).toMatch(/through http_proxy/);
    expect(apiConnectivitySkipReason({ HTTPS_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1" }, NO_POLICY)).toBeNull();
    expect(apiConnectivitySkipReason({}, NO_POLICY)).toBeNull();
  });

  test("a skipped test sends nothing and passes", async () => {
    const seen: string[] = [];
    const r = await runApiConnectivity({ ANTHROPIC_UNIX_SOCKET: "/s" }, { probe: answering(200, seen), ...NO_POLICY });
    expect(r).toEqual({
      tested: false,
      passed: true,
      lines: ["Not tested: API requests go through ANTHROPIC_UNIX_SOCKET, which this test does not use"],
    });
    expect(seen).toEqual([]);
  });
});

describe("GET /api/doctor/connectivity", () => {
  test("probes the env's base URL with fetch and returns the report", async () => {
    const saved = { base: process.env.ANTHROPIC_BASE_URL, home: process.env.HOME };
    const keys = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_UNIX_SOCKET",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
    const savedSkips = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.test";
    process.env.HOME = "/nonexistent-claudius-home";
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response("not found", { status: 404 });
    });
    try {
      const { GET } = await import("@/app/api/doctor/connectivity/route");
      const body = (await (await GET()).json()) as { tested: boolean; passed: boolean; lines: string[] };
      expect(seen).toEqual(["https://gateway.example.test/api/hello"]);
      expect(body.tested).toBe(true);
      expect(body.passed).toBe(true);
      expect(body.lines[0]).toMatch(/^API \(custom host\): answered HTTP 404 in \d+ ms$/);
    } finally {
      vi.unstubAllGlobals();
      for (const [k, v] of Object.entries({ ANTHROPIC_BASE_URL: saved.base, HOME: saved.home, ...savedSkips })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("the test", () => {
  test("GET /api/hello on the default host; 200 passes", async () => {
    const seen: string[] = [];
    const r = await runApiConnectivity({}, { probe: answering(200, seen), now: clock(84), ...NO_POLICY });
    expect(seen).toEqual(["https://api.anthropic.com/api/hello"]);
    expect(r).toEqual({
      tested: true,
      passed: true,
      lines: ["API (api.anthropic.com): answered HTTP 200 in 84 ms", SETTINGS_LINE],
    });
  });

  test("an Anthropic host must answer 200", async () => {
    const r = await runApiConnectivity({}, { probe: answering(403), now: clock(30), ...NO_POLICY });
    expect(r.passed).toBe(false);
    expect(r.lines[0]).toBe("API (api.anthropic.com): answered HTTP 403 in 30 ms (expected 200)");
    expect(r.hint).toBe(HINT);
  });

  test("any answer from a custom host passes; the host isn't named", async () => {
    const seen: string[] = [];
    const env = { ANTHROPIC_BASE_URL: "https://llm.corp.example/anthropic//", NODE_EXTRA_CA_CERTS: "/etc/ca.pem" };
    const r = await runApiConnectivity(env, { probe: answering(404, seen), now: clock(12), ...NO_POLICY });
    expect(seen).toEqual(["https://llm.corp.example/anthropic/api/hello"]);
    expect(r).toEqual({
      tested: true,
      passed: true,
      lines: [
        "API (custom host): answered HTTP 404 in 12 ms",
        "ANTHROPIC_BASE_URL: set to a custom host · NODE_EXTRA_CA_CERTS: set · CLAUDE_CODE_CLIENT_CERT: not set",
      ],
    });
  });

  test("a base URL on an Anthropic host is named as one", async () => {
    const r = await runApiConnectivity(
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CODE_CLIENT_CERT: "/c.pem" },
      { probe: answering(200), now: clock(5), ...NO_POLICY },
    );
    expect(r.lines[1]).toBe(
      "ANTHROPIC_BASE_URL: set to an Anthropic host · NODE_EXTRA_CA_CERTS: not set · CLAUDE_CODE_CLIENT_CERT: set",
    );
  });

  test("a refused connection reports its code", async () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) });
    const r = await runApiConnectivity({}, { probe: failing(err), now: clock(7), ...NO_POLICY });
    expect(r).toEqual({
      tested: true,
      passed: false,
      lines: ["API (api.anthropic.com): failed after 7 ms: ECONNREFUSED", SETTINGS_LINE],
      hint: HINT,
    });
  });

  test("a certificate failure says why, with the code", async () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    });
    const r = await runApiConnectivity({}, { probe: failing(err), now: clock(40), ...NO_POLICY });
    expect(r.lines[0]).toMatch(
      /^API \(api\.anthropic\.com\): failed after 40 ms: The server's certificate isn't trusted, .* \(SELF_SIGNED_CERT_IN_CHAIN\)$/,
    );
    expect(r.passed).toBe(false);
  });

  test("no answer in 10 s", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const r = await runApiConnectivity({}, { probe: failing(timeout), ...NO_POLICY });
    expect(r.lines[0]).toBe("API (api.anthropic.com): no answer in 10 s");
    expect(r.passed).toBe(false);
  });

  test("an error with no code falls back to its message", async () => {
    const r = await runApiConnectivity(
      { ANTHROPIC_BASE_URL: "not a url" },
      { probe: failing(new TypeError("Failed to parse URL from not a url/api/hello")), now: clock(0), ...NO_POLICY },
    );
    expect(r.lines[0]).toBe("API (custom host): failed after 0 ms: Failed to parse URL from not a url/api/hello");
  });
});
