#!/usr/bin/env bash
# Manage Cloudflare Single Redirects for claudius.network.
#
# Currently configured:
#   /install   →  /setup.sh         (302, preserves query string)
#
# Why a Cloudflare redirect instead of a file in site/?
#   - No file duplication. setup.sh stays the single source of truth.
#   - No Worker needed. Single Redirects are a free-tier feature.
#   - Works for `curl -fsSL` because -L (follow redirects) is implicit in
#     -fsSL, so `curl … /install | bash` follows to /setup.sh transparently.
#
# Requirements:
#   - bash, curl, jq
#   - $CLOUDFLARE_API_TOKEN exported, with permissions:
#       Zone → Config Rules → Edit  (scope: claudius.network)
#     Token UIs sometimes label this "Single Redirects" instead — same scope.
#
# Usage:
#   export CLOUDFLARE_API_TOKEN=cfut_…
#   ./cloudflare/redirects.sh
#
# Idempotent — re-running PUTs the same ruleset and is a no-op when the
# rules haven't changed. Edit the heredoc below to add / change rules.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"

readonly API="https://api.cloudflare.com/client/v4"
readonly ZONE_NAME="claudius.network"
auth() { echo "Authorization: Bearer $CLOUDFLARE_API_TOKEN"; }

echo "▸ Resolving zone id for $ZONE_NAME…"
ZONE_ID=$(curl -fsS -H "$(auth)" "$API/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')
[ -n "$ZONE_ID" ] || { echo "could not resolve zone for $ZONE_NAME" >&2; exit 1; }
echo "  zone: $ZONE_ID"

echo "▸ PUTting http_request_dynamic_redirect entrypoint…"
# Whole-ruleset PUT — any rule not in this payload is removed. That's
# intentional: the file is the source of truth for what redirects exist.
RESPONSE=$(curl -fsS -X PUT \
  -H "$(auth)" -H "Content-Type: application/json" \
  "$API/zones/$ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint" \
  -d '{
    "rules": [
      {
        "description": "/install → /setup.sh (the pretty install alias)",
        "expression": "(http.host eq \"claudius.network\") and (http.request.uri.path eq \"/install\")",
        "action": "redirect",
        "action_parameters": {
          "from_value": {
            "status_code": 302,
            "target_url": { "value": "https://claudius.network/setup.sh" },
            "preserve_query_string": true
          }
        }
      }
    ]
  }')
echo "$RESPONSE" | jq -e '.success' >/dev/null || { echo "$RESPONSE" | jq; exit 1; }
echo "$RESPONSE" | jq '.result.rules | map({description, action, expression})'

echo "▸ Smoke test"
for url in "https://claudius.network/install" "https://claudius.network/setup.sh"; do
  # -o /dev/null discards body; -w prints code & final URL after redirects.
  read -r code final < <(curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' -m 10 -L "$url")
  echo "  $code  $url → $final"
done

echo "✓ redirects deployed"
