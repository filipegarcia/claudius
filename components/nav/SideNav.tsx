"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, Network, Webhook, BookText, ShieldCheck, FolderTree, Bot, Calendar, BarChart3, Image as ImageIcon, Folder, Briefcase, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

type Item = {
  label: string;
  icon: typeof MessageSquare;
  href?: string;
};

// Workspace-scoped items only. System-global tiles (Plugins, Settings,
// Account/Usage) live in WorkspaceSwitcher below the divider — see the IA
// review note in TODO.md.
const items: Item[] = [
  // `?new=1` is consumed by the chat page (and useSession boot effect) and
  // forces creation of a fresh session, even from the chat page itself.
  // Without it, navigating /?session=X → /?session=X is a no-op and you'd
  // stay in the same conversation.
  { label: "Chat", icon: MessageSquare, href: "/?new=1" },
  { label: "Sessions", icon: FolderTree, href: "/sessions" },
  { label: "Files", icon: Folder, href: "/files" },
  { label: "Git", icon: GitBranch, href: "/git" },
  { label: "Memory", icon: BookText, href: "/memory" },
  { label: "Assets", icon: ImageIcon, href: "/assets" },
  { label: "Cost", icon: BarChart3, href: "/cost" },
  { label: "Agents", icon: Bot, href: "/agents" },
  { label: "MCP", icon: Network, href: "/mcp" },
  { label: "Hooks", icon: Webhook, href: "/hooks" },
  { label: "Schedule", icon: Calendar, href: "/schedule" },
  { label: "Permissions", icon: ShieldCheck, href: "/permissions" },
  // Workspace settings — defaults that apply to new chats in this workspace.
  { label: "Workspace", icon: Briefcase, href: "/workspace" },
];

const OLD_ITALIC = [
  "\u{10300}", "\u{10301}", "\u{10302}", "\u{10303}", "\u{10304}",
  "\u{10305}", "\u{10306}", "\u{10307}", "\u{10308}", "\u{10309}",
  "\u{1030A}", "\u{1030B}", "\u{1030C}", "\u{1030D}", "\u{1030E}",
  "\u{1030F}", "\u{10310}", "\u{10311}", "\u{10312}", "\u{10313}",
  "\u{10314}", "\u{10315}", "\u{10316}", "\u{10317}", "\u{10318}",
  "\u{10319}", "\u{1031A}",
];

const C_INDEX = 2; // 𐌂 (U+10302)

function AnimatedGlyph({ running }: { running: boolean }) {
  const [i, setI] = useState(C_INDEX);
  useEffect(() => {
    if (!running) {
      setI(C_INDEX);
      return;
    }
    const id = setInterval(() => setI((n) => (n + 1) % OLD_ITALIC.length), 350);
    return () => clearInterval(id);
  }, [running]);
  return (
    <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent)] text-white">
      <span
        key={running ? i : "idle"}
        className={cn("block text-base leading-none", running && "animate-glyph-fade")}
        style={{ fontFamily: "'Noto Sans Old Italic', 'Segoe UI Historic', serif" }}
      >
        {OLD_ITALIC[i]}
      </span>
    </div>
  );
}

export function SideNav({ running = false }: { running?: boolean }) {
  const pathname = usePathname();
  return (
    <>
      <WorkspaceSwitcher />
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--panel)] py-3">
        <AnimatedGlyph running={running} />
        {items.map(({ label, icon: Icon, href }) => {
          // Strip query string when computing active state — Chat's href is
          // "/?new=1" but the displayed pathname is just "/".
          const hrefPath = href ? href.split("?")[0] : undefined;
          const active = hrefPath ? pathname === hrefPath : false;
          const cls = cn(
            "flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted)]",
            "hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
            active && "bg-[var(--panel-2)] text-[var(--foreground)]",
          );
          if (href) {
            return (
              <Link key={label} href={href} title={label} className={cls}>
                <Icon className="h-4.5 w-4.5" />
              </Link>
            );
          }
          return (
            <button key={label} title={label} className={cls} disabled>
              <Icon className="h-4.5 w-4.5" />
            </button>
          );
        })}
      </aside>
    </>
  );
}
