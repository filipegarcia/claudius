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
| GET    | `/rooms/:slug/stream`                   | none      | SSE: `replay` then live events |
| GET    | `/rooms/:slug/messages?before=&limit=`  | none      | Backfill older history |
| POST   | `/rooms/:slug/messages`                 | nickname  | Body `{ nick, body }`; rate-limited 10/30s/IP |
| POST   | `/admin/messages`                       | admin     | Post as `admin`. Body `{ roomSlug, body }` |
| POST   | `/admin/messages/:id/delete`            | admin     | Soft-delete |
| POST   | `/admin/messages/:id/pin`               | admin     | Pin (one per room) |
| POST   | `/admin/rooms/:slug/unpin`              | admin     | Clear pin |
| GET    | `/admin/bans`                           | admin     | List bans |
| POST   | `/admin/bans`                           | admin     | Body `{ kind: 'nick'\|'ip', value, reason? }` |
| DELETE | `/admin/bans/:id`                       | admin     | Lift a ban |

Admin requests carry the token in `X-Admin-Token`.

### SSE event shapes

```ts
type ChatEvent =
  | { type: "replay"; roomSlug; messages; pinnedMessageId }
  | { type: "message"; message }
  | { type: "message_deleted"; roomSlug; id }
  | { type: "message_pinned"; roomSlug; id }
  | { type: "message_unpinned"; roomSlug };
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
systemd-managed daemon behind Caddy for TLS. Two paths diverge at
step 7 depending on whether you have a domain:

- **No domain → `sslip.io` magic DNS** (free, zero setup). HTTPS works,
  no DDoS protection.
- **Domain → Cloudflare in front** (small annual cost for the domain).
  HTTPS works, plus origin hiding and DDoS scrubbing.

End state in both cases:

```
Browser ──HTTPS──► Caddy on VPS :443 ──HTTP──► chat-server :8787
                   (with Cloudflare optionally proxying public TLS)
```

And the URL Claudius installs connect to:

| Path        | What goes in `NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL`        |
|-------------|------------------------------------------------------------|
| sslip.io    | `https://<vps-ip>.sslip.io`  (e.g. `https://203.0.113.7.sslip.io`) |
| Cloudflare  | `https://chat.claudius.network` (the Cloudflare DNS record) |

### Prereqs

- A Debian or Ubuntu VPS with root/sudo and SSH access.
- A public IPv4 reachable on port 443 (and 80 for the cert challenge).
- The chat-server tree available on your laptop (this repo's
  `chat-server/` directory).

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
(if Cloudflare is in front), falling back to `X-Forwarded-For` (which
Caddy populates automatically).

### 7. Pick a TLS hostname path

#### A. sslip.io — no domain needed

`sslip.io` is a free magic-DNS service: `<ip>.sslip.io` resolves to
that IP automatically, no registration. Let's Encrypt issues real
certs for it.

Edit the Caddyfile to substitute your VPS's IP, then reload:

```bash
sudo cp /opt/claudius-chat-server/Caddyfile /etc/caddy/Caddyfile
sudo sed -i "s/203\.0\.113\.7/$(curl -s ifconfig.me)/" /etc/caddy/Caddyfile
# verify it looks right:
sudo head -5 /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Your public URL is `https://<vps-ip>.sslip.io`. Skip to step 8.

#### B. Cloudflare — domain required

This path puts Cloudflare's proxy in front of Caddy for DDoS
protection and origin-IP hiding. Caddy still terminates the origin
cert; Cloudflare terminates the public cert.

The canonical Claudius community server uses the domain
**`claudius.network`** with subdomain `chat`, so the URL ends up as
`https://chat.claudius.network`. The setup script defaults to these
values — override `CF_ZONE` / `CF_HOST` if you're deploying for a
different domain.

