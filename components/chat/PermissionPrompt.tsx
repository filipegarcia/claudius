"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Lightbulb, Shield } from "lucide-react";
import type { PermissionDecision, PermissionRequestEvent } from "@/lib/shared/events";
import { visualizeInvisibleUnicode } from "@/lib/shared/invisible-unicode";
import { cn } from "@/lib/utils/cn";

type Props = {
  request: PermissionRequestEvent;
  onResolve: (decision: PermissionDecision) => void;
  /**
   * Claude Code 2.1.247 — "Added a tip on Bash permission prompts pointing to
   * auto mode, with a one-keystroke 'Yes, and switch to auto mode' option."
   * True when Auto mode is available for this session (the `disableAutoMode`
   * settings escape hatch — see `useDisableAutoMode` — hasn't hidden it and
   * the user isn't already in it). Omit/false hides the tip entirely rather
   * than showing a button that would just get coerced back server-side.
   */
  autoModeAvailable?: boolean;
  /**
   * Allow this request once AND switch the session into Auto mode, in one
   * click. Only called from the tip button below — never wired to a
   * keyboard shortcut, since Escape is already claimed for "deny" on this
   * modal.
   */
  onSwitchToAutoMode?: () => void;
  /**
   * How many permission requests are waiting, including this one (Claude
   * Code 2.1.286 parity: "2 of 5" when several stack up — e.g. parallel
   * subagents each asking). This prompt is always the oldest, so it is "1 of
   * N"; answering it brings up the next. Hidden when 1 or omitted.
   */
  queueTotal?: number;
};

