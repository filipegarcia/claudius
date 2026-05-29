"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Database as DatabaseIcon,
  History,
  Play,
  Square,
  Settings,
  Save,
  Calendar,
  Server,
  Folder,
  FolderOpen,
  AlertCircle,
  CheckCircle2,
  ChevronUp,
  ChevronDown as ChevronDownSmall,
  Plus,
  RefreshCw,
  Layers,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

/**
 * Database — a faked JetBrains-DataGrip-style SQL console rendered fully
 * in the browser.
 *
 * This is a demo customization: no real database connection, no
 * server-side state, no auth. The tabs, schemas, console contents, and
 * tree are static fixtures designed to look like a working IDE so we can
 * showcase the customize → publish workflow on the marketing site.
 *
 * Drop a real adapter in {@link CONSOLES}/{@link TREE} when you want to
 * wire it up to a real engine (Postgres / Clickhouse / etc.).
 */

type ConsoleTab = {
  id: string;
  label: string;
  engine: "postgres" | "python" | "clickhouse";
  /** Lines of the active document. Tokens carry their tone. */
  lines: SqlLine[];
  /** Inline error/warning counts shown in the top-right of the editor. */
  errors: number;
  warnings: number;
  schemaLabel: string;
};

type SqlToken = {
  text: string;
  tone?: "kw" | "fn" | "tbl" | "col" | "str" | "num" | "comment" | "op" | "id";
  /** Render a wavy red underline on this token (spell-check decoration). */
  spelling?: boolean;
};

type SqlLine = {
  tokens: SqlToken[];
  /** Whole-line tone wins over per-token (used for comments). */
  tone?: "comment";
};

const CONSOLES: ConsoleTab[] = [
  {
    id: "screening-demo",
    label: "console [screening - Demo]",
    engine: "postgres",
    errors: 0,
    warnings: 4,
    schemaLabel: "screening.<schema>",
    lines: [],
  },
  {
    id: "staging-front",
    label: "console [01 - staging - Front]",
    engine: "postgres",
    errors: 2,
    warnings: 1,
    schemaLabel: "front.<schema>",
    lines: [],
  },
  {
    id: "consume-url",
    label: "consume_url_processing.py",
    engine: "python",
    errors: 0,
    warnings: 0,
    schemaLabel: "python · 3.12",
    lines: [],
  },
  {
    id: "api-localhost",
    label: "console [api@localhost]",
    engine: "postgres",
    errors: 18,
    warnings: 18,
    schemaLabel: "api.<schema>",
    lines: [
      {
        tokens: [
          { text: "select", tone: "kw" },
          { text: " * ", tone: "op" },
          { text: "from", tone: "kw" },
          { text: " " },
          { text: "project_institution", tone: "tbl", spelling: false },
        ],
      },
      {
        tokens: [
          { text: "where", tone: "kw" },
          { text: " " },
          { text: "id", tone: "col" },
          { text: " = " },
          { text: "'c7a38ee8-cf5d-4edb-9f2f-4c301580040e'", tone: "str" },
        ],
      },
      { tone: "comment", tokens: [{ text: "--" }] },
      { tokens: [{ text: " " }] },
      { tokens: [{ text: " " }] },
      {
        tone: "comment",
        tokens: [{ text: "--my portfolio - f5d3d41d-7883-4fd1-946c-6b60143ddc6b mastercard" }],
      },
      { tone: "comment", tokens: [{ text: "         -- a0d02afb-b4a7-4f42-b6ea-207c6432c820 ISF" }] },
      { tone: "comment", tokens: [{ text: "--d55492a0-a566-4e2f-b866-fa5053a58e41 neutral" }] },
      { tokens: [{ text: " " }] },
      {
        tokens: [
          { text: "select", tone: "kw" },
          { text: " * ", tone: "op" },
          { text: "from", tone: "kw" },
          { text: " " },
          { text: "project_institution", tone: "tbl", spelling: true },
        ],
      },
      {
        tone: "comment",
        tokens: [{ text: "--where id = 'd55492a0-a566-4e2f-b866-fa5053a58e41'" }],
      },
      { tone: "comment", tokens: [{ text: "--" }] },
      {
        tokens: [
          { text: "select", tone: "kw" },
          { text: " *", tone: "op" },
        ],
      },
      {
        tokens: [
          { text: "from", tone: "kw" },
          { text: " " },
          { text: "project_institution_settings", tone: "tbl" },
        ],
      },
      {
        tokens: [
          { text: "where", tone: "kw" },
          { text: " " },
          { text: "institution_id", tone: "col" },
          { text: " =" },
          { text: "'11111111-2222-4333-8444-555555555555'", tone: "str" },
        ],
      },
      { tokens: [{ text: " " }] },
      {
        tokens: [
          { text: ";", tone: "op" },
        ],
      },
      {
        tone: "comment",
        tokens: [{ text: "-- f0a61054-4991-4041-9f06-09d35d53dbaa - " }, { text: "natixix", tone: "id" }],
      },
      { tokens: [{ text: " " }] },
      {
        tokens: [
          { text: "select", tone: "kw" },
          { text: " *", tone: "op" },
        ],
      },
      {
        tokens: [
          { text: "from", tone: "kw" },
          { text: " " },
          { text: "project_user", tone: "tbl" },
        ],
      },
      {
        tone: "comment",
        tokens: [{ text: "--where email " }, { text: "ilike", tone: "id" }, { text: " 'test-user%';" }],
      },
      { tokens: [{ text: " " }] },
      {
        tokens: [
          { text: "select", tone: "kw" },
          { text: " ", tone: "op" },
          { text: "count", tone: "fn" },
          { text: "(*) " },
          { text: "from", tone: "kw" },
          { text: " " },
          { text: "project_signal", tone: "tbl" },
        ],
      },
      {
        tokens: [
          { text: "where", tone: "kw" },
          { text: " " },
          { text: "created_at", tone: "col" },
          { text: " >= " },
          { text: "now", tone: "fn" },
          { text: "() - " },
          { text: "interval", tone: "kw" },
          { text: " " },
          { text: "'7 days'", tone: "str" },
        ],
      },
      { tokens: [{ text: " " }] },
    ],
  },
];

