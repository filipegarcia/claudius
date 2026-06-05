"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  X,
  Trash2,
  Megaphone,
  Hash,
  Eraser,
  Scissors,
  PowerOff,
  Power,
  Filter,
  Plus,
  Users,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import type {
  Ban,
  BannedWord,
  ChannelMember,
  Room,
} from "@/lib/shared/community";
import type { UseCommunity } from "@/lib/client/use-community";

type Props = {
  community: UseCommunity;
  rooms: Room[];
  onClose: () => void;
  /**
   * Open a DM thread with the clicked nickname. Wired from
   * CommunityChat so the "DM" button in the members list flips the
   * main column to the DMThread view. Optional — when omitted, the
   * members list still renders but without the DM action button.
   */
  onSelectNick?: (nick: string) => void;
};

/**
 * Slide-over panel for admin-only operations.
 *
 * Two sections:
 *   1. Announce — post a message AS admin to any room.
 *   2. Bans — list/create/remove bans by nick or IP.
 *
 * The admin token used to live in this panel as a paste-it-in-the-browser
 * field; it now lives server-side as `CLAUDIUS_CHAT_ADMIN_TOKEN` and admin
 * actions are proxied through `/api/community/admin/*`. The panel itself
 * is only rendered when `isAdmin` is true (see app/community/page.tsx).
 *
 * We deliberately don't surface delete/pin here — those are inline on
 * each Message row when admin mode is active.
 */
