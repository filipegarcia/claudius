"use client";

import { Hourglass } from "lucide-react";
import type { PermissionRequestEvent } from "@/lib/shared/events";

type Props = {
  request: PermissionRequestEvent | null;
};

export function PermissionPending({ request }: Props) {
  if (!request) return null;
  return (
    <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-200">
      <button
        type="button"
        onClick={() => {
          // Re-focus the modal: it owns the page when mounted, so just bring
          // the document focus to it via a known data attribute.
          const el = document.querySelector<HTMLElement>("[data-permission-modal] button");
          el?.focus();
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        className="flex w-full items-center gap-1.5 text-left text-[11px]"
      >
        <Hourglass className="h-3 w-3 shrink-0 animate-pulse" />
        <span className="truncate">Waiting on your approval — open prompt</span>
      </button>
      <div className="mt-0.5 truncate font-mono text-[10px] opacity-80">
        {request.toolName}
      </div>
    </div>
  );
}
