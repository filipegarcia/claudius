"use client";

import { useParams } from "next/navigation";
import ChatSurface from "@/components/chat/ChatSurface";

/**
 * Workspace chat route. The shared chat UI lives in {@link ChatSurface}; this
 * thin wrapper supplies the workspace identity from the URL. (The customization
 * chat route under `app/customize/[id]/chat` renders the same component with a
 * `kind:"customization"` context.) The `[workspaceId]` layout already validates
 * the id against the store, so the value here is a real workspace id.
 */
export default function WorkspaceChatPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return <ChatSurface kind="workspace" id={workspaceId} cwd={null} />;
}
