"use client";

import { useEffect, useState } from "react";

const COOKIE = "claudius.customization";

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * The id of the active customization (the `claudius.customization` cookie), or
 * null when a workspace is active instead. Customizations are no longer backed
 * by a workspace, so this cookie — not the workspace cookie — is what tells the
 * nav/banner "we're inside customization <id>". Re-reads on focus/visibility so
 * a select in another tab/route is picked up without a full reload.
 */
export function useActiveCustomization(): string | null {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    // The cookie is client-only, so we can't read it during render without a
    // hydration mismatch. The initial read is scheduled via setTimeout(_, 0)
    // so the setState fires from a timer callback (an external-system update)
    // rather than synchronously in the effect body — satisfying
    // react-hooks/set-state-in-effect (same idiom as the chat page's polls).
    const initial = setTimeout(() => setId(readCookie()), 0);
    const onMaybe = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setId(readCookie());
    };
    document.addEventListener("visibilitychange", onMaybe);
    window.addEventListener("focus", onMaybe);
    return () => {
      clearTimeout(initial);
      document.removeEventListener("visibilitychange", onMaybe);
      window.removeEventListener("focus", onMaybe);
    };
  }, []);

  return id;
}
