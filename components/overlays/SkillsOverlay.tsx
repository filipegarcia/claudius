"use client";

import { Bot, Cpu, Wand2 } from "lucide-react";
import { Overlay } from "./Overlay";

type Props = {
  agents: string[];
  skills: string[];
  slashCommands: string[];
  onClose: () => void;
};

export function SkillsOverlay({ agents, skills, slashCommands, onClose }: Props) {
  return (
    <Overlay
      title="Skills, agents & commands"
      subtitle="Reported by the active session"
      onClose={onClose}
      width={680}
    >
      <div className="grid gap-4 px-4 py-4 md:grid-cols-3">
        <Section icon={Wand2} title="Skills" tone="text-violet-400" items={skills} />
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
