// A collision-resistant per-tab identifier used for write-lock arbitration
// (the SSE `?tabId=` the server tracks to decide which tab holds the write
// lock).
//
// Why the CSPRNG and not `Math.random()`: CodeQL flags the tab id as
// `js/insecure-randomness` because it flows to the server as an identifier
// (alert #59). `crypto.getRandomValues` satisfies the query.
//
// Why NOT `crypto.randomUUID()` (the obvious one-liner): randomUUID requires a
// *secure context*, so it's `undefined` over plain HTTP on a LAN IP — which
// `next.config.ts`'s `allowedDevOrigins` explicitly supports (phone ↔ laptop
// on the same Wi-Fi). `getRandomValues` has no secure-context requirement and
// works everywhere Claudius runs.
//
// Hex-encoding raw bytes (full-byte, no modulo / no `% n` scaling) also keeps
// clear of `js/biased-cryptographic-random` — see CLAUDE.md. 8 bytes → 64 bits,
// far more collision-resistant than the old `Math.random().toString(36)` slice.
export function newTabId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "tab-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
