"use client";

import { createContext, useContext } from "react";
import {
  useCommunityNotificationsState,
  type UseCommunityNotifications,
} from "@/lib/client/use-community-notifications";

/**
 * App-wide subscriber for the community chat. Mounts at the layout root
 * alongside `NotificationsProvider` so the workspace switcher's Community
 * tile can read the unread badge + on/off state without spinning up its
 * own EventSources.
 *
 * Lives separately from `NotificationsProvider` because:
 *   • The chat-server is on a different origin (NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL)
 *     and has its own auth/admin model.
 *   • Community prefs are global per-browser (one chat, one nick), not
 *     per-workspace, so the per-workspace storage in NotificationsProvider
 *     doesn't fit.
 *   • Shipping it as a sibling means there's no risk of a community
 *     outage taking down the workspace badges (or vice versa).
 *
 * The "is the user actually viewing room X right now?" signal is pushed
 * in by the community page itself via `setViewingRoom(slug | null)` —
 * the provider doesn't sniff pathname or tab visibility on its own. That
 * keeps the rule for "what counts as seen?" close to the UI that owns
 * the current room selection.
 */

const Ctx = createContext<UseCommunityNotifications | null>(null);

export function CommunityNotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = useCommunityNotificationsState();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCommunityNotifications(): UseCommunityNotifications {
  const ctx = useContext(Ctx);
  if (!ctx) return EMPTY;
  return ctx;
}

const EMPTY: UseCommunityNotifications = {
  configured: false,
  enabled: false,
  permissionState: "unsupported",
  unreadCount: 0,
  unreadByRoom: {},
  unreadByPeer: {},
  setEnabled: async () => false,
  setViewingRoom: () => {},
  setViewingPeer: () => {},
  setMyNick: () => {},
};
