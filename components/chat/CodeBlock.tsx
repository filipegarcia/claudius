"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Hourglass, Play } from "lucide-react";
import { highlight } from "@/lib/client/shiki";
import { useActiveSessionId } from "@/lib/client/useActiveSessionId";
import { commandNeedsSudo, sendBash } from "@/lib/client/sendBash";

type Props = {
  code: string;
  lang?: string;
};

/** Languages we recognise as shell. Matches what users tend to fence. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console"]);

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};

export function CodeBlock({ code, lang }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sessionId = useActiveSessionId();

  // `!`-mode parity: bash/sh/shell/zsh code fences get an Execute button.
  // The button reuses the same /api/sessions/[id]/bash endpoint as the
  // composer's `!` prefix — so the same persistent shell, same UI echo,
  // same model-visibility contract. Disabled (with explanatory tooltip)
  // until a session is bound and the code is non-empty.
  const isShell = !!lang && SHELL_LANGS.has(lang);
  const [sudoOpen, setSudoOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    highlight(code, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  async function run(password?: string) {
    if (!sessionId || running) return;
    setRunning(true);
    try {
      const res = await sendBash(sessionId, {
        command: code,
        sudoPassword: password,
      });
      if (res) {
        setLastResult({
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          truncated: res.truncated,
          timedOut: res.timedOut,
        });
      } else {
        setLastResult({
          stdout: "",
          stderr: "Bash execution failed (network or server error).",
          exitCode: -1,
          truncated: false,
          timedOut: false,
        });
      }
      setResultOpen(true);
    } finally {
      setRunning(false);
    }
  }

  function onExecuteClick() {
    if (!sessionId || running) return;
    if (commandNeedsSudo(code)) {
      setSudoOpen(true);
      return;
    }
    void run();
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[#0a0a0a]">
      <div className="flex h-7 items-center justify-between border-b border-[var(--border)] bg-[var(--panel-2)] px-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <span>{lang || "text"}</span>
        <div className="flex items-center gap-1">
          {isShell && (
            <button
              onClick={onExecuteClick}
              disabled={!sessionId || running || code.trim().length === 0}
              data-testid="codeblock-execute"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-amber-300 hover:bg-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-40"
              title={
                !sessionId
                  ? "Open a session to execute"
                  : commandNeedsSudo(code)
                    ? "Run with sudo — you'll be asked for a password"
                    : "Run this command in the session's shell"
              }
            >
              {running ? (
                <Hourglass className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {running ? "Running" : "Execute"}
            </button>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--panel)]"
            title="Copy"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {/* Code body sized in em (0.86 ≈ 12/14 — the original text-xs vs. the
          chat surface's default text-sm body) so it scales with the user's
          Settings → Chat size slider. The header chrome above keeps its
          fixed pixel sizes — those are UI controls, not content. */}
      {html ? (
        <div
          className="shiki-host overflow-auto text-[0.86em] leading-[1.5] scroll-thin"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-auto p-3 text-[0.86em] leading-[1.5] scroll-thin">{code}</pre>
      )}
      {lastResult && (
        <ExecutionResult
          result={lastResult}
          open={resultOpen}
          onToggle={() => setResultOpen((o) => !o)}
        />
      )}
      {sudoOpen && (
        <InlineSudoModal
          command={code}
          running={running}
          onCancel={() => setSudoOpen(false)}
          onSubmit={(pwd) => {
            setSudoOpen(false);
            void run(pwd);
          }}
        />
      )}
    </div>
  );
}

/**
 * Compact, collapsible footer that shows the last `Execute` run's output.
 * stdout in plain text, stderr in red. A truncation badge surfaces the
 * server-side soft-cap; a timeout badge surfaces the per-command deadline.
 */
function ExecutionResult({
  result,
  open,
  onToggle,
}: {
  result: RunResult;
  open: boolean;
  onToggle: () => void;
}) {
  const success = result.exitCode === 0 && !result.timedOut;
  return (
    <div
      data-testid="codeblock-execute-result"
      className="border-t border-[var(--border)] bg-[var(--panel-2)]/40 text-[0.85em]"
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] uppercase tracking-wide text-[var(--muted)] hover:bg-[var(--panel)]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className={success ? "text-emerald-400" : "text-red-400"}>
          exit {result.exitCode}
        </span>
        {result.timedOut && <span className="text-red-400">· timed out</span>}
        {result.truncated && <span className="text-amber-400">· truncated</span>}
      </button>
      {open && (
        <div className="max-h-64 overflow-auto px-2 pb-2 scroll-thin">
          {result.stdout && (
            <pre className="whitespace-pre-wrap font-mono text-[12px] text-[var(--foreground)]">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="whitespace-pre-wrap font-mono text-[12px] text-red-400">
              {result.stderr}
            </pre>
          )}
          {!result.stdout && !result.stderr && (
            <div className="text-[12px] italic text-[var(--muted)]">(no output)</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline (per-CodeBlock) sudo password modal. Lives inside the block rather
 * than as a top-level portal because each code fence has its own Execute
 * button — opening a fixed full-screen overlay every time would feel
 * disproportionate. The modal portal'd from PromptInput handles the
 * composer `!sudo …` path.
 */
function InlineSudoModal({
  command,
  running,
  onSubmit,
  onCancel,
}: {
  command: string;
  running: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [pwd, setPwd] = useState("");
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="codeblock-sudo-modal"
      className="absolute inset-0 z-[5] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!pwd) return;
          const p = pwd;
          setPwd("");
          onSubmit(p);
        }}
        className="mx-3 w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3"
      >
        <div className="mb-2 text-sm font-semibold">Run with sudo</div>
        <div className="mb-2 max-h-16 overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-[11px] text-[var(--foreground)]">
          {command.length > 200 ? command.slice(0, 200) + "…" : command}
        </div>
        <input
          autoFocus
          type="password"
          autoComplete="off"
          data-testid="codeblock-sudo-password"
          data-1p-ignore="true"
          data-lpignore="true"
          disabled={running}
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Password"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-sm focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={running || !pwd}
            data-testid="codeblock-sudo-run"
            className="rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-sm font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </form>
    </div>
  );
}