export function PermissionPrompt({ request, onResolve, autoModeAvailable, onSwitchToAutoMode, queueTotal }: Props) {
  // SDK 0.3.268 `defaultToNo` — the prompt must not be approvable by a
  // single stray keystroke: open straight on the decline panel instead of
  // requiring a click on "Deny…" first.
  const [showDeny, setShowDeny] = useState(!!request.defaultToNo);
  const [feedback, setFeedback] = useState("");
  const [showInput, setShowInput] = useState(false);

  // CC 2.1.211 — the title/description are untrusted text (a tool-authored
  // prompt, an MCP server's label) the user reads first, so they get the same
  // bidi/zero-width visualization as the tool input below.
  const summaryVis = visualizeInvisibleUnicode(
    request.title ?? `Claude wants to use ${request.displayName ?? request.toolName}`,
  );
  const summary = summaryVis.visualized;
  const descriptionVis = request.description
    ? visualizeInvisibleUnicode(request.description)
    : null;
  // SDK 0.3.268 `suppressAlwaysAllowRule` — the rule an "Always allow" click
  // would write grants more than this ask's own action, so hide all three
  // standing-grant buttons. The auto-mode tip button is itself a one-click
  // standing grant (switches the whole session into Auto mode), so it's
  // hidden under the same flag — and also under `defaultToNo`, since it's a
  // one-key approve shortcut that flag explicitly rules out.
  const hideAlwaysButtons = !!request.suppressAlwaysAllowRule;
  // CC 2.1.235 — the narrow rule(s) an "Always allow" click will actually
  // write, from the SDK's suggestions. Rendered as `Tool(ruleContent)` so the
  // user sees they're granting `Bash(git status:*)`, not all of `Bash`.
  const alwaysRuleLabels = (request.suggestedRules ?? []).map((r) =>
    r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName,
  );
  // CC 2.1.211 — the tool input is untrusted text the user is about to
  // authorise; surface any bidi-override / zero-width characters as visible
  // `‹U+XXXX›` tokens so a Trojan-Source command can't disguise what it runs.
  const { visualized: inputText, count: inputHiddenCount } = visualizeInvisibleUnicode(
    JSON.stringify(request.input, null, 2),
  );
  // Fire the banner if hidden/bidi chars appear anywhere the user reads: the
  // title, the description, or the tool input.
  const hiddenCharCount =
    summaryVis.count + (descriptionVis?.count ?? 0) + inputHiddenCount;
  const hideAutoModeTip = !!request.suppressAlwaysAllowRule || !!request.defaultToNo;
  const denyButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore auto-repeat: with a queue, a held Escape would otherwise deny
      // every stacked request in a row, including ones never seen.
      if (e.key === "Escape" && !e.repeat) onResolve({ kind: "deny" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  // `defaultToNo`: put focus on the decline action explicitly rather than
  // relying on the `autoFocus` DOM attribute, which is unreliable once this
  // modal (and its already-autofocused composer sibling) mounts after the
  // initial page load — a second competing `autoFocus` element doesn't
  // reliably win the browser's autofocus processing at that point.
  useEffect(() => {
    if (request.defaultToNo) denyButtonRef.current?.focus();
    // Runs once per request — `requestId` is a stable per-prompt identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-permission-modal
      data-default-to-no={request.defaultToNo ? "true" : undefined}
    >
      <div className="w-[min(620px,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)]/15 text-[var(--accent)]">
            <Shield className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--muted)]">
              <span>Permission required</span>
              {queueTotal !== undefined && queueTotal > 1 && (
                <span
                  data-testid="permission-queue-count"
                  title={`${queueTotal - 1} more waiting after this one`}
                  className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-[var(--foreground)]"
                >
                  1 of {queueTotal}
                </span>
              )}
              {request.agentId && (
                <span
                  data-testid="permission-agent-badge"
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-[var(--accent)]"
                >
                  Subagent · {request.agentId}
                </span>
              )}
              {request.mcpServer && (
                <span
                  data-testid="permission-mcp-source-badge"
                  title="Which MCP server is serving this tool, and where its definition came from"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal",
                    request.mcpServer.source === "sdk"
                      ? "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-300",
                  )}
                >
                  MCP · {request.mcpServer.name} ({request.mcpServer.source})
                </span>
              )}
            </div>
            <div className="mt-0.5 text-sm font-medium">{summary}</div>
            {descriptionVis && (
              <div className="mt-1 text-xs text-[var(--muted)]">{descriptionVis.visualized}</div>
            )}
          </div>
        </div>

        <div className="px-4 py-3">
          <button
            onClick={() => setShowInput((s) => !s)}
            className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            {showInput ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Tool input — {request.toolName}
          </button>
          {hiddenCharCount > 0 && (
            <div
              data-testid="permission-hidden-chars"
              className="mb-2 flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300"
            >
              <Shield className="h-3 w-3 shrink-0" />
              Contains {hiddenCharCount} hidden/bidi character{hiddenCharCount === 1 ? "" : "s"}, shown
              below as <code className="font-mono">‹U+…›</code> — read the command carefully.
            </div>
          )}
          {showInput && (
            <pre className="max-h-60 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-xs whitespace-pre-wrap scroll-thin">
              {inputText}
            </pre>
          )}
        </div>

        {request.toolName === "Bash" && autoModeAvailable && onSwitchToAutoMode && !hideAutoModeTip && (
          <div
            data-testid="permission-auto-mode-tip"
            className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--accent)]/5 px-4 py-2 text-xs text-[var(--muted)]"
          >
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            <span>Tip: Auto mode runs safe commands like this without asking each time.</span>
            <button
              onClick={() => {
                onSwitchToAutoMode();
                onResolve({ kind: "allow_once" });
              }}
              className="ml-auto shrink-0 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
            >
              Yes, and switch to auto mode
            </button>
          </div>
        )}

        {!hideAlwaysButtons && (
          <div
            data-testid="permission-always-rule"
            className="border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 pt-2 text-[11px] text-[var(--muted)]"
          >
            {alwaysRuleLabels.length > 0 ? (
              <>
                “Always” saves{" "}
                {alwaysRuleLabels.map((label, i) => (
                  <span key={label}>
                    {i > 0 && ", "}
                    <code className="rounded bg-[var(--panel)] px-1 font-mono text-[var(--foreground)]">
                      {label}
                    </code>
                  </span>
                ))}
                {" "}— not the whole tool.
              </>
            ) : (
              // CC 2.1.235 — the SDK offered no narrow rule for this call, so
              // "Always" can only grant the whole tool. Say so explicitly
              // rather than letting the broad grant happen silently.
              <span className="text-amber-400">
                “Always” saves the whole{" "}
                <code className="rounded bg-[var(--panel)] px-1 font-mono">{request.toolName}</code>{" "}
                tool — every call it can make, not just this one.
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
          <button
            onClick={() => onResolve({ kind: "allow_once" })}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            Allow once
          </button>
          {!hideAlwaysButtons && (
            <>
              <button
                onClick={() => onResolve({ kind: "allow_always_session" })}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
                title="Allow this tool for the rest of this session"
              >
                Always (session)
              </button>
              <button
                onClick={() => onResolve({ kind: "allow_always_save", destination: "projectSettings" })}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
                title="Save an allow rule to .claude/settings.json"
              >
                Always (project)
              </button>
              <button
                onClick={() => onResolve({ kind: "allow_always_save", destination: "userSettings" })}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
                title="Save an allow rule to ~/.claude/settings.json"
              >
                Always (user)
              </button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowDeny((s) => !s)}
              className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/20"
            >
              {showDeny ? "Cancel deny" : "Deny…"}
            </button>
          </div>
        </div>

        {showDeny && (
          <div className="border-t border-[var(--border)] bg-[var(--panel)]/60 px-4 py-3">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Optional feedback for Claude
            </label>
            <textarea
              // Skip the native autofocus when `defaultToNo` puts explicit
              // focus on the deny button instead (see the ref effect above)
              // — two competing autoFocus elements is unreliable.
              autoFocus={!request.defaultToNo}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Why are you denying this? (sent back to Claude as the deny message)"
              rows={2}
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 text-xs focus:border-[var(--accent)]/60 focus:outline-none"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                ref={denyButtonRef}
                onClick={() => onResolve({ kind: "deny" })}
                // `defaultToNo`: this is the prompt's decline option — see
                // the ref effect above, which focuses it explicitly so
                // Enter denies rather than approves.
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                Deny without feedback
              </button>
              <button
                onClick={() => onResolve({ kind: "deny", message: feedback || undefined })}
                className="rounded-md bg-red-500/90 px-3 py-1.5 text-xs text-white hover:bg-red-500"
              >
                Deny with feedback
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
