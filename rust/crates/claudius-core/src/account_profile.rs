//! Port of `lib/server/account-profile.ts`: the email / org / plan an
//! account-switcher profile resolves to, for the Account section and the
//! `/usage` provider switcher (`GET /api/accounts/profile`, G02c).
//!
//! An `oauth-token` profile asks Anthropic's OAuth profile endpoint with its
//! token; every failure falls back to what's stored on the profile and to the
//! Claude Code global config ([`crate::claude_global_config`]). Answers are
//! reused for 5 minutes per profile id (failures aren't).
//!
//! The HTTP call is a boundary ([`ProfileFetch`]): the port has no HTTPS
//! client of its own yet, so whoever serves the route supplies one (and the
//! tests a scripted one). The body is read the way `Response.json()` reads it.
//!
//! A failure whose certificate chain had no trusted root reports the CC
//! 2.1.309 hint instead of the raw message, and logs one line
//! ([`crate::tls_cert_hint`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use claudius_agent::js;
use futures::future::BoxFuture;
use serde_json::{Map, Value};

use crate::accounts::{
    AccountKind, AccountMetadata, AccountProfile, AccountsError, AccountsStore, Clock,
    describe_bedrock_config,
};
use crate::claude_global_config::ClaudeGlobalConfig;
use crate::fetch::FetchError;
use crate::tls_cert_hint::own_request_hint_for;

pub const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const CACHE_TTL_MS: i64 = 5 * 60 * 1000;

const GLOBAL_GUESS_NOTE: &str = "shown from local Claude Code config \u{2014} verify identity";

/// An HTTP response: its status and body bytes.
#[derive(Clone, Debug)]
pub struct FetchResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// `fetch(url, { method: "GET", headers })`: the response, or the thrown
/// error ([`FetchError`]: undici's network failure is `"fetch failed"`, with
/// the certificate-trust verdict beside it). Redirects are the transport's
/// business, as they are fetch's.
pub trait ProfileFetch: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<FetchResponse, FetchError>>;
}

/// `res.json()`: undici drops a leading UTF-8 BOM and its decoder another,
/// invalid bytes become U+FFFD, then `JSON.parse`.
fn response_json(body: &[u8]) -> Result<Value, String> {
    let once = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    let twice = once.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(once);
    js::json_parse(&String::from_utf8_lossy(twice))
}

/// `a ?? b` over raw values (`None` is `undefined`).
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        a => a,
    }
}

/// `{ key: v }` where an `undefined` value isn't printed.
fn put(map: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        map.insert(key.into(), v.clone());
    }
}

/// `{ ...fromCached, errored, error }`.
fn with_error(from: &Map<String, Value>, error: String) -> Value {
    let has = |k: &str| from.get(k).is_some_and(js::truthy);
    let mut out = from.clone();
    out.insert(
        "errored".into(),
        (!(has("email") || has("subscriptionType"))).into(),
    );
    out.insert("error".into(), error.into());
    Value::Object(out)
}

/// The resolver: the store, the global-config reader, the HTTP transport,
/// and the per-profile cache (TS module state).
pub struct ProfileInfoResolver {
    store: AccountsStore,
    global: Arc<ClaudeGlobalConfig>,
    fetch: Arc<dyn ProfileFetch>,
    now: Clock,
    cache: Mutex<HashMap<String, (Value, i64)>>,
}

