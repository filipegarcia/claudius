"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Icon, Workspace, WorkspaceDefaults } from "@/lib/server/workspaces-store";

const COOKIE = "claudius.workspace";

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// ── Shared module-level store ──────────────────────────────────────────────
// Previously every useWorkspaces() consumer held its own useState + useEffect
// fetch. On the chat route ~7 consumers mount at once (NotificationsProvider,
// ChatSurface, StatusLine, MessageList, SideNav, WorkspaceSwitcher,
// NotificationsDrawer) — so each fired its own GET /api/workspaces, AND every
// focus / visibilitychange / BroadcastChannel event fanned a refetch out to all
// 7 simultaneously (~15 concurrent requests per interaction). Over HTTP/2 those
// no longer queue on the 6-connection limit, but they still flood the single
// Next process, so heavier requests (RSC route renders, file reads) pend behind
// them. This shared store collapses all consumers to ONE fetch (in-flight
// coalesced) and ONE set of refresh listeners, regardless of consumer count.
// The hook's public API is unchanged.
type Snapshot = {
  items: Workspace[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
};

const INITIAL: Snapshot = { items: [], activeId: null, loading: true, error: null };

let snapshot: Snapshot = INITIAL;
const subscribers = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let inFlightController: AbortController | null = null;
let loadedOnce = false;
let listenersInstalled = false;

function emit(): void {
  for (const s of subscribers) s();
}

function setSnapshot(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

function resolveActiveId(
  workspaces: Workspace[],
  serverActiveId: string | null | undefined,
): string | null {
  // Resolution order matches the server's `resolveActiveWorkspace`: cookie wins
  // → server hint (workspaces.json activeId) → first workspace. Falling back to
  // the first item used to disagree with the server whenever there was no
  // cookie (fresh browser, incognito, Playwright).
  const cookie = readCookie();
  const cookieMatch = cookie && workspaces.some((w) => w.id === cookie) ? cookie : null;
  const serverHint =
    serverActiveId && workspaces.some((w) => w.id === serverActiveId) ? serverActiveId : null;
  const fallback = workspaces[0]?.id ?? null;
  return cookieMatch ?? serverHint ?? fallback;
}

/**
 * Fetch the workspace list into the shared store. Concurrent callers coalesce
 * onto one in-flight request (this is what collapses the mount burst). `force`
 * aborts any in-flight fetch and starts fresh, so a refresh after a mutation
 * isn't served stale data from an older in-flight read.
 */
function load(force: boolean): Promise<void> {
  if (inFlight && !force) return inFlight;
  if (inFlight && force) {
    inFlightController?.abort();
    inFlight = null;
    inFlightController = null;
  }
  const controller = new AbortController();
  inFlightController = controller;
  const p = fetch("/api/workspaces", { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { workspaces: Workspace[]; activeId?: string | null };
    })
    .then((d) => {
      // Keep the existing array reference when the payload is byte-identical so
      // consumers with `items` in their effect deps don't re-run on every poll.
      const items =
        JSON.stringify(snapshot.items) === JSON.stringify(d.workspaces)
          ? snapshot.items
          : d.workspaces;
      loadedOnce = true;
      setSnapshot({
        items,
        activeId: resolveActiveId(d.workspaces, d.activeId),
        error: null,
        loading: false,
      });
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSnapshot({ error: err instanceof Error ? err.message : String(err), loading: false });
    })
    .finally(() => {
      if (inFlightController === controller) {
        inFlight = null;
        inFlightController = null;
      }
    });
  inFlight = p;
  return p;
}

function installListenersOnce(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  // ONE shared set of refresh triggers instead of one per consumer. The
  // workspace list is server-side and shared between the browser tab and the
  // Electron renderer, but each renderer's view is a snapshot from its last GET.
  //   1. `visibilitychange → visible` / `focus` — the user returned to this
  //      renderer, so re-validate (also covers the Electron↔browser case, whose
  //      separate storage partitions don't share a BroadcastChannel).
  //   2. `BroadcastChannel("claudius.workspaces")` — same-profile cross-tab
  //      posts from the mutation helpers below.
  // App-lifetime store → listeners are never removed (a fixed, tiny cost).
  const onMaybeRefresh = () => {
    if (typeof document !== "undefined" && document.hidden) return;
    void load(true);
  };
  document.addEventListener("visibilitychange", onMaybeRefresh);
  window.addEventListener("focus", onMaybeRefresh);
  if (typeof BroadcastChannel !== "undefined") {
    const bc = new BroadcastChannel("claudius.workspaces");
    bc.addEventListener("message", () => void load(true));
  }
}

/** Tell other tabs in the same profile the list changed; they refetch. */
function announceMutation(): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  try {
    const bc = new BroadcastChannel("claudius.workspaces");
    bc.postMessage({ at: Date.now() });
    bc.close();
  } catch {
    // Sandboxed contexts can throw — the focus-refetch path covers the change.
  }
}

function refresh(): void {
  setSnapshot({ loading: true });
  void load(true);
}

async function select(id: string, route?: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${id}/select`, { method: "POST" });
  if (!res.ok) return;
  setSnapshot({ activeId: id });
  if (typeof window === "undefined") return;
  // Full-document load is intentional: the new workspace's cwd is server-side
  // state, so a router.push wouldn't reset the SDK's child process.
  if (typeof route === "string" && route.startsWith("/")) {
    const target = route.startsWith(`/${id}`) ? route : `/${id}${route === "/" ? "" : route}`;
    window.location.href = target;
    return;
  }
  const path = window.location.pathname;
  const m = path.match(/^\/wks_[a-f0-9]+(\/.*)?$/);
  if (m) {
    const inner = m[1] ?? "";
    window.location.href = `/${id}${inner}`;
    return;
  }
  if (path === "/" || /^\/customize($|\/)/.test(path)) {
    window.location.href = `/${id}`;
  } else {
    window.location.reload();
  }
}

async function create(input: {
  name: string;
  rootPath: string;
  icon?: Icon;
  defaults?: WorkspaceDefaults;
}): Promise<{ ok: true; workspace: Workspace } | { ok: false; error: string }> {
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false as const, error: err.error ?? `HTTP ${res.status}` };
  }
  const ws = (await res.json()) as Workspace;
  refresh();
  announceMutation();
  await fetch(`/api/workspaces/${ws.id}/select`, { method: "POST" });
  setSnapshot({ activeId: ws.id });
  return { ok: true as const, workspace: ws };
}

async function update(id: string, patch: Partial<Workspace>): Promise<boolean> {
  const res = await fetch(`/api/workspaces/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.ok) {
    refresh();
    announceMutation();
  }
  return res.ok;
}

