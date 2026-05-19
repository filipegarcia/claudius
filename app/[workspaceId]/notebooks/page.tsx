"use client";

import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  CircleStop,
  Code2,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Play,
  Type,
  Trash2,
  ArrowDown,
  ArrowUp,
  Sigma,
  Sparkles,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

/**
 * Notebooks — a faked Jupyter-style notebook runner rendered fully in the
 * browser.
 *
 * Demo customization: no kernel, no execution, no file I/O. The notebook
 * is a static fixture of code + markdown cells with pre-rendered outputs,
 * picked to read as a real data-science walkthrough. Use this as the
 * scaffold when wiring up a real `ipykernel` / `jupyter-client` adapter.
 */

type CodeOutput =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "result"; text: string }
  | { kind: "table"; columns: string[]; rows: (string | number)[][] }
  | { kind: "plot"; svg: React.ReactNode; caption?: string }
  | { kind: "html"; html: string };

type Cell =
  | {
      kind: "code";
      id: string;
      executionCount: number | null;
      source: string[];
      outputs: CodeOutput[];
      /** `running` shows a hollow square + pulsing in-progress marker. */
      state?: "idle" | "running";
    }
  | {
      kind: "markdown";
      id: string;
      source: React.ReactNode;
    };

const NOTEBOOK: { filename: string; cells: Cell[] } = {
  filename: "signal_explore.ipynb",
  cells: [
    {
      kind: "markdown",
      id: "md1",
      source: (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">
            Signal exploration · Q2 backfill
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Pulling the last seven days of <code className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[12px]">project_signal</code>{" "}
            rows from the read replica, cleaning a handful of outliers, and
            looking for a daily-cadence pattern worth alerting on.
          </p>
        </>
      ),
    },
    {
      kind: "code",
      id: "c1",
      executionCount: 1,
      source: [
        "import pandas as pd",
        "import numpy as np",
        "import matplotlib.pyplot as plt",
        "",
        "from claudius.signals import load_recent",
        "",
        "df = load_recent(days=7)",
        "df.head()",
      ],
      outputs: [
        {
          kind: "table",
          columns: ["id", "kind", "score", "created_at", "actor"],
          rows: [
            ["08af2c", "geo_anomaly", 0.92, "2026-05-12 06:14", "watcher-01"],
            ["12cb88", "amount_spike", 0.81, "2026-05-12 05:48", "watcher-02"],
            ["12cc04", "mcc_drift", 0.74, "2026-05-12 05:31", "watcher-01"],
            ["12cc11", "geo_anomaly", 0.68, "2026-05-12 05:22", "watcher-03"],
            ["12cd99", "velocity", 0.62, "2026-05-12 04:55", "watcher-02"],
          ],
        },
      ],
    },
    {
      kind: "markdown",
      id: "md2",
      source: (
        <>
          <h2 className="text-lg font-semibold tracking-tight text-[var(--foreground)]">
            1. Drop the spike outliers
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            A handful of <code className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[12px]">amount_spike</code> rows are
            sitting at <code className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[12px]">score &gt; 0.97</code> — almost
            always a re-fired retry from the upstream job. Clip them.
          </p>
        </>
      ),
    },
    {
      kind: "code",
      id: "c2",
      executionCount: 2,
      source: [
        "before = len(df)",
        "df = df[~((df['kind'] == 'amount_spike') & (df['score'] > 0.97))]",
        "print(f'dropped {before - len(df):,} retry rows · {len(df):,} remain')",
      ],
      outputs: [
        { kind: "stdout", text: "dropped 184 retry rows · 12,318 remain" },
      ],
    },
    {
      kind: "code",
      id: "c3",
      executionCount: 3,
      source: [
        "hourly = df.set_index('created_at').resample('H')['score'].mean()",
        "fig, ax = plt.subplots(figsize=(9, 3))",
        "ax.fill_between(hourly.index, hourly.values, alpha=0.18, color='#d97757')",
        "ax.plot(hourly.index, hourly.values, color='#d97757', lw=1.5)",
        "ax.set_title('mean signal score, hourly')",
        "ax.set_ylabel('score')",
        "fig.tight_layout(); plt.show()",
      ],
      outputs: [
        {
          kind: "plot",
          svg: <FakePlot />,
          caption: "Figure 1 — mean signal score, hourly · last 7d",
        },
      ],
    },
    {
      kind: "code",
      id: "c4",
      executionCount: null,
      state: "running",
      source: [
        "from sklearn.ensemble import IsolationForest",
        "",
        "clf = IsolationForest(contamination=0.04, random_state=42)",
        "df['anomaly'] = clf.fit_predict(df[['score']])",
        "df.groupby('kind')['anomaly'].value_counts()",
      ],
      outputs: [],
    },
  ],
};

