"use client";

import { useId } from "react";
import { cn } from "@/lib/utils/cn";

export type Scope = "workspace" | "account";

type Props = {
  value: Scope;
  onChange: (next: Scope) => void;
  /** Optional override label for the workspace side (e.g. "Project"). */
  workspaceLabel?: string;
  /** Optional override label for the account side. */
  accountLabel?: string;
  className?: string;
};

/**
 * Compact two-state segmented control for the dual-scope pages
 * (Memory / Assets / Cost / Agents / Hooks / Permissions). Lives in the page
 * header next to the title. Default is `workspace`.
 */
export function ScopeToggle({
  value,
  onChange,
  workspaceLabel = "Workspace",
  accountLabel = "Account",
  className,
}: Props) {
  const labelId = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      className={cn(
        "ml-2 inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-0.5 text-[10px]",
        className,
      )}
    >
      <span id={labelId} className="sr-only">
        Scope
      </span>
      <button
        type="button"
        role="radio"
        aria-checked={value === "workspace"}
        onClick={() => onChange("workspace")}
        className={cn(
          "rounded px-2 py-0.5 font-medium transition",
          value === "workspace"
            ? "bg-[var(--panel)] text-[var(--foreground)] shadow-sm"
            : "text-[var(--muted)] hover:text-[var(--foreground)]",
        )}
      >
        {workspaceLabel}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "account"}
        onClick={() => onChange("account")}
        className={cn(
          "rounded px-2 py-0.5 font-medium transition",
          value === "account"
            ? "bg-[var(--panel)] text-[var(--foreground)] shadow-sm"
            : "text-[var(--muted)] hover:text-[var(--foreground)]",
        )}
      >
        {accountLabel}
      </button>
    </div>
  );
}
