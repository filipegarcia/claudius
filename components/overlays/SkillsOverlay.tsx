"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Circle, CircleDot, Cpu, Wand2 } from "lucide-react";
import { Overlay } from "./Overlay";

type Props = {
  agents: string[];
  skills: string[];
  slashCommands: string[];
  sessionId: string | null;
  cwd: string | null;
  onClose: () => void;
};

type SkillFrontmatter = { name: string; source: string; tokens: number };

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function SkillsOverlay({
  agents,
  skills,
  slashCommands,
  sessionId,
  cwd,
  onClose,
}: Props) {
  // CC 2.1.280 parity ("[VSCode] Added each skill's source, token estimate
  // and on/off state to the Slash commands dialog, with a click to change
  // the state"). Claudius's `/skills` overlay already listed bare names —
  // this enriches each skill row with the same per-skill source + token
  // cost the `/skill-doctor` `ContextOverlay` already computes (reused via
  // the same `/api/sessions/[id]/context` endpoint, not recomputed here),
  // plus a click-to-toggle backed by the SDK's `Settings.skillOverrides`
  // passthrough key (see `lib/server/settings.ts`'s `updateSkillOverride`).
  const [frontmatter, setFrontmatter] = useState<SkillFrontmatter[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Disables every toggle button while ANY toggle POST is in flight — not
  // just the clicked one. `updateSkillOverride` is a plain read-patch-write
  // against one file with no lock (same shape as `updatePermissions` /
  // `updateAutoMode`); two concurrent toggles from this same client would
  // race and one could silently clobber the other's entry. Serializing
  // client-side is cheap and closes the realistic case (a user clicking two
  // different skills back-to-back) without adding file-locking infra that
  // no sibling settings-updater in this codebase has either.
  const [togglePending, setTogglePending] = useState(false);
  // Set as soon as the first toggle fires. Guards the mount-time overrides
  // GET (below) from clobbering fresher, server-confirmed state with a
  // response that happened to resolve after a toggle already landed — once
  // the user has toggled anything, the toggle handler's own response is the
  // sole source of truth for `overrides`.
  const hasToggledRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { skills?: { skillFrontmatter?: SkillFrontmatter[] } } | null) => {
        setFrontmatter(d?.skills?.skillFrontmatter ?? []);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFrontmatter([]);
      });
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    fetch(`/api/settings/skill-overrides?cwd=${encodeURIComponent(cwd)}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { skillOverrides?: Record<string, string> } | null) => {
        if (hasToggledRef.current) return;
        setOverrides(d?.skillOverrides ?? {});
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  async function toggle(name: string) {
    if (!cwd || togglePending) return;
    hasToggledRef.current = true;
    const isOff = overrides[name] === "off";
    setTogglePending(true);
    try {
      const res = await fetch("/api/settings/skill-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name, value: isOff ? "on" : "off" }),
      });
      if (res.ok) {
        const d = (await res.json()) as { skillOverrides?: Record<string, string> };
        setOverrides(d.skillOverrides ?? {});
      }
    } finally {
      setTogglePending(false);
    }
  }

  const byName = new Map((frontmatter ?? []).map((f) => [f.name, f]));

  return (
    <Overlay
      title="Skills, agents & commands"
      subtitle="Reported by the active session"
      onClose={onClose}
      width={680}
    >
      <div className="grid gap-4 px-4 py-4 md:grid-cols-3">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <Wand2 className="h-3 w-3 text-violet-400" />
            Skills · {skills.length}
          </div>
          {cwd && skills.length > 0 && (
            <p className="mb-1.5 text-[10px] text-[var(--muted)]">
              Toggling applies to new sessions, not this one.
            </p>
          )}
          <ul className="space-y-0.5" data-testid="skills-overlay-skill-list">
            {skills.length === 0 ? (
              <li className="text-[11px] text-[var(--muted)]">none</li>
            ) : (
              skills.map((s) => {
                const fm = byName.get(s);
                const off = overrides[s] === "off";
                return (
                  <li
                    key={s}
                    data-testid="skills-overlay-skill-row"
                    className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1 text-[11px]"
                  >
                    <button
                      type="button"
                      data-testid="skills-overlay-toggle"
                      data-skill={s}
                      data-state={off ? "off" : "on"}
                      title={
                        !cwd
                          ? "Workspace not resolved yet — toggling isn't available"
                          : off
                            ? `${s} is off — click to turn on`
                            : `${s} is on — click to turn off`
                      }
                      disabled={!cwd || togglePending}
                      onClick={() => void toggle(s)}
                      className="shrink-0 text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-50"
                    >
                      {off ? <Circle className="h-3 w-3" /> : <CircleDot className="h-3 w-3 text-emerald-400" />}
                    </button>
                    <span className={`truncate font-mono ${off ? "text-[var(--muted)] line-through" : ""}`}>
                      {s}
                    </span>
                    {fm && (
                      <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-[var(--muted)]">
                        {fm.source} · {fmtTokens(fm.tokens)}
                      </span>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </div>
        <Section icon={Bot} title="Agents" tone="text-emerald-400" items={agents} />
        <Section icon={Cpu} title="Slash commands" tone="text-sky-400" items={slashCommands} />
      </div>
    </Overlay>
  );
}

function Section({
  icon: Icon,
  title,
  tone,
  items,
}: {
  icon: typeof Bot;
  title: string;
  tone: string;
  items: string[];
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <Icon className={`h-3 w-3 ${tone}`} />
        {title} · {items.length}
      </div>
      <ul className="space-y-0.5">
        {items.length === 0 ? (
          <li className="text-[11px] text-[var(--muted)]">none</li>
        ) : (
          items.map((s) => (
            <li
              key={s}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1 font-mono text-[11px]"
            >
              {s}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
