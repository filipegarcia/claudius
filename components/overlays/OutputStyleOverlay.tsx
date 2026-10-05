"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Overlay } from "./Overlay";
import { outputStyleDescription } from "@/lib/shared/output-styles";

type Props = {
  sessionId: string;
  onClose: () => void;
  /** Surface a short result/error line (reuses the chat toast). */
  onNotice?: (message: string) => void;
};

/**
 * CC 2.1.286 — `/output-style` (no args) opens a picker that lands on the
 * current style with a description under each name, instead of a bare toast.
 * Available styles come from the session's `output-style` endpoint
 * (`available_output_styles`, names-only); descriptions come from
 * {@link outputStyleDescription}. Selecting PATCHes the session.
 */
export function OutputStyleOverlay({ sessionId, onClose, onNotice }: Props) {
  const [current, setCurrent] = useState<string | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/output-style`)
      .then((r) => r.json())
      .then((d: { current?: string; available?: string[] }) => {
        if (cancelled) return;
        setCurrent(d.current ?? "default");
        setAvailable(d.available ?? []);
      })
      .catch(() => {
        if (!cancelled) onNotice?.("Couldn't load output styles");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onNotice]);

  async function select(style: string) {
    setBusy(style);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/output-style`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputStyle: style }),
      });
      if (!r.ok) throw new Error(String(r.status));
      onNotice?.(`Output style set to ${style}`);
      onClose();
    } catch {
      onNotice?.("Couldn't set output style");
      setBusy(null);
    }
  }

  return (
    <Overlay title="Output style" subtitle="/output-style" onClose={onClose} width={460}>
      <div data-testid="output-style-overlay" className="flex flex-col gap-1 px-2 py-2">
        {loading ? (
          <div className="px-2 py-3 text-xs text-[var(--muted)]">Loading…</div>
        ) : available.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[var(--muted)]">No output styles available.</div>
        ) : (
          available.map((style) => {
            const isCurrent = style === current;
            return (
              <button
                key={style}
                type="button"
                disabled={busy != null}
                onClick={() => select(style)}
                className={`flex items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--panel)] disabled:opacity-50 ${
                  isCurrent ? "bg-[var(--panel)]" : ""
                }`}
              >
                <Check
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isCurrent ? "text-[var(--accent)]" : "opacity-0"}`}
                />
                <span className="min-w-0">
                  <span className="text-sm">{style}</span>
                  <span className="block text-[11px] text-[var(--muted)]">
                    {outputStyleDescription(style)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </Overlay>
  );
}
