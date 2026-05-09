"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { WandSparkles, ExternalLink, Keyboard, Eye, Rocket, Loader2 } from "lucide-react";
import type { Workspace } from "@/lib/server/workspaces-store";
import type { Customization } from "@/lib/server/customizations-store";
import type { PreviewState } from "@/lib/server/preview-server";
import { PANE_LABELS_EVENT } from "@/components/overlays/PaneLabelsHost";

const COOKIE = "claudius.workspace";

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

type Runtime =
  | { isPreview: false }
  | { isPreview: true; customizationId: string; name: string | null };

/**
 * Persistent banner shown at the top of every route in customization-related
 * contexts. Behaves differently depending on whether the page is served by
 * the main Claudius install or by an auto-spawned preview:
 *
 *   • Main + customization workspace active → reminder + Show components +
 *     Open preview (auto-starts the preview if needed) + Publish/revert link.
 *   • Preview server (regardless of workspace) → tells the user this is a
 *     preview and points them back to the main Claudius tab to publish.
 */
export function CustomizationBanner() {
  const [active, setActive] = useState<Workspace | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [customizations, setCustomizations] = useState<Customization[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [openingPreview, setOpeningPreview] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [wsRes, rtRes, custRes] = await Promise.all([
          fetch("/api/workspaces").catch(() => null),
          fetch("/api/customize/runtime").catch(() => null),
          fetch("/api/customizations").catch(() => null),
        ]);
        if (cancelled) return;
        if (wsRes && wsRes.ok) {
          const d = (await wsRes.json()) as { workspaces: Workspace[] };
          const id = readCookie();
          setActive(id ? d.workspaces.find((w) => w.id === id) ?? null : null);
        }
        if (rtRes && rtRes.ok) setRuntime((await rtRes.json()) as Runtime);
        if (custRes && custRes.ok) {
          const d = (await custRes.json()) as { customizations: Customization[] };
          setCustomizations(d.customizations);
        }
      } catch {
        // Banner is decorative — silent failure is fine.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Identify the customization in scope. Three sources of truth, in order:
  //   1. the preview's own runtime (authoritative inside a preview process),
  //   2. the active workspace's rootPath matched to a customization src dir,
  //   3. nothing — banner stays hidden.
  const customizationByActive =
    active?.kind === "customization"
      ? customizations.find((c) => active.id === c.workspaceId) ?? null
      : null;
  const customizationId =
    runtime?.isPreview ? runtime.customizationId : customizationByActive?.id ?? null;

  const fetchPreview = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/customizations/${id}/preview`);
      if (r.ok) setPreview((await r.json()) as PreviewState);
    } catch {
      // ignore
    }
  }, []);

  // When we know which customization matters and we're on the main server,
  // poll preview state so the "Open preview" button reflects reality.
  useEffect(() => {
    if (!customizationId || runtime?.isPreview) return;
    void fetchPreview(customizationId);
    const t = setInterval(() => {
      void fetchPreview(customizationId);
    }, 4000);
    return () => clearInterval(t);
  }, [customizationId, runtime?.isPreview, fetchPreview]);

  const onOpenPreview = useCallback(async () => {
    if (!customizationId) return;
    setOpeningPreview(true);
    try {
      let state = preview;
      if (!state || state.status === "exited" || state.status === "error") {
        const r = await fetch(`/api/customizations/${customizationId}/preview`, { method: "POST" });
        if (r.ok) state = (await r.json()) as PreviewState;
        setPreview(state);
      }
      // Wait briefly for the port to be ready, then open.
      const start = Date.now();
      while (state && state.status === "starting" && Date.now() - start < 8000) {
        await new Promise((res) => setTimeout(res, 600));
        const r = await fetch(`/api/customizations/${customizationId}/preview`);
        if (r.ok) state = (await r.json()) as PreviewState;
      }
      if (state?.port) {
        window.open(`http://localhost:${state.port}/`, "_blank", "noopener,noreferrer");
      }
      setPreview(state ?? null);
    } finally {
      setOpeningPreview(false);
    }
  }, [customizationId, preview]);

  const onShowComponents = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(PANE_LABELS_EVENT));
    }
  }, []);

  // ── Preview server banner ────────────────────────────────────────────────
  if (runtime?.isPreview) {
    return (
      <div
        data-pane-name="customization-banner"
        className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-[var(--foreground)]"
      >
        <Eye className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">Preview</span>
        <span className="hidden truncate text-[var(--muted)] sm:inline">
          — you&apos;re viewing the customization
          {runtime.name ? <> <span className="text-[var(--foreground)]">&ldquo;{runtime.name}&rdquo;</span></> : null}.
          Switch back to your main Claudius tab and click <span className="text-[var(--foreground)]">Publish</span> to apply changes to the live install.
        </span>
        <button
          onClick={onShowComponents}
          title="Toggle component name overlay (⌘.)"
          className="ml-auto flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[var(--foreground)] hover:bg-amber-500/25"
        >
          <Keyboard className="h-3 w-3" /> Show component names
        </button>
      </div>
    );
  }

  // ── Main server, customization workspace active ─────────────────────────
  if (active?.kind === "customization") {
    const previewRunning = preview && (preview.status === "ready" || preview.status === "starting");
    return (
      <div
        data-pane-name="customization-banner"
        className="flex items-center gap-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-1.5 text-xs text-[var(--foreground)]"
      >
        <WandSparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="font-medium">Customization mode</span>
        <span className="hidden truncate text-[var(--muted)] sm:inline">
          — edits in this workspace are isolated. Open the preview to see them; hit Publish to apply.
        </span>
        <button
          onClick={onShowComponents}
          title="Toggle component name overlay (⌘.)"
          className="ml-auto flex shrink-0 items-center gap-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--accent)]/25"
        >
          <Keyboard className="h-3 w-3" /> Show component names
        </button>
        <button
          onClick={() => void onOpenPreview()}
          disabled={openingPreview || !customizationId}
          title={previewRunning ? `Open preview (port ${preview?.port})` : "Start preview and open"}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
        >
          {openingPreview ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Eye className="h-3 w-3" />
          )}
          {previewRunning ? `Open preview · :${preview?.port}` : "Open preview"}
        </button>
        <Link
          href={customizationId ? `/customize/${customizationId}` : "/customize"}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--accent)]/25"
        >
          <Rocket className="h-3 w-3" /> Publish / revert <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    );
  }

  return null;
}
