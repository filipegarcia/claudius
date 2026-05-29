// Admin gate + helpers.
//
// One env var, CLAUDIUS_CHAT_ADMIN_TOKEN, gates every admin route. The
// browser sends the token in the X-Admin-Token header (set by the
// admin panel after the owner pastes it once). Constant-time compare
// to avoid timing leaks — overkill at this scale, but trivial to do
// right.

import { timingSafeEqual } from "node:crypto";

const ADMIN_TOKEN = process.env.CLAUDIUS_CHAT_ADMIN_TOKEN ?? "";

if (!ADMIN_TOKEN) {
  console.warn(
    "[chat-server] CLAUDIUS_CHAT_ADMIN_TOKEN is unset — admin endpoints will reject everything.",
  );
}

export function isAdminRequest(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const got = req.headers.get("x-admin-token");
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reserved nicknames. The admin posts as "admin" (server-set), so a
 *  regular user can't impersonate. We also block obvious system names. */
const RESERVED = new Set(["admin", "claudius", "system", "mod", "moderator", "root"]);

export function isReservedNick(nick: string): boolean {
  return RESERVED.has(nick.toLowerCase());
}
