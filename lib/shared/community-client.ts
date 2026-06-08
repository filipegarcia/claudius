/**
 * Self-identifier sent to the community chat-server on every request as
 * `?client=<id>`. Shape mirrors a User-Agent product token:
 *
 *   claudius/web:0.3.152.0
 *   claudius/electron-mac:0.3.152.0
 *   claudius/electron-windows:0.3.152.0
 *   claudius/electron-linux:0.3.152.0
 *
 * Lets the chat-server operator distinguish web visitors from packaged
 * desktop installs in logs / connection metrics, and tag the Claudius
 * build version they're running. Older chat-servers ignore unknown
 * query params (same advisory contract as `?nick=` already in use), so
 * old deploys keep working unchanged.
 *
 * Transport choice: query param, not header. EventSource has no way to
 * send custom headers, and putting the id in two places (a header on
 * `fetch` + a param on SSE) would split the mechanism for no gain.
 * One query param everywhere also avoids adding the identifier to
 * `Access-Control-Allow-Headers` — a header would extend the CORS
 * preflight allowlist and create a deploy-ordering coupling between
 * Claudius and the chat-server. A param needs no allowlist.
 */
import { isElectron } from "./runtime";
import { CLAUDIUS_VERSION } from "./version";

const PLATFORM_LABELS: Record<string, string> = {
  darwin: "mac",
  win32: "windows",
  linux: "linux",
};

function rendererPlatform(): string | null {
  if (typeof window === "undefined") return null;
  const p = window.claudius?.platform;
  return typeof p === "string" ? p : null;
}

function nodePlatform(): string | null {
  if (typeof process === "undefined") return null;
  const p = process.platform;
  return typeof p === "string" ? p : null;
}

/**
 * Lazy getter (not a module const) because the renderer-side
 * `window.claudius` preload bridge can mount slightly after module
 * evaluation — computing on call ensures we read the bridge once it's
 * live. The result is cheap to compute, so we don't memoize.
 */
export function getCommunityClient(): string {
  if (!isElectron()) return `claudius/web:${CLAUDIUS_VERSION}`;
  const raw = rendererPlatform() ?? nodePlatform() ?? "unknown";
  const label = PLATFORM_LABELS[raw] ?? raw;
  return `claudius/electron-${label}:${CLAUDIUS_VERSION}`;
}

/**
 * Append `client=<id>` to a chat-server URL. Picks `?` or `&`
 * automatically based on whether the URL already carries a query
 * string. Use at every call site that hits the chat-server (`fetch`,
 * `EventSource`, the admin proxy) so the identifier travels uniformly.
 */
export function withCommunityClientParam(url: string): string {
  const id = encodeURIComponent(getCommunityClient());
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}client=${id}`;
}
