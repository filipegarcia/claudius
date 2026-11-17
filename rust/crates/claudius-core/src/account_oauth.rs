//! Port of `lib/server/account-oauth.ts` and of the handler in
//! `app/api/accounts/oauth/route.ts`: the account switcher's browser sign-in.
//!
//! It is the Authorization Code + PKCE flow of the CLI's `setup-token`, with
//! the manual redirect: `start` returns the authorize URL for the user to
//! open, the success page shows them a `<code>#<state>` blob, and `complete`
//! exchanges it at the token endpoint for a long-lived (`user:inference`,
//! one year) token and stores it as a new `oauth-token` profile
//! ([`AccountsStore::add_account`]).
//!
//! The PKCE verifier stays here: pending flows live in [`OAuthFlows`] (TS
//! module state), keyed by an opaque `flowId`, for 10 minutes. State,
//! verifier and flow id come from an injectable [`SecureRandom`], the OS
//! CSPRNG by default (`randomBytes`), and the clock is injectable too.
//!
//! The token request goes through the [`Fetch`] boundary
//! ([`crate::fetch::HttpsClient`] in production). Answers, request bodies,
//! error wording and the store bytes match the TS byte for byte (replayed in
//! `tests/account_oauth_golden.rs`).
//!
//! Secrets: the verifier, the pasted code and the tokens never reach a log,
//! and the `Debug` prints here leave them out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use claudius_agent::js;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::account_profile::ProfileInfoResolver;
use crate::accounts::{AccountsStore, Clock, NewAccount};
use crate::fetch::{Fetch, Request};
use crate::tls_cert_hint::own_request_hint_for;

pub const OAUTH_AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const OAUTH_MANUAL_REDIRECT_URL: &str = "https://platform.claude.com/oauth/code/callback";
pub const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// The `inferenceOnly` scope set: the one that mints long-lived tokens.
pub const OAUTH_SCOPES: [&str; 1] = ["user:inference"];
/// How long a started flow waits for its code.
pub const FLOW_TTL_MS: i64 = 10 * 60 * 1000;
/// The token lifetime asked for (`setup-token`'s one year).
pub const TOKEN_EXPIRES_IN_S: i64 = 365 * 24 * 60 * 60;

/// CC 2.1.311 parity, verbatim from the bundled CLI's
/// `AuthCodeRefusedError`: what a refused pasted code says.
pub const REFUSED_AUTH_CODE_MESSAGE: &str = "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";

/// What a sign-in that couldn't verify the server's certificate says
/// (CC 2.1.309); the hint itself is [`crate::tls_cert_hint`]'s.
pub fn unreachable_message(hint: &str) -> String {
    format!("Sign-in couldn't reach Anthropic. {hint}")
}

const FLOW_UNKNOWN: &str = "flow expired or unknown \u{2014} please restart sign-in";
const STATE_MISMATCH: &str = "OAuth state mismatch \u{2014} please restart sign-in";
const INVALID_CODE: &str =
    "Invalid authorization code. The codes expire fast \u{2014} try signing in again.";

/// `randomBytes`: fills the buffer, or fails with the error's message.
pub type SecureRandom = Arc<dyn Fn(&mut [u8]) -> Result<(), String> + Send + Sync>;

fn os_random(buf: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buf).map_err(|e| e.to_string())
}

/// `buf.toString("base64")` with `+/` as `-_` and the padding cut.
fn base64_url(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(ABC[(n >> (18 - 6 * i)) as usize & 63]));
        }
    }
    out
}