export function AdminPanel({ community, rooms, onClose, onSelectNick }: Props) {
  // Announce form state.
  const [announceRoom, setAnnounceRoom] = useState(community.currentRoom);
  const [announceBody, setAnnounceBody] = useState("");
  const [announceBusy, setAnnounceBusy] = useState(false);
  const [announceErr, setAnnounceErr] = useState<string | null>(null);

  // Ban form + list.
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [banKind, setBanKind] = useState<"nick" | "ip">("nick");
  const [banValue, setBanValue] = useState("");
  const [banReason, setBanReason] = useState("");
  // Default ON for the inline message-ban case (people usually want
  // to make the offending content go away), but presented as a
  // checkbox here so the admin can ban without purging when needed.
  const [banPurge, setBanPurge] = useState(true);
  const [banBusy, setBanBusy] = useState(false);
  const [banErr, setBanErr] = useState<string | null>(null);
  const [banLastPurged, setBanLastPurged] = useState<number | null>(null);

  // Kill-switch UI state. The reason text is stashed locally and sent
  // alongside the disable call so the offline overlay can show why.
  const [killSwitchReason, setKillSwitchReason] = useState("");
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
  const [killSwitchErr, setKillSwitchErr] = useState<string | null>(null);

  // Banned-words list state.
  const [bannedWords, setBannedWords] = useState<BannedWord[] | null>(null);
  const [bannedWordInput, setBannedWordInput] = useState("");
  const [bannedWordBusy, setBannedWordBusy] = useState(false);
  const [bannedWordErr, setBannedWordErr] = useState<string | null>(null);

  // Channel form state. Slug + display name are required; description
  // optional. The slug regex matches the server-side validation in
  // chat-server/src/server.ts (SLUG_RE) so the failure mode is "button
  // is greyed out" rather than a server round-trip + error toast.
  const [channelSlug, setChannelSlug] = useState("");
  const [channelName, setChannelName] = useState("");
  const [channelDesc, setChannelDesc] = useState("");
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelErr, setChannelErr] = useState<string | null>(null);

  // Clear / compact targets the room currently in the announce dropdown
  // so the admin can scope all room-level operations with one selector.
  // Compact keep-count defaults to 100 (the same as the server's default
  // and the typical replay window).
  const [compactKeep, setCompactKeep] = useState(100);
  const [roomOpBusy, setRoomOpBusy] = useState<"clear" | "compact" | null>(
    null,
  );
  const [roomOpErr, setRoomOpErr] = useState<string | null>(null);

  // Members list (admin-only roster for the announce-selected room).
  // Stored per-room would be tidier but the panel is short-lived and
  // refetching on room switch is cheap.
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);

  // Re-fetch counters — the effects below run the actual fetch keyed on
  // these counters plus the admin flag. setState calls only happen in
  // Promise callbacks, satisfying react-hooks/set-state-in-effect. The
  // "clear state when admin flips off" half lives in the `lastIsAdmin`
  // in-render reset block below, again to keep setState out of effects.
  const [bansTrigger, setBansTrigger] = useState(0);
  const [bannedWordsTrigger, setBannedWordsTrigger] = useState(0);
  const [membersTrigger, setMembersTrigger] = useState(0);
  const [lastIsAdmin, setLastIsAdmin] = useState(community.isAdmin);
  if (lastIsAdmin !== community.isAdmin) {
    setLastIsAdmin(community.isAdmin);
    if (!community.isAdmin) {
      setBans(null);
      setBannedWords(null);
      setMembers(null);
    }
  }

  useEffect(() => {
    if (!community.isAdmin) return;
    let cancelled = false;
    void community.listBans().then((b) => {
      if (!cancelled) setBans(b);
    });
    return () => {
      cancelled = true;
    };
  }, [community, bansTrigger]);

  useEffect(() => {
    if (!community.isAdmin) return;
    let cancelled = false;
    void community.listBannedWords().then((b) => {
      if (!cancelled) setBannedWords(b);
    });
    return () => {
      cancelled = true;
    };
  }, [community, bannedWordsTrigger]);

  // Members fetch is keyed on the announce-selected room so switching
  // channels (via the "Post as admin" selector at the top of the panel)
  // reloads the roster for the new room. Re-fetch also runs when the
  // admin clicks the manual refresh button.
  useEffect(() => {
    if (!community.isAdmin) return;
    let cancelled = false;
    // The sync setMembersBusy(true) here is the "I'm about to do
    // work" flag for the refresh-spinner. It's not a cascade — deps
    // are user-driven (room switch / explicit refresh), the post-
    // resolution setMembers/setMembersBusy(false) live in the Promise
    // callback, and we abort via `cancelled` if a re-run interrupts
    // an in-flight fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMembersBusy(true);
    void community.listChannelMembers(announceRoom).then((m) => {
      if (!cancelled) {
        setMembers(m);
        setMembersBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [community, announceRoom, membersTrigger]);

  const refreshBans = useCallback(() => {
    setBansTrigger((n) => n + 1);
  }, []);

  const refreshBannedWords = useCallback(() => {
    setBannedWordsTrigger((n) => n + 1);
  }, []);

  const refreshMembers = useCallback(() => {
    setMembersTrigger((n) => n + 1);
  }, []);

  const addWord = async () => {
    const w = bannedWordInput.trim();
    if (!w) return;
    setBannedWordBusy(true);
    setBannedWordErr(null);
    const res = await community.addBannedWord(w);
    setBannedWordBusy(false);
    if (res.ok) {
      setBannedWordInput("");
      await refreshBannedWords();
    } else {
      setBannedWordErr(res.error);
    }
  };

  const removeWord = async (word: string) => {
    const res = await community.removeBannedWord(word);
    if (res.ok) await refreshBannedWords();
  };

  const announce = async () => {
    if (!announceBody.trim()) return;
    setAnnounceBusy(true);
    setAnnounceErr(null);
    const res = await community.sendAsAdmin(announceRoom, announceBody.trim());
    setAnnounceBusy(false);
    if (res.ok) setAnnounceBody("");
    else setAnnounceErr(res.error);
  };

  const createBan = async () => {
    const v = banValue.trim();
    if (!v) return;
    setBanBusy(true);
    setBanErr(null);
    setBanLastPurged(null);
    const res = await community.ban(banKind, v, {
      reason: banReason.trim() || undefined,
      purgeMessages: banPurge,
    });
    setBanBusy(false);
    if (res.ok) {
      const data = res.data as { purgedCount?: number } | undefined;
      setBanLastPurged(data?.purgedCount ?? 0);
      setBanValue("");
      setBanReason("");
      await refreshBans();
    } else {
      setBanErr(res.error);
    }
  };

  // Kill-switch handlers. Disable confirms because it's high-impact —
  // every connected client immediately sees the offline overlay.
  // Enable doesn't confirm (low-impact, easy to undo).
  const disable = async () => {
    if (
      !confirm(
        "Disable the community for ALL connected users? They'll see an offline overlay until you re-enable.",
      )
    ) {
      return;
    }
    setKillSwitchBusy(true);
    setKillSwitchErr(null);
    const res = await community.disableCommunity(
      killSwitchReason.trim() || undefined,
    );
    setKillSwitchBusy(false);
    if (res.ok) {
      setKillSwitchReason("");
    } else {
      setKillSwitchErr(res.error);
    }
  };

  const enable = async () => {
    setKillSwitchBusy(true);
    setKillSwitchErr(null);
    const res = await community.enableCommunity();
    setKillSwitchBusy(false);
    if (!res.ok) setKillSwitchErr(res.error);
  };

  const liftBan = async (id: number) => {
    const res = await community.unban(id);
    if (res.ok) await refreshBans();
  };

  // Channel handlers. createChannel double-validates the slug against
  // the server regex so the button is only ever enabled for inputs the
  // server will actually accept. We don't auto-jump to the new room on
  // success — admins often create a channel and then keep doing other
  // things; jumping the active room would be jarring.
  const createChannel = async () => {
    const slug = channelSlug.trim();
    const name = channelName.trim();
    if (!slug || !name) return;
    setChannelBusy(true);
    setChannelErr(null);
    const res = await community.createRoom(
      slug,
      name,
      channelDesc.trim() || undefined,
    );
    setChannelBusy(false);
    if (res.ok) {
      setChannelSlug("");
      setChannelName("");
      setChannelDesc("");
    } else {
      setChannelErr(res.error);
    }
  };

  const clearChannel = async () => {
    if (
      !confirm(
        `Hard-delete EVERY message in #${announceRoom}? This is irreversible.`,
      )
    ) {
      return;
    }
    setRoomOpBusy("clear");
    setRoomOpErr(null);
    const res = await community.clearRoom(announceRoom);
    setRoomOpBusy(null);
    if (!res.ok) setRoomOpErr(res.error);
  };

  const compactChannel = async () => {
    if (compactKeep < 0 || compactKeep > 10_000) return;
    if (
      !confirm(
        `Trim #${announceRoom} to the most recent ${compactKeep} messages? Older history will be permanently deleted.`,
      )
    ) {
      return;
    }
    setRoomOpBusy("compact");
    setRoomOpErr(null);
    const res = await community.compactRoom(announceRoom, compactKeep);
    setRoomOpBusy(null);
    if (!res.ok) setRoomOpErr(res.error);
  };

  // Same regex as chat-server/src/server.ts SLUG_RE. Centralising would
  // mean a shared module the standalone chat-server can't depend on —
  // duplicating one regex is the lower-friction option.
  const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
  const slugValid = SLUG_RE.test(channelSlug.trim());
  const channelSlugError =
    channelSlug.length > 0 && !slugValid
      ? "slug must be lowercase, start with a letter or digit, only [a-z0-9_-]"
      : null;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
          Admin
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          title="Close admin panel"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="scroll-thin flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {/* Community state — kill switch. First section because it's
            the most impactful lever on the page. */}
        <section data-testid="community-admin-kill-switch">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            {community.communityState.enabled ? (
              <Power className="h-3.5 w-3.5 text-[var(--accent)]" />
            ) : (
              <PowerOff className="h-3.5 w-3.5 text-[var(--accent)]" />
            )}
            Community state
          </h3>
          {community.communityState.enabled ? (
            <>
              <p className="mb-2 text-[10px] text-[var(--muted)]">
                Live. Disabling shows every connected user an offline
                overlay until you re-enable. They stay connected so
                the flip-back is instant — no reload needed.
              </p>
              <input
                value={killSwitchReason}
                onChange={(e) => setKillSwitchReason(e.target.value)}
                placeholder="reason shown to users (optional)"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
                maxLength={200}
              />
              <button
                type="button"
                onClick={disable}
                disabled={killSwitchBusy || !community.isAdmin}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent)]/10 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-40"
              >
                <PowerOff className="h-3.5 w-3.5" />
                {killSwitchBusy ? "Disabling…" : "Kill switch — disable community"}
              </button>
            </>
          ) : (
            <>
              <p className="mb-2 text-[10px] text-[var(--accent)]">
                Disabled.{" "}
                {community.communityState.reason
                  ? `Reason: "${community.communityState.reason}".`
                  : "No reason set."}{" "}
                Users are blocked from posting and see an offline
                overlay.
              </p>
              <button
                type="button"
                onClick={enable}
                disabled={killSwitchBusy || !community.isAdmin}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] py-1 text-xs font-medium text-[var(--background)] hover:brightness-110 disabled:opacity-40"
              >
                <Power className="h-3.5 w-3.5" />
                {killSwitchBusy ? "Re-enabling…" : "Re-enable community"}
              </button>
            </>
          )}
          {killSwitchErr && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">
              {killSwitchErr}
            </p>
          )}
        </section>

        {/* Announce */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            <Megaphone className="h-3.5 w-3.5" /> Post as admin
          </h3>
          <select
            value={announceRoom}
            onChange={(e) => setAnnounceRoom(e.target.value)}
            className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
          >
            {rooms.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name}
              </option>
            ))}
          </select>
          <textarea
            rows={3}
            value={announceBody}
            onChange={(e) => setAnnounceBody(e.target.value)}
            placeholder="Announcement…"
            className="scroll-thin w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <button
            type="button"
            onClick={announce}
            disabled={announceBusy || !announceBody.trim() || !community.isAdmin}
            className="mt-2 w-full rounded-md bg-[var(--accent)] py-1 text-xs font-medium text-[var(--background)] hover:brightness-110 disabled:opacity-40"
          >
            {announceBusy ? "Sending…" : "Send announcement"}
          </button>
          {announceErr && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">{announceErr}</p>
          )}
        </section>

        {/* Create channel */}
        <section data-testid="community-admin-create-channel">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            <Hash className="h-3.5 w-3.5" /> Open channel
          </h3>
          <input
            value={channelSlug}
            onChange={(e) =>
              setChannelSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))
            }
            placeholder="slug (e.g. announcements)"
            aria-invalid={channelSlugError !== null}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          {channelSlugError && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">
              {channelSlugError}
            </p>
          )}
          <input
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            placeholder="display name (e.g. #announcements)"
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <input
            value={channelDesc}
            onChange={(e) => setChannelDesc(e.target.value)}
            placeholder="description (optional)"
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <button
            type="button"
            onClick={createChannel}
            disabled={
              channelBusy ||
              !slugValid ||
              !channelName.trim() ||
              !community.isAdmin
            }
            className="mt-2 w-full rounded-md bg-[var(--accent)] py-1 text-xs font-medium text-[var(--background)] hover:brightness-110 disabled:opacity-40"
          >
            {channelBusy ? "Creating…" : "Open channel"}
          </button>
          {channelErr && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">{channelErr}</p>
          )}
        </section>

        {/* Clear + compact (room-level ops on the announce-selected room) */}
        <section data-testid="community-admin-room-ops">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            Room ops
          </h3>
          <p className="mb-2 text-[10px] text-[var(--muted)]">
            Operates on{" "}
            <span className="font-mono text-[var(--foreground)]">
              {currentRoomName(rooms, announceRoom)}
            </span>{" "}
            (change the channel via the “Post as admin” selector above).
          </p>
          <button
            type="button"
            onClick={clearChannel}
            disabled={roomOpBusy !== null || !community.isAdmin}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--border)] py-1 text-xs font-medium hover:bg-[var(--panel-2)] disabled:opacity-40"
          >
            <Eraser className="h-3.5 w-3.5" />
            {roomOpBusy === "clear" ? "Clearing…" : "Clear all messages"}
          </button>
          <div className="mt-2 flex gap-1">
            <input
              type="number"
              min={0}
              max={10000}
              value={compactKeep}
              onChange={(e) =>
                setCompactKeep(
                  Math.max(0, Math.min(10000, Number(e.target.value) || 0)),
                )
              }
              className="w-20 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label="keep most-recent N messages"
            />
            <button
              type="button"
              onClick={compactChannel}
              disabled={roomOpBusy !== null || !community.isAdmin}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--border)] py-1 text-xs font-medium hover:bg-[var(--panel-2)] disabled:opacity-40"
            >
              <Scissors className="h-3.5 w-3.5" />
              {roomOpBusy === "compact" ? "Compacting…" : "Compact"}
            </button>
          </div>
          {roomOpErr && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">{roomOpErr}</p>
          )}
        </section>

        {/* Members — admin-only roster for the selected channel.
            Derived from message history (no membership table exists),
            so the list is "everyone who has ever posted here, live
            messages only." Sorted newest-active first. */}
        <section data-testid="community-admin-members">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            <Users className="h-3.5 w-3.5" /> Members
            <button
              type="button"
              onClick={refreshMembers}
              disabled={membersBusy || !community.isAdmin}
              title="Refresh"
              className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
              data-testid="community-admin-members-refresh"
            >
              <RefreshCw
                className={
                  "h-3 w-3 " + (membersBusy ? "animate-spin" : "")
                }
              />
            </button>
          </h3>
          <p className="mb-2 text-[10px] text-[var(--muted)]">
            Connected users + posters in{" "}
            <span className="font-mono text-[var(--foreground)]">
              {currentRoomName(rooms, announceRoom)}
            </span>
            . Green dot = currently online; italic = lurking (connected
            but never posted). Change the room via the “Post as admin”
            selector above.
          </p>
          <ul className="space-y-1">
            {members && members.length === 0 && !membersBusy && (
              <li className="text-[10px] text-[var(--muted)]">
                Nobody connected and no posters yet.
              </li>
            )}
            {members === null && membersBusy && (
              <li className="text-[10px] text-[var(--muted)]">Loading…</li>
            )}
            {members?.map((m) => {
              const isLurker = m.messageCount === 0;
              const statsLabel = isLurker
                ? "connected · no posts"
                : `${m.messageCount}·${m.lastSeen !== null ? formatRelative(m.lastSeen) : "—"}`;
              const statsTitle = isLurker
                ? `Connected to #${announceRoom} — has not posted yet`
                : `${m.messageCount} message${m.messageCount === 1 ? "" : "s"} · last seen ${new Date(m.lastSeen ?? 0).toLocaleString()}${m.firstSeen !== null ? ` · first seen ${new Date(m.firstSeen).toLocaleString()}` : ""}`;
              return (
                <li
                  key={m.nick.toLowerCase()}
                  className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
                  data-testid={`community-admin-member-${m.nick}`}
                >
                  <span
                    className={
                      "h-1.5 w-1.5 shrink-0 rounded-full " +
                      (m.online
                        ? "bg-[var(--accent)]"
                        : "bg-[var(--border)]")
                    }
                    title={m.online ? "Online" : "Offline"}
                    aria-label={m.online ? "online" : "offline"}
                  />
                  <span
                    className={
                      "truncate font-mono " +
                      (isLurker ? "text-[var(--muted)] italic" : "")
                    }
                  >
                    {m.nick}
                  </span>
                  <span
                    className="font-mono text-[10px] text-[var(--muted)]"
                    title={statsTitle}
                  >
                    {statsLabel}
                  </span>
                  {onSelectNick && (
                    <button
                      type="button"
                      onClick={() => onSelectNick(m.nick)}
                      title={`Direct message ${m.nick}`}
                      className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--accent)]"
                      data-testid={`community-admin-member-dm-${m.nick}`}
                    >
                      <MessageSquare className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {/* Bans */}
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            Bans
          </h3>
          <div className="flex gap-1">
            <select
              value={banKind}
              onChange={(e) => setBanKind(e.target.value as "nick" | "ip")}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
            >
              <option value="nick">nick</option>
              <option value="ip">ip</option>
            </select>
            <input
              value={banValue}
              onChange={(e) => setBanValue(e.target.value)}
              placeholder={banKind === "nick" ? "alice" : "1.2.3.4"}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
          <input
            value={banReason}
            onChange={(e) => setBanReason(e.target.value)}
            placeholder="reason (optional)"
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--muted)]">
            <input
              type="checkbox"
              checked={banPurge}
              onChange={(e) => setBanPurge(e.target.checked)}
              className="h-3 w-3 accent-[var(--accent)]"
              data-testid="community-admin-ban-purge"
            />
            Also delete this user’s previous messages
          </label>
          <button
            type="button"
            onClick={createBan}
            disabled={banBusy || !banValue.trim() || !community.isAdmin}
            className="mt-2 w-full rounded-md border border-[var(--border)] py-1 text-xs font-medium hover:bg-[var(--panel-2)] disabled:opacity-40"
          >
            {banBusy ? "Banning…" : "Add ban"}
          </button>
          {banErr && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">{banErr}</p>
          )}
          {banLastPurged !== null && !banErr && (
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              {banLastPurged === 0
                ? "Ban added. No prior messages to purge."
                : `Ban added; purged ${banLastPurged} previous message${banLastPurged === 1 ? "" : "s"}.`}
            </p>
          )}

          <ul className="mt-3 space-y-1">
            {bans && bans.length === 0 && (
              <li className="text-[10px] text-[var(--muted)]">No bans.</li>
            )}
            {bans?.map((b) => (
              <li
                key={b.id}
                className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
              >
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted)]">
                  {b.kind}
                </span>
                <span className="truncate font-mono">{b.value}</span>
                {b.reason && (
                  <span className="truncate text-[10px] text-[var(--muted)]">
                    — {b.reason}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => liftBan(b.id)}
                  title="Lift ban"
                  className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--accent)]"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Banned words (channels only) */}
        <section data-testid="community-admin-banned-words">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            <Filter className="h-3.5 w-3.5" /> Banned words
          </h3>
          <p className="mb-2 text-[10px] text-[var(--muted)]">
            Case-insensitive substring match. Applies to channel posts
            only — DMs aren’t filtered.
          </p>
          <div className="flex gap-1">
            <input
              value={bannedWordInput}
              onChange={(e) => setBannedWordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !bannedWordBusy) addWord();
              }}
              placeholder="word or phrase"
              maxLength={100}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
            <button
              type="button"
              onClick={addWord}
              disabled={
                bannedWordBusy || !bannedWordInput.trim() || !community.isAdmin
              }
              title="Add"
              className="rounded-md bg-[var(--accent)] px-2 py-1 text-[var(--background)] hover:brightness-110 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {bannedWordErr && (
            <p className="mt-1 text-[10px] text-[var(--accent)]">
              {bannedWordErr}
            </p>
          )}
          <ul className="mt-3 space-y-1">
            {bannedWords && bannedWords.length === 0 && (
              <li className="text-[10px] text-[var(--muted)]">
                No words filtered.
              </li>
            )}
            {bannedWords?.map((w) => (
              <li
                key={w.word}
                className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
              >
                <span className="truncate font-mono">{w.word}</span>
                <button
                  type="button"
                  onClick={() => removeWord(w.word)}
                  title="Remove"
                  className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--accent)]"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}

function currentRoomName(rooms: Room[], slug: string): string {
  return rooms.find((r) => r.slug === slug)?.name ?? `#${slug}`;
}

/**
 * Compact relative-time formatter for the members roster — "now",
 * "Nm", "Nh", "Nd". Kept local (rather than reusing Message.tsx's
 * formatTime) because the admin context wants days-level precision
 * for stale members; the chat-row formatter falls back to a full
 * date past 24h.
 */
function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
