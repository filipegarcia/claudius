"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { pathSegment } from "@/lib/shared/route-params";

/**
 * The workspace redirects that the pages used to do on the server
 * (rust/parity/server-components.md § 3, N03 rows 2, 3, 4 and 6). They now
 * run in the browser off `GET /api/workspaces`, so the pages read nothing on
 * the server (N04's static build) while Next on its own, with no Rust in
 * front, keeps working the same.
 *
 * With the Rust front door in front, its page rules (`claudius_server::pages`
 * R1, R2, R4, R5) answer a document load or a router fetch with a 307 before
 * any of these renders. Each one here makes the decision the matching rule
 * makes. Like the server `redirect()`s they replace (which, under the root
 * `<Suspense>`, reached the browser as a client-side replace), they navigate
 * with `router.replace`.
 */

/**
 * What `GET /api/workspaces` answers. `activeId` is the server's
 * `resolveActiveWorkspace`: the cookie's workspace, else the store's
 * `activeId ?? workspaces[0]`, each only if it exists; else `null`.
 */
type Routing = { workspaces: { id: string }[]; activeId: string | null };

/** Where to go for a routing answer; `null` stays on this page. */
type Decide = (r: Routing) => string | null;

type Outcome = { state: "pending" } | { state: "stay" } | { state: "error"; error: string };

/** The URL's query and fragment, verbatim (the Rust rules keep the raw query too). */
function searchAndHash(): string {
  return window.location.search + window.location.hash;
}

/** `/`: the active workspace's chat, else the first one's, else `/welcome` (R1, was `app/page.tsx`). */
const toActiveWorkspace: Decide = (r) => {
  const id = r.activeId ?? r.workspaces[0]?.id;
  return id ? `/${id}${searchAndHash()}` : "/welcome";
};

/**
 * A bare workspace-scoped path (`/git`, `/sessions/<id>`): the same path under
 * the active workspace, else `/` (R2, was `redirectToWorkspaceRoute`). With a
 * `wks_` cookie, `proxy.ts` 307s before this page renders.
 */
const toScopedRoute: Decide = (r) =>
  r.activeId
    ? `/${r.activeId}${window.location.pathname}${searchAndHash()}`
    : `/${searchAndHash()}`;

/** `/welcome` once a workspace exists: `/`, which resolves onward (R5). */
const toRootIfOnboarded: Decide = (r) => (r.workspaces.length > 0 ? "/" : null);

/**
 * One fresh read of `GET /api/workspaces` per path, then `router.replace` to
 * what `decide` returns. Decided once, from that read, like the server
 * component it replaces: a later change to the list (say the splash's own
 * `create`) never moves the user.
 */
function useWorkspaceRedirect(decide: Decide): Outcome {
  const router = useRouter();
  const pathname = usePathname();
  const [outcome, setOutcome] = useState<Outcome>({ state: "pending" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/workspaces", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = (await res.json()) as Routing;
        if (controller.signal.aborted) return;
        const target = decide(r);
        if (target === null) setOutcome({ state: "stay" });
        else router.replace(target);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({ state: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [decide, router, pathname]);

  return outcome;
}

function RedirectError({ error }: { error: string }) {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-sm text-[var(--muted)]"
      data-testid="workspace-redirect-error"
    >
      Couldn&apos;t load your workspaces: {error}
    </div>
  );
}

/** `app/page.tsx`: send the chat root to a workspace (R1). */
export function RootRedirect() {
  const outcome = useWorkspaceRedirect(toActiveWorkspace);
  return outcome.state === "error" ? <RedirectError error={outcome.error} /> : null;
}

/** The bare stubs (`app/git/page.tsx`, …): send the path under a workspace (R2). */
export function BareRouteRedirect() {
  const outcome = useWorkspaceRedirect(toScopedRoute);
  return outcome.state === "error" ? <RedirectError error={outcome.error} /> : null;
}

/**
 * `app/welcome/page.tsx`: the first-run splash, shown only while no workspace
 * exists (R5). Nothing renders until the list is in, so the splash never
 * flashes on an install that has already been set up.
 */
export function WelcomeGate({ children }: { children: ReactNode }) {
  const outcome = useWorkspaceRedirect(toRootIfOnboarded);
  if (outcome.state === "stay") return <>{children}</>;
  return outcome.state === "error" ? <RedirectError error={outcome.error} /> : null;
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * `app/[workspaceId]/layout.tsx`: render the workspace's pages only for a
 * workspace that exists, else `router.replace("/")` (R4). Without it, a
 * bookmark to a deleted workspace would mount the chat, whose boot creates a
 * session in whatever workspace the server resolves.
 *
 * - An id in the shared `useWorkspaces` list, which the pages load anyway,
 *   renders at once: a real id costs no extra request.
 * - An id missing from the list is asked about on its own,
 *   `GET /api/workspaces/<id>`: the old layout's `getWorkspace`, and the
 *   check R4 makes. Only a 404 sends the user to `/`. The list may predate
 *   the workspace (one made in another tab), or disagree with the server (a
 *   test stubbing the list, while R1 behind Rust resolves `/` from the store
 *   and would send the browser straight back: a loop). Any other failure
 *   renders the pages, which show their own error state, as does a failed
 *   list read.
 * - Once an id has been seen, its pages stay mounted whatever the list does
 *   later, as with the server check once per request: deleting the open
 *   workspace navigates on its own (`WorkspaceSwitcher`).
 */
export function WorkspaceIdGuard({ children }: { children: ReactNode }) {
  const seg = pathSegment(usePathname(), 0);
  const id = seg === null ? "" : decodeSegment(seg);
  const { items, loading, error } = useWorkspaces();
  const router = useRouter();
  const known = items.some((w) => w.id === id);

  // The last id seen to exist (derived state, set during render).
  const [seenId, setSeenId] = useState<string | null>(null);
  if (known && seenId !== id) setSeenId(id);

  // The last id the per-id check let through.
  const [checkedId, setCheckedId] = useState<string | null>(null);
  const waiting = !known && seenId !== id && checkedId !== id && !loading && !error;
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    fetch(`/api/workspaces/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.status === 404) router.replace("/");
        else setCheckedId(id);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheckedId(id);
      });
    return () => controller.abort();
  }, [waiting, id, router]);

  return known || seenId === id || checkedId === id || error ? <>{children}</> : null;
}