/// `createHash("sha256").update(verifier).digest()`, base64url.
pub fn code_challenge(verifier: &str) -> String {
    base64_url(&Sha256::digest(verifier.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `isRefusedAuthCode(status, bodyText)`: the engine's predicate for a
/// refused pasted code — a 400 or 401 whose body is an object carrying the
/// OAuth `invalid_grant` error (RFC 6749 §5.2), directly or in the Anthropic
/// API's nested envelope. An on-hold account is excluded, as in the engine:
/// signing in again can't fix it, so it keeps its own message. A body that
/// doesn't parse, or isn't an object, is not a refusal.
pub fn is_refused_auth_code(status: u16, body_text: &str) -> bool {
    if status != 400 && status != 401 {
        return false;
    }
    let Ok(body) = js::json_parse(body_text) else {
        return false;
    };
    // `!body || typeof body !== "object"`: an array passes (it is an object),
    // a primitive or `null` doesn't.
    let frame = match &body {
        Value::Object(_) | Value::Array(_) => &body,
        _ => return false,
    };
    if frame.get("error_description").and_then(Value::as_str) == Some("account_on_hold") {
        return false;
    }
    let Some(err) = frame.get("error") else {
        return false;
    };
    if err.as_str() == Some("invalid_grant") {
        return true;
    }
    // `!!err && typeof err === "object"` and then `.type` / `.code`.
    match err {
        Value::Object(_) | Value::Array(_) => {
            err.get("type").and_then(Value::as_str) == Some("invalid_grant")
                || err.get("code").and_then(Value::as_str) == Some("invalid_grant")
        }
        _ => false,
    }
}

struct PendingFlow {
    code_verifier: String,
    state: String,
    created_at: i64,
}

/// `startOAuthFlow()`'s answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthStart {
    pub flow_id: String,
    pub auth_url: String,
    pub state: String,
}

impl OAuthStart {
    /// `{flowId, authUrl, state}`.
    pub fn to_json(&self) -> Value {
        json!({"flowId": self.flow_id, "authUrl": self.auth_url, "state": self.state})
    }
}

/// `exchangeOAuthCode`'s answer. The fields are the raw response values
/// (`None` is `undefined`), as the TS hands them on.
#[derive(Clone, Default)]
pub struct OAuthExchange {
    pub access_token: Value,
    pub refresh_token: Option<Value>,
    /// `Date.now() + expires_in * 1000` when `expires_in` is a number.
    pub expires_at: Option<f64>,
    pub scope: Option<Value>,
    pub account_uuid: Option<Value>,
    pub email_address: Option<Value>,
    pub organization_uuid: Option<Value>,
    pub subscription_type: Option<&'static str>,
}

impl std::fmt::Debug for OAuthExchange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthExchange")
            .field("access_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("email_address", &self.email_address)
            .finish_non_exhaustive()
    }
}

impl OAuthExchange {
    /// The TS object as `JSON.stringify` prints it (`undefined` left out).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("accessToken".into(), self.access_token.clone());
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                m.insert(k.into(), v);
            }
        };
        put("refreshToken", self.refresh_token.clone());
        put("expiresAt", self.expires_at.map(crate::js_num));
        put("scope", self.scope.clone());
        put("accountUuid", self.account_uuid.clone());
        put("emailAddress", self.email_address.clone());
        put("organizationUuid", self.organization_uuid.clone());
        put("subscriptionType", self.subscription_type.map(Value::from));
        Value::Object(m)
    }
}

/// `subscriptionTypeFromOrgType`.
fn subscription_type(org_type: Option<&Value>) -> Option<&'static str> {
    match org_type?.as_str()? {
        "claude_max" => Some("Claude Max"),
        "claude_pro" => Some("Claude Pro"),
        "claude_team" => Some("Claude Team"),
        "claude_enterprise" => Some("Claude Enterprise"),
        _ => None,
    }
}

/// The in-progress flows (TS `pendingFlows`), with their clock and
/// randomness.
pub struct OAuthFlows {
    pending: Mutex<HashMap<String, PendingFlow>>,
    now: Clock,
    random: SecureRandom,
}

impl Default for OAuthFlows {
    fn default() -> Self {
        OAuthFlows::new()
    }
}

impl OAuthFlows {
    /// No flows; the system clock and the OS CSPRNG.
    pub fn new() -> OAuthFlows {
        OAuthFlows {
            pending: Mutex::new(HashMap::new()),
            now: Arc::new(crate::now_ms),
            random: Arc::new(os_random),
        }
    }

    pub fn with_clock(mut self, now: Clock) -> OAuthFlows {
        self.now = now;
        self
    }