type TreeNode = {
  id: string;
  label: string;
  /** Short suffix in muted color. */
  badge?: string;
  icon: "folder" | "postgres" | "clickhouse" | "schema" | "table";
  children?: TreeNode[];
  /** Selected at boot. */
  selected?: boolean;
  /** Expanded at boot. */
  open?: boolean;
};

const TREE: TreeNode[] = [
  {
    id: "localhost",
    label: "Localhost",
    icon: "folder",
    open: true,
    children: [
      {
        id: "api",
        label: "api@localhost",
        icon: "postgres",
        badge: "1 of 2",
        open: true,
        selected: true,
        children: [
          {
            id: "api-schema",
            label: "api",
            icon: "schema",
            badge: "1 of 3",
          },
          {
            id: "server-objects",
            label: "Server Objects",
            icon: "folder",
          },
        ],
      },
      {
        id: "risk-api",
        label: "risk-api@localhost",
        icon: "postgres",
        badge: "1",
      },
      {
        id: "screening",
        label: "screening@localhost",
        icon: "postgres",
      },
    ],
  },
  { id: "prod", label: "PROD", icon: "folder" },
  { id: "staging", label: "Staging", icon: "folder" },
  { id: "demo", label: "Demo", icon: "folder" },
  { id: "clickhouse", label: "Clickhouse", icon: "clickhouse", badge: "1 of 4" },
  { id: "prod-dl", label: "Prod DL", icon: "postgres", badge: "1 of 4" },
];

const TOKEN_TONES: Record<NonNullable<SqlToken["tone"]>, string> = {
  // Colors picked to read on the existing dark surface and roughly match a
  // DataGrip-flavoured monokai. We don't theme these via CSS vars because
  // syntax highlighting deliberately uses fixed hues regardless of theme.
  kw: "text-[#cf8e6d]",
  fn: "text-[#56a8f5]",
  tbl: "text-[#bcbec4] underline decoration-dotted decoration-[#5b5d63] underline-offset-2",
  col: "text-[#bcbec4]",
  str: "text-[#6aab73]",
  num: "text-[#2aacb8]",
  comment: "text-[#7a7e85]",
  op: "text-[#bcbec4]",
  id: "text-[#bcbec4]",
};