export default function NotebooksPage() {
  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="notebooks-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3 w-3" />
            Back
          </Link>
          <div className="flex items-center gap-2 text-[var(--foreground)]">
            <BookOpen className="h-3.5 w-3.5" />
            <span className="font-medium">Notebooks</span>
          </div>
          <span className="text-[var(--muted)]">Python 3.12 · kernel ipykernel</span>
          <div className="ml-auto flex items-center gap-3 text-[10px] text-[var(--muted)]">
            <span>idle · last saved 14:08:42</span>
            <button
              className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Refresh kernel"
            >
              <RefreshCw className="h-3 w-3" />
              Restart
            </button>
          </div>
        </header>

        <div data-testid="notebooks-page" className="flex flex-1 overflow-hidden">
          <FileTree />
          <Workbench />
        </div>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* File tree                                                                 */
/* ----------------------------------------------------------------------- */

function FileTree() {
  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--panel)] text-[12px]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        <FolderOpen className="h-3.5 w-3.5" />
        Files
        <span className="ml-auto flex items-center gap-1">
          <button className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]" title="New notebook">
            <Plus className="h-3 w-3" />
          </button>
        </span>
      </div>
      <div className="flex-1 overflow-auto py-1 text-[var(--foreground)]/85">
        <TreeRow icon={<FolderOpen className="h-3.5 w-3.5 text-[#d97757]" />} label="notebooks/" indent={0} bold />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#9ca0a6]" />} label="bulk_signal_replay.ipynb" indent={1} muted />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#d97757]" />} label="signal_explore.ipynb" indent={1} active />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#9ca0a6]" />} label="merchant_clusters.ipynb" indent={1} muted />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#9ca0a6]" />} label="incident-2026-04-22.ipynb" indent={1} muted />
        <TreeRow icon={<FolderOpen className="h-3.5 w-3.5 text-[#d97757]" />} label="src/" indent={0} bold />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#9ca0a6]" />} label="signals.py" indent={1} muted />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#9ca0a6]" />} label="load_recent.py" indent={1} muted />
        <TreeRow icon={<FileText className="h-3.5 w-3.5 text-[#9ca0a6]" />} label="utils.py" indent={1} muted />
      </div>
    </aside>
  );
}

function TreeRow({
  icon,
  label,
  indent,
  active,
  muted,
  bold,
}: {
  icon: React.ReactNode;
  label: string;
  indent: number;
  active?: boolean;
  muted?: boolean;
  bold?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 hover:bg-[var(--panel-2)]",
        active && "bg-[var(--accent)]/15 text-[var(--accent)]",
        muted && !active && "text-[var(--muted)]",
        bold && "font-medium",
      )}
      style={{ paddingLeft: 8 + indent * 14 }}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Notebook surface                                                          */
/* ----------------------------------------------------------------------- */

function Workbench() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <NotebookToolbar />
      <div className="flex-1 overflow-auto bg-[var(--background)] py-6">
        <div className="mx-auto max-w-4xl space-y-3 px-6">
          {NOTEBOOK.cells.map((cell) =>
            cell.kind === "code" ? <CodeCell key={cell.id} cell={cell} /> : <MarkdownCell key={cell.id} cell={cell} />,
          )}
        </div>
      </div>
    </div>
  );
}

