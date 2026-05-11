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
NEXT_PUBLIC_CHAT_SERVER_URL=http://localhost:8787 bun run dev
```

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

After deploy, set `NEXT_PUBLIC_CHAT_SERVER_URL=https://<your-app>.fly.dev`
in the Claudius build environment and rebuild.

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
