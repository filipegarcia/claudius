"use client";

import { useEffect, useState } from "react";
import { Overlay } from "./Overlay";

type ContextResponse = {
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: { color: string; isFilled: boolean; categoryName: string; tokens: number; percentage: number; squareFullness: number }[][];
  model: string;
  memoryFiles: { path: string; type: string; tokens: number }[];
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  deferredBuiltinTools?: { name: string; tokens: number; isLoaded: boolean }[];
};

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

type Props = {
  sessionId: string | null;
  onClose: () => void;
};

export function ContextOverlay({ sessionId, onClose }: Props) {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/sessions/${sessionId}/context`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ContextResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <Overlay title="Context window" subtitle={`/context · ${data?.model ?? ""}`} onClose={onClose} width={760}>
      {loading && <div className="px-4 py-6 text-center text-sm text-[var(--muted)]">Loading…</div>}
      {error && <div className="px-4 py-6 text-center text-sm text-red-400">{error}</div>}
      {data && (
        <div className="space-y-5 px-4 py-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between text-[11px] text-[var(--muted)]">
              <span>
                <span className="font-mono text-sm text-[var(--foreground)]">{fmtTokens(data.totalTokens)}</span> /{" "}
                {fmtTokens(data.maxTokens)} tokens · {data.percentage}%
              </span>
              <span>
                raw cap {fmtTokens(data.rawMaxTokens)}
              </span>
            </div>
            <Grid grid={data.gridRows} />
          </div>
          <Section title="Categories">
            <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {data.categories.map((c) => (
                <li key={c.name} className="flex items-center gap-2 rounded-md bg-[var(--panel-2)]/40 px-2 py-1">
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: c.color }} />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="font-mono text-[var(--muted)]">{fmtTokens(c.tokens)}</span>
                </li>
              ))}
            </ul>
          </Section>
          {data.memoryFiles.length > 0 && (
            <Section title={`Memory files (${data.memoryFiles.length})`}>
              <ul className="space-y-1 text-xs">
                {data.memoryFiles.map((f) => (
                  <li key={f.path} className="flex items-baseline justify-between gap-2 rounded-md bg-[var(--panel-2)]/40 px-2 py-1">
                    <span className="truncate font-mono">{f.path}</span>
                    <span className="text-[var(--muted)]">
                      {f.type} · {fmtTokens(f.tokens)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {data.mcpTools.length > 0 && (
            <Section title={`MCP tools (${data.mcpTools.length})`}>
              <ul className="space-y-1 text-xs">
                {data.mcpTools.map((t) => (
                  <li
                    key={`${t.serverName}/${t.name}`}
                    className="flex items-baseline justify-between gap-2 rounded-md bg-[var(--panel-2)]/40 px-2 py-1"
                  >
                    <span className="truncate font-mono">
                      {t.serverName}.{t.name}
                    </span>
                    <span className="text-[var(--muted)]">
                      {t.isLoaded ? "loaded" : "deferred"} · {fmtTokens(t.tokens)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {data.deferredBuiltinTools && data.deferredBuiltinTools.length > 0 && (
            <Section title="Deferred built-in tools">
              <ul className="space-y-1 text-xs">
                {data.deferredBuiltinTools.map((t) => (
                  <li key={t.name} className="flex items-baseline justify-between gap-2 rounded-md bg-[var(--panel-2)]/40 px-2 py-1">
                    <span className="truncate font-mono">{t.name}</span>
                    <span className="text-[var(--muted)]">
                      {t.isLoaded ? "loaded" : "deferred"} · {fmtTokens(t.tokens)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </Overlay>
  );
}

function Grid({ grid }: { grid: ContextResponse["gridRows"] }) {
  if (grid.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-2">
      <div className="grid gap-[2px]" style={{ gridTemplateRows: `repeat(${grid.length}, 14px)` }}>
        {grid.map((row, ri) => (
          <div key={ri} className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${row.length}, 14px)` }}>
            {row.map((cell, ci) => (
              <div
                key={ci}
                title={`${cell.categoryName} · ${cell.tokens.toLocaleString()} tok`}
                className="rounded-[2px]"
                style={{
                  background: cell.isFilled ? cell.color : "color-mix(in oklab, var(--panel-2) 80%, transparent)",
                  opacity: cell.isFilled ? Math.max(0.35, cell.squareFullness || 1) : 0.4,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">{title}</h3>
      {children}
    </section>
  );
}