function NotebookToolbar() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--panel)] px-3 text-[11px] text-[var(--muted)]">
      <span className="font-mono text-[12px] text-[var(--foreground)]">{NOTEBOOK.filename}</span>
      <span className="ml-2 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px]">
        modified
      </span>
      <div className="mx-3 h-4 w-px bg-[var(--border)]" />
      <ToolbarBtn title="Save (⌘S)">
        <Save className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Add cell below">
        <Plus className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Move cell up">
        <ArrowUp className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Move cell down">
        <ArrowDown className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn title="Delete cell">
        <Trash2 className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <div className="mx-3 h-4 w-px bg-[var(--border)]" />
      <ToolbarBtn title="Run cell (⇧⏎)">
        <Play className="h-3.5 w-3.5 text-emerald-400" />
      </ToolbarBtn>
      <ToolbarBtn title="Interrupt kernel">
        <CircleStop className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <button className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]">
        Code
        <ChevronDown className="h-3 w-3" />
      </button>
      <div className="ml-auto flex items-center gap-3 text-[10px]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
          Kernel: ipykernel · 3.12.4
        </span>
        <span className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5">
          <Sigma className="h-3 w-3" />
          AI assist
          <Sparkles className="h-3 w-3 text-[var(--accent)]" />
        </span>
      </div>
    </div>
  );
}

function ToolbarBtn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      className="flex h-7 w-7 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
      title={title}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------------- */
/* Code cell                                                                  */
/* ----------------------------------------------------------------------- */

const PY_KW = new Set([
  "import",
  "from",
  "as",
  "def",
  "return",
  "if",
  "else",
  "elif",
  "in",
  "for",
  "while",
  "not",
  "and",
  "or",
  "True",
  "False",
  "None",
  "with",
  "class",
  "yield",
  "lambda",
  "print",
]);

function highlight(line: string): React.ReactNode {
  // Conservative tokeniser: keywords, numbers, strings, comments,
  // function-call names (whatever's before "("). Good enough for the demo
  // and small enough to stay readable in JSX.
  if (line.trim().startsWith("#")) {
    return <span className="text-[var(--muted)]/80">{line}</span>;
  }
  const out: React.ReactNode[] = [];
  // Match strings first (greedy), then split the rest on word boundaries.
  const tokenRe = /'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+(?:\.[0-9]+)?|\s+|[^\w\s]/g;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = tokenRe.exec(line)) !== null) {
    const t = m[0];
    if (/^['"]/.test(t)) {
      out.push(
        <span key={key++} className="text-[#6aab73]">
          {t}
        </span>,
      );
    } else if (PY_KW.has(t)) {
      out.push(
        <span key={key++} className="text-[#cf8e6d]">
          {t}
        </span>,
      );
    } else if (/^[0-9]+(\.[0-9]+)?$/.test(t)) {
      out.push(
        <span key={key++} className="text-[#2aacb8]">
          {t}
        </span>,
      );
    } else if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(t)) {
      // Function-call: peek ahead in the original line for "(" after this match.
      const next = line[m.index + t.length];
      if (next === "(") {
        out.push(
          <span key={key++} className="text-[#56a8f5]">
            {t}
          </span>,
        );
      } else {
        out.push(<span key={key++}>{t}</span>);
      }
    } else {
      out.push(<span key={key++}>{t}</span>);
    }
  }
  return out;
}

function CodeCell({ cell }: { cell: Extract<Cell, { kind: "code" }> }) {
  const running = cell.state === "running";
  return (
    <div
      className={cn(
        "group rounded-lg border bg-[var(--panel)]",
        running ? "border-[var(--accent)]/60" : "border-[var(--border)]",
      )}
    >
      {/* Source pane */}
      <div className="flex">
        <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-2 border-r border-[var(--border)] bg-[var(--panel-2)]/40 py-2 text-[10px] text-[var(--muted)]">
          <span className="flex items-center gap-1 font-mono">
            <Code2 className="h-3 w-3" />
          </span>
          <span className="tabular-nums">
            {cell.executionCount === null ? (running ? "[*]" : "[ ]") : `[${cell.executionCount}]`}
          </span>
        </div>
        <pre className="flex-1 overflow-auto px-4 py-2.5 font-mono text-[13px] leading-[1.55] text-[var(--foreground)]/90">
          {cell.source.map((line, i) => (
            <div key={i} className="whitespace-pre">
              {highlight(line) || " "}
            </div>
          ))}
        </pre>
      </div>
      {/* Outputs */}
      {cell.outputs.length > 0 && (
        <div className="border-t border-[var(--border)]/60 bg-[var(--background)]">
          {cell.outputs.map((o, i) => (
            <CellOutput key={i} output={o} />
          ))}
        </div>
      )}
      {running && (
        <div className="flex items-center gap-2 border-t border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-2 text-[11px] text-[var(--accent)]">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
          Kernel running this cell…
        </div>
      )}
    </div>
  );
}

