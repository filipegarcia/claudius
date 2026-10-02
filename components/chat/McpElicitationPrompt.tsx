"use client";

import { useEffect, useMemo, useState } from "react";
import { ClipboardList, ExternalLink, KeyRound, TriangleAlert } from "lucide-react";
import type { ElicitationDecision, McpElicitationRequestEvent } from "@/lib/shared/events";
import {
  buildElicitationContent,
  initialFormValues,
  parseElicitationSchema,
  safeElicitationUrl,
  type ElicitationField,
  type ElicitationFormValues,
} from "@/lib/shared/elicitation";
import { cn } from "@/lib/utils/cn";

type Props = {
  request: McpElicitationRequestEvent;
  onResolve: (decision: ElicitationDecision) => void;
  /** How many elicitations are waiting, including this one. "1 of N" when > 1. */
  queueTotal?: number;
};

/**
 * Modal for an MCP elicitation (SDK `onElicitation`): an MCP server asking
 * the user to fill in a form, or to open a URL — usually to sign in, which
 * Claude Code 2.1.287 enabled for servers on the 2025-11-25 protocol.
 *
 * All content is server-authored: the message renders as plain text, and the
 * URL is only opened when it's http(s) and not this app's own origin (a
 * remote server shouldn't be able to steer the user into Claudius's own
 * routes). The full URL is always shown before opening so the user can see
 * where it goes.
 *
 * Escape cancels (the user dismissed it); "Decline" is an explicit no — MCP
 * servers can treat the two differently.
 */
export function McpElicitationPrompt({ request, onResolve, queueTotal }: Props) {
  const isUrl = request.mode === "url";
  const url = useMemo(() => {
    const u = safeElicitationUrl(request.url);
    if (!u) return null;
    if (typeof window !== "undefined" && u.origin === window.location.origin) return null;
    return u;
  }, [request.url]);
  const fields = useMemo(() => (isUrl ? [] : parseElicitationSchema(request.requestedSchema)), [isUrl, request.requestedSchema]);
  const [values, setValues] = useState<ElicitationFormValues>(() => initialFormValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.repeat) onResolve({ action: "cancel" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  const heading =
    request.title ??
    (isUrl
      ? `${request.displayName ?? request.serverName} wants you to open a link`
      : `${request.displayName ?? request.serverName} needs some information`);

  function submitForm() {
    const built = buildElicitationContent(fields, values);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    onResolve({ action: "accept", content: built.content });
  }

  function openLink() {
    if (!url) return;
    window.open(url.href, "_blank", "noopener,noreferrer");
    onResolve({ action: "accept" });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-testid="mcp-elicitation-modal"
      data-mode={request.mode}
    >
      <div className="w-[min(560px,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)]/15 text-[var(--accent)]">
            {isUrl ? <KeyRound className="h-3.5 w-3.5" /> : <ClipboardList className="h-3.5 w-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--muted)]">
              <span>MCP server request</span>
              <span
                data-testid="mcp-elicitation-server"
                className="inline-flex items-center rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-[var(--accent)]"
              >
                {request.serverName}
              </span>
              {queueTotal !== undefined && queueTotal > 1 && (
                <span
                  data-testid="mcp-elicitation-queue-count"
                  className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-[var(--foreground)]"
                >
                  1 of {queueTotal}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-sm font-medium">{heading}</div>
            {request.description && <div className="mt-1 text-xs text-[var(--muted)]">{request.description}</div>}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto px-4 py-3 scroll-thin">
          {request.message && (
            <p data-testid="mcp-elicitation-message" className="whitespace-pre-wrap text-sm">
              {request.message}
            </p>
          )}

          {isUrl &&
            (url ? (
              <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Opens</div>
                <div data-testid="mcp-elicitation-host" className="font-medium">
                  {url.host}
                </div>
                <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--muted)]">{url.href}</div>
              </div>
            ) : (
              <div
                data-testid="mcp-elicitation-unsafe-url"
                className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>This server sent a link that can&apos;t be opened safely (only http and https links are allowed).</span>
              </div>
            ))}

          {!isUrl && fields.length > 0 && (
            <div className="mt-3 space-y-3">
              {fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  error={errors[f.key]}
                  onChange={(v) => {
                    setValues((prev) => ({ ...prev, [f.key]: v }));
                    setErrors((prev) => {
                      if (!(f.key in prev)) return prev;
                      const next = { ...prev };
                      delete next[f.key];
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
          {isUrl ? (
            <button
              data-testid="mcp-elicitation-open"
              onClick={openLink}
              disabled={!url}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open link
            </button>
          ) : (
            <button
              data-testid="mcp-elicitation-submit"
              onClick={submitForm}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              {fields.length > 0 ? "Submit" : "Accept"}
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              data-testid="mcp-elicitation-decline"
              onClick={() => onResolve({ action: "decline" })}
              className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/20"
            >
              Decline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: ElicitationField;
  value: string | boolean | string[] | undefined;
  error?: string;
  onChange: (v: string | boolean | string[]) => void;
}) {
  const id = `elicit-${field.key}`;
  const inputClass = cn(
    "w-full rounded-md border bg-[var(--panel-2)] px-2 py-1.5 text-sm focus:outline-none",
    error ? "border-red-500/60" : "border-[var(--border)] focus:border-[var(--accent)]/60",
  );
  const label = (
    <label htmlFor={id} className="mb-1 block text-xs font-medium">
      {field.label}
      {field.required && <span className="ml-0.5 text-red-400">*</span>}
    </label>
  );
  const help = field.description && <div className="mt-1 text-[11px] text-[var(--muted)]">{field.description}</div>;
  const err = error && (
    <div data-testid={`mcp-elicitation-error-${field.key}`} className="mt-1 text-[11px] text-red-400">
      {error}
    </div>
  );

  if (field.kind === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="font-medium">{field.label}</span>
        </label>
        {help}
        {err}
      </div>
    );
  }
  if (field.kind === "multi-enum") {
    const picked = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend className="mb-1 text-xs font-medium">
          {field.label}
          {field.required && <span className="ml-0.5 text-red-400">*</span>}
        </legend>
        <div className="flex flex-col gap-1">
          {field.options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(o.value)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...picked, o.value] : picked.filter((p) => p !== o.value))
                }
              />
              {o.label}
            </label>
          ))}
        </div>
        {help}
        {err}
      </fieldset>
    );
  }
  if (field.kind === "enum") {
    return (
      <div>
        {label}
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {help}
        {err}
      </div>
    );
  }
  const type =
    field.kind === "number"
      ? "number"
      : field.format === "email"
        ? "email"
        : field.format === "uri"
          ? "url"
          : field.format === "date"
            ? "date"
            : // `date-time` stays free text: datetime-local yields no zone, and
              // the server expects RFC 3339.
              "text";
  return (
    <div>
      {label}
      <input
        id={id}
        data-testid={`mcp-elicitation-field-${field.key}`}
        type={type}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
      {help}
      {err}
    </div>
  );
}
