"use client";

/**
 * Dev-only preview: a chat with the AskUserQuestion form embedded inline in
 * the transcript, right under the model's message. Mounts the real
 * `AskUserQuestionPrompt` component (inline variant) with a fixture event so
 * the marketing shot matches what users see in a live session — without
 * needing a real Claude turn. The chat stays fully visible (no dim/blur):
 * that's the whole point of the inline form — the reader keeps the context
 * the model just wrote while answering.
 */

import { AskUserQuestionPrompt } from "@/components/chat/AskUserQuestionPrompt";
import type { AskUserQuestionEvent } from "@/lib/shared/events";
import { Mic, Paperclip, ArrowUp } from "lucide-react";
import { PreviewChrome } from "../_chat-chrome/PreviewChrome";

const FIXTURE: AskUserQuestionEvent = {
  type: "ask_user_question",
  requestId: "preview-ask",
  toolUseId: "toolu_preview_ask",
  questions: [
    {
      question: "Pick a styling approach for the Claudius marketing site.",
      header: "Styling",
      multiSelect: false,
      options: [
        {
          label: "Tailwind via CDN (Recommended)",
          description:
            "Drop a <script> in the head; tailwindcss-jit serves utility classes at runtime. Zero build step, lightning iteration, the bundle stays in the browser cache after first hit.",
        },
        {
          label: "Vanilla CSS",
          description:
            "Hand-roll a small stylesheet (~120 lines). Zero dependencies, perfect a11y story, but every new component costs a CSS pass.",
        },
        {
          label: "Astro",
          description:
            "Promotes the site to a real static-site generator. Overkill for one page today, but pays off the moment the site grows beyond `index.html`.",
        },
      ],
    },
    {
      question: "Pick a default theme to ship the site with.",
      header: "Theme",
      multiSelect: false,
      options: [
        {
          label: "Dark",
          description: "Soft warm dark. The default in-app, lowest cognitive switching cost.",
        },
        { label: "Light", description: "Cream-on-white. Reads well in linked Twitter cards." },
        {
          label: "Midnight",
          description: "Deep blue-violet. Pairs nicely with the Synthwave customization preview.",
        },
      ],
    },
  ],
};

export default function ChatAskPreview() {
  return (
    <PreviewChrome
      activeTab="98a3c4f1"
      tabs={[
        { id: "01-pending", label: "Call AskUserQuestion now w…" },
        { id: "98a3c4f1", label: "98a3c4f1", active: true },
      ]}
    >
      <div className="relative flex h-full flex-col">
        {/* Status line */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
          <span className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
            Session 98a3c4f1
          </span>
          <span>·</span>
          <span>Awaiting answer</span>
        </div>

        {/* Chat transcript — fully visible. The inline question form is the
            last item, embedded right under the model's message. */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div
            data-testid="ask-user-question-preview"
            className="mx-auto max-w-3xl space-y-6"
          >
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm">
                Help me decide a couple of things for the Claudius site. Ask me both at once via AskUserQuestion.
              </div>
            </div>
            <div className="text-[var(--foreground)]">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                Claude
              </div>
              <div className="space-y-2 text-sm leading-7">
                <p>
                  Two quick choices — I&rsquo;ll wait for your answer before
                  scaffolding anything.
                </p>
              </div>
            </div>

            {/* The inline form — real component, fixture event */}
            <AskUserQuestionPrompt
              inline
              request={FIXTURE}
              sessionLabel="SDK rollout plan"
              onSubmit={() => {}}
              onCancel={() => {}}
            />
          </div>
        </div>

        {/* Prompt input — usable while a question is pending (typed messages
            queue behind the blocked turn). */}
        <div className="shrink-0 px-6 pb-6">
          <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2.5">
            <Paperclip className="h-4 w-4 text-[var(--muted)]" />
            <span className="flex-1 truncate text-sm text-[var(--muted)]">
              Answer above, or keep typing…
            </span>
            <Mic className="h-4 w-4 text-[var(--muted)]" />
            <button className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--background)]">
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </PreviewChrome>
  );
}
