"use client";

import { usePathname } from "next/navigation";
import ChatSurface from "@/components/chat/ChatSurface";
import { pathSegment } from "@/lib/shared/route-params";

/**
 * Workspace chat route. The shared chat UI lives in {@link ChatSurface}; this
 * thin wrapper supplies the workspace identity from the URL. (The customization
 * chat route under `app/customize/[id]/chat` renders the same component with a
 * `kind:"customization"` context.) The `[workspaceId]` layout already validates
 * the id against the store, so the value here is a real workspace id. Read
 * from the pathname, not `useParams()` (see lib/shared/route-params.ts).
 */
export default function WorkspaceChatPage() {
  const workspaceId = pathSegment(usePathname(), 0) ?? "";
  return <ChatSurface kind="workspace" id={workspaceId} cwd={null} />;
}
