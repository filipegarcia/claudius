# claudius-chat-server

A tiny SSE chat backend for the `/community` page in Claudius.

Every Claudius install runs **locally on the user's machine**, so a shared
community chat needs one central server that every install can reach.
This is that server — ~700 lines of Bun + SQLite, fan-out via SSE,
admin gated by a single env-var token.

## What it does

- Hosts a small list of rooms (`#general`, `#bugs`, `#ideas` — seeded by
  the migration; edit `migrations/001_init.sql` to change).
- Lets anyone POST a message with a chosen nickname; broadcasts it to
  every subscriber of that room over SSE.
- Persists the last N messages so new joiners get history.
- Lets *you* (the operator) post as `admin`, delete any message, pin
  one message per room, and ban by nick or IP — gated by the
  `CLAUDIUS_CHAT_ADMIN_TOKEN` env var.

It does **not** do: user accounts, federation, file uploads, threads,
reactions, typing indicators, presence. Each of those is additive.

## Running locally

```bash
cd chat-server
bun install
CLAUDIUS_CHAT_ADMIN_TOKEN=dev-token bun run dev   # :8787
```

Then in the Claudius repo:

```bash
NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL=http://localhost:8787 bun run dev
```

Set `CLAUDIUS_CHAT_ADMIN_TOKEN` in the same environment if this user
should see the admin UI in /community — Claudius proxies admin calls
through `/api/community/admin/*` using that token, so it stays out of
the client bundle.

Open <http://localhost:3000/community>, pick a nickname, post a message.
Open a second window in incognito → both tabs see each other's
messages via SSE.

## Wire surface

| Method | Path                                    | Auth      | Notes |
|--------|-----------------------------------------|-----------|-------|
| GET    | `/health`                               | none      | `{ ok: true }` |
| GET    | `/rooms`                                | none      | List rooms |
| GET    | `/rooms/:slug/stream`                   | none      | SSE: `replay { messages: [] }` (no history on join) then live events |
| GET    | `/rooms/:slug/messages?before=&limit=`  | none      | Backfill older history (default `limit=100`, max `500`). Client pulls 50 at a time via the “Load older” button as the user scrolls up |
| POST   | `/rooms/:slug/messages`                 | nickname  | Body `{ nick, body }`; rate-limited 10/30s/IP |
| POST   | `/admin/messages`                       | admin     | Post as `admin`. Body `{ roomSlug, body }` |
| POST   | `/admin/messages/:id/delete`            | admin     | Soft-delete. Body blanked on the wire; client renders `[deleted by admin]` placeholder |
| POST   | `/admin/messages/:id/pin`               | admin     | Pin (one per room) |
| POST   | `/admin/rooms`                          | admin     | Create channel. Body `{ slug, name, description? }`. Slug must match `[a-z0-9][a-z0-9_-]{0,30}` |
| POST   | `/admin/rooms/:slug/unpin`              | admin     | Clear pin |
| POST   | `/admin/rooms/:slug/clear`              | admin     | Hard-delete every message in the room. Broadcasts an empty `replay` to subscribers |
| POST   | `/admin/rooms/:slug/compact?keep=N`     | admin     | Trim room to the most recent N messages (default 100, max 10 000). Broadcasts a fresh `replay` |
| GET    | `/admin/bans`                           | admin     | List bans |
| POST   | `/admin/bans`                           | admin     | Body `{ kind: 'nick'\|'ip', value, reason?, purgeMessages? }`. When `purgeMessages: true`, soft-deletes every existing message from that user (matched by nick lowercased, or by IP) and broadcasts a `message_deleted` per row so connected clients render the placeholder live |
| DELETE | `/admin/bans/:id`                       | admin     | Lift a ban |
| GET    | `/admin/community/state`                | admin     | Returns `{ state: { enabled, reason, disabledAt } }` |
| POST   | `/admin/community/disable`              | admin     | Optional body `{ reason }` (≤ 200 chars). Sets the kill switch; broadcasts `community_state{enabled:false}` to every subscriber across every room. POST messages return 503 while disabled |
| POST   | `/admin/community/enable`               | admin     | Clears the kill switch; broadcasts `community_state{enabled:true}` to every subscriber |
| GET    | `/admin/banned-words`                   | admin     | List the curated banned-word filter (channels only) |
| POST   | `/admin/banned-words`                   | admin     | Body `{ word }` (≤ 100 chars). Channel posts containing this substring (case-insensitive) get rejected with 400 |
| DELETE | `/admin/banned-words/:word`             | admin     | Remove a word (URL-encoded) from the filter |

