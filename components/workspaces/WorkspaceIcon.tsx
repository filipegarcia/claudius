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
      <div
        className="flex items-center justify-center text-white"
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
        className="object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  const fontSize = Math.round(size * 0.5);
  return (
    <div
      className="flex items-center justify-center font-semibold text-white"
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
