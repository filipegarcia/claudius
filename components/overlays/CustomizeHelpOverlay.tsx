"use client";

import { Keyboard, WandSparkles, Layers, Eye, Rocket, Undo2, Terminal } from "lucide-react";
import { Overlay } from "./Overlay";
import { PANE_LABELS_EVENT } from "./PaneLabelsHost";

export function CustomizeHelpOverlay({ onClose }: { onClose: () => void }) {
  function openPaneLabels() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(PANE_LABELS_EVENT));
      onClose();
    }
  }

  return (
    <Overlay
      title="Customize Claudius"
      subtitle="A guided tour"
      onClose={onClose}
      width={720}
    >
      <div className="space-y-5 px-5 py-5 text-sm leading-relaxed">
        <Step
          icon={<WandSparkles className="h-4 w-4" />}
          title="1. Create a customization"
        >
          On the <code className="text-[var(--foreground)]">/customize</code> page, click
          <span className="mx-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">New customization</span>.
          Claudius mirrors its current source into an isolated folder under
          <code className="text-[var(--foreground)]"> ~/.claude/.claudius/customizations/</code> and creates a workspace pointing there.
          The workspace switcher on the far left shows it with a wand badge.
        </Step>

        <Step
          icon={<Layers className="h-4 w-4" />}
          title="2. Learn the component names"
        >
          Press
          <kbd className="mx-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 text-[10px]">⌘ .</kbd>
          (or
          <kbd className="mx-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 text-[10px]">Ctrl .</kbd>
          on non-Mac) to overlay every component with its canonical name —
          <code className="text-[var(--foreground)]"> left-nav</code>,
          <code className="text-[var(--foreground)]"> chat-area</code>,
          <code className="text-[var(--foreground)]"> right-rail</code>, etc.
          Use those names when chatting with Claude (e.g. &quot;move the left-nav settings tile up&quot;).
          <div className="mt-2">
            <button
              onClick={openPaneLabels}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--panel-2)]"
            >
              <Keyboard className="h-3 w-3" /> Try it now
            </button>
          </div>
        </Step>

        <Step
          icon={<WandSparkles className="h-4 w-4" />}
          title="3. Edit using the existing tooling"
        >
          Inside the customization workspace, every component works the same — chat with Claude Code, browse files, view git
          (the customization src is just a regular directory). A persistent banner at the top of every page reminds you
          that edits are isolated.
        </Step>

        <Step
          icon={<Eye className="h-4 w-4" />}
          title="4. Preview before publishing"
        >
          On
          <code className="text-[var(--foreground)]"> /customize/&lt;id&gt;</code>, click
          <span className="mx-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">Start preview</span>.
          Claudius spawns a separate
          <code className="text-[var(--foreground)]"> next dev</code> on a free port from 3100+,
          serving your edited tree. Open the preview link to test in a new tab —
          your running Claudius is untouched.
        </Step>

        <Step
          icon={<Rocket className="h-4 w-4" />}
          title="5. Publish"
        >
          When happy, click
          <span className="mx-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">Publish</span>.
          Claudius snapshots the base files about to be displaced, then copies your edits over them. Next dev hot-reloads,
          and your changes are live. The publish appears in the history list with status <em>active</em>.
        </Step>

        <Step
          icon={<Undo2 className="h-4 w-4" />}
          title="6. Revert from the UI"
        >
          On the same page, every publish row has a
          <span className="mx-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">Revert</span>
          button. Reverting copies the snapshotted base files back into place and marks the publish as reverted.
          Multiple publishes can be active at once — they layer in chronological order.
        </Step>

        <Step
          icon={<Terminal className="h-4 w-4" />}
          title="7. CLI revert (escape hatch)"
        >
          If a publish breaks the running UI itself, run this from a terminal:
          <pre className="mt-2 rounded-md border border-[var(--border)] bg-black/40 px-3 py-2 font-mono text-xs">
make claudius-revert      # undoes the most recent active publish
make claudius-revert-all  # undoes every active publish
          </pre>
          The script has zero Claudius runtime dependencies — it works even when the dev server is dead.
        </Step>

        <p className="border-t border-[var(--border)] pt-4 text-xs text-[var(--muted)]">
          Heads-up: when Claudius itself is upgraded, active publishes whose stored base hash no longer matches the live
          tree are auto-reverted at startup with reason <code>stale_at_upgrade</code>. Re-publish from your customization
          src to apply on top of the new base.
        </p>
      </div>
    </Overlay>
  );
}

function Step({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium text-[var(--foreground)]">{title}</h3>
        <div className="mt-1 text-[var(--muted)]">{children}</div>
      </div>
    </div>
  );
}
