"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Overlay } from "./Overlay";
import {
  CATEGORY_LABELS,
  mergeSuggestions,
  type SlashCategory,
  type SlashSuggestion,
} from "@/lib/shared/slash-commands";
import { useSdkCommands } from "@/lib/client/useSdkCommands";
import { findHelpTopic, usageLine } from "@/lib/shared/slash-help";

type Props = {
  sdkSlashCommands: string[];
  sdkSkills: string[];
  /** Current session id — used to fetch rich SDK command metadata on open. */
  sessionId: string | null;
  /**
   * CC 2.1.326 — `/help <command>` or `/<command> --help`: the command to show
   * usage for. Pre-fills the filter and adds a usage card above the list.
   */
  topic?: string | null;
  onClose: () => void;
};

export function HelpOverlay({ sdkSlashCommands, sdkSkills, sessionId, topic, onClose }: Props) {
  // Fetched only while the overlay is mounted (it's conditionally rendered),
  // so the help dialog shows real SDK/plugin command descriptions.
  const sdkRichCommands = useSdkCommands(sessionId);
  const all = useMemo(
    () => mergeSuggestions(sdkSlashCommands, sdkSkills, sdkRichCommands),
    [sdkSlashCommands, sdkSkills, sdkRichCommands],
  );
  const [filter, setFilter] = useState(topic ?? "");
  const topicCmd = useMemo(() => (topic ? findHelpTopic(all, topic) : undefined), [all, topic]);

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? all.filter(
          (c) =>
            c.name.includes(f) ||
            (c.aliases ?? []).some((a) => a.includes(f)) ||
            c.description.toLowerCase().includes(f),
        )
      : all;
    const map = new Map<SlashCategory, SlashSuggestion[]>();
    for (const c of filtered) {
      const arr = map.get(c.category) ?? [];
      arr.push(c);
      map.set(c.category, arr);
    }
    return map;
  }, [filter, all]);

  return (
    <Overlay title="Slash commands" subtitle={`Help · ${all.length} commands`} onClose={onClose} width={760}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2">
        <Search className="h-3.5 w-3.5 text-[var(--muted)]" />
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter commands…"
          className="flex-1 bg-transparent text-sm focus:outline-none"
        />
      </div>
      <div className="px-4 py-3">
        {topic && (
          <TopicUsage topic={topic} cmd={topicCmd} />
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from(grouped.entries()).map(([cat, list]) => (
            <section key={cat}>
              <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                {CATEGORY_LABELS[cat]} · {list.length}
              </h3>
              <ul className="space-y-1.5">
                {list.map((c) => (
                  <li key={c.id} className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <code className="font-mono text-xs">
                        <span className="text-[var(--accent)]">/</span>
                        {c.name}
                        {c.argsHint && <span className="text-[var(--muted)]"> {c.argsHint}</span>}
                      </code>
                      <span
                        className={`text-[9px] uppercase tracking-wide ${
                          c.handler === "native"
                            ? "text-emerald-400"
                            : c.handler === "sdk"
                            ? "text-sky-400"
                            : "text-[var(--muted)]"
                        }`}
                      >
                        {c.handler}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--muted)]">{c.description}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <div className="border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-[11px] text-[var(--muted)]">
        <span className="font-mono">app</span> = handled in the browser ·{" "}
        <span className="font-mono">sdk</span> = forwarded to Claude Code ·{" "}
        <span className="font-mono">external</span> = terminal/hosted only
      </div>
    </Overlay>
  );
}

/** CC 2.1.326 — the usage card `/help <command>` and `/<command> --help` open on. */
function TopicUsage({ topic, cmd }: { topic: string; cmd: SlashSuggestion | undefined }) {
  if (!cmd) {
    return (
      <div data-testid="help-usage-missing" className="mb-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-2 text-xs text-[var(--muted)]">
        No command named <code className="font-mono text-[var(--foreground)]">/{topic}</code>. Clear the filter to see them all.
      </div>
    );
  }
  const aliases = cmd.aliases ?? [];
  return (
    <div data-testid="help-usage" className="mb-3 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Usage</div>
      <code data-testid="help-usage-line" className="mt-0.5 block font-mono text-sm">
        {usageLine(cmd)}
      </code>
      <div className="mt-1 text-xs text-[var(--muted)]">{cmd.description}</div>
      {aliases.length > 0 && (
        <div className="mt-1 text-[11px] text-[var(--muted)]">
          Also: {aliases.map((a) => `/${a}`).join(", ")}
        </div>
      )}
    </div>
  );
}