    pub fn with_random(mut self, random: SecureRandom) -> OAuthFlows {
        self.random = random;
        self
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, PendingFlow>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `gcFlows`: drop flows older than the TTL.
    fn gc(&self, pending: &mut HashMap<String, PendingFlow>) {
        let cutoff = (self.now)() - FLOW_TTL_MS;
        pending.retain(|_, f| f.created_at >= cutoff);
    }

    fn bytes(&self, n: usize) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; n];
        (self.random)(&mut buf)?;
        Ok(buf)
    }

    /// `__debugFlowCount`.
    pub fn pending_count(&self) -> usize {
        self.lock().len()
    }

    /// `startOAuthFlow`: a new flow (verifier 32 random bytes, state 24,
    /// flow id 8, drawn in that order) and its authorize URL. Fails only
    /// when the randomness does.
    pub fn start(&self) -> Result<OAuthStart, String> {
        let mut pending = self.lock();
        self.gc(&mut pending);
        let code_verifier = base64_url(&self.bytes(32)?);
        let challenge = code_challenge(&code_verifier);
        let state = base64_url(&self.bytes(24)?);
        let flow_id = format!("oauth_{}", hex(&self.bytes(8)?));
        pending.insert(
            flow_id.clone(),
            PendingFlow {
                code_verifier,
                state: state.clone(),
                created_at: (self.now)(),
            },
        );
        drop(pending);
        let mut url = url::Url::parse(OAUTH_AUTHORIZE_URL).expect("a valid constant");
        url.query_pairs_mut()
            .append_pair("code", "true")
            .append_pair("client_id", OAUTH_CLIENT_ID)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", OAUTH_MANUAL_REDIRECT_URL)
            .append_pair("scope", &OAUTH_SCOPES.join(" "))
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
        Ok(OAuthStart {
            flow_id,
            auth_url: url.to_string(),
            state,
        })
    }

    /// `exchangeOAuthCode(flowId, rawCode)` on the raw values (`None` is
    /// `undefined`): the flow is taken (an unknown or non-string id fails),
    /// the code is trimmed and split at `#` (its state must be the flow's),
    /// then posted to the token endpoint. `Err` is the thrown message.
    pub async fn exchange_code(
        &self,
        fetch: &dyn Fetch,
        flow_id: Option<&Value>,
        raw_code: Option<&Value>,
    ) -> Result<OAuthExchange, String> {
        let flow = {
            let mut pending = self.lock();
            self.gc(&mut pending);
            let flow = flow_id
                .and_then(Value::as_str)
                .and_then(|id| pending.remove(id));
            flow.ok_or(FLOW_UNKNOWN)?
        };
        let trimmed = match raw_code {
            Some(Value::String(s)) => js::trim(s),
            None => return Err("Cannot read properties of undefined (reading 'trim')".into()),
            Some(Value::Null) => {
                return Err("Cannot read properties of null (reading 'trim')".into());
            }
            Some(_) => return Err("rawCode.trim is not a function".into()),
        };
        if trimmed.is_empty() {
            return Err("authorization code required".into());
        }
        let (mut code, mut state) = (trimmed, flow.state.as_str());
        if trimmed.contains('#') {
            let parts: Vec<&str> = trimmed.split('#').collect();
            if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
                return Err("expected code#state format from the success page".into());
            }
            (code, state) = (parts[0], parts[1]);
            if state != flow.state {
                return Err(STATE_MISMATCH.into());
            }
        }
        let body = json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": OAUTH_MANUAL_REDIRECT_URL,
            "client_id": OAUTH_CLIENT_ID,
            "code_verifier": flow.code_verifier,
            "state": state,
            "expires_in": TOKEN_EXPIRES_IN_S,
        });
        let req = Request {
            method: "POST".into(),
            url: OAUTH_TOKEN_URL.into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(js::stringify(&body)),
        };
        let res = fetch.fetch(&req).await.map_err(|e| {
            // CC 2.1.309: behind a TLS-inspecting proxy the exchange fails
            // certificate verification; say what to do instead of
            // "fetch failed".
            match own_request_hint_for(e.ca_trust) {
                Some(hint) => {
                    tracing::warn!(
                        target: crate::log::API,
                        "[accounts] token exchange failed certificate verification \u{2014} {hint}"
                    );
                    unreachable_message(hint)
                }
                None => e.message,
            }
        })?;
        if !res.ok() {
            let text = res.text().unwrap_or_default();
            // CC 2.1.311: a refused code says to sign in again, before the
            // old 401-only branch (an OAuth refusal is a 400).
            if is_refused_auth_code(res.status, &text) {
                return Err(REFUSED_AUTH_CODE_MESSAGE.into());
            }
            if res.status == 401 {
                return Err(INVALID_CODE.into());
            }
            let detail = if text.is_empty() {
                &res.status_text
            } else {
                &text
            };
            return Err(format!("token exchange failed ({}): {detail}", res.status));
        }
        let data = res.json()?;
        if data.is_null() {
            return Err("Cannot read properties of null (reading 'access_token')".into());
        }
        let data = Some(&data);
        let Some(access_token) = js::prop(data, "access_token").filter(|v| js::truthy(v)) else {
            return Err("token exchange returned no access_token".into());
        };
        let account = js::prop(data, "account");
        let org = js::prop(data, "organization");
        Ok(OAuthExchange {
            access_token: access_token.clone(),
            refresh_token: js::prop(data, "refresh_token").cloned(),
            expires_at: js::prop(data, "expires_in")
                .and_then(Value::as_f64)
                .map(|s| (self.now)() as f64 + s * 1000.0),
            scope: js::prop(data, "scope").cloned(),
            account_uuid: js::prop(account, "uuid").cloned(),
            email_address: js::prop(account, "email_address").cloned(),
            organization_uuid: js::prop(org, "uuid").cloned(),
            subscription_type: subscription_type(js::prop(org, "organization_type")),
        })
    }
}