export default function DatabasePage() {
  const [activeId, setActiveId] = useState<string>("api-localhost");
  const active = CONSOLES.find((c) => c.id === activeId) ?? CONSOLES[0];

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="database-main" className="flex h-full flex-1 flex-col overflow-hidden bg-[#1e1f22]">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[#393b40] bg-[#2b2d30] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[#9ca0a6] hover:text-[#cfd2d6]">
            <ArrowLeft className="h-3 w-3" />
            Back
          </Link>
          <div className="flex items-center gap-2 text-[#cfd2d6]">
            <DatabaseIcon className="h-3.5 w-3.5" />
            <span className="font-medium">Database</span>
          </div>
          <span className="text-[#7a7e85]">
            {CONSOLES.length} consoles · 4 connections
          </span>
          <div className="ml-auto flex items-center gap-3 text-[10px] text-[#7a7e85]">
            <span>sampled 14:08:42 · auto-refresh 5s</span>
            <button
              className="flex items-center gap-1 rounded border border-[#393b40] px-2 py-0.5 text-[#9ca0a6] hover:bg-[#2b2d30] hover:text-[#cfd2d6]"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>
        </header>

        <div data-testid="database-page" className="flex flex-1 overflow-hidden">
          {/* ── Editor column ─────────────────────────────────────────── */}
          <div className="flex flex-1 flex-col overflow-hidden border-r border-[#393b40]">
            <ConsoleTabs tabs={CONSOLES} activeId={activeId} onSelect={setActiveId} />
            <ConsoleToolbar active={active} />
            <SqlEditor active={active} />
          </div>

          {/* ── Database tree ─────────────────────────────────────────── */}
          <DatabasePanel />
        </div>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Tab strip                                                                 */
/* ----------------------------------------------------------------------- */

function ConsoleTabs({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: ConsoleTab[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div data-testid="database-tabs" className="flex h-8 shrink-0 items-stretch border-b border-[#393b40] bg-[#2b2d30] text-[12px]">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              "group flex items-center gap-2 border-r border-[#393b40] px-3",
              active
                ? "bg-[#3a578e]/30 text-[#cfd2d6]"
                : "text-[#9ca0a6] hover:bg-[#2e3035] hover:text-[#cfd2d6]",
              active && "border-b-2 border-b-[#3574f0]",
            )}
            title={t.label}
          >
            <EngineDot engine={t.engine} />
            <span className="truncate max-w-[260px]">{t.label}</span>
            {active && (
              <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-[#9ca0a6] hover:bg-[#393b40] hover:text-[#cfd2d6]">
                ×
              </span>
            )}
          </button>
        );
      })}
      <button
        className="flex w-8 items-center justify-center border-r border-[#393b40] text-[#7a7e85] hover:bg-[#2e3035] hover:text-[#cfd2d6]"
        title="New console"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="flex-1 border-b border-[#393b40]" />
      <button className="flex w-7 items-center justify-center text-[#7a7e85] hover:bg-[#2e3035] hover:text-[#cfd2d6]" title="Tab options">
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function EngineDot({ engine }: { engine: ConsoleTab["engine"] }) {
  if (engine === "python") {
    return <span className="inline-block h-3 w-3 rounded-sm bg-gradient-to-br from-[#3776ab] to-[#ffd43b]" />;
  }
  if (engine === "clickhouse") {
    return <span className="inline-block h-3 w-3 rounded-sm bg-gradient-to-br from-[#fec036] to-[#fdc636]" />;
  }
  // Postgres elephant placeholder — a small navy square is enough at
  // this size to read as "postgres" alongside the tab label.
  return <span className="inline-block h-3 w-3 rounded-sm bg-[#336791]" />;
}

/* ----------------------------------------------------------------------- */
/* Toolbar                                                                   */
/* ----------------------------------------------------------------------- */

