import { NextResponse } from "next/server";
import { query } from "@anthropic-ai/claude-agent-sdk";

export const runtime = "nodejs";

/**
 * Live-probe a fixed set of full model IDs to verify they're operational
 * for the current user. Each probe spawns a fresh ephemeral query (the
 * SDK's `persistSession: false`, `maxTurns: 1`) that sends a single
 * one-token test prompt and waits for an assistant reply.
 *
 * All probes run in parallel — wall-clock time is the slowest individual
 * probe, not N × slowest. Results are cached zero seconds (caller caches
 * client-side in component state; the results don't change mid-session).
 *
 * Why here rather than in the client: the `query()` function from
 * `@anthropic-ai/claude-agent-sdk` reads the bundled CLI binary from
 * Bun's `$bunfs` virtual filesystem — only accessible in the app's
 * server context, not from raw Bun scripts or browser code.
 */

type ProbeCandidate = {
  value: string;
  displayName: string;
  description: string;
};

type ProbeResult = ProbeCandidate & {
  ok: boolean;
  error?: string;
};

/** Full versioned model IDs to probe. Aliases (sonnet, opus, etc.) are
 *  already surfaced in the main picker via `supportedModels()`. These
 *  pinned IDs let users target a specific generation without going
 *  through alias resolution. */
const PROBE_CANDIDATES: ProbeCandidate[] = [
  {
    value: "claude-fable-5",
    displayName: "Fable 5",
    description:
      "Pinned to Fable 5. Most capable; full effort tiers + adaptive thinking.",
  },
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description:
      "Pinned to Opus 4.8. Deepest reasoning on complex, long-horizon tasks.",
  },
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Pinned to Opus 4.7.",
  },
  {
    value: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Pinned to Opus 4.6.",
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description:
      "Pinned to Sonnet 4.6. Balanced speed and quality; supports adaptive thinking.",
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description:
      "Pinned to Haiku 4.5. Fastest responses for lightweight tasks.",
  },
];

const PROBE_TIMEOUT_MS = 20_000;

async function probeOne(candidate: ProbeCandidate): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // Spawn an ephemeral one-shot session with the candidate model.
    // `persistSession: false` skips writing to ~/.claude/projects/.
    // `maxTurns: 1` caps the session at a single exchange.
    // Using the string-prompt overload is the simplest form; the SDK
    // emits a single assistant reply then the query drains naturally.
    const q = query({
      prompt: "Reply with exactly: ok",
      options: {
        model: candidate.value,
        maxTurns: 1,
        persistSession: false,
        abortController: controller,
        // Override advisor model to match the candidate being probed.
        // Some models (e.g. fable-5) require their sub-agent tools to use the
        // same model family — if we leave it at the user's configured advisor
        // (typically claude-opus-4-8) the API returns a 400.
        settings: { advisorModel: candidate.value },
      },
    });

    for await (const event of q) {
      const e = event as {
        type: string;
        subtype?: string;
        error?: string;
        is_error?: boolean;
        api_error_status?: number;
      };
      if (e.type === "assistant") {
        // The SDK sets `error` on the assistant event when the model is
        // rejected by the API (e.g. "model_not_found"). Check before
        // treating any assistant reply as success.
        if (e.error) {
          return { ...candidate, ok: false, error: e.error };
        }
        // Real model responded — operational.
        return { ...candidate, ok: true };
      }
      if (e.type === "result") {
        // `is_error: true` signals a failed run even when `subtype` is
        // "success" (the CLI synthesises a success-shaped result event
        // for model-not-found / entitlement errors, but sets is_error).
        if (e.is_error) {
          const errMsg = e.error ??
            (e.api_error_status ? `api_error_${e.api_error_status}` : e.subtype ?? "unknown_error");
          return { ...candidate, ok: false, error: errMsg };
        }
        const ok = !e.subtype || e.subtype === "success";
        return { ...candidate, ok, error: ok ? undefined : e.subtype };
      }
    }
    // Query drained without an assistant or result event — treat as ok.
    return { ...candidate, ok: true };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ...candidate, ok: false, error: "timed out" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ...candidate, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
    // Abort any still-running process cleanly.
    controller.abort();
  }
}

export async function GET() {
  const settled = await Promise.allSettled(PROBE_CANDIDATES.map(probeOne));
  const results: ProbeResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          ...PROBE_CANDIDATES[i],
          ok: false,
          error: "probe threw unexpectedly",
        },
  );
  return NextResponse.json({ results });
}