impl ProfileInfoResolver {
    pub fn new(
        store: AccountsStore,
        global: Arc<ClaudeGlobalConfig>,
        fetch: Arc<dyn ProfileFetch>,
    ) -> ProfileInfoResolver {
        ProfileInfoResolver {
            store,
            global,
            fetch,
            now: Arc::new(crate::now_ms),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_clock(mut self, now: Clock) -> ProfileInfoResolver {
        self.now = now;
        self
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Value, i64)>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn remember(&self, id: &str, info: &Value) {
        self.cache()
            .insert(id.to_owned(), (info.clone(), (self.now)()));
    }

    /// `getProfileInfoForAccount(profileId, { skipCache })`: `None` for an
    /// unknown id; else the `AccountProfileInfo` object, keys in the TS
    /// order, `undefined` ones left out. A store that doesn't load, or a
    /// Bedrock config [`describe_bedrock_config`] refuses, is an error. After
    /// a successful lookup the profile's stored metadata is backfilled
    /// (`updateAccountMetadata`; TS fires it and moves on, here it's done
    /// before returning; a failure is ignored either way).
    pub async fn get_profile_info_for_account(
        &self,
        profile_id: &str,
        skip_cache: bool,
    ) -> Result<Option<Value>, AccountsError> {
        let cur = self.store.read_raw()?;
        let Some(profile) = cur.profiles.into_iter().find(|p| p.id() == profile_id) else {
            return Ok(None);
        };
        if !skip_cache
            && let Some((info, at)) = self.cache().get(profile_id)
            && (self.now)() - at < CACHE_TTL_MS
        {
            return Ok(Some(info.clone()));
        }
        let global = self.global.read_oauth_account(false);
        let from = from_cached(&profile, global.as_ref());

        match profile.kind() {
            AccountKind::ApiKey => {
                let info = Value::Object(from);
                self.remember(profile_id, &info);
                Ok(Some(info))
            }
            AccountKind::Bedrock => {
                let ambient = Map::from_iter([("auth".to_owned(), Value::from("ambient"))]);
                let summary = describe_bedrock_config(profile.bedrock().unwrap_or(&ambient))?;
                let mut info = head(&profile, "bedrock");
                info.insert("bedrockSummary".into(), summary.into());
                let info = Value::Object(info);
                self.remember(profile_id, &info);
                Ok(Some(info))
            }
            AccountKind::OauthToken => Ok(Some(self.lookup(&profile, &from).await)),
        }
    }

    async fn lookup(&self, profile: &AccountProfile, from: &Map<String, Value>) -> Value {
        let headers = [
            (
                "Authorization".to_owned(),
                format!("Bearer {}", profile.secret()),
            ),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ];
        let res = match self.fetch.get(PROFILE_URL, &headers).await {
            Ok(res) => res,
            // CC 2.1.309: a certificate-verification failure (typically a
            // TLS-inspecting proxy) says what to do instead of undici's bare
            // "fetch failed".
            Err(e) => {
                return match own_request_hint_for(e.ca_trust) {
                    Some(hint) => {
                        tracing::warn!(
                            target: crate::log::API,
                            "[accounts] profile request failed certificate verification \u{2014} {hint}"
                        );
                        with_error(from, hint.to_owned())
                    }
                    None => with_error(from, e.message),
                };
            }
        };
        if !(200..=299).contains(&res.status) {
            let note = match res.status {
                401 => "token rejected (re-add this account)".to_owned(),
                403 => "scope-limited (inference-only token \u{2014} using cached info)".to_owned(),
                s if s >= 500 => format!("Anthropic temporarily unavailable (HTTP {s})"),
                s => format!("profile endpoint HTTP {s}"),
            };
            return with_error(from, note);
        }
        let data = match response_json(&res.body) {
            Ok(Value::Null) => {
                return with_error(
                    from,
                    "Cannot read properties of null (reading 'organization')".into(),
                );
            }
            Ok(data) => data,
            Err(message) => return with_error(from, message),
        };
        let org = js::prop(Some(&data), "organization");
        let account = js::prop(Some(&data), "account");
        let plan = match js::prop(org, "organization_type").and_then(Value::as_str) {
            Some("claude_max") => Some(Value::from("Claude Max")),
            Some("claude_pro") => Some(Value::from("Claude Pro")),
            Some("claude_team") => Some(Value::from("Claude Team")),
            Some("claude_enterprise") => Some(Value::from("Claude Enterprise")),
            _ => from.get("subscriptionType").cloned(),
        };
        let mut info = head(profile, "firstParty");
        put(
            &mut info,
            "email",
            nullish(js::prop(account, "email"), from.get("email")),
        );
        put(&mut info, "displayName", js::prop(account, "display_name"));
        put(
            &mut info,
            "organizationUuid",
            nullish(js::prop(org, "uuid"), from.get("organizationUuid")),
        );
        put(&mut info, "subscriptionType", plan.as_ref());
        put(&mut info, "rateLimitTier", js::prop(org, "rate_limit_tier"));
        let meta = AccountMetadata {
            account_uuid: js::prop(account, "uuid").cloned(),
            email_address: info.get("email").cloned(),
            organization_uuid: info.get("organizationUuid").cloned(),
            subscription_type: info.get("subscriptionType").cloned(),
        };
        let info = Value::Object(info);
        self.remember(profile.id(), &info);
        let _ = self.store.update_account_metadata(profile.id(), &meta);
        info
    }

    /// `invalidateProfileCache(profileId?)`: one entry, or all of them.
    pub fn invalidate_profile_cache(&self, profile_id: Option<&str>) {
        match profile_id {
            Some(id) => {
                self.cache().remove(id);
            }
            None => self.cache().clear(),
        }
    }
}

/// `{provider, profileId, profileLabel, profileKind}`.
fn head(profile: &AccountProfile, provider: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("provider".into(), provider.into());
    m.insert("profileId".into(), profile.id().into());
    m.insert("profileLabel".into(), profile.label().into());
    m.insert("profileKind".into(), profile.kind().as_str().into());
    m
}

/// `fromCached`: the stored metadata, filled from the global config when its
/// account matches the profile's (or, for a profile with no `accountUuid`,
/// as a guess flagged with an `error` note).
fn from_cached(
    profile: &AccountProfile,
    global: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mine = profile.get("accountUuid").filter(|v| js::truthy(v));
    let (use_global, guess) = match global {
        None => (false, false),
        Some(g) => match (mine, g.get("accountUuid").filter(|v| js::truthy(v))) {
            (Some(a), Some(b)) => (a.is_string() && a == b, false),
            (None, _) => (true, true),
            (Some(_), None) => (false, false),
        },
    };
    let g = |k: &str| global.filter(|_| use_global).and_then(|g| g.get(k));
    let mut m = head(profile, "firstParty");
    put(
        &mut m,
        "email",
        nullish(profile.get("emailAddress"), g("emailAddress")),
    );
    put(&mut m, "displayName", g("displayName"));
    put(
        &mut m,
        "organizationUuid",
        nullish(profile.get("organizationUuid"), g("organizationUuid")),
    );
    put(&mut m, "subscriptionType", profile.get("subscriptionType"));
    if guess {
        m.insert("error".into(), GLOBAL_GUESS_NOTE.into());
    }
    m
}