function ConsoleToolbar({ active }: { active: ConsoleTab }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#393b40] bg-[#2b2d30] px-2 text-[11px] text-[#9ca0a6]">
      <ToolbarBtn title="Execute (⌘⏎)">
        <Play className="h-3.5 w-3.5 text-[#5eb27d]" />
      </ToolbarBtn>
      <ToolbarBtn title="Execute current statement">
        <Layers className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Query history">
        <History className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Playground">
        <span className="rounded-sm bg-[#393b40] px-1 font-mono text-[10px]">P</span>
      </ToolbarBtn>
      <ToolbarBtn title="Configure data sources">
        <Settings className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Output tool window">
        <Save className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <div className="mx-1 h-4 w-px bg-[#393b40]" />
      <button className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[#393b40] hover:text-[#cfd2d6]" title="Transaction mode">
        <span>Tx: Auto</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      <ToolbarBtn title="Stop">
        <Square className="h-3 w-3 text-[#7a7e85]" />
      </ToolbarBtn>
      <div className="mx-1 h-4 w-px bg-[#393b40]" />
      <button className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[#393b40] hover:text-[#cfd2d6]" title="Run target">
        <Calendar className="h-3 w-3" />
        <span>Playground</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      <div className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[#9ca0a6]">
        <Server className="h-3 w-3" />
        <span className="font-mono">{active.schemaLabel}</span>
        <ChevronDown className="h-3 w-3" />
      </div>
    </div>
  );
}

function ToolbarBtn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      className="flex h-7 w-7 items-center justify-center rounded text-[#9ca0a6] hover:bg-[#393b40] hover:text-[#cfd2d6]"
      title={title}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------------- */
/* SQL editor                                                                */
/* ----------------------------------------------------------------------- */

function SqlEditor({ active }: { active: ConsoleTab }) {
  return (
    <div className="relative flex flex-1 overflow-auto bg-[#1e1f22] font-mono text-[13px] leading-[1.7]">
      {/* Gutter */}
      <div className="sticky left-0 z-10 select-none bg-[#1e1f22] py-3 pl-4 pr-3 text-right text-[#5b5d63]">
        {active.lines.map((_, i) => (
          <div key={i} className="tabular-nums">
            {String(i + 1).padStart(2, " ")}
          </div>
        ))}
      </div>
      {/* Lines */}
      <div className="relative flex-1 py-3 pr-6">
        {active.lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre",
              line.tone === "comment" && "text-[#7a7e85]",
            )}
          >
            {line.tokens.length === 0 ? (
              " "
            ) : (
              line.tokens.map((tok, ti) => (
                <span
                  key={ti}
                  className={cn(
                    tok.tone && TOKEN_TONES[tok.tone],
                    tok.spelling && "decoration-wavy decoration-red-400 underline",
                  )}
                >
                  {tok.text || " "}
                </span>
              ))
            )}
          </div>
        ))}

        {/* Right gutter: error/warning summary and a fold marker, like
            DataGrip's "x errors, y warnings" pill in the top-right. */}
        <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-2 text-[11px]">
          <div className="flex items-center gap-1 rounded-md bg-[#2b2d30]/80 px-1.5 py-0.5">
            <AlertCircle className="h-3 w-3 text-[#e16767]" />
            <span className="font-sans tabular-nums text-[#bcbec4]">{active.errors}</span>
            <CheckCircle2 className="ml-1 h-3 w-3 text-[#5eb27d]" />
            <span className="font-sans tabular-nums text-[#bcbec4]">{active.warnings}</span>
            <ChevronUp className="ml-0.5 h-3 w-3 text-[#7a7e85]" />
            <ChevronDownSmall className="h-3 w-3 text-[#7a7e85]" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Database tree pane                                                        */
/* ----------------------------------------------------------------------- */

function DatabasePanel() {
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden bg-[#2b2d30] text-[12px] text-[#cfd2d6]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#393b40] px-3 text-[11px] font-medium uppercase tracking-wide text-[#9ca0a6]">
        <DatabaseIcon className="h-3.5 w-3.5" />
        <span>Database</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="flex h-5 w-5 items-center justify-center rounded text-[#9ca0a6] hover:bg-[#393b40]" title="New">
            <Plus className="h-3 w-3" />
          </button>
          <button className="flex h-5 w-5 items-center justify-center rounded text-[#9ca0a6] hover:bg-[#393b40]" title="Refresh">
            <RefreshCw className="h-3 w-3" />
          </button>
          <button className="flex h-5 w-5 items-center justify-center rounded text-[#9ca0a6] hover:bg-[#393b40]" title="Options">
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {TREE.map((n) => (
          <TreeRow key={n.id} node={n} depth={0} />
        ))}
      </div>
    </aside>
  );
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState<boolean>(node.open ?? false);
  const hasChildren = !!(node.children && node.children.length > 0);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[#393b40]",
          node.selected && "bg-[#2f5db0]/40",
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
        title={node.label}
      >
        {hasChildren ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-[#7a7e85]" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-[#7a7e85]" />
          )
        ) : (
          <span className="w-3" />
        )}
        <TreeIcon kind={node.icon} open={open} />
        <span className="truncate text-[#cfd2d6]">{node.label}</span>
        {node.badge && (
          <span className="ml-auto rounded bg-[#393b40]/60 px-1.5 text-[10px] tabular-nums text-[#9ca0a6]">
            {node.badge}
          </span>
        )}
      </button>
      {hasChildren && open && (
        <div>
          {node.children!.map((c) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeIcon({ kind, open }: { kind: TreeNode["icon"]; open: boolean }) {
  if (kind === "folder") {
    return open ? (
      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#a8763e]" />
    ) : (
      <Folder className="h-3.5 w-3.5 shrink-0 text-[#a8763e]" />
    );
  }
  if (kind === "clickhouse") {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="block h-3 w-3 rounded-sm bg-gradient-to-b from-[#fec036] to-[#fdc636]" />
      </span>
    );
  }
  if (kind === "schema") {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[#56a8f5]">
        <Layers className="h-3.5 w-3.5" />
      </span>
    );
  }
  // postgres / table: a small navy box with a subtle highlight
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span className="block h-3 w-3 rounded-sm bg-[#336791]" />
    </span>
  );
}
