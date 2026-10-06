"use client";

import { createContext, useContext } from "react";

/**
 * CC 2.1.290 — the resolved `showMessageTimestamps` setting, read once near
 * the chat root (ChatSurface, from `useShowMessageTimestamps`) and shared via
 * context so every bubble applies it without its own `/api/settings` fetch —
 * the same arrangement as `clock-options-context.ts`.
 *
 * Defaults to `true` (shown), the setting's default, so a bubble rendered
 * outside the provider (e.g. TranscriptViewer) shows its time too.
 */
const MessageTimestampsContext = createContext<boolean>(true);

export const MessageTimestampsProvider = MessageTimestampsContext.Provider;

export function useShowMessageTimestampsContext(): boolean {
  return useContext(MessageTimestampsContext);
}
