# `cloudflare/` — infrastructure for the marketing site

What Cloudflare does for `claudius.network`, captured in code so a fresh laptop
(or a future engineer) can rebuild or redeploy without spelunking the
dashboard.

## Layout

| File | Purpose |
| --- | --- |
| `posthog-proxy.js` | Cloudflare Worker source. First-party PostHog reverse proxy mounted at `claudius.network/ph/*`. |
| `wrangler.toml` | Wrangler config for `posthog-proxy`. Lets you `wrangler deploy` from this directory. |
| `deploy.sh` | Curl-based redeploy. Works without `wrangler` — needs only `bash`, `curl`, `jq`, and an API token in `CLOUDFLARE_API_TOKEN`. |
| `README.md` | This file. |

## What's deployed

```
┌────────────────────────────────────────────────────────────────────────┐
│  Visitor                                                               │
│   │                                                                    │
│   ├── https://claudius.network/                ─────► GitHub Pages     │
│   │                                                   (apex artifact)  │
│   │                                                                    │
│   └── https://claudius.network/ph/*            ─────► Cloudflare Worker│
│       (PostHog analytics, first-party path)           `posthog-proxy`  │
│                                                          │             │
│                              /ph/static/*    ─────►  eu-assets.i.posthog.com
│                              /ph/* (else)    ─────►  eu.i.posthog.com  │
└────────────────────────────────────────────────────────────────────────┘
```

### DNS (Cloudflare → DNS → Records, `claudius.network` zone)

Apex (`@`) — 4× A and 4× AAAA records, all **proxied (orange cloud)**:

| Type | Values |
| --- | --- |
| `A` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` |
| `AAAA` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |

These are GitHub Pages' published anycast IPs. If GitHub ever rotates them,
update here too (their docs page lists the current set).

### Zone settings

| Setting | Value | Why |
| --- | --- | --- |
| SSL/TLS mode | `Full (strict)` | Required when the origin has a real cert (GitHub Pages does via Let's Encrypt). `Flexible` causes the GitHub HTTPS redirect to loop. |
| Always Use HTTPS | `on` | Cloudflare 301s any HTTP request to HTTPS. |
| Plan | `Free` | Workers Free tier (100k req/day) is plenty for this site. Origin Rules would need Pro, so we use a Worker instead. |

### Worker: `posthog-proxy`

- **Script name**: `posthog-proxy` (account-level)
- **Bound route**: `claudius.network/ph/*` (zone-level)
- **Source**: `posthog-proxy.js` in this directory.

Routing logic, ~30 lines of JS:
- `/ph/static/*` → `eu-assets.i.posthog.com/*` (PostHog JS bundle)
- `/ph/*` (anything else) → `eu.i.posthog.com/*` (events, `/decide/`, `/e/`, `/i/v0/e/`, `/array/`, …)
- Strips the `/ph` prefix before forwarding.
- Drops inbound `Host` so `fetch()` sets it from the upstream URL (PostHog
  routes by SNI/Host, so this is required).
- Drops `CF-Connecting-IP` and `CF-IPCountry` so the Cloudflare hop doesn't
  leak into PostHog's request logs.

The site reaches the proxy via:

```js
posthog.init('phc_…', {
  api_host: 'https://claudius.network/ph',
  …
});
```

The PostHog snippet's loader does `s.api_host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js'`; with `api_host` set to a non-PostHog string, the `replace` is a no-op and the JS bundle is fetched from `claudius.network/ph/static/array.js`. The Worker routes that to `eu-assets.i.posthog.com/static/array.js`. Adblockers don't recognise the requests because the domain is first-party.

## Redeploying the Worker

Either path works. They produce identical results because both ultimately hit
`PUT /accounts/{id}/workers/scripts/posthog-proxy`.

### Option A — Wrangler (Cloudflare's official tool)

```bash
cd cloudflare
bunx wrangler login              # first time only; opens browser, OAuth
bunx wrangler deploy             # reads wrangler.toml + posthog-proxy.js
```

`wrangler login` stores credentials in `~/.config/.wrangler/`; no token file
in the repo. Wrangler also takes care of route binding via the `[[routes]]`
stanza in `wrangler.toml`.

### Option B — Curl + a scoped API token (no extra tooling)

Generate a token at Cloudflare → Profile → API Tokens → Create Token, with:

| Permission | Scope |
| --- | --- |
| Account → Workers Scripts → Edit | (account) |
| Zone → Workers Routes → Edit | `claudius.network` |

Then:

```bash
export CLOUDFLARE_API_TOKEN=cfut_…
./cloudflare/deploy.sh
```

The script resolves the zone + account ids itself, uploads the script, and
ensures the route binding exists. Idempotent — safe to re-run after editing
`posthog-proxy.js`. Revoke the token afterwards.

### Option C — Dashboard

Workers & Pages → `posthog-proxy` → **Edit Code** → paste the contents of
`posthog-proxy.js` → **Save and Deploy**. The route binding stays untouched.

## Verifying after deploy

```bash
# JS bundle (PostHog lib, served from eu-assets via proxy)
curl -sI https://claudius.network/ph/static/array.js | head -5
# Expect: HTTP/2 200, content-type: application/javascript, cf-ray header

# Feature-flag endpoint (forwarded to events host)
curl -s https://claudius.network/ph/decide/ | head -c 200
# Expect: JSON starting with {"errorsWhileComputingFlags":false,"featureFlags":{…

# Marketing root still served (Worker only intercepts /ph/*)
curl -sI https://claudius.network/ | head -3
# Expect: HTTP/2 200, server: cloudflare (GitHub.com upstream cached)
```

If `/ph/static/array.js` returns 404 or non-JS content, the route binding
likely dropped — re-run `deploy.sh` or check Workers & Pages → posthog-proxy
→ Triggers.

## Rolling back

The Worker is purely a forwarder; rolling back is two steps:

1. Workers & Pages → `posthog-proxy` → **Delete** (removes the script and
   automatically unbinds the route).
2. In `site/index.html`, point `api_host` back to `https://eu.i.posthog.com`.

The site will still work — PostHog will just be a third-party call again
and adblockers will see it.

## Why a Worker (and not Origin Rules)?

Cloudflare's Origin Rules can do the same upstream override, but the `Host
Header` and `SNI` overrides — required to route to PostHog's edge — are
Pro plan only. URL Rewrite with `regex_replace` is Business plan only.
Workers on the Free plan handle both for $0. If you upgrade to Pro in the
future, you could replace the Worker with two Origin Rules + a Transform
Rule and skip the Free-tier request budget entirely. The Worker source
stays useful as documentation of what those rules need to do.
