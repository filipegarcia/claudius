#!/usr/bin/env bash
# Deploy / redeploy the `posthog-proxy` Cloudflare Worker.
#
# Curl-based alternative to `wrangler deploy` — useful when wrangler isn't
# installed or you don't want to OAuth-link a machine to the account.
#
# Requirements:
#   - bash, curl, jq
#   - $CLOUDFLARE_API_TOKEN exported, with permissions:
#       Account → Workers Scripts → Edit
#       Zone    → Workers Routes  → Edit  (scope: claudius.network)
#
# Usage:
#   export CLOUDFLARE_API_TOKEN=cfut_…
#   ./cloudflare/deploy.sh
#
# Idempotent — safe to re-run after editing posthog-proxy.js. If the route
# binding already exists, the POST returns 409 and we treat that as success.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"

readonly API="https://api.cloudflare.com/client/v4"
readonly ZONE_NAME="claudius.network"
readonly SCRIPT_NAME="posthog-proxy"
readonly ROUTE_PATTERN="claudius.network/ph/*"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WORKER_SRC="$SCRIPT_DIR/posthog-proxy.js"

[ -f "$WORKER_SRC" ] || { echo "missing $WORKER_SRC" >&2; exit 1; }

auth() { echo "Authorization: Bearer $CLOUDFLARE_API_TOKEN"; }

echo "▸ Resolving zone + account ids…"
ZONE_ID=$(curl -fsS -H "$(auth)" "$API/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')
ACCT_ID=$(curl -fsS -H "$(auth)" "$API/accounts" | jq -r '.result[0].id // empty')
[ -n "$ZONE_ID" ] || { echo "could not resolve zone for $ZONE_NAME" >&2; exit 1; }
[ -n "$ACCT_ID" ] || { echo "could not resolve account (token may be zone-only)" >&2; exit 1; }
echo "  zone:    $ZONE_ID"
echo "  account: $ACCT_ID"

echo "▸ Uploading Worker script ($SCRIPT_NAME)…"
UPLOAD=$(curl -fsS -X PUT -H "$(auth)" \
  "$API/accounts/$ACCT_ID/workers/scripts/$SCRIPT_NAME" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2025-01-01"};type=application/json' \
  -F "worker.js=@$WORKER_SRC;filename=worker.js;type=application/javascript+module")
echo "$UPLOAD" | jq -e '.success' >/dev/null || { echo "$UPLOAD" | jq; exit 1; }
echo "  ok — modified_on: $(echo "$UPLOAD" | jq -r '.result.modified_on')"

echo "▸ Ensuring route binding ($ROUTE_PATTERN → $SCRIPT_NAME)…"
EXISTING=$(curl -fsS -H "$(auth)" "$API/zones/$ZONE_ID/workers/routes" \
  | jq -r --arg p "$ROUTE_PATTERN" '.result[] | select(.pattern == $p) | .id')
if [ -n "$EXISTING" ]; then
  echo "  already bound ($EXISTING) — skipping"
else
  curl -fsS -X POST -H "$(auth)" -H "Content-Type: application/json" \
    "$API/zones/$ZONE_ID/workers/routes" \
    -d "{\"pattern\":\"$ROUTE_PATTERN\",\"script\":\"$SCRIPT_NAME\"}" \
    | jq '.result | {id, pattern, script}'
fi

echo "▸ Smoke test"
for url in \
    "https://claudius.network/ph/static/array.js" \
    "https://claudius.network/ph/decide/"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$url")
  echo "  $code  $url"
done

echo "✓ deploy complete"