Admin requests carry the token in `X-Admin-Token`.

### SSE event shapes

```ts
type ChatEvent =
  | { type: "replay"; roomSlug; messages; pinnedMessageId }
  | { type: "message"; message }
  | { type: "message_deleted"; roomSlug; id }
  | { type: "message_pinned"; roomSlug; id }
  | { type: "message_unpinned"; roomSlug }
  | { type: "community_state"; enabled: boolean; reason: string | null };
```

See `src/types.ts` for the full TypeScript declarations. Mirrored in
`lib/shared/community.ts` on the Claudius side — keep them in sync.

## Env vars

| Var                            | Default            | Purpose |
|--------------------------------|--------------------|---------|
| `PORT`                         | `8787`             | HTTP listen port |
| `CHAT_DB_PATH`                 | `./data/chat.db`   | SQLite file path |
| `CLAUDIUS_CHAT_ADMIN_TOKEN`    | *(unset)*          | Required for any `/admin/*` route. If unset, all admin requests get 401. |
| `TRUST_PROXY_IP_HEADERS`       | *(unset)*          | Set to `1` when behind a trusted reverse proxy (Caddy/nginx/Cloudflare). Reads the real client IP from `CF-Connecting-IP` then `X-Forwarded-For` instead of the socket peer. Leave unset on bare-internet deploys — header trust without a proxy is spoofable. |

## Deploying to a Linux VPS

End-to-end runbook for putting this on a Debian/Ubuntu VPS as a
systemd-managed daemon behind Caddy for TLS, with Cloudflare proxying
public traffic to hide the origin and add DDoS scrubbing. End state:

```
Browser ──HTTPS──► Cloudflare ──HTTPS──► Caddy on VPS :443 ──HTTP──► chat-server :8787
```

Claudius installs connect to **`https://chat.claudius.network`** (the
canonical community URL — override `CF_ZONE` / `CF_HOST` if you're
deploying for your own domain).

### Prereqs

- A Debian or Ubuntu VPS with root/sudo and SSH access.
- A public IPv4. Port 80 must be reachable from the internet for
  Let's Encrypt; port 443 only needs to be reachable from Cloudflare
  once you're done.
