# Makefile for chat-server. Run `make` (no args) to see every target,
# grouped by the section headers below.
#
# Most local targets just wrap `bun run …` from package.json. The rest
# cover the operational surface documented in README.md: SQLite
# inspection, Docker, the systemd unit on a Linux VPS, Caddy,
# and the Cloudflare setup script.
#
# Tunables (override on the command line, e.g. `make health URL=…`):
#   URL          Base URL for smoke targets. default: http://localhost:8787
#   PORT         HTTP port. default: 8787
#   DB           SQLite file path. default: ./data/chat.db
#   VPS          ssh target for VPS-side targets. e.g. VPS=root@1.2.3.4
#   IMAGE        Docker image tag. default: claudius-chat-server:dev
#   ADMIN_TOKEN  Token to send as X-Admin-Token on admin-smoke targets.

.PHONY: help \
	install install-prod dev start typecheck test ci clean \
	db db-path db-reset db-reset-messages db-reset-dms \
	health rooms smoke \
	docker-build docker-run docker-stop \
	systemd-install systemd-enable systemd-start systemd-stop \
	systemd-restart systemd-status systemd-logs \
	caddy-install caddy-reload \
	cloudflare-setup cloudflare-setup-phase1 cloudflare-setup-phase2 \
	admin-token

URL         ?= http://localhost:8787
PORT        ?= 8787
DB          ?= ./data/chat.db
IMAGE       ?= claudius-chat-server:dev

# Default target: list every target, grouped by the `# ── … ──` section
# headers below. Mirrors the awk trick used in the top-level Makefile.
.DEFAULT_GOAL := help

help:
	@awk ' \
		/^# ── / { sub(/^# ── */, ""); sub(/ *──+ *$$/, ""); printf "\n\033[1m%s\033[0m\n", $$0; next } \
		/^[a-zA-Z][a-zA-Z0-9_-]*:([^=]|$$)/ { sub(/:.*$$/, ""); printf "  %s\n", $$0 } \
	' $(MAKEFILE_LIST)

# ── Local dev ─────────────────────────────────────────────────────────
# `install` keeps the lockfile honest. `install-prod` matches what the
# VPS / Docker build does (no devDeps). `dev` hot-reloads via `bun
# --watch`. `start` is the production entry. `typecheck` runs `tsc
# --noEmit`. `test` runs the bun-test suite with the project's preload
# (see tests/_setup.ts). `ci` is the combo a pre-merge gate would run.

install:
	bun install --frozen-lockfile

install-prod:
	bun install --production

dev:
	bun run dev

start:
	bun start

typecheck:
	bun run typecheck

test:
	bun run test

ci: install typecheck test

clean:
	rm -rf node_modules

# ── SQLite inspection ─────────────────────────────────────────────────
# `db` opens an interactive sqlite3 shell against the local db. `db-path`
# just prints the path (useful for `sqlite3 "$(make db-path)"` from
# scripts). The `db-reset*` targets are destructive — use only against
# a local dev database. If the server is running while you reset, the
# wipe won't be broadcast over SSE; restart the server (or have clients
# reconnect) to pick up the empty state.
#
# - `db-reset`           nukes the whole file (drops everything, including
#                        rooms, bans, banned-words, kill-switch state)
# - `db-reset-messages`  keeps rooms + DMs + bans, wipes channel messages
#                        only. Also clears every room's pinned_message_id
#                        so no room points at a deleted row.
# - `db-reset-dms`       wipes the dms table; channels untouched.

db:
	sqlite3 $(DB)

db-path:
	@echo $(DB)

db-reset:
	@printf 'About to delete %s (and -wal/-shm). Continue? [y/N] ' "$(DB)"; \
	read ans; \
	case "$$ans" in \
		y|Y|yes|YES) rm -f $(DB) $(DB)-wal $(DB)-shm && echo "✓ removed" ;; \
		*) echo "aborted" ;; \
	esac

db-reset-messages:
	@printf 'About to delete every channel message in %s (keeps rooms + DMs + bans). Continue? [y/N] ' "$(DB)"; \
	read ans; \
	case "$$ans" in \
		y|Y|yes|YES) \
			sqlite3 $(DB) "DELETE FROM messages; UPDATE rooms SET pinned_message_id = NULL;" \
			&& echo "✓ messages cleared, pins reset" ;; \
		*) echo "aborted" ;; \
	esac

