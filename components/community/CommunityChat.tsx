"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  BellOff,
  MessageSquarePlus,
  PowerOff,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useCommunity } from "@/lib/client/use-community";
import { useDMs } from "@/lib/client/use-dms";
import { useCommunityNotifications } from "@/components/community/CommunityNotificationsProvider";
import { RoomList } from "@/components/community/RoomList";
import { MessageList } from "@/components/community/MessageList";
import { PinnedBanner } from "@/components/community/PinnedBanner";
import { Composer } from "@/components/community/Composer";
import { NicknameModal } from "@/components/community/NicknameModal";
import { AdminPanel } from "@/components/community/AdminPanel";
import { DMThread } from "@/components/community/DMThread";
import { NewDMModal } from "@/components/community/NewDMModal";

type Props = {
  /**
   * Called when the user clicks the "opt out" link in the footer.
   * Lifted up to /community/page.tsx so it can persist the choice
   * before unmounting this component (preventing one last render
   * with the chat still wired up).
   */
  onOptOut: () => void;
};

/**
 * The actual community chat surface — everything that talks to the
 * chat-server lives in this component so it can be conditionally
 * mounted by the consent gate in app/community/page.tsx. When the
 * user has not opted in, this component is *not rendered*, so
 * useCommunity() is not called and no SSE connection / /rooms fetch
 * is ever issued.
 *
 * (The earlier shape of this page had useCommunity at the top level
 * with a "not configured" empty state. Now configured-vs-consented
 * vs opted-out are three distinct screens routed by the parent.)
 */