- A domain in a Cloudflare zone — either registered through
  [Cloudflare Registrar](https://dash.cloudflare.com/?to=/:account/domains/register)
  (at cost, ~$10/year) or moved to Cloudflare's nameservers from
  another registrar.
- The `chat-server/` tree from this repo available on your laptop.

### 1. Install Bun on the VPS

```bash
ssh root@<vps-ip>
curl -fsSL https://bun.sh/install | bash
install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
bun --version    # sanity check
```

### 2. Ship the chat-server code to the VPS

From your laptop, in the Claudius repo root:

```bash
ssh root@<vps-ip> 'mkdir -p /opt/claudius-chat-server'
rsync -a --delete chat-server/ root@<vps-ip>:/opt/claudius-chat-server/
ssh root@<vps-ip> 'cd /opt/claudius-chat-server && bun install --production'
```

### 3. Set the admin token

The admin token guards `/admin/*` (deleting messages, pinning, banning).
Generate one and stash it outside the unit file in mode-0600 env file:

```bash
ssh root@<vps-ip>
umask 077
printf 'CLAUDIUS_CHAT_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > /etc/claudius-chat-server.env
```

Save the token somewhere — Claudius installs that should see the
admin UI need the *same* token set in their build environment.

### 4. Install + start the systemd unit

```bash
install -m 0644 /opt/claudius-chat-server/claudius-chat-server.service \
  /etc/systemd/system/claudius-chat-server.service
systemctl daemon-reload
systemctl enable --now claudius-chat-server

systemctl status claudius-chat-server    # active (running)
curl -s http://127.0.0.1:8787/health      # {"ok":true}
```

The unit runs the server under a transient `DynamicUser=`, restarts on
failure (with crash-loop protection), keeps the SQLite db in
`/var/lib/claudius-chat-server/`, and logs to the journal. Follow logs
with `journalctl -u claudius-chat-server -f`.

### 5. Install Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

### 6. Tell the chat-server it's behind a proxy

Without this, every message will look like it came from `127.0.0.1`
(Caddy's loopback connection to the upstream) and a single IP ban or
rate-limit would silence *everyone*. Append the flag to the env file:

```bash
echo 'TRUST_PROXY_IP_HEADERS=1' >> /etc/claudius-chat-server.env
systemctl restart claudius-chat-server
```

`getClientIp()` in `src/server.ts` then prefers `CF-Connecting-IP`
(set by Cloudflare and forwarded by Caddy), falling back to
`X-Forwarded-For`.

### 7. Configure DNS + TLS via Cloudflare

**7.1. Create a scoped API token** at
<https://dash.cloudflare.com/profile/api-tokens> → "Create Token" →
"Custom token". Permissions:

- `Zone : DNS : Edit`
- `Zone : Zone Settings : Edit`

Zone Resources → Include → Specific zone → *your domain*. Save the
token string somewhere safe; you can't see it again.

**7.2. Run the setup script** from your laptop:

```bash
cd chat-server
export CF_API_TOKEN=<the-token-from-7.1>
export CF_VPS_IP=<vps-ip>

# CF_ZONE defaults to claudius.network and CF_HOST to chat.
# Override only if deploying for a different domain, e.g.:
#   export CF_ZONE=example.com
#   export CF_HOST=community

./cloudflare-setup.sh              # both phases with a pause
```

The script:
1. Creates `A chat → <vps-ip>` grey-clouded (so Caddy can complete
   the Let's Encrypt HTTP-01 challenge directly against the VPS).
2. Prompts you to verify — go to step 7.3, then come back and press
   Enter.
3. Flips the record to proxied (orange-cloud), sets TLS mode to
   **Full (strict)**, enables **Always Use HTTPS**.

**7.3. Drop the Caddyfile in place** on the VPS:

```bash
ssh root@<vps-ip>
cp /opt/claudius-chat-server/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy

# Trigger Caddy's first ACME run (DNS is still grey-clouded, so LE
# hits the VPS directly on :80):
curl -s https://chat.claudius.network/health      # {"ok":true}
```

The shipped Caddyfile already points at `chat.claudius.network` with
the right SSE-safe proxy settings and `CF-Connecting-IP` forwarding —
no editing needed (override `CF_HOST`/`CF_ZONE` and `sed` the
Caddyfile if you're using a different hostname).

Once `/health` returns `{"ok":true}`, hop back to the laptop terminal
where `cloudflare-setup.sh` is paused and press Enter to flip the DNS
record to orange-cloud + Full (strict) TLS.

### 8. Lock down the firewall

Port 80 stays open to the world so future Let's Encrypt renewals work
(LE never publishes a stable IP range). Port 443 gets restricted to
Cloudflare's published edge IPs, so the origin can only be reached
*through* Cloudflare:

```bash
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp                  # ACME — open to world

# Cloudflare-only :443. Refresh occasionally (CF adds IPs over time);
# cron-able or run by hand. Lists:
#   https://www.cloudflare.com/ips-v4
#   https://www.cloudflare.com/ips-v6
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  ufw allow from "$ip" to any port 443 proto tcp
done
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  ufw allow from "$ip" to any port 443 proto tcp
done

ufw enable
```

### 9. Verify end-to-end

From your laptop:

```bash
URL=https://chat.claudius.network

curl -s "$URL/health"             # {"ok":true}
curl -s "$URL/rooms"              # list of rooms
curl -N "$URL/rooms/general/stream"   # SSE: replay frame then heartbeats
```

If the SSE stream hangs and `curl -v` shows a `526` (Cloudflare TLS
error), Caddy didn't issue its origin cert — check
`journalctl -u caddy` and that the Cloudflare TLS mode is **Full
(strict)**, not Flexible. If it shows `522`, the firewall isn't
letting Cloudflare reach the origin on `:443` — refresh the CF IP
allow-list.

### 10. Point Claudius at it

In the Claudius repo's build environment (typically `.env.local` or
your hosting provider's env config), set:

```
NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL=https://chat.claudius.network
```

If this Claudius install should see the admin controls in `/community`,
also set `CLAUDIUS_CHAT_ADMIN_TOKEN` to the same value you put in
`/etc/claudius-chat-server.env` in step 3 — Claudius proxies admin
calls through `/api/community/admin/*` server-side so the token stays
out of the client bundle.

Rebuild Claudius (`bun run build`, restart) and visit `/community`.
Pick a nickname, post a message, open a second window in incognito —
both should see each other in real time.

If this Claudius install should see the admin controls in `/community`,
also set `CLAUDIUS_CHAT_ADMIN_TOKEN` to the same value you put in
`/etc/claudius-chat-server.env` in step 3 — Claudius proxies admin
calls through `/api/community/admin/*` server-side so the token stays
out of the client bundle.

Rebuild Claudius (`bun run build` then restart) and visit
`/community`. Pick a nickname, post a message, open a second window in
incognito — both should see each other in real time.

### Updates

To deploy new chat-server code:

```bash
rsync -a --delete chat-server/ root@<vps-ip>:/opt/claudius-chat-server/
ssh root@<vps-ip> '
  cd /opt/claudius-chat-server && bun install --production &&
  systemctl restart claudius-chat-server
'
```

The SQLite db in `/var/lib/claudius-chat-server/` survives restarts and
redeploys.

## Deploying to Fly.io

```bash
# from chat-server/
fly launch --no-deploy --copy-config
fly volumes create chat_data --size 1 --region <yours>
fly secrets set CLAUDIUS_CHAT_ADMIN_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

The `fly.toml` here pins `auto_stop_machines = "off"` and
`min_machines_running = 1` because SSE clients hold open connections —
stopping the VM would kick every browser tab.

After deploy, set `NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL=https://<your-app>.fly.dev`
in the Claudius build environment and rebuild. If the same install
should host the admin, also set `CLAUDIUS_CHAT_ADMIN_TOKEN` to the
value you set on the chat-server above.

## Operating notes

- **Logs**: every applied migration prints once at startup; nothing else
  unless something throws. SSE subscriber failures log a single
  `subscriber threw` warning per occurrence.
- **DB browsing**: `sqlite3 data/chat.db` and have at it. The schema is
  five tables (rooms, messages, bans, system_state, banned_words) and
  no foreign-key surprises.
- **Soft-delete reasons**: every soft-deleted message row carries a
  `deletion_reason`: `admin` (per-message moderation), `banned` (ban-
  and-purge), `cleared` (bulk channel clear), `compacted` (bulk
  trim). Admin per-message and `banned` rows reach the wire as
  `[deleted by admin]` placeholders; `cleared` and `compacted` stay
  in the table but never reach subscribers — so you can run
  `SELECT * FROM messages WHERE deletion_reason = 'cleared'` to
  review what got swept after the fact.
- **Trimming history**: not automatic. When the `messages` table feels
  big, `DELETE FROM messages WHERE created_at < <cutoff>` — readers
  only ever see `recentMessages(limit=100)`, so trimming is invisible
  to live users.
- **Moving providers**: the only state worth migrating is `data/chat.db`.
  scp it over and you're done.