db-reset-dms:
	@printf 'About to delete every DM in %s (channels untouched). Continue? [y/N] ' "$(DB)"; \
	read ans; \
	case "$$ans" in \
		y|Y|yes|YES) \
			sqlite3 $(DB) "DELETE FROM dms;" \
			&& echo "✓ DMs cleared" ;; \
		*) echo "aborted" ;; \
	esac

# ── Smoke (against URL=…) ─────────────────────────────────────────────
# Quick HTTP probes against a running instance. Defaults to the local
# dev server; override URL=… to point at the deployed one, e.g.
#   make health URL=https://chat.claudius.network

health:
	@curl -fsS $(URL)/health && echo

rooms:
	@curl -fsS $(URL)/rooms | sed 's/,/,\n /g'

smoke: health rooms

# ── Docker (local) ────────────────────────────────────────────────────
# Build and run the same image Fly deploys. Mounts ./data into the
# container so the SQLite db survives container restarts.

docker-build:
	docker build -t $(IMAGE) .

docker-run:
	docker run --rm -it \
		-p $(PORT):8787 \
		-v $$(pwd)/data:/data \
		-e CLAUDIUS_CHAT_ADMIN_TOKEN=$${CLAUDIUS_CHAT_ADMIN_TOKEN:-dev-token} \
		--name claudius-chat-server \
		$(IMAGE)

docker-stop:
	-docker stop claudius-chat-server

# ── systemd (VPS) ─────────────────────────────────────────────────────
# These wrap the systemd unit shipped in this directory. They run on
# the VPS itself by default. To drive them from your laptop instead,
# set VPS=root@<vps-ip> and every command will be ssh'd over, e.g.
#   make systemd-status VPS=root@1.2.3.4
#
# `systemd-install` copies the unit into /etc/systemd/system/, reloads
# the daemon, and enables + starts the service in one shot. Idempotent.

SSH := $(if $(VPS),ssh $(VPS),)
SUDO := $(if $(VPS),,sudo )

systemd-install:
	$(SSH) $(SUDO)install -m 0644 \
		/opt/claudius-chat-server/claudius-chat-server.service \
		/etc/systemd/system/claudius-chat-server.service
	$(SSH) $(SUDO)systemctl daemon-reload
	$(SSH) $(SUDO)systemctl enable --now claudius-chat-server

systemd-enable:
	$(SSH) $(SUDO)systemctl enable --now claudius-chat-server

systemd-start:
	$(SSH) $(SUDO)systemctl start claudius-chat-server

systemd-stop:
	$(SSH) $(SUDO)systemctl stop claudius-chat-server

systemd-restart:
	$(SSH) $(SUDO)systemctl restart claudius-chat-server

systemd-status:
	$(SSH) systemctl status claudius-chat-server || true

systemd-logs:
	$(SSH) journalctl -u claudius-chat-server -f

# ── Caddy (VPS) ───────────────────────────────────────────────────────
# Drops this directory's Caddyfile into /etc/caddy/ and reloads Caddy.
# Same VPS=… override as the systemd targets.

caddy-install:
	$(SSH) $(SUDO)cp /opt/claudius-chat-server/Caddyfile /etc/caddy/Caddyfile
	$(SSH) $(SUDO)systemctl reload caddy

caddy-reload:
	$(SSH) $(SUDO)systemctl reload caddy

# ── Cloudflare ────────────────────────────────────────────────────────
# Runs the cloudflare-setup.sh script in this directory. Requires
# CF_API_TOKEN and CF_VPS_IP in the env (see README §7.2). Override
# CF_ZONE / CF_HOST for non-default deploys. `cloudflare-setup` runs
# both phases with a manual pause between them.

cloudflare-setup:
	./cloudflare-setup.sh

cloudflare-setup-phase1:
	./cloudflare-setup.sh --phase1

cloudflare-setup-phase2:
	./cloudflare-setup.sh --phase2

# ── Helpers ───────────────────────────────────────────────────────────
# `admin-token` generates a 32-byte hex token you can paste into
# /etc/claudius-chat-server.env or `fly secrets set …` — same recipe
# the README spells out.

admin-token:
	@openssl rand -hex 32
