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

/**
 * The SDK ships theme tokens (e.g. `"promptBorder"`, `"inactive"`, `"claude"`,
 * `"purple_FOR_SUBAGENTS_ONLY"`) instead of CSS color strings. Setting
 * `background: promptBorder` is invalid CSS and renders as transparent —
 * which is exactly the "empty bar" symptom users were seeing. Map every known
 * token to a dark-theme-friendly hex value, fall back to a name-hash palette
 * for anything unrecognized, and only pass through `c.color` if it parses as
 * a real CSS color (hex / rgb / rgba).
 */
const COLOR_TOKEN_MAP: Record<string, string> = {
  claude: "#d97757", // Claude brand orange — matches --accent
  warning: "#f5a524", // amber
  permission: "#7c9ef4", // soft blue
  inactive: "#6b7280", // mid gray, still visible on --panel-2
  promptBorder: "#3a3a44",
  purple_FOR_SUBAGENTS_ONLY: "#a78bfa",
  text: "#e5e7eb",
  error: "#ef4444",
  success: "#22c55e",
  info: "#38bdf8",
};

const FALLBACK_PALETTE = [
  "#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa",
  "#fb923c", "#22d3ee", "#f87171", "#a3e635", "#e879f9",
];

function isCssColor(s: string): boolean {
  // Cheap accept for things that already are CSS-valid: hex (#abc / #aabbcc /
  // #aabbccdd), rgb()/rgba(), hsl(). Named CSS colors like "red" also work but
  // the SDK doesn't use bare names — it uses theme tokens — so we don't try
  // to enumerate the X11 list here.
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return true;
  if (/^rgba?\(/i.test(s)) return true;
  if (/^hsla?\(/i.test(s)) return true;
  return false;
}

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

function colorForCategory(name: string, sdkColor: string | undefined): string {
  if (sdkColor && isCssColor(sdkColor)) return sdkColor;
  if (sdkColor && COLOR_TOKEN_MAP[sdkColor]) return COLOR_TOKEN_MAP[sdkColor];
  return FALLBACK_PALETTE[hashIndex(name, FALLBACK_PALETTE.length)];
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
            <StackedBar
              categories={data.categories}
              totalTokens={data.totalTokens}
              maxTokens={data.maxTokens}
            />
            {/*
              The SDK ships a `gridRows` mosaic shape — each cell colored
              by category with opacity reflecting fill level. In the
              current build it returns rows whose cells all have
              `isFilled: false`, which renders as an invisible grid
              (unfilled cells use a near-transparent backdrop). Keeping
              the renderer here so we can re-enable when the upstream
              data is reliable; gate kept for safety.
            */}
            {false && hasRenderableGrid(data.gridRows) && (
              <Grid grid={data.gridRows} />
            )}
          </div>
          <Section title="Categories">
            <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {data.categories.map((c) => (
                <li key={c.name} className="flex items-center gap-2 rounded-md bg-[var(--panel-2)]/40 px-2 py-1">
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: colorForCategory(c.name, c.color) }}
                  />
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

/**
 * The SDK *should* deliver a non-trivial mosaic in `gridRows` — rows × cells
 * with at least one cell each. Some builds return empty rows (or no rows at
 * all), in which case we fall back to a horizontal stacked bar from the
 * category totals so the box is never blank.
 */
function hasRenderableGrid(grid: ContextResponse["gridRows"]): boolean {
  if (!Array.isArray(grid) || grid.length === 0) return false;
  return grid.some((row) => Array.isArray(row) && row.length > 0);
}

function StackedBar({
  categories,
  totalTokens,
  maxTokens,
}: {
  categories: ContextResponse["categories"];
  totalTokens: number;
  maxTokens: number;
}) {
  const denom = Math.max(maxTokens, totalTokens, 1);
  const used = Math.min(1, totalTokens / denom);
  const freeTokens = Math.max(0, maxTokens - totalTokens);
  // The SDK includes "Free space" in the categories list with the full
  // remaining budget. We render that as the diagonal-stripe filler below, so
  // skip it here to avoid double-counting (and to keep the colored portion
  // representing *used* context only).
  const usedCategories = categories.filter((c) => c.name !== "Free space");
  // Sort biggest first so the bar's widest segments lead.
  const sorted = [...usedCategories].sort((a, b) => b.tokens - a.tokens);
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div
        className="relative flex h-12 w-full overflow-hidden rounded-md bg-[var(--panel-2)]/40"
        role="img"
        aria-label={`${Math.round(used * 100)} percent of context used`}
      >
        {sorted.map((c) => {
          const share = c.tokens / denom;
          if (share <= 0) return null;
          return (
            <div
              key={c.name}
              title={`${c.name} · ${c.tokens.toLocaleString()} tok (${Math.round((c.tokens / Math.max(totalTokens, 1)) * 100)}% of used)`}
              style={{ background: colorForCategory(c.name, c.color), width: `${share * 100}%` }}
              className="h-full hover:brightness-125 transition"
            />
          );
        })}
        {freeTokens > 0 && (
          <div
            title={`Free space · ${freeTokens.toLocaleString()} tok`}
            className="h-full flex-1 bg-[repeating-linear-gradient(45deg,transparent_0_6px,rgba(255,255,255,0.04)_6px_12px)]"
          />
        )}
      </div>
      <div className="mt-2 flex items-baseline justify-between text-[10px] text-[var(--muted)]">
        <span>
          <span className="text-[var(--foreground)] font-mono">{Math.round(used * 100)}%</span> used &middot;{" "}
          {fmtTokens(totalTokens)} / {fmtTokens(maxTokens)} tokens
        </span>
        <span>{fmtTokens(freeTokens)} free</span>
      </div>
    </div>
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
                  background: cell.isFilled
                    ? colorForCategory(cell.categoryName, cell.color)
                    : "color-mix(in oklab, var(--panel-2) 80%, transparent)",
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
