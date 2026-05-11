"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, BellOff, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useCommunity } from "@/lib/client/use-community";
import { useCommunityNotifications } from "@/components/community/CommunityNotificationsProvider";
import { RoomList } from "@/components/community/RoomList";
import { MessageList } from "@/components/community/MessageList";
import { PinnedBanner } from "@/components/community/PinnedBanner";
import { Composer } from "@/components/community/Composer";
import { NicknameModal } from "@/components/community/NicknameModal";
import { AdminPanel } from "@/components/community/AdminPanel";

/**
 * /community — embedded chat for everyone running Claudius. Talks to
 * the standalone chat-server defined in NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL.
 * If that env var is unset, we render a friendly empty state so dev
 * builds don't crash.
 *
 * The admin UI (shield icon + slide-over panel + per-message moderation)
 * only renders when `community.isAdmin` is true. That flag is set by
 * /api/community/admin/check — server-side it inspects
 * `CLAUDIUS_CHAT_ADMIN_TOKEN`. Non-admin installs never see admin
 * controls.
 *
 * Layout:
 *   ┌──────────┬──────────────────────────────────┬───────────┐
 *   │ Side nav │ Pinned banner                    │           │
 *   │          │ ─────────────────────────────    │  Admin    │
 *   │  Rooms   │           Messages               │  panel    │
 *   │          │ ─────────────────────────────    │  (opt)    │
 *   │          │ Composer                         │           │
 *   └──────────┴──────────────────────────────────┴───────────┘
 */
export default function CommunityPage() {
  const community = useCommunity();
  const notifications = useCommunityNotifications();
  const [adminOpen, setAdminOpen] = useState(false);

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
      if (!confirm(`Ban "${nick}" (nick + last-known IP)?`)) return;
      const r = await community.ban("nick", nick.toLowerCase());
      if (!r.ok) alert(`Ban failed: ${r.error}`);
    },
    [community],
  );

  // ── Empty state ──────────────────────────────────────────────────

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

      {/* Room list */}
      <aside className="w-44 shrink-0 border-r border-[var(--border)] bg-[var(--panel)]">
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
          currentSlug={community.currentRoom}
          onSelect={community.setCurrentRoom}
          unreadByRoom={notifications.unreadByRoom}
        />
        {community.roomsError && (
          <p className="px-3 text-[10px] text-[var(--accent)]">
            {community.roomsError}
          </p>
        )}
      </aside>

      {/* Main chat column */}
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
        />

        <Composer
          nick={community.nick}
          disabled={!community.connected}
          onSend={community.send}
        />
      </main>

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
