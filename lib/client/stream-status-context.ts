"use client";

import { createContext, useContext } from "react";

/**
 * CC 2.1.302 parity — "Fixed a subagent's pane spinning forever in a Remote
 * Control session after your computer goes offline; it now says Remote Control
 * is disconnected". Claudius's analog: while the session's SSE stream is
 * reconnecting (`useSession().streamStatus === "reconnecting"`), nothing about
 * a running subagent can be known, so its card must not keep pulsing as if it
 * were making progress.
 *
 * Provided once near the chat root (ChatSurface), like
 * `message-timestamps-context.ts`. Defaults to `false` (connected), so a card
 * rendered outside the provider (e.g. TranscriptViewer) is unaffected.
 */
const StreamDisconnectedContext = createContext<boolean>(false);

export const StreamDisconnectedProvider = StreamDisconnectedContext.Provider;

export function useStreamDisconnected(): boolean {
  return useContext(StreamDisconnectedContext);
}
