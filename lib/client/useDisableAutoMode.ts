"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";

/**
 * Whether Auto mode (the SDK's autonomous permission mode) is disabled via
 * the user-scope `disableAutoMode` setting. Claude Code 2.1.207 made Auto
 * mode available without the `CLAUDE_CODE_ENABLE_AUTO_MODE` opt-in on
 * Bedrock/Vertex/Foundry and shipped this settings escape hatch alongside
 * it. Claudius mirrors the escape hatch by hiding "Auto" from the
 * ModeSelector dropdown and the Shift+Tab cycle.
 *
 * This is UI polish, not the enforcement point — `Session.setPermissionMode`
 * independently coerces a requested "auto" back to "default" server-side, so
 * a stale/unfetched value here can't let a user actually enter Auto mode.
 *
 * User scope only (matches the server-side check) — a per-project
 * `.claude/settings.local.json` override is intentionally NOT consulted,
 * mirroring upstream's 2.1.207 scope restriction.
 */
export function useDisableAutoMode(cwd: string | null): boolean {
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setDisabled(data.settings.disableAutoMode === "disable");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);

  return disabled;
}
