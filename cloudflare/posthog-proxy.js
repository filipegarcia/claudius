/**
 * PostHog reverse proxy — first-party path on claudius.network/ph/*
 *
 * Deployed as a Cloudflare Worker named `posthog-proxy`, bound to the route
 * `claudius.network/ph/*`. Purpose: make analytics traffic appear first-party
 * so it isn't blocked by ad/tracker blockers (EasyPrivacy, uBlock, Brave
 * Shield, etc.) that would otherwise drop direct calls to *.posthog.com.
 *
 * Routing:
 *   /ph/static/*          → eu-assets.i.posthog.com   (posthog-js library bundle)
 *   /ph/* (anything else) → eu.i.posthog.com          (events, /decide, /e, /i/v0/e, …)
 *
 * The /ph prefix is stripped before the request leaves Cloudflare, so PostHog
 * sees its expected URL shape. Inbound Host / CF-* headers are removed so
 * PostHog's edge picks up the upstream hostname for SNI/Host.
 *
 * Site-side config in site/index.html:
 *   posthog.init('phc_…', { api_host: 'https://claudius.network/ph', … })
 *
 * To redeploy this Worker without re-pasting the source:
 *   - Cloudflare dashboard: Workers & Pages → posthog-proxy → Edit Code → paste this file.
 *   - Or via API: PUT /accounts/{account_id}/workers/scripts/posthog-proxy
 *     with multipart metadata={"main_module":"worker.js"} and a worker.js part
 *     carrying this file's contents.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ph/")) {
      // Should be unreachable — the Worker is mounted only on /ph/* — but be
      // defensive in case the route gets widened or this Worker is reused.
      return new Response("Not Found", { status: 404 });
    }
    // /ph/static/* → JS lib bundle host. Everything else
    // (/ph/decide/, /ph/e/, /ph/i/v0/e/, /ph/array/, …) → events host.
    const upstreamHost = url.pathname.startsWith("/ph/static/")
      ? "eu-assets.i.posthog.com"
      : "eu.i.posthog.com";
    // Strip the /ph prefix; keep the leading slash.
    const upstreamUrl = `https://${upstreamHost}${url.pathname.slice(3)}${url.search}`;
    // Don't carry inbound Host / Cloudflare-injected headers through — let
    // fetch() set Host from the URL so PostHog's edge sees the SNI/Host it
    // expects. CF-Connecting-IP etc. would leak the proxy hop into PostHog
    // logs unnecessarily.
    const headers = new Headers(request.headers);
    headers.delete("Host");
    headers.delete("CF-Connecting-IP");
    headers.delete("CF-IPCountry");
    return fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow",
    });
  },
};
