"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import ChatSurface from "@/components/chat/ChatSurface";
import type { CustomizationWithSrcDir } from "@/lib/server/customizations-store";
import { pathSegment } from "@/lib/shared/route-params";

/** What `GET /api/customizations/<seg>` answered, tagged with the segment it was for. */
type Loaded =
  | { seg: string; ok: true; id: string; srcDir: string }
  | { seg: string; ok: false; error: string };

/**
 * Customization chat route. Renders the shared {@link ChatSurface} with a
 * customization context — its `cwd` is the editable mirror src dir, so fresh
 * sessions run against the customization rather than any workspace.
 *
 * A client page (rust/parity/server-components.md § 3, N03 row 1): the id
 * comes from the pathname (not `params`, see lib/shared/route-params.ts) and
 * the record, with its `srcDir`, from `GET /api/customizations/<id>`.
 *
 * - **Unknown id** (404) → `router.replace("/customize")`, as the server
 *   component's `redirect()` did. With the Rust front door in front, a
 *   document load never gets here (its rule R6 answers the 307 first); this
 *   covers Next alone and soft navigations (`router.push` from the drawer).
 * - **`ChatSurface` mounts only once `srcDir` is known.** use-session's boot
 *   effect runs once on mount and reads `defaultCwd` after its async
 *   open-tabs lookup; a cwd that arrives late (or `null`) would create the
 *   fresh session in the cookie's context instead of the mirror.
 */
export default function CustomizationChatPage() {
  const seg = pathSegment(usePathname(), 1);
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!seg) return;
    const controller = new AbortController();
    fetch(`/api/customizations/${seg}`, { signal: controller.signal })
      .then(async (res) => {
        if (controller.signal.aborted) return;
        if (res.status === 404) {
          router.replace("/customize");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const c = (await res.json()) as CustomizationWithSrcDir;
        setLoaded({ seg, ok: true, id: c.id, srcDir: c.srcDir });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ seg, ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [seg, router]);

  // A result for another segment (a soft navigation between two chats) is stale.
  const current = loaded?.seg === seg ? loaded : null;
  if (current?.ok) {
    return <ChatSurface key={current.id} kind="customization" id={current.id} cwd={current.srcDir} />;
  }
  if (current) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--muted)]" data-testid="customization-chat-error">
        Couldn&apos;t load this customization: {current.error}
      </div>
    );
  }
  return <div className="h-full" data-testid="customization-chat-loading" />;
}
