"use client";

import { WandSparkles } from "lucide-react";
import type { Workspace } from "@/lib/server/workspaces-store";

type Props = {
  workspace: Workspace;
  size?: number;
};

export function WorkspaceIcon({ workspace, size = 40 }: Props) {
  const radius = Math.round(size * 0.22);
  // Customization workspaces always render with the wand glyph as the
  // primary mark — matches the magic button in the workspace switcher rail
  // and removes the need for a separate badge overlay.
  if (workspace.kind === "customization") {
    const iconSize = Math.round(size * 0.55);
    const bg =
      workspace.icon.kind === "letter" ? workspace.icon.color : "var(--accent)";
    return (
      // `shrink-0` is critical: this icon is rendered inside flex rows
      // (StatusLine breadcrumb, WorkspaceSwitcher tiles) where the default
      // `flex-shrink: 1` would squeeze the explicit width/height below the
      // declared size when the sibling text competes for space — turning the
      // square badge into a vertically stretched pill (the "squashed" look).
      // Keep the declared `size × size` as a hard floor in every branch.
      <div
        className="flex shrink-0 items-center justify-center text-white"
        style={{
          width: size,
          height: size,
          background: bg,
          borderRadius: radius,
        }}
      >
        <WandSparkles style={{ width: iconSize, height: iconSize }} strokeWidth={2} />
      </div>
    );
  }
  if (workspace.icon.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/workspaces/${workspace.id}/icon`}
        alt={workspace.name}
        width={size}
        height={size}
        // See the comment on the customization branch above re: `shrink-0`.
        // `<img>` is replaced content but Chromium still honors flex-shrink
        // on it inside a flex row, so the same squash happens without this.
        className="shrink-0 object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  const fontSize = Math.round(size * 0.5);
  return (
    // See the comment on the customization branch above re: `shrink-0`. This
    // letter branch is the one rendered next to the workspace name in the
    // StatusLine, which is the exact spot where the squash was reported.
    <div
      className="flex shrink-0 items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: workspace.icon.color,
        borderRadius: radius,
        fontSize,
      }}
    >
      {workspace.icon.letter || workspace.name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}
