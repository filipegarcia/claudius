# syntax=docker/dockerfile:1.7
#
# Tiny image for the Claudius chat-server. Two stages: a builder that
# installs (better-sqlite3 has a native module) and a runtime that just
# copies the result and runs `bun start`. Fly's volume mounts at /data
# so we point CHAT_DB_PATH there.

FROM oven/bun:1.1-debian AS builder
WORKDIR /app

# No native deps — bun:sqlite is bundled into Bun itself.
COPY package.json ./
RUN bun install --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# ── runtime ─────────────────────────────────────────────────────────
FROM oven/bun:1.1-debian
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV PORT=8787
ENV CHAT_DB_PATH=/data/chat.db

# Fly's volume mounts here; create dir for non-Fly runs too.
RUN mkdir -p /data

EXPOSE 8787

CMD ["bun", "src/server.ts"]
