"use client";

/**
 * Dev-only preview that renders a chat-style fixture demonstrating the
 * "Minecraft Thinking" customization in action. The customization edits
 * `components/chat/ThinkingBlock.tsx` to embed a Minecraft parkour video
 * alongside the model's reasoning — but in a live chat we'd need an actual
 * streaming turn to see it. This page fakes that turn so the marketing
 * screenshot can capture the feature deterministically.
 *
 * Notes for the screenshot test:
 *   - The "video" is a static thumbnail (YouTube hqdefault) rather than the
 *     real <iframe> the customization uses. Network-loaded iframes are
 *     flaky in headless browsers (rate-limits, region blocks, slow embeds)
 *     and would make the screenshot unreliable. The visual is identical.
 *   - All state is hard-coded; no fetch, no SSE, no session manager.
 */

import { ChevronDown, Brain, Volume2, Pause } from "lucide-react";

const PARKOUR_THUMB =
  "https://img.youtube.com/vi/n_Dv4JMiwK8/hqdefault.jpg";

const USER_PROMPT =
  "Refactor the workspaces store so a workspace can have multiple root paths. Keep `rootPath` working for single-root callers.";

const REASONING_TEXT = `Let me think about this carefully.

The current shape is { id, name, rootPath }. To support multiple roots
without breaking single-root callers, I want \`rootPaths: string[]\`
internal, with \`rootPath\` as a derived getter returning rootPaths[0]
(or undefined). Migration is forward-only — old records have rootPath
and no rootPaths; we copy rootPath into rootPaths on first read.

Callers I need to audit:
  • createWorkspace — accepts a single rootPath today, should accept
    rootPath | rootPaths and normalize to the array form.
  • The /api/workspaces route handler — its JSON contract is the source
    of truth for the client. Adding rootPaths is additive; keep rootPath
    for one release as a deprecated alias.
  • The Files / Git pages use workspace.rootPath as cwd. They'll keep
    working against rootPaths[0] for now; a follow-up can let the user
    pick which root each pane targets.

Plan: write the type change first (lib/server/workspaces-store.ts), then
the migration, then update createWorkspace's signature, then thread
rootPaths through the API. Tests for each step.`;

const ASSISTANT_REPLY = `Here's the migration in two passes. **Pass 1** (this PR): add \`rootPaths: string[]\` to the workspace type, derive it from \`rootPath\` on read, and accept both shapes in \`createWorkspace\`. The API contract stays additive — clients that still send \`rootPath\` are unchanged.

\`\`\`ts
// lib/server/workspaces-store.ts
export type Workspace = {
  id: string;
  name: string;
  rootPaths: string[];
  /** @deprecated use rootPaths */
  rootPath: string;
  // …
};
\`\`\`

**Pass 2** (follow-up): teach the Files, Git, and Chat panes about multi-root, including a small UI to pick which root a session opens against. Tracked in TODO.md.`;

export default function MinecraftPreviewPage() {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 text-[11px] uppercase tracking-wide text-[var(--muted)]">
          /dev preview &middot; cust &middot; Minecraft Thinking
        </div>

        {/* User turn */}
        <div className="mb-6 flex justify-end">
          <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm text-[var(--foreground)]">
            {USER_PROMPT}
          </div>
        </div>

        {/* Assistant turn */}
        <div className="group">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            Claude
            <span className="text-[10px] opacity-60">streaming…</span>
          </div>

          {/* Minecraft Thinking block — open, parkour visible */}
          <div
            data-testid="minecraft-thinking-block"
            className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/50"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--muted)]"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              <Brain className="h-3.5 w-3.5" />
              <span>Thinking</span>
            </button>
            <div className="border-t border-[var(--border)] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-[var(--muted)]">
              {REASONING_TEXT}
            </div>
          </div>

          {/* Assistant final text */}
          <div className="space-y-2 text-sm leading-7 text-[var(--foreground)]">
            {ASSISTANT_REPLY.split("\n\n").map((para, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {para}
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* Parkour modal overlay — picture-in-picture-style floating panel,
       * pinned bottom-right so the chat behind stays readable. A soft
       * backdrop dim + blur ring frames the panel without fully obscuring
       * the background, matching the user's "modal overlay, still showing
       * the background" brief. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-40 bg-black/15 backdrop-blur-[1.5px]"
      />
      <div
        data-testid="minecraft-parkour-modal"
        className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none"
      >
        <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/95 p-3 shadow-2xl ring-1 ring-emerald-500/30"
          style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.6), 0 0 0 1px rgba(110,231,183,0.18)" }}
        >
          <div className="flex w-full items-center justify-between px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
              subway surfers attention assist&trade;
            </span>
            <span className="text-[var(--muted)]/70">picture-in-picture</span>
          </div>
          <div
            className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-black"
            style={{ width: 560, height: 315 }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={PARKOUR_THUMB}
              alt="Minecraft parkour course mid-jump"
              width={560}
              height={315}
              loading="eager"
              decoding="async"
              data-testid="minecraft-parkour-thumb"
              style={{ display: "block", width: 560, height: 315, objectFit: "cover" }}
            />
            <span className="absolute right-3 top-3 rounded bg-red-500/95 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white shadow">
              live
            </span>
            {/* Bottom gradient + scrubber bar so it reads like a real player */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 to-transparent" />
            <div className="absolute inset-x-3 bottom-3 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/20">
                <div className="h-full w-2/5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
              </div>
              <span className="font-mono text-[10px] text-white/90">02:18 / 05:42</span>
            </div>
          </div>
          <div className="flex w-full items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px]">
                <Volume2 className="h-3 w-3" />
                <span>mute</span>
              </span>
              <span className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px]">
                <Pause className="h-3 w-3" />
                <span>pause</span>
              </span>
            </div>
            <span className="font-mono text-[10px] text-[var(--muted)]">⌥M to hide</span>
          </div>
        </div>
      </div>
    </div>
  );
}