/// What the route handler answers: a JSON body with its status, or a throw
/// (Next's empty 500) with the error's message for the log.
#[derive(Clone, Debug, PartialEq)]
pub enum RouteAnswer {
    Json(u16, Value),
    Thrown(String),
}

fn error(status: u16, message: impl Into<String>) -> RouteAnswer {
    RouteAnswer::Json(status, json!({"error": message.into()}))
}

/// `POST /api/accounts/oauth` after its body parsed: `{action: "start"}`,
/// or `{action: "complete", flowId, code, label}` (each truthy), which
/// exchanges the code, stores the token as a new profile and answers
/// `{state, emailAddress}` with the public accounts state. Every failure of
/// `complete` is a 400 with its message. `profiles` is the profile-info
/// cache to drop the new id from, if the caller keeps one.
pub async fn post_route(
    flows: &OAuthFlows,
    fetch: &dyn Fetch,
    store: &AccountsStore,
    profiles: Option<&ProfileInfoResolver>,
    body: &Value,
) -> RouteAnswer {
    // `body.action`: no `?.`, so a `null` body throws.
    if body.is_null() {
        return RouteAnswer::Thrown("Cannot read properties of null (reading 'action')".into());
    }
    let field = |k: &str| body.as_object().and_then(|o| o.get(k));
    match field("action").and_then(Value::as_str) {
        Some("start") => match flows.start() {
            Ok(flow) => RouteAnswer::Json(200, flow.to_json()),
            Err(e) => RouteAnswer::Thrown(e),
        },
        Some("complete") => {
            let (flow_id, code, label) = (field("flowId"), field("code"), field("label"));
            let (true, true, Some(label)) = (
                flow_id.is_some_and(js::truthy),
                code.is_some_and(js::truthy),
                label.filter(|v| js::truthy(v)),
            ) else {
                return error(400, "flowId, code, label required");
            };
            match complete(flows, fetch, store, profiles, flow_id, code, label).await {
                Ok(v) => RouteAnswer::Json(200, v),
                Err(message) => error(400, message),
            }
        }
        _ => error(400, "unknown action"),
    }
}

async fn complete(
    flows: &OAuthFlows,
    fetch: &dyn Fetch,
    store: &AccountsStore,
    profiles: Option<&ProfileInfoResolver>,
    flow_id: Option<&Value>,
    code: Option<&Value>,
    label: &Value,
) -> Result<Value, String> {
    let exchanged = flows.exchange_code(fetch, flow_id, code).await?;
    // `body.label.trim() || (email ? `Claude (${email})` : "Claude")`.
    let Value::String(label) = label else {
        return Err("body.label.trim is not a function".into());
    };
    let email = exchanged.email_address.as_ref();
    let label = match js::trim(label) {
        "" => match email.filter(|v| js::truthy(v)) {
            Some(e) => format!("Claude ({})", js::to_string(Some(e))),
            None => "Claude".into(),
        },
        label => label.to_owned(),
    };
    let (_, profile) = store
        .add_account(&NewAccount {
            label: Some(label.into()),
            kind: Some("oauth-token".into()),
            secret: Some(exchanged.access_token.clone()),
            bedrock: None,
            account_uuid: exchanged.account_uuid.clone(),
            email_address: exchanged.email_address.clone(),
            organization_uuid: exchanged.organization_uuid.clone(),
            subscription_type: exchanged.subscription_type.map(Value::from),
            expires_at: exchanged.expires_at,
        })
        .map_err(|e| e.0)?;
    if let Some(profiles) = profiles {
        profiles.invalidate_profile_cache(Some(profile.id()));
    }
    let state = store.read_public().map_err(|e| e.0)?;
    Ok(json!({
        "state": state,
        "emailAddress": exchanged.email_address.unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_url_matches_node() {
        // Buffer.from(x).toString("base64") with the url-safe swaps.
        for (bytes, want) in [
            (&b""[..], ""),
            (b"f", "Zg"),
            (b"fo", "Zm8"),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg"),
            (&[0xfb, 0xff, 0xfe][..], "-__-"),
            (
                &[0xff; 32][..],
                "__________________________________________8",
            ),
        ] {
            assert_eq!(base64_url(bytes), want, "{bytes:?}");
        }
        // RFC 7636 appendix B.
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