function CellOutput({ output }: { output: CodeOutput }) {
  if (output.kind === "stdout") {
    return (
      <pre className="whitespace-pre-wrap px-4 py-2 font-mono text-[12px] text-[var(--foreground)]/80">
        {output.text}
      </pre>
    );
  }
  if (output.kind === "stderr") {
    return (
      <pre className="whitespace-pre-wrap px-4 py-2 font-mono text-[12px] text-red-300">{output.text}</pre>
    );
  }
  if (output.kind === "result") {
    return (
      <pre className="whitespace-pre-wrap px-4 py-2 font-mono text-[12px] text-[var(--foreground)]">{output.text}</pre>
    );
  }
  if (output.kind === "table") {
    return (
      <div className="overflow-auto px-4 py-2">
        <table className="min-w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--muted)]">
              {output.columns.map((c, i) => (
                <th key={i} className="border-b border-[var(--border)] px-2 py-1 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {output.rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border)]/40 last:border-b-0 hover:bg-[var(--panel-2)]/40">
                {row.map((cell, j) => (
                  <td key={j} className="px-2 py-1 font-mono text-[var(--foreground)]/80 tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (output.kind === "plot") {
    return (
      <div className="px-4 py-3">
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          {output.svg}
        </div>
        {output.caption && (
          <div className="mt-2 text-center text-[10px] italic text-[var(--muted)]">{output.caption}</div>
        )}
      </div>
    );
  }
  return null;
}

function MarkdownCell({ cell }: { cell: Extract<Cell, { kind: "markdown" }> }) {
  return (
    <div className="group flex">
      <div className="w-12 shrink-0 pt-1 text-center text-[10px] text-[var(--muted)]/60">
        <Type className="mx-auto h-3 w-3" />
      </div>
      <div className="flex-1 px-2 py-2 leading-relaxed">{cell.source}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Fake matplotlib plot                                                       */
/* ----------------------------------------------------------------------- */

function FakePlot() {
  // Hand-tuned curve so the screenshot has a recognisable area + line plot
  // instead of a generic placeholder. ViewBox is 9:3 to match the figsize.
  const w = 720;
  const h = 220;
  const pts: Array<[number, number]> = [];
  // Synth points: clear daily rhythm with a gentle uptrend.
  const N = 60;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const day = Math.sin(t * 4 * Math.PI + 0.8) * 0.18; // 2 full days visible
    const drift = t * 0.18;
    const noise = Math.sin(t * 22) * 0.04;
    const y = 0.45 + day + drift + noise;
    pts.push([20 + t * (w - 40), h - 20 - y * (h - 50)]);
  }
  const path = pts
    .map(([x, y], i) => (i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`))
    .join(" ");
  const area = `${path} L ${pts[pts.length - 1][0].toFixed(1)} ${h - 20} L ${pts[0][0].toFixed(1)} ${h - 20} Z`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} className="block">
      <defs>
        <linearGradient id="nb-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d97757" stopOpacity="0.36" />
          <stop offset="100%" stopColor="#d97757" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* axes */}
      {[0.25, 0.5, 0.75, 1].map((g, i) => (
        <line
          key={i}
          x1={20}
          x2={w - 20}
          y1={h - 20 - g * (h - 50)}
          y2={h - 20 - g * (h - 50)}
          stroke="rgba(154,154,163,0.18)"
          strokeWidth={1}
        />
      ))}
      <line x1={20} x2={w - 20} y1={h - 20} y2={h - 20} stroke="rgba(154,154,163,0.5)" strokeWidth={1} />
      <line x1={20} x2={20} y1={20} y2={h - 20} stroke="rgba(154,154,163,0.5)" strokeWidth={1} />
      <path d={area} fill="url(#nb-fill)" />
      <path d={path} fill="none" stroke="#d97757" strokeWidth={1.8} />
      <text x={w / 2} y={16} textAnchor="middle" fontSize="11" fill="#bcbec4" fontFamily="ui-sans-serif">
        mean signal score, hourly
      </text>
      <text x={6} y={h / 2 + 4} textAnchor="middle" fontSize="9" fill="#9ca0a6" transform={`rotate(-90 6 ${h / 2})`}>
        score
      </text>
    </svg>
  );
}
