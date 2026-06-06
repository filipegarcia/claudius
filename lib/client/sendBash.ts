import type { SendBashRequest, SendBashResponse } from "@/lib/shared/events";

/**
 * POST a `!`-mode bash command to the session's bash endpoint.
 *
 * Wraps the fetch + JSON marshalling so the composer and the CodeBlock
 * Execute button both have a single, typed entry point. Errors normalise
 * to `null` so the caller can render a generic failure strip without
 * inspecting `Response.ok`. The `sudoPassword` field passes straight
 * through to the route handler and is never persisted client-side
 * (the caller is expected to drop it after the call resolves).
 */
export async function sendBash(
  sessionId: string,
  req: SendBashRequest,
): Promise<SendBashResponse | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/bash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) return null;
    return (await r.json()) as SendBashResponse;
  } catch {
    return null;
  }
}

/**
 * Quick sniff: does this command's first non-whitespace token look like a
 * sudo invocation? Used by the composer + CodeBlock to decide whether to
 * pop the password modal before sending. Intentionally lenient — we'd
 * rather pop the modal once on a false positive than miss a real sudo
 * (the modal has a Skip button).
 */
export function commandNeedsSudo(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return /^sudo\b/.test(trimmed);
}
