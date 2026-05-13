#!/usr/bin/env bash
#
# cloudflare-setup.sh — configure Cloudflare for the chat-server VPS.
#
# Idempotent. Two phases, with a manual pause in the middle:
#
#   Phase 1  Create/update an A record pointing at the VPS, grey-clouded
#            (proxied=false) so Caddy can complete the Let's Encrypt
#            HTTP-01 challenge.
#
#   Phase 2  Flip the record to orange-cloud (proxied=true), set TLS
#            mode to Full (strict), enable Always Use HTTPS.
#
# Required env vars:
#   CF_API_TOKEN   — token with Zone:DNS:Edit + Zone:Zone Settings:Edit
#                    scoped to the target zone. Create at
#                    https://dash.cloudflare.com/profile/api-tokens
#   CF_VPS_IP      — IPv4 of the VPS the chat-server is running on
#
# Optional env vars (defaults for the canonical Claudius community deploy):
#   CF_ZONE        — apex domain.   default: claudius.network
#   CF_HOST        — subdomain.     default: chat
#
# Usage:
#   ./cloudflare-setup.sh             # both phases, prompts between them
#   ./cloudflare-setup.sh --phase1    # just create the grey A record
#   ./cloudflare-setup.sh --phase2    # just flip to orange + strict TLS
#
# Safe to re-run.

set -euo pipefail

# ── inputs ─────────────────────────────────────────────────────────

: "${CF_API_TOKEN:?CF_API_TOKEN must be set}"
: "${CF_VPS_IP:?CF_VPS_IP must be set (the VPS IPv4)}"

# Defaults match the canonical claudius.network community deploy.
# Override CF_ZONE / CF_HOST when running this for a different
# domain/subdomain.
CF_ZONE="${CF_ZONE:-claudius.network}"
CF_HOST="${CF_HOST:-chat}"

FQDN="${CF_HOST}.${CF_ZONE}"

PHASE="${1:-all}"
case "$PHASE" in
	--phase1|--phase2|all) ;;
	*) echo "usage: $0 [--phase1|--phase2]"; exit 2 ;;
esac

# ── deps ───────────────────────────────────────────────────────────

for bin in curl jq; do
	command -v "$bin" >/dev/null || { echo "missing dependency: $bin"; exit 1; }
done

# ── api helpers ────────────────────────────────────────────────────

API="https://api.cloudflare.com/client/v4"

# cf_api METHOD PATH [BODY]
# Returns the .result of a successful response on stdout.
# Cloudflare sometimes returns HTTP 200 with success=false, so we
# always parse + check the JSON envelope explicitly.
cf_api() {
	local method="$1" path="$2" body="${3:-}"
	local resp
	if [[ -n "$body" ]]; then
		resp=$(curl -sS -X "$method" "$API$path" \
			-H "Authorization: Bearer $CF_API_TOKEN" \
			-H "Content-Type: application/json" \
			--data "$body")
	else
		resp=$(curl -sS -X "$method" "$API$path" \
			-H "Authorization: Bearer $CF_API_TOKEN")
	fi
	if [[ "$(jq -r '.success' <<<"$resp")" != "true" ]]; then
		echo "cloudflare api error ($method $path):" >&2
		jq -r '.errors // .' <<<"$resp" >&2
		exit 1
	fi
	jq -c '.result' <<<"$resp"
}

# ── lookup zone ────────────────────────────────────────────────────

ZID=$(cf_api GET "/zones?name=${CF_ZONE}" | jq -r '.[0].id // empty')
if [[ -z "$ZID" ]]; then
	echo "zone not found: $CF_ZONE (does the token have access to it?)" >&2
	exit 1
fi
echo "✓ zone $CF_ZONE → $ZID"

# ── phase 1: A record, grey-clouded ────────────────────────────────

phase1() {
	echo "── phase 1: A $FQDN → $CF_VPS_IP (proxied=false) ──"

	local rid
	rid=$(cf_api GET "/zones/$ZID/dns_records?type=A&name=$FQDN" \
		| jq -r '.[0].id // empty')

	local body
	body=$(jq -cn \
		--arg name "$CF_HOST" \
		--arg ip   "$CF_VPS_IP" \
		'{type:"A", name:$name, content:$ip, proxied:false, ttl:120}')

	if [[ -z "$rid" ]]; then
		cf_api POST "/zones/$ZID/dns_records" "$body" >/dev/null
		echo "✓ created A record (grey-clouded)"
	else
		cf_api PATCH "/zones/$ZID/dns_records/$rid" "$body" >/dev/null
		echo "✓ updated A record (grey-clouded)"
	fi
}

# ── phase 2: orange-cloud + strict TLS ─────────────────────────────

phase2() {
	echo "── phase 2: flip $FQDN to proxied + strict TLS ──"

	local rid
	rid=$(cf_api GET "/zones/$ZID/dns_records?type=A&name=$FQDN" \
		| jq -r '.[0].id // empty')
	if [[ -z "$rid" ]]; then
		echo "no A record for $FQDN — run phase 1 first" >&2
		exit 1
	fi

	# TTL must be 1 (auto) when proxied=true; CF rejects anything else.
	local body
	body=$(jq -cn \
		--arg name "$CF_HOST" \
		--arg ip   "$CF_VPS_IP" \
		'{type:"A", name:$name, content:$ip, proxied:true, ttl:1}')

	cf_api PATCH "/zones/$ZID/dns_records/$rid" "$body" >/dev/null
	echo "✓ A record now proxied (orange-clouded)"

	cf_api PATCH "/zones/$ZID/settings/ssl" '{"value":"strict"}' >/dev/null
	echo "✓ SSL mode → Full (strict)"

	cf_api PATCH "/zones/$ZID/settings/always_use_https" '{"value":"on"}' >/dev/null
	echo "✓ Always Use HTTPS → on"
}

# ── run ────────────────────────────────────────────────────────────

case "$PHASE" in
	--phase1)
		phase1
		cat <<-EOF

		Next: on the VPS, make sure Caddy is reloaded and hit
		    curl https://$FQDN/health
		from your laptop. Caddy will issue a Let's Encrypt cert on
		the first request. Once that returns {"ok":true}, run:

		    $0 --phase2
		EOF
		;;
	--phase2)
		phase2
		;;
	all)
		phase1
		echo
		echo "Now reload Caddy on the VPS and verify the cert issues:"
		echo "    ssh <vps> 'sudo systemctl reload caddy'"
		echo "    curl https://$FQDN/health      # expect {\"ok\":true}"
		echo
		read -r -p "Press enter once that works to proceed to phase 2 (Ctrl-C to abort)… "
		echo
		phase2
		echo
		echo "Done. Test via Cloudflare:"
		echo "    curl https://$FQDN/health"
		echo "    curl -N https://$FQDN/rooms/general/stream"
		;;
esac
