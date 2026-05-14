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
} from "lucide-react";
import type { Ban, Room } from "@/lib/shared/community";
import type { UseCommunity } from "@/lib/client/use-community";

type Props = {
  community: UseCommunity;
  rooms: Room[];
  onClose: () => void;
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
export function AdminPanel({ community, rooms, onClose }: Props) {
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
  const [banBusy, setBanBusy] = useState(false);
  const [banErr, setBanErr] = useState<string | null>(null);

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

  const refreshBans = useCallback(async () => {
    if (!community.isAdmin) {
      setBans(null);
      return;
    }
    setBans(await community.listBans());
  }, [community]);

  useEffect(() => {
    void refreshBans();
  }, [refreshBans]);

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
    const res = await community.ban(banKind, v, banReason.trim() || undefined);
    setBanBusy(false);
    if (res.ok) {
      setBanValue("");
      setBanReason("");
      await refreshBans();
    } else {
      setBanErr(res.error);
    }
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
      </div>
    </aside>
  );
}

function currentRoomName(rooms: Room[], slug: string): string {
  return rooms.find((r) => r.slug === slug)?.name ?? `#${slug}`;
}