**B.1. Get a domain** in a Cloudflare zone. Cheapest path: register
through [Cloudflare Registrar](https://dash.cloudflare.com/?to=/:account/domains/register)
at cost (~$10/year for `.com`, $10/year for `.network`). Any other
registrar works if you move DNS to Cloudflare.

**B.2. Create a scoped API token** at
<https://dash.cloudflare.com/profile/api-tokens> → "Create Token" →
"Custom token". Permissions:

- `Zone : DNS : Edit`
- `Zone : Zone Settings : Edit`

Zone Resources → Include → Specific zone → *your domain*. Save the
token string somewhere safe; you can't see it again.

**B.3. Run the setup script** from your laptop:

```bash
cd chat-server
export CF_API_TOKEN=<the-token-from-B.2>
export CF_VPS_IP=<vps-ip>

# CF_ZONE defaults to claudius.network and CF_HOST to chat.
# Override only if deploying for a different domain, e.g.:
#   export CF_ZONE=example.com
#   export CF_HOST=community

./cloudflare-setup.sh              # both phases with a pause
```

The script:
1. Creates `A chat → <vps-ip>` grey-clouded (so Caddy can complete
   the Let's Encrypt HTTP-01 challenge).
2. Prompts you to verify — go to step 7.B.4, then come back and
   press Enter.
3. Flips the record to proxied (orange-cloud), sets TLS mode to
   **Full (strict)**, enables **Always Use HTTPS**.

**B.4. Configure Caddy with the real hostname.** On the VPS:

```bash
sudo cp /opt/claudius-chat-server/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/203\.0\.113\.7\.sslip\.io/chat.claudius.network/' /etc/caddy/Caddyfile

# Add CF-Connecting-IP forwarding so getClientIp() sees real client IPs.
# (Caddyfile is whitespace-tolerant inside a block, so an unindented
#  append works fine.)
sudo sed -i '/flush_interval -1/a header_up CF-Connecting-IP {http.request.header.CF-Connecting-IP}' \
  /etc/caddy/Caddyfile

sudo systemctl reload caddy

# Hit it once to trigger the LE cert (while DNS is still grey-clouded):
curl -s https://chat.claudius.network/health      # {"ok":true}
```

Once that returns `{"ok":true}`, hop back to the laptop terminal
where `cloudflare-setup.sh` is paused and press Enter to flip to
orange-cloud.

Your public URL is `https://chat.claudius.network`.

### 8. Open the firewall

```bash
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp                  # Let's Encrypt HTTP-01 + ACME renewals
ufw allow 443/tcp                 # public chat-server entry point
ufw enable
```

**If you went the Cloudflare path** (7.B) and want to ensure traffic
can *only* reach the origin through Cloudflare, replace the
`allow 443/tcp` line with per-CF-IP rules:

```bash
ufw delete allow 443/tcp
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  ufw allow from "$ip" to any port 443 proto tcp
done
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  ufw allow from "$ip" to any port 443 proto tcp
done
```

Re-run that loop occasionally (or via cron) since Cloudflare adds
IPs from time to time.

### 9. Verify end-to-end

From your laptop:

```bash
URL=https://<your-hostname>       # the sslip.io or Cloudflare URL

curl -s "$URL/health"             # {"ok":true}
curl -s "$URL/rooms"              # list of rooms
curl -N "$URL/rooms/general/stream"   # SSE: replay frame then heartbeats
```

If the SSE stream hangs and `curl -v` shows a `503` or `526` (Cloudflare
TLS error), check that Caddy issued its cert (`journalctl -u caddy`)
and that the Cloudflare TLS mode is **Full (strict)**, not Flexible.

### 10. Point Claudius at it

In the Claudius repo's build environment (typically `.env.local` or
your hosting provider's env config), set:

```
NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL=https://<your-hostname>
```

with `<your-hostname>` being either:
- `<vps-ip>.sslip.io` for the sslip.io path, or
- `chat.claudius.network` (or your own `chat.<domain>`) for the
  Cloudflare path.

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
  three tables and no foreign-key surprises.
- **Trimming history**: not automatic. When the `messages` table feels
  big, `DELETE FROM messages WHERE created_at < <cutoff>` — readers
  only ever see `recentMessages(limit=100)`, so trimming is invisible
  to live users.
- **Moving providers**: the only state worth migrating is `data/chat.db`.
  scp it over and you're done.
