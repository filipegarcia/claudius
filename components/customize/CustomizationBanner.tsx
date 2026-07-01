"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WandSparkles, ExternalLink, Keyboard, Eye, Rocket, Loader2, RotateCw } from "lucide-react";
import type { Customization } from "@/lib/server/customizations-store";
import type { PreviewState } from "@/lib/server/preview-server";
import { PANE_LABELS_EVENT } from "@/components/overlays/PaneLabelsHost";
import { useIsElectron } from "@/lib/client/useElectron";

const COOKIE = "claudius.customization";

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
  // The active customization id (the `claudius.customization` cookie). Null when
  // a workspace is active instead.
  const [activeCustId, setActiveCustId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [customizations, setCustomizations] = useState<Customization[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [openingPreview, setOpeningPreview] = useState(false);
  const [restartingPreview, setRestartingPreview] = useState(false);
  // In the packaged Electron app the preview is a separate local dev server;
  // `window.open` routes it to the user's default browser (not an in-app
  // window yet). Surface that so the click isn't a surprise.
  const isElectron = useIsElectron();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [rtRes, custRes] = await Promise.all([
          fetch("/api/customize/runtime").catch(() => null),
          fetch("/api/customizations").catch(() => null),
        ]);
        if (cancelled) return;
        setActiveCustId(readCookie());
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

  // Identify the customization in scope. Sources of truth, in priority:
  //   1. the preview's own runtime (authoritative inside a preview process),
  //   2. the URL — when the user is on /customize/<id>, that id wins so the
  //      banner's "Open preview" never targets the wrong customization just
  //      because the active-customization cookie still points elsewhere,
  //   3. the active-customization cookie id,
  //   4. nothing — banner stays hidden.
  const pathname = usePathname();
  const customizeIdFromUrl = useMemo(() => {
    const m = pathname?.match(/^\/customize\/(cust_[a-z0-9]+)/i);
    return m?.[1] ?? null;
  }, [pathname]);
  const customizationByUrl = useMemo(
    () =>
      customizeIdFromUrl
        ? customizations.find((c) => c.id === customizeIdFromUrl) ?? null
        : null,
    [customizeIdFromUrl, customizations],
  );
  const customizationByActive =
    activeCustId ? customizations.find((c) => c.id === activeCustId) ?? null : null;
  const customizationInScope = customizationByUrl ?? customizationByActive;
  const customizationId =
    runtime?.isPreview ? runtime.customizationId : customizationInScope?.id ?? null;

  // Stable callback for the on-demand preview re-fetch (used by
  // `onOpenPreview` below). setState lives inside the Promise callback,
  // so it doesn't trip react-hooks/set-state-in-effect when invoked from
  // an effect.
  const fetchPreview = useCallback((id: string, signal?: AbortSignal) => {
    return fetch(`/api/customizations/${id}/preview`, { signal })
      .then(async (r) => {
        if (!r.ok) return;
        setPreview((await r.json()) as PreviewState);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // best-effort polling
      });
  }, []);

  // When we know which customization matters and we're on the main server,
  // poll preview state so the "Open preview" button reflects reality.
  // The initial fetch runs inside the effect via the same `fetchPreview`
  // callback — setState happens in its Promise chain, not in this effect
  // body, satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!customizationId || runtime?.isPreview) return;
    const controller = new AbortController();
    void fetchPreview(customizationId, controller.signal);
    const t = setInterval(() => {
      void fetchPreview(customizationId, controller.signal);
    }, 4000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
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

  const onRestartPreview = useCallback(async () => {
    if (!customizationId) return;
    setRestartingPreview(true);
    try {
      const r = await fetch(`/api/customizations/${customizationId}/preview/restart`, { method: "POST" });
      if (r.ok) setPreview((await r.json()) as PreviewState);
    } finally {
      setRestartingPreview(false);
    }
  }, [customizationId]);

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

  // ── Main server, customization active OR /customize/<id> URL ──
  if (customizationByActive || customizationByUrl) {
    const previewRunning = preview && (preview.status === "ready" || preview.status === "starting");
    return (
      <div
        data-pane-name="customization-banner"
        className="flex items-center gap-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-1.5 text-xs text-[var(--foreground)]"
      >
        <WandSparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="font-medium">Customization mode</span>
        <span className="hidden truncate text-[var(--muted)] sm:inline">
          — edits in this customization are isolated. Open the preview to see them; hit Publish to apply.
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
          disabled={openingPreview || restartingPreview || !customizationId}
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
        {isElectron && (
          <span
            title="The preview runs as a local dev server and opens in your default browser."
            className="hidden shrink-0 items-center gap-1 text-[10px] text-[var(--muted)] lg:flex"
          >
            <ExternalLink className="h-2.5 w-2.5" /> opens in browser
          </span>
        )}
        {previewRunning && (
          <button
            onClick={() => void onRestartPreview()}
            disabled={restartingPreview || openingPreview}
            title="Restart the preview process — useful after syncing from base or when it gets wedged"
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
          >
            {restartingPreview ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
            Restart
          </button>
        )}
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