async function remove(id: string): Promise<boolean> {
  const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
  if (res.ok) {
    refresh();
    announceMutation();
  }
  return res.ok;
}

async function reorder(ids: string[]): Promise<boolean> {
  // Optimistic: reorder the shared list immediately; re-pull on server failure.
  const byId = new Map(snapshot.items.map((w) => [w.id, w]));
  setSnapshot({ items: ids.map((id) => byId.get(id)!).filter(Boolean) });
  const res = await fetch("/api/workspaces/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) refresh();
  return res.ok;
}

async function uploadIcon(id: string, file: File): Promise<boolean> {
  const reader = new FileReader();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl);
  if (!m) return false;
  const res = await fetch(`/api/workspaces/${id}/icon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: m[1] }),
  });
  if (res.ok) {
    const ext = ((await res.json().catch(() => ({}))) as { ext?: string }).ext ?? "png";
    await update(id, { icon: { kind: "image", ext } });
  }
  return res.ok;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return INITIAL;
}

/**
 * Load the workspace list with the active selection resolved. Backed by a
 * shared module-level store (see the note above) so N consumers = ONE fetch and
 * ONE refresh-listener set. `create` auto-selects the new workspace; `select`
 * navigates after the server confirms the switch. Returned function identities
 * are module-stable, so callers can safely list them in effect deps.
 */
export function useWorkspaces() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    installListenersOnce();
    // Coalesced: the first mounting consumer triggers the fetch; the rest reuse
    // the in-flight promise. Skipped entirely once the list has loaded.
    if (!loadedOnce) void load(false);
  }, []);

  return {
    items: snap.items,
    activeId: snap.activeId,
    loading: snap.loading,
    error: snap.error,
    refresh,
    select,
    create,
    update,
    remove,
    reorder,
    uploadIcon,
  };
}