export function CommunityChat({ onOptOut }: Props) {
  const community = useCommunity();
  const dms = useDMs();
  const notifications = useCommunityNotifications();
  const [adminOpen, setAdminOpen] = useState(false);
  const [newDMOpen, setNewDMOpen] = useState(false);

  const toggleNotifications = useCallback(async () => {
    const next = !notifications.enabled;
    const accepted = await notifications.setEnabled(next);
    // Surface denied / unsupported permission as an inline alert so the
    // user understands the toggle "flipped on" but won't actually fire OS
    // toasts. Cheap UX, no extra component.
    if (
      accepted &&
      next &&
      typeof Notification !== "undefined" &&
      Notification.permission === "denied"
    ) {
      alert(
        "Notifications are blocked for this site in your browser settings. " +
          "Unread badges will still appear, but no desktop toasts will be shown until you allow notifications.",
      );
    }
  }, [notifications]);

  // Tell the notifications hook which room we're actively viewing, so
  // landing on a channel only clears that channel's unread badge. We pair
  // the room slug with tab visibility — when the tab goes background we
  // tell the hook "viewing nothing" so badges/toasts resume for the room
  // the user can't see right now anyway.
  const { setViewingRoom, setMyNick } = notifications;
  useEffect(() => {
    const update = () => {
      const visible =
        typeof document === "undefined" ? true : !document.hidden;
      setViewingRoom(visible ? community.currentRoom : null);
    };
    update();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", update);
      return () => {
        document.removeEventListener("visibilitychange", update);
        setViewingRoom(null);
      };
    }
    return () => setViewingRoom(null);
  }, [community.currentRoom, setViewingRoom]);

  // Keep the notifications hook in sync with the user's nick so it can
  // ignore their own messages when computing unread counts.
  useEffect(() => {
    setMyNick(community.nick);
  }, [community.nick, setMyNick]);

  const pinnedMessage = useMemo(
    () =>
      community.pinnedId
        ? community.messages.find((m) => m.id === community.pinnedId) ?? null
        : null,
    [community.messages, community.pinnedId],
  );

  // Inline moderation handlers — thin wrappers that surface error toasts
  // would be nicer, but for v1 a plain alert keeps the surface small.
  const handleDelete = useCallback(
    async (id: string) => {
      const r = await community.deleteMessage(id);
      if (!r.ok) alert(`Delete failed: ${r.error}`);
    },
    [community],
  );

  const handlePin = useCallback(
    async (id: string) => {
      const r = await community.pinMessage(id);
      if (!r.ok) alert(`Pin failed: ${r.error}`);
    },
    [community],
  );

  const handleUnpin = useCallback(async () => {
    const r = await community.unpinRoom(community.currentRoom);
    if (!r.ok) alert(`Unpin failed: ${r.error}`);
  }, [community]);

  const handleBan = useCallback(
    async (nick: string) => {
      if (
        !confirm(
          `Ban "${nick}" (nick + last-known IP) and delete all their previous messages?`,
        )
      ) {
        return;
      }
      // Inline ban from a message row always purges — the admin is
      // looking at offending content and the reasonable default is
      // "make it all go away." The AdminPanel form has a checkbox
      // for the rare ban-without-purge case.
      const r = await community.ban("nick", nick.toLowerCase(), {
        purgeMessages: true,
      });
      if (!r.ok) alert(`Ban failed: ${r.error}`);
    },
    [community],
  );

  // ── Empty state — chat-server URL unset ──────────────────────────
  //
  // Distinct from the "opted out" state handled by the parent page:
  // this one means the build was shipped without a chat-server URL
  // (forks that disable /community by setting the env var to "").

  if (!community.configured) {
    return (
      <div className="flex h-full" data-testid="community-empty-state">
        <SideNav />
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
            <h1 className="text-base font-semibold">Community chat not configured</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Community chat runs on a small standalone{" "}
              <code className="font-mono">chat-server</code> — institutions
              typically deploy their own and point Claudius at it. Set{" "}
              <code className="font-mono">NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL</code>{" "}
              in your <code className="font-mono">.env.local</code> (or your
              deployment environment) to the server URL, then restart
              Claudius. See <code className="font-mono">chat-server/README.md</code>{" "}
              for how to deploy one.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full" data-testid="community-page">
      <SideNav />

      {/* Room + DM list */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)]">
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            Rooms
          </span>
          {community.connected ? (
            <Wifi className="h-3.5 w-3.5 text-[var(--accent)]" />
          ) : (
            <WifiOff className="h-3.5 w-3.5 text-[var(--muted)]" />
          )}
        </div>
        <RoomList
          rooms={community.rooms}
          currentSlug={dms.currentPeer ? null : community.currentRoom}
          onSelect={(slug) => {
            // Selecting a channel implicitly closes any open DM
            // thread — the main column flips back to room view.
            dms.setCurrentPeer(null);
            community.setCurrentRoom(slug);
          }}
          unreadByRoom={notifications.unreadByRoom}
        />
        {community.roomsError && (
          <p className="px-3 text-[10px] text-[var(--accent)]">
            {community.roomsError}
          </p>
        )}

        {/* Direct messages */}
        <div className="mt-4 flex items-center justify-between px-3 pb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            Direct messages
          </span>
          <button
            type="button"
            onClick={() => setNewDMOpen(true)}
            disabled={!dms.configured}
            title="New direct message"
            className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            data-testid="community-dm-new"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <ul
          className="px-2 pb-2"
          data-testid="community-dm-list"
        >
          {dms.conversations.length === 0 && (
            <li className="px-2 py-1 text-[10px] text-[var(--muted)]">
              No DMs yet. Start one with the “+” above.
            </li>
          )}
          {dms.conversations.map((c) => {
            const isCurrent =
              dms.currentPeer?.toLowerCase() === c.peerNick.toLowerCase();
            const preview = c.lastMessage.deletedAt
              ? "(deleted)"
              : c.lastMessage.body;
            return (
              <li key={c.peerNick}>
                <button
                  type="button"
                  onClick={() => dms.setCurrentPeer(c.peerNick)}
                  className={
                    "block w-full truncate rounded px-2 py-1 text-left text-xs " +
                    (isCurrent
                      ? "bg-[var(--panel-2)] text-[var(--foreground)]"
                      : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]")
                  }
                  data-testid={`community-dm-conv-${c.peerNick}`}
                >
                  <span className="block truncate font-mono">@{c.peerNick}</span>
                  <span className="block truncate text-[10px] text-[var(--muted)]">
                    {preview || " "}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Footer: opt-out link, low-emphasis. Always shown so users can
            disconnect without hunting through Settings. */}
        <div className="mt-auto border-t border-[var(--border)] px-3 py-2">
          <button
            type="button"
            onClick={onOptOut}
            className="text-[10px] text-[var(--muted)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
            data-testid="community-opt-out"
          >
            Disconnect from community
          </button>
        </div>
      </aside>

      {/* Main column: DM thread when a peer is selected, otherwise the
          channel chat. Mounting the DMThread instead of the channel
          surface means the channel SSE keeps running in the
          background (so unread badges accumulate while you're in a
          DM) but the channel UI isn't taking up the column. */}
      {dms.currentPeer ? (
        <DMThread
          dms={dms}
          peer={dms.currentPeer}
          onClose={() => dms.setCurrentPeer(null)}
        />
      ) : (
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-sm text-[var(--foreground)]">
              {currentRoomName(community)}
            </span>
            <span className="truncate text-xs text-[var(--muted)]">
              {currentRoomDescription(community)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-[var(--muted)]">
              {community.nick ? `you: ${community.nick}` : "no nickname"}
            </span>
            {community.nick && (
              <button
                type="button"
                onClick={() => community.setNick("")}
                title="Change nickname"
                className="rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              >
                <span className="text-[10px] underline-offset-2 hover:underline">change</span>
              </button>
            )}
            <button
              type="button"
              onClick={toggleNotifications}
              title={
                notifications.enabled
                  ? "Notifications: on (click to mute)"
                  : "Notifications: off (click to enable)"
              }
              aria-pressed={notifications.enabled}
              data-testid="community-notifications-toggle"
              className={
                "rounded p-1 transition " +
                (notifications.enabled
                  ? "bg-[var(--panel-2)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]")
              }
            >
              {notifications.enabled ? (
                <Bell className="h-4 w-4" />
              ) : (
                <BellOff className="h-4 w-4" />
              )}
            </button>
            {community.isAdmin && (
              <button
                type="button"
                onClick={() => setAdminOpen((v) => !v)}
                title="Admin"
                className={
                  "rounded p-1 transition " +
                  (adminOpen
                    ? "bg-[var(--panel-2)] text-[var(--accent)]"
                    : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]")
                }
                data-testid="community-admin-toggle"
              >
                <ShieldCheck className="h-4 w-4" />
              </button>
            )}
          </div>
        </header>

        {/* Kill-switch banner. Shown to everyone (admins included)
            when an admin has flipped the community off. The history
            stays browsable; only posting is blocked, and the composer
            below disables itself. Stays connected over SSE so the
            matching enable event flips it back without a reload. */}
        {!community.communityState.enabled && (
          <div
            className="flex items-start gap-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-2 text-xs text-[var(--accent)]"
            data-testid="community-offline-banner"
            role="alert"
          >
            <PowerOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <span className="font-medium">Community is currently offline.</span>{" "}
              <span className="text-[var(--accent)]/80">
                {community.communityState.reason
                  ? `Reason: ${community.communityState.reason}.`
                  : "An admin has temporarily disabled posting."}
                {community.isAdmin &&
                  " Re-enable from the admin panel (shield icon, top-right)."}
              </span>
            </div>
          </div>
        )}

        {pinnedMessage && (
          <PinnedBanner
            message={pinnedMessage}
            isAdmin={community.isAdmin}
            onUnpin={handleUnpin}
          />
        )}

        <MessageList
          messages={community.messages}
          nick={community.nick}
          isAdmin={community.isAdmin}
          pinnedId={community.pinnedId}
          onDelete={handleDelete}
          onPin={handlePin}
          onBan={handleBan}
          hasMore={community.hasMore}
          loadingOlder={community.loadingOlder}
          onLoadOlder={community.loadOlder}
        />

        <Composer
          nick={community.nick}
          disabled={!community.connected || !community.communityState.enabled}
          onSend={community.send}
        />
      </main>
      )}

      {newDMOpen && (
        <NewDMModal
          dms={dms}
          onSent={(peer) => {
            setNewDMOpen(false);
            dms.setCurrentPeer(peer);
          }}
          onClose={() => setNewDMOpen(false)}
        />
      )}

      {adminOpen && community.isAdmin && (
        <AdminPanel
          community={community}
          rooms={community.rooms}
          onClose={() => setAdminOpen(false)}
        />
      )}

      {/* Nickname picker — modal blocks interaction until a nick is chosen. */}
      {!community.nick && (
        <NicknameModal onSubmit={community.setNick} />
      )}
    </div>
  );
}

function currentRoomName(community: ReturnType<typeof useCommunity>): string {
  return (
    community.rooms.find((r) => r.slug === community.currentRoom)?.name ??
    `#${community.currentRoom}`
  );
}

function currentRoomDescription(
  community: ReturnType<typeof useCommunity>,
): string {
  return (
    community.rooms.find((r) => r.slug === community.currentRoom)?.description ??
    ""
  );
}
