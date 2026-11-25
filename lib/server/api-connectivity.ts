import { ownRequestCertFailureHint, certFailureCause } from "@/lib/shared/tls-cert-hint";

/**
 * CC 2.1.331 parity — "Added an API connectivity section to `claude doctor`
 * that reports whether the API can be reached, with the HTTP status or the
 * error, or says why it wasn't tested".
 *
 * Claudius draws its own /doctor, so this ports the engine's section (2.1.332
 * bundle), lines included: one unauthenticated GET to
 * `${ANTHROPIC_BASE_URL || https://api.anthropic.com}/api/hello` with a 10 s
 * timeout, the HTTP status or the error, then a line naming the network
 * settings in play, and — when the test fails — the engine's
 * proxy/firewall/VPN pointer. Any answer from a custom host counts as
 * reachable; an Anthropic host must answer 200.
 *
 * Not tested, with the engine's reasons: a cloud provider (Bedrock, Vertex,
 * Foundry), a managed settings source that did not load,
 * `ANTHROPIC_UNIX_SOCKET`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. One
 * Claudius-only reason: Node's `fetch` (which this test uses) ignores
 * `HTTPS_PROXY` / `HTTP_PROXY` unless `NODE_USE_ENV_PROXY=1`, while the engine
 * sends its requests through the proxy, so with a proxy set the result
 * wouldn't match the engine's and the test says so instead. The engine's
 * extra "Sign-in" probe for claude.ai logins is not ported.
 */

export const API_CONNECTIVITY_TIMEOUT_MS = 10_000;

const ANTHROPIC_HOST_RE = /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/i;
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const NETWORK_HINT =
  "A proxy, firewall, VPN or security software between this machine and the host can cause these results. See https://code.claude.com/docs/en/network-config";
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

type Env = Record<string, string | undefined>;

export type ApiConnectivityReport = {
  /** False when the test was skipped; `lines` then holds the reason. */
  tested: boolean;
  /** Every probe got the answer it expects (true when not tested). */
  passed: boolean;
  /** The engine's lines, without its "- " bullets. */
  lines: string[];
  /** The engine's network pointer, when the test failed. */
  hint?: string;
};

/** What the test calls to reach the host; `fetch` in production. */
export type ConnectivityProbe = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number }>;

const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").toLowerCase().trim());

/** The engine's reason not to send the test request, or null to send it. */
export function apiConnectivitySkipReason(env: Env, opts: { managedSettingsDidNotLoad: boolean }): string | null {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) || truthy(env.CLAUDE_CODE_USE_FOUNDRY)) {
    return "Not tested: this session uses a cloud provider or a gateway, or your settings name a gateway, not the Anthropic API";
  }
  if (opts.managedSettingsDidNotLoad) {
    return "Not tested: a managed settings source did not load, so Claude Code sends no test request";
  }
  if (env.ANTHROPIC_UNIX_SOCKET) {
    return "Not tested: API requests go through ANTHROPIC_UNIX_SOCKET, which this test does not use";
  }
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return "Not tested: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set";
  }
  if (env.NODE_USE_ENV_PROXY !== "1") {
    const proxy = PROXY_VARS.find((k) => env[k]);
    if (proxy) return `Not tested: API requests go through ${proxy}, which this test does not use`;
  }
  return null;
}

/** The error code on `err` or its `cause` chain (fetch wraps the socket error). */
function errorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function hostLabel(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return ANTHROPIC_HOST_RE.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Run the test (or say why not) against `env`. */
export async function runApiConnectivity(
  env: Env,
  opts: {
    probe: ConnectivityProbe;
    managedSettingsDidNotLoad: boolean;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<ApiConnectivityReport> {
  const skip = apiConnectivitySkipReason(env, opts);
  if (skip) return { tested: false, passed: true, lines: [skip] };

  const now = opts.now ?? (() => performance.now());
  const timeoutMs = opts.timeoutMs ?? API_CONNECTIVITY_TIMEOUT_MS;
  const url = `${(env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/hello`;
  const anthropicHost = hostLabel(url);
  const label = `API (${anthropicHost ?? "custom host"})`;

  let passed: boolean;
  let result: string;
  const started = now();
  try {
    const res = await opts.probe(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "claudius-doctor" } });
    const unexpected = res.status !== 200 && anthropicHost !== undefined;
    passed = !unexpected;
    result = `answered HTTP ${res.status} in ${Math.round(now() - started)} ms${unexpected ? " (expected 200)" : ""}`;
  } catch (err) {
    passed = false;
    if (err instanceof Error && err.name === "TimeoutError") {
      result = `no answer in ${timeoutMs / 1000} s`;
    } else {
      const code = errorCode(err);
      const certHint = code && certFailureCause(err) ? ownRequestCertFailureHint(err) : null;
      const message = err instanceof Error && err.message ? err.message : undefined;
      const what = certHint ?? code ?? message ?? "an unknown error";
      result = `failed after ${Math.round(now() - started)} ms: ${what}${code && !what.includes(code) ? ` (${code})` : ""}`;
    }
  }

  const base = env.ANTHROPIC_BASE_URL
    ? hostLabel(env.ANTHROPIC_BASE_URL)
      ? "set to an Anthropic host"
      : "set to a custom host"
    : "not set";
  const lines = [
    `${label}: ${result}`,
    `ANTHROPIC_BASE_URL: ${base} · NODE_EXTRA_CA_CERTS: ${env.NODE_EXTRA_CA_CERTS ? "set" : "not set"} · ` +
      `CLAUDE_CODE_CLIENT_CERT: ${env.CLAUDE_CODE_CLIENT_CERT ? "set" : "not set"}`,
  ];
  return passed ? { tested: true, passed, lines } : { tested: true, passed, lines, hint: NETWORK_HINT };
}
