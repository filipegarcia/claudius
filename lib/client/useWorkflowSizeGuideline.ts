"use client";

import { useEffect, useState } from "react";
import type { ClaudeSettings } from "@/lib/server/settings";
import { DEFAULT_WORKFLOW_SIZE, effectiveWorkflowSize, type WorkflowSize } from "@/lib/shared/workflow-size";

/**
 * CC 2.1.219 (H14) — the user-scope `workflowSizeGuideline`, resolved to the
 * effective size (the SDK default "medium" when unset). Read from user scope,
 * matching the sibling setting hooks (`useMaxEffortLevel`, `useProseMaxWidth`).
 * Shown on the running workflow block. Defaults until the fetch resolves.
 */
export function useWorkflowSizeGuideline(cwd: string | null): WorkflowSize {
  const [size, setSize] = useState<WorkflowSize>(DEFAULT_WORKFLOW_SIZE);
  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();
    fetch(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { settings: ClaudeSettings };
        setSize(effectiveWorkflowSize(data.settings.workflowSizeGuideline));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [cwd]);
  return size;
}
