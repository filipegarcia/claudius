# High Memory-Usage Warning Banner (1.5GB / 2.5GB)

**Source:** Claude Code TUI — hooks-ux
**Status:** UNVERIFIED

## What it is
A polling hook samples the process heap every 10s and flips a session-level status between `normal`, `high`, and `critical` so a banner can warn users that a long-running session is about to OOM. `hooks/useMemoryUsage.ts` carries the thresholds inline: `const HIGH_MEMORY_THRESHOLD = 1.5 * 1024 * 1024 * 1024 // 1.5GB in bytes` and `const CRITICAL_MEMORY_THRESHOLD = 2.5 * 1024 * 1024 * 1024 // 2.5GB in bytes`. The hook short-circuits re-rendering while status stays `normal` to avoid wasting React updates on a green-state heartbeat.

## Claudius today
Not surfaced in Claudius. There is no proactive heap-pressure UI — the closest thing is `app/api/heapdump/route.ts`, a manual `process.report.writeReport()` endpoint used for post-mortem diagnosis, not a live banner. The natural home for a port would be a server-side sampler in `lib/server/session.ts` (or a sibling like `lib/server/memory-pressure.ts`) that calls `process.memoryUsage()` on an interval and broadcasts a status event over SSE, mirroring how `lib/client/useRateLimitWarning.ts` + `lib/client/useContextWarning.ts` already drive `components/chat/ContextWarningBanner.tsx`. The browser process itself has no equivalent API — `performance.memory` is Chromium-only and reports the renderer heap, not the Node session worker, so any high/critical readout has to come from the server.

## Decision
UNVERIFIED — the thresholds and labels are visible only in the leak file `hooks/useMemoryUsage.ts`; there is no corroborating binary string match for "high memory" / "critical memory" banner copy, so the exact banner wording and trigger contract remain unconfirmed. If we want parity, the cheapest cut is a 10s `process.memoryUsage().heapUsed` sampler on the Node side that emits `{ status: "normal" | "high" | "critical" }` deltas only on transitions (matching the leak's short-circuit), with a new banner component slotted next to `components/chat/ContextWarningBanner.tsx`. Worth deferring until either the strings show up in a future build or we see real Claudius sessions hitting OOM — `app/api/heapdump/route.ts` already covers the diagnostic side.
