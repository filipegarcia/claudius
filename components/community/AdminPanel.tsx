"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, X, Trash2, Megaphone } from "lucide-react";
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
