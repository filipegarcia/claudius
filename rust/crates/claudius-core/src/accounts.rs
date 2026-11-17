//! The account switcher's store: port of `lib/server/accounts-store.ts`, the
//! validation half of `lib/shared/accounts.ts`, and `shouldWarnTokenExpiring`
//! from `lib/server/token-expiry.ts`.
//!
//! One Claudius install holds several Claude credentials (subscription OAuth
//! tokens, API keys, Amazon Bedrock settings) in
//! `~/.claude/.claudius/accounts.json` (or `$CLAUDIUS_ACCOUNTS_DIR`), mode
//! 0600, and new sessions spawn under the active one. The file is shared with
//! the TS app, byte for byte:
//!
//! - it's read as text (invalid UTF-8 becomes U+FFFD, a BOM is not skipped)
//!   and parsed like `JSON.parse`; a missing file is the empty state, and any
//!   other failure is an error with the JS `message`;
//! - profiles that fail the TS shape check are dropped, the others keep every
//!   key (foreign ones too) in their order;
//! - every write is `JSON.stringify(state, null, 2)` with no trailing
//!   newline, through a `<file>.<pid>.<12 hex>.tmp` and a rename, then
//!   `chmod 0600`; the top-level keys are always `profiles`,
//!   `activeProfileId`, `autoRotateOnRateLimit`.
//!
//! [`AccountsStore::build_env_for_profile`] is the env a profile's CLI runs
//! with: the parent env minus every auth variable, the profile's credential,
//! and `CLAUDE_CONFIG_DIR` pointed at a per-profile mirror of `~/.claude`
//! whose `.credentials.json` holds the profile's OAuth token (the only way
//! the CLI's macOS keychain lookup is bypassed). Values are what the spawned
//! CLI sees: Node coerces each env value with `String(v)` and drops
//! `undefined` ones.
//!
//! Secrets: [`AccountProfile`]'s `Debug` never prints `secret` or a Bedrock
//! `sessionToken`, and nothing here logs.
//!
//! Deliberate difference: a profile id whose config dir isn't strictly inside
//! `<dir>/profiles/` (only a hand-edited file has one: `""`, `.`, `..`,
//! `../x`) is never provisioned (an error) and its delete leaves the disk
//! alone. TS provisions and `rm -rf`s whatever the id points at, up to the
//! whole store directory.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::node_fs::{self, FsError};
use crate::node_path;

/// Env var that moves the store (TS `accountsDir()`'s override).
pub const ACCOUNTS_DIR_ENV: &str = "CLAUDIUS_ACCOUNTS_DIR";

/// `TOKEN_EXPIRY_WARNING_WINDOW_MS`: warn 3 days ahead of an expiry.
pub const TOKEN_EXPIRY_WARNING_WINDOW_MS: f64 = 3.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// The variables every profile's env starts without.
pub const SCRUBBED_ENV: [&str; 10] = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_ORGANIZATION_UUID",
];

/// `BEDROCK_CREDENTIAL_VARS`: what a Bedrock profile that brings its own
/// credentials (any auth but `ambient`) clears.
pub const BEDROCK_CREDENTIAL_VARS: [&str; 5] = [
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
];

pub const BEDROCK_AUTH_METHODS: [&str; 4] =
    ["aws-profile", "access-keys", "bearer-token", "ambient"];
pub const BEDROCK_REGION_PREFIXES: [&str; 6] = ["us", "eu", "apac", "jp", "au", "global"];

/// What a store call throws: the JS error's `message`. The TS routes answer
/// it as `{error: message}` (POST / PATCH) or let it become an empty 500.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AccountsError(pub String);

impl From<FsError> for AccountsError {
    fn from(e: FsError) -> Self {
        AccountsError(e.message)
    }
}

fn fail<T>(message: impl Into<String>) -> Result<T, AccountsError> {
    Err(AccountsError(message.into()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountKind {
    OauthToken,
    ApiKey,
    Bedrock,
}

impl AccountKind {
    /// `isAccountKind`.
    pub fn from_value(v: &Value) -> Option<AccountKind> {
        match v.as_str()? {
            "oauth-token" => Some(AccountKind::OauthToken),
            "api-key" => Some(AccountKind::ApiKey),
            "bedrock" => Some(AccountKind::Bedrock),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AccountKind::OauthToken => "oauth-token",
            AccountKind::ApiKey => "api-key",
            AccountKind::Bedrock => "bedrock",
        }
    }
}

/// A stored profile that passed the TS shape check (`isProfileShape`): an
/// object with string `id`, `label`, `secret` and `createdAt`, a known
/// `kind`, and for `bedrock` a `bedrock` object with a string `auth`. Every
/// other key is kept as stored, in order, and written back.
#[derive(Clone, PartialEq)]
pub struct AccountProfile {
    raw: Map<String, Value>,
}

impl std::fmt::Debug for AccountProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountProfile")
            .field("id", &self.id())
            .field("label", &self.label())
            .field("kind", &self.kind())
            .field("secret", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl AccountProfile {
    /// `isProfileShape`.
    pub fn from_value(v: &Value) -> Option<AccountProfile> {
        let raw = v.as_object()?;
        let is_str = |k: &str| raw.get(k).is_some_and(Value::is_string);
        if !(is_str("id") && is_str("label") && is_str("secret") && is_str("createdAt")) {
            return None;
        }
        let kind = AccountKind::from_value(raw.get("kind")?)?;
        if kind == AccountKind::Bedrock
            && !raw
                .get("bedrock")
                .and_then(Value::as_object)
                .is_some_and(|b| b.get("auth").is_some_and(Value::is_string))
        {
            return None;
        }
        Some(AccountProfile { raw: raw.clone() })
    }

    fn str_field(&self, key: &str) -> &str {
        self.raw
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    pub fn id(&self) -> &str {
        self.str_field("id")
    }

    pub fn label(&self) -> &str {
        self.str_field("label")
    }

    pub fn kind(&self) -> AccountKind {
        self.raw
            .get("kind")
            .and_then(AccountKind::from_value)
            .unwrap_or(AccountKind::ApiKey)
    }

    /// The raw credential. Never send it to a client ([`to_public`](Self::to_public)).
    pub fn secret(&self) -> &str {
        self.str_field("secret")
    }

    pub fn created_at(&self) -> &str {
        self.str_field("createdAt")
    }

    /// Any stored key as it is (`accountUuid`, `emailAddress`, …); `None` is
    /// JS `undefined`, `Some(Null)` a stored `null`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.raw.get(key)
    }

    /// The Bedrock settings (`profile.bedrock`) when they're an object.
    pub fn bedrock(&self) -> Option<&Map<String, Value>> {
        self.raw.get("bedrock").and_then(Value::as_object)
    }

    /// `expiresAt` when it's a number: the session's
    /// `activeProfileExpiresAt`, which only a number can trigger
    /// ([`should_warn_token_expiring`]).
    pub fn expires_at(&self) -> Option<f64> {
        self.raw.get("expiresAt").and_then(Value::as_f64)
    }

    /// The stored object, every key in order.
    pub fn to_value(&self) -> Value {
        Value::Object(self.raw.clone())
    }

    /// `toPublic`: `{id, label, kind, secretPreview, createdAt}`, where the
    /// preview is the secret's last 4 UTF-16 units (`…abcd`, `•` per unit
    /// up to 4, `""` for none). A Bedrock profile previews
    /// [`describe_bedrock_config`] instead and adds its `bedrock` settings
    /// without `sessionToken`.
    pub fn to_public(&self) -> Result<Value, AccountsError> {
        let mut out = Map::new();
        out.insert("id".into(), self.raw["id"].clone());
        out.insert("label".into(), self.raw["label"].clone());
        out.insert("kind".into(), self.raw["kind"].clone());
        match (self.kind(), self.bedrock()) {
            (AccountKind::Bedrock, Some(b)) => {
                let bedrock: Map<String, Value> = b
                    .iter()
                    .filter(|(k, _)| *k != "sessionToken")
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                out.insert(
                    "secretPreview".into(),
                    describe_bedrock_config(&bedrock)?.into(),
                );
                out.insert("createdAt".into(), self.raw["createdAt"].clone());
                out.insert("bedrock".into(), Value::Object(bedrock));
            }
            _ => {
                out.insert("secretPreview".into(), preview_secret(self.secret()).into());
                out.insert("createdAt".into(), self.raw["createdAt"].clone());
            }
        }
        Ok(Value::Object(out))
    }
}

/// The last `n` UTF-16 units of `s` (`s.slice(-n)`). A cut through a
/// surrogate pair leaves JS a lone surrogate; here it's U+FFFD.
fn utf16_last(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let tail = &units[units.len().saturating_sub(n)..];
    char::decode_utf16(tail.iter().copied())
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// `previewSecret`.
fn preview_secret(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let len = s.encode_utf16().count();
    if len <= 4 {
        return "\u{2022}".repeat(len);
    }
    format!("\u{2026}{}", utf16_last(s, 4))
}

/// `describeBedrockConfig`: the secret-free one-liner for the accounts list,
/// e.g. `us-east-1 · profile work-sso`. Values print as JS `String(v)`; a
/// truthy `accessKeyId` that is neither a string nor an array throws, as
/// `.slice` does in TS.
pub fn describe_bedrock_config(cfg: &Map<String, Value>) -> Result<String, AccountsError> {
    let mut parts: Vec<String> = Vec::new();
    let truthy = |k: &str| cfg.get(k).filter(|v| js::truthy(v));
    if let Some(region) = truthy("region") {
        parts.push(js::to_string(Some(region)));
    }
    match cfg.get("auth").and_then(Value::as_str) {
        Some("aws-profile") => {
            let name = match cfg.get("awsProfile") {
                None | Some(Value::Null) => "?".to_owned(),
                v => js::to_string(v),
            };
            parts.push(format!("profile {name}"));
        }
        Some("access-keys") => parts.push(match truthy("accessKeyId") {
            None => "access keys".to_owned(),
            Some(Value::String(s)) => format!("key {}", utf16_last(s, 4)),
            Some(Value::Array(items)) => {
                let tail = Value::Array(items[items.len().saturating_sub(4)..].to_vec());
                format!("key {}", js::to_string(Some(&tail)))
            }
            Some(_) => return fail("cfg.accessKeyId.slice is not a function"),
        }),
        Some("bearer-token") => parts.push("API key".to_owned()),
        Some("ambient") => parts.push("ambient AWS env".to_owned()),
        _ => {}
    }
    if let Some(model) = truthy("model") {
        parts.push(js::to_string(Some(model)));
    }
    Ok(parts.join(" \u{b7} "))
}

static AWS_REGION: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z]{2}(-[a-z]+)+-[0-9]+$").expect("valid pattern"));

/// `isValidAwsRegion`: `us-east-1`, `us-gov-west-1`, … (ASCII only).
pub fn is_valid_aws_region(s: &str) -> bool {
    AWS_REGION.is_match(s)
}

/// `new URL(s)` parses and its protocol is `http:` or `https:`.
fn is_http_url(s: &str) -> bool {
    url::Url::parse(s).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

/// `normalizeBedrockConfig(input, secret)`: the trimmed Bedrock settings of
/// an Add request (`input` is the raw `bedrock` body value; `None` is
/// `undefined`), in the TS key order (`auth`, `region`, `awsProfile` or
/// `accessKeyId` + `sessionToken`, `model`, `regionPrefix`, `baseUrl`), or
/// the Add form's error message.
pub fn normalize_bedrock_config(
    input: Option<&Value>,
    secret: &str,
) -> Result<Map<String, Value>, AccountsError> {
    let input = input.filter(|v| js::truthy(v));
    let prop = |k: &str| js::prop(input, k);
    let Some(auth) = prop("auth")
        .and_then(Value::as_str)
        .filter(|a| BEDROCK_AUTH_METHODS.contains(a))
    else {
        return fail(
            "bedrock.auth must be one of: aws-profile, access-keys, bearer-token, ambient",
        );
    };
    let trim = |k: &str| match prop(k) {
        Some(Value::String(s)) => Some(js::trim(s))
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
        _ => None,
    };
    let region = trim("region");
    if let Some(r) = region.as_deref().filter(|r| !is_valid_aws_region(r)) {
        return fail(format!(
            "\"{r}\" doesn't look like an AWS region (e.g. us-east-1)"
        ));
    }
    let mut cfg = Map::new();
    cfg.insert("auth".into(), auth.into());
    if let Some(r) = region {
        cfg.insert("region".into(), r.into());
    }
    match auth {
        "aws-profile" => {
            let Some(name) = trim("awsProfile") else {
                return fail("AWS profile name required");
            };
            cfg.insert("awsProfile".into(), name.into());
        }
        "access-keys" => {
            let Some(key) = trim("accessKeyId") else {
                return fail("AWS access key id required");
            };
            if secret.is_empty() {
                return fail("AWS secret access key required");
            }
            cfg.insert("accessKeyId".into(), key.into());
            if let Some(token) = trim("sessionToken") {
                cfg.insert("sessionToken".into(), token.into());
            }
        }
        "bearer-token" if secret.is_empty() => return fail("Bedrock API key required"),
        _ => {}
    }
    if let Some(model) = trim("model") {
        cfg.insert("model".into(), model.into());
    }
    match prop("regionPrefix") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(v) => {
            if !v
                .as_str()
                .is_some_and(|p| BEDROCK_REGION_PREFIXES.contains(&p))
            {
                return fail("regionPrefix must be one of: us, eu, apac, jp, au, global");
            }
            cfg.insert("regionPrefix".into(), v.clone());
        }
    }
    if let Some(url) = trim("baseUrl") {
        if !is_http_url(&url) {
            return fail("baseUrl must be an http(s) URL");
        }
        cfg.insert("baseUrl".into(), url.into());
    }
    Ok(cfg)
}

/// `shouldWarnTokenExpiring(expiresAt, now)`: a finite expiry less than 3
/// days ahead (and not past). `None` is any non-number.
pub fn should_warn_token_expiring(expires_at: Option<f64>, now: f64) -> bool {
    let Some(e) = expires_at.filter(|e| e.is_finite()) else {
        return false;
    };
    let remaining = e - now;
    remaining > 0.0 && remaining <= TOKEN_EXPIRY_WARNING_WINDOW_MS
}

/// `AccountsState`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountsState {
    pub profiles: Vec<AccountProfile>,
    /// Always the id of one of `profiles` when read from disk (possibly `""`,
    /// which [`AccountsStore::get_active_profile`] treats as none).
    pub active_profile_id: Option<String>,
    pub auto_rotate_on_rate_limit: bool,
}

impl AccountsState {
    /// The state as the TS holds it (and writes it), secrets included.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "profiles".into(),
            Value::Array(self.profiles.iter().map(AccountProfile::to_value).collect()),
        );
        out.insert(
            "activeProfileId".into(),
            self.active_profile_id
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert(
            "autoRotateOnRateLimit".into(),
            self.auto_rotate_on_rate_limit.into(),
        );
        Value::Object(out)
    }

    /// `readAccountsPublic`'s shape: every profile through
    /// [`AccountProfile::to_public`].
    pub fn to_public(&self) -> Result<Value, AccountsError> {
        let mut out = Map::new();
        let profiles = self
            .profiles
            .iter()
            .map(AccountProfile::to_public)
            .collect::<Result<Vec<_>, _>>()?;
        out.insert("profiles".into(), Value::Array(profiles));
        out.insert(
            "activeProfileId".into(),
            self.active_profile_id
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert(
            "autoRotateOnRateLimit".into(),
            self.auto_rotate_on_rate_limit.into(),
        );
        Ok(Value::Object(out))
    }

    fn parse(parsed: &Value) -> Result<AccountsState, AccountsError> {
        if parsed.is_null() {
            return fail("Cannot read properties of null (reading 'profiles')");
        }
        let get = |k: &str| js::prop(Some(parsed), k);
        let profiles: Vec<AccountProfile> = match get("profiles") {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(AccountProfile::from_value)
                .collect(),
            _ => Vec::new(),
        };
        let active_profile_id = get("activeProfileId")
            .and_then(Value::as_str)
            .filter(|id| profiles.iter().any(|p| p.id() == *id))
            .map(str::to_owned);
        Ok(AccountsState {
            profiles,
            active_profile_id,
            auto_rotate_on_rate_limit: get("autoRotateOnRateLimit") == Some(&Value::Bool(true)),
        })
    }
}

/// `addAccount`'s input. Fields are the raw values the TS reads (`None` is
/// `undefined`), so a route can hand its JSON body through as it is.
#[derive(Clone, Default)]
pub struct NewAccount {
    pub label: Option<Value>,
    pub kind: Option<Value>,
    /// Required for `oauth-token` / `api-key`; per auth method for `bedrock`.
    pub secret: Option<Value>,
    /// Only read for `kind: "bedrock"` ([`normalize_bedrock_config`]).
    pub bedrock: Option<Value>,
    /// Stored when truthy.
    pub account_uuid: Option<Value>,
    pub email_address: Option<Value>,
    pub organization_uuid: Option<Value>,
    pub subscription_type: Option<Value>,
    /// Stored when the TS value is a number (`typeof === "number"`); a
    /// non-finite one is written as `null`, as `JSON.stringify` writes it.
    pub expires_at: Option<f64>,
}

impl std::fmt::Debug for NewAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewAccount")
            .field("label", &self.label)
            .field("kind", &self.kind)
            .field("secret", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// `updateAccountMetadata`'s patch: raw values, each stored when truthy and
/// not `===` the stored one.
#[derive(Clone, Debug, Default)]
pub struct AccountMetadata {
    pub account_uuid: Option<Value>,
    pub email_address: Option<Value>,
    pub organization_uuid: Option<Value>,
    pub subscription_type: Option<Value>,
}

/// `rotateToNextProfile`'s result: both profiles' public views.
#[derive(Clone, Debug, PartialEq)]
pub struct Rotation {
    pub from: Value,
    pub to: Value,
}

/// JS `===` between two JSON values from separate parses: primitives by
/// value (numbers numerically), objects and arrays never.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `new Date(ms).toISOString()`.
fn iso_string(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `accountsDir()` for an override value and a home dir: a non-empty
/// `CLAUDIUS_ACCOUNTS_DIR` as it is, else `join(home, ".claude", ".claudius")`.
pub fn accounts_dir_for(override_dir: Option<&str>, home: &str) -> String {
    match override_dir {
        Some(d) if !d.is_empty() => d.to_owned(),
        _ => node_path::join(&[home, ".claude", ".claudius"]),
    }
}

fn home_string() -> String {
    crate::paths::home_dir().to_string_lossy().into_owned()
}

/// `accountsDir()`, read from the environment now.
pub fn accounts_dir() -> String {
    let over = std::env::var_os(ACCOUNTS_DIR_ENV).map(|v| v.to_string_lossy().into_owned());
    accounts_dir_for(over.as_deref(), &home_string())
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Random = Arc<dyn Fn(&mut [u8]) + Send + Sync>;

/// The store at one directory. Every write goes through one process-wide
/// lock, so concurrent writers in this process don't lose each other's
/// changes (TS can: each call reads, then writes).
#[derive(Clone)]
pub struct AccountsStore {
    dir: String,
    home: String,
    now: Clock,
    random: Random,
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_lock() -> MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn os_random(buf: &mut [u8]) {
    if getrandom::fill(buf).is_err() {
        // Never seen in practice; ids and temp names stay unique enough.
        for chunk in buf.chunks_mut(16) {
            let n = chunk.len();
            chunk.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..n]);
        }
    }
}

impl AccountsStore {
    /// The store in `dir` (TS `accountsDir()`), mirroring `home/.claude`
    /// into profile config dirs. System clock and randomness.
    pub fn new(dir: impl Into<String>, home: impl Into<String>) -> AccountsStore {
        AccountsStore {
            dir: dir.into(),
            home: home.into(),
            now: Arc::new(crate::now_ms),
            random: Arc::new(os_random),
        }
    }

    /// The store the TS app uses right now: `$CLAUDIUS_ACCOUNTS_DIR`, else
    /// `~/.claude/.claudius` (`paths::home_dir`).
    pub fn from_env() -> AccountsStore {
        AccountsStore::new(accounts_dir(), home_string())
    }

    /// Replace the clock behind `createdAt` (ms since the epoch).
    pub fn with_clock(mut self, now: Clock) -> AccountsStore {
        self.now = now;
        self
    }

    /// Replace the bytes behind profile ids and temp names.
    pub fn with_random(mut self, random: Random) -> AccountsStore {
        self.random = random;
        self
    }

    pub fn dir(&self) -> &str {
        &self.dir
    }

    pub fn accounts_path(&self) -> String {
        node_path::join(&[&self.dir, "accounts.json"])
    }

    fn profiles_root(&self) -> String {
        node_path::join(&[&self.dir, "profiles"])
    }

    /// `profileConfigDir(id)`: the `CLAUDE_CONFIG_DIR` a profile runs with.
    pub fn profile_config_dir(&self, id: &str) -> String {
        node_path::join(&[&self.dir, "profiles", id])
    }

    /// The profile's config dir when it lies strictly inside
    /// `<dir>/profiles/` (see the module docs).
    fn contained_profile_dir(&self, id: &str) -> Option<String> {
        let dir = self.profile_config_dir(id);
        let root = self.profiles_root();
        let inside = dir
            .strip_prefix(&root)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(|rest| !rest.is_empty());
        inside.then_some(dir)
    }

    fn hex(&self, n: usize) -> String {
        let mut buf = vec![0u8; n];
        (self.random)(&mut buf);
        buf.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn tmp_name(&self, path: &str) -> String {
        format!("{path}.{}.{}.tmp", std::process::id(), self.hex(6))
    }

    /// `readAccountsRaw`: missing file → empty state; any other read or
    /// parse failure is an error.
    pub fn read_raw(&self) -> Result<AccountsState, AccountsError> {
        let text = match node_fs::read_to_string(&self.accounts_path()) {
            Ok(t) => t,
            Err(e) if e.is_not_found() => return Ok(AccountsState::default()),
            Err(e) => return Err(e.into()),
        };
        let parsed = js::json_parse(&text).map_err(AccountsError)?;
        AccountsState::parse(&parsed)
    }

    /// `readAccountsPublic`.
    pub fn read_public(&self) -> Result<Value, AccountsError> {
        self.read_raw()?.to_public()
    }

    /// `writeAccounts`.
    fn write(&self, next: &AccountsState) -> Result<(), AccountsError> {
        node_fs::mkdir_recursive(&self.dir, 0o777)?;
        let path = self.accounts_path();
        let tmp = self.tmp_name(&path);
        node_fs::write_file(&tmp, &js::stringify_pretty(&next.to_value()), 0o600)?;
        if let Err(e) = node_fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        let _ = node_fs::chmod(&path, 0o600);
        Ok(())
    }

    /// `addAccount`: label and secret trimmed (a non-string one throws like
    /// `.trim()`), the label required, the kind checked, Bedrock settings
    /// normalized (else the secret required); then the profile is appended
    /// with a fresh `acc_<16 hex>` id and becomes active if none is.
    pub fn add_account(
        &self,
        input: &NewAccount,
    ) -> Result<(AccountsState, AccountProfile), AccountsError> {
        let trimmed = |v: Option<&Value>, name: &str| match v {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(s)) => Ok(js::trim(s).to_owned()),
            Some(_) => fail(format!("(input.{name} ?? \"\").trim is not a function")),
        };
        let label = trimmed(input.label.as_ref(), "label")?;
        let secret = trimmed(input.secret.as_ref(), "secret")?;
        if label.is_empty() {
            return fail("label required");
        }
        let Some(kind) = input.kind.as_ref().and_then(AccountKind::from_value) else {
            return fail("kind must be oauth-token, api-key or bedrock");
        };
        let bedrock = match kind {
            AccountKind::Bedrock => {
                Some(normalize_bedrock_config(input.bedrock.as_ref(), &secret)?)
            }
            _ if secret.is_empty() => return fail("secret required"),
            _ => None,
        };
        let _guard = write_lock();
        let cur = self.read_raw()?;
        let mut raw = Map::new();
        raw.insert("id".into(), format!("acc_{}", self.hex(8)).into());
        raw.insert("label".into(), label.into());
        raw.insert("kind".into(), kind.as_str().into());
        raw.insert("secret".into(), secret.into());
        raw.insert("createdAt".into(), iso_string((self.now)()).into());
        if let Some(b) = bedrock {
            raw.insert("bedrock".into(), Value::Object(b));
        }
        for (key, v) in [
            ("accountUuid", &input.account_uuid),
            ("emailAddress", &input.email_address),
            ("organizationUuid", &input.organization_uuid),
            ("subscriptionType", &input.subscription_type),
        ] {
            if let Some(v) = v.as_ref().filter(|v| js::truthy(v)) {
                raw.insert(key.into(), v.clone());
            }
        }
        if let Some(e) = input.expires_at {
            raw.insert("expiresAt".into(), crate::js_num(e));
        }
        let profile = AccountProfile { raw };
        let mut profiles = cur.profiles;
        profiles.push(profile.clone());
        let state = AccountsState {
            profiles,
            active_profile_id: cur
                .active_profile_id
                .or_else(|| Some(profile.id().to_owned())),
            auto_rotate_on_rate_limit: cur.auto_rotate_on_rate_limit,
        };
        self.write(&state)?;
        Ok((state, profile))
    }

    /// `setAutoRotate`.
    pub fn set_auto_rotate(&self, on: bool) -> Result<AccountsState, AccountsError> {
        let _guard = write_lock();
        let next = AccountsState {
            auto_rotate_on_rate_limit: on,
            ..self.read_raw()?
        };
        self.write(&next)?;
        Ok(next)
    }

    /// `updateAccountMetadata`: on every profile with this id, each truthy
    /// field that isn't `===` the stored value is set (in place, or appended
    /// in the order `accountUuid`, `emailAddress`, `organizationUuid`,
    /// `subscriptionType`); nothing is written when nothing changed.
    pub fn update_account_metadata(
        &self,
        id: &str,
        meta: &AccountMetadata,
    ) -> Result<(), AccountsError> {
        let _guard = write_lock();
        let mut cur = self.read_raw()?;
        let mut mutated = false;
        for p in cur.profiles.iter_mut().filter(|p| p.id() == id) {
            for (key, v) in [
                ("accountUuid", &meta.account_uuid),
                ("emailAddress", &meta.email_address),
                ("organizationUuid", &meta.organization_uuid),
                ("subscriptionType", &meta.subscription_type),
            ] {
                if let Some(v) = v.as_ref().filter(|v| js::truthy(v))
                    && !strict_eq(Some(v), p.raw.get(key))
                {
                    p.raw.insert(key.into(), v.clone());
                    mutated = true;
                }
            }
        }
        if mutated {
            self.write(&cur)?;
        }
        Ok(())
    }

    /// `rotateToNextProfile`: with two or more profiles, the one after the
    /// active one (wrapping) becomes active. `None` when there's no peer:
    /// fewer than two profiles, no active one (the first would rotate to
    /// itself), or the next one shares the active id. The write happens
    /// before the public views are built, so a profile [`AccountProfile::to_public`]
    /// refuses still rotates, then errors.
    pub fn rotate_to_next_profile(&self) -> Result<Option<Rotation>, AccountsError> {
        let _guard = write_lock();
        let cur = self.read_raw()?;
        let n = cur.profiles.len();
        if n < 2 {
            return Ok(None);
        }
        let idx = cur
            .profiles
            .iter()
            .position(|p| cur.active_profile_id.as_deref() == Some(p.id()));
        let from = cur.profiles[idx.unwrap_or(0)].clone();
        let to = cur.profiles[idx.map_or(0, |i| (i + 1) % n)].clone();
        if from.id() == to.id() {
            return Ok(None);
        }
        self.write(&AccountsState {
            active_profile_id: Some(to.id().to_owned()),
            ..cur
        })?;
        Ok(Some(Rotation {
            from: from.to_public()?,
            to: to.to_public()?,
        }))
    }

    /// `setActiveAccount`: "profile not found" for an id no profile has.
    pub fn set_active_account(&self, id: &str) -> Result<AccountsState, AccountsError> {
        let _guard = write_lock();
        let cur = self.read_raw()?;
        if !cur.profiles.iter().any(|p| p.id() == id) {
            return fail("profile not found");
        }
        let next = AccountsState {
            active_profile_id: Some(id.to_owned()),
            ..cur
        };
        self.write(&next)?;
        Ok(next)
    }

    /// `deleteAccount`: drops every profile with this id (an unknown id
    /// returns the state as read, writing nothing); a deleted active pointer
    /// moves to the first profile left. Then the profile's config dir goes,
    /// best-effort (only inside `<dir>/profiles/`).
    pub fn delete_account(&self, id: &str) -> Result<AccountsState, AccountsError> {
        let _guard = write_lock();
        let cur = self.read_raw()?;
        let profiles: Vec<AccountProfile> = cur
            .profiles
            .iter()
            .filter(|p| p.id() != id)
            .cloned()
            .collect();
        if profiles.len() == cur.profiles.len() {
            return Ok(cur);
        }
        let mut active_profile_id = cur.active_profile_id.clone();
        if active_profile_id.as_deref() == Some(id) {
            active_profile_id = profiles.first().map(|p| p.id().to_owned());
        }
        let state = AccountsState {
            profiles,
            active_profile_id,
            auto_rotate_on_rate_limit: cur.auto_rotate_on_rate_limit,
        };
        self.write(&state)?;
        if let Some(dir) = self.contained_profile_dir(id) {
            let _ = node_fs::rm_recursive_force(&dir);
        }
        Ok(state)
    }

    /// `getActiveProfile`: `None` when the pointer is unset or `""`.
    pub fn get_active_profile(&self) -> Result<Option<AccountProfile>, AccountsError> {
        let cur = self.read_raw()?;
        let Some(active) = cur.active_profile_id.as_deref().filter(|a| !a.is_empty()) else {
            return Ok(None);
        };
        Ok(cur.profiles.into_iter().find(|p| p.id() == active))
    }

    /// `getProfileById`: the first profile with this id.
    pub fn get_profile_by_id(&self, id: &str) -> Result<Option<AccountProfile>, AccountsError> {
        Ok(self.read_raw()?.profiles.into_iter().find(|p| p.id() == id))
    }

    /// `buildEnvForProfile` over this process's environment.
    pub fn build_env_for_profile(
        &self,
        profile: &AccountProfile,
    ) -> Result<HashMap<String, String>, AccountsError> {
        let base = std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        self.build_env_for_profile_from(profile, base)
    }

    /// `buildEnvForProfile` over `base` (TS `process.env`): [`SCRUBBED_ENV`]
    /// removed, then `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` or the
    /// Bedrock env ([`apply_bedrock_env`]), then `CLAUDE_CONFIG_DIR` at the
    /// provisioned profile dir, then the account triple
    /// (`CLAUDE_CODE_ACCOUNT_UUID`, `…_USER_EMAIL`, `…_ORGANIZATION_UUID`)
    /// when all three are truthy.
    pub fn build_env_for_profile_from(
        &self,
        profile: &AccountProfile,
        base: HashMap<String, String>,
    ) -> Result<HashMap<String, String>, AccountsError> {
        let mut env = base;
        for k in SCRUBBED_ENV {
            env.remove(k);
        }
        match profile.kind() {
            AccountKind::OauthToken => {
                env.insert("CLAUDE_CODE_OAUTH_TOKEN".into(), profile.secret().into());
            }
            AccountKind::ApiKey => {
                env.insert("ANTHROPIC_API_KEY".into(), profile.secret().into());
            }
            AccountKind::Bedrock => apply_bedrock_env(&mut env, profile)?,
        }
        let dir = self.provision_profile_config_dir(profile)?;
        env.insert("CLAUDE_CONFIG_DIR".into(), dir);
        let triple = ["accountUuid", "emailAddress", "organizationUuid"].map(|k| profile.get(k));
        if triple.iter().all(|v| v.is_some_and(js::truthy)) {
            for (var, v) in [
                "CLAUDE_CODE_ACCOUNT_UUID",
                "CLAUDE_CODE_USER_EMAIL",
                "CLAUDE_CODE_ORGANIZATION_UUID",
            ]
            .into_iter()
            .zip(triple)
            {
                env.insert(var.into(), js::to_string(v));
            }
        }
        Ok(env)
    }

    /// `provisionProfileConfigDir`: the profile dir (mode 0700), a symlink
    /// in it for every entry of `~/.claude` but `.credentials.json` (an
    /// existing link to the right place is kept, a wrong one replaced, a real
    /// file or directory left alone; every failure skipped), then
    /// `.credentials.json`: the OAuth token for `oauth-token` (via a temp
    /// file and a rename, mode 0600), removed for the other kinds.
    fn provision_profile_config_dir(
        &self,
        profile: &AccountProfile,
    ) -> Result<String, AccountsError> {
        let Some(dir) = self.contained_profile_dir(profile.id()) else {
            return fail("profile id escapes the profiles directory");
        };
        node_fs::mkdir_recursive(&dir, 0o700)?;
        let real = node_path::join(&[&self.home, ".claude"]);
        let names: Vec<String> = match std::fs::read_dir(&real) {
            Ok(rd) => rd
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => Vec::new(),
        };
        for name in names {
            if name == ".credentials.json" {
                continue;
            }
            let target = node_path::join(&[&real, &name]);
            let link = node_path::join(&[&dir, &name]);
            let missing = |e: &std::io::Error| e.kind() == std::io::ErrorKind::NotFound;
            match std::fs::read_link(&link) {
                Ok(existing) => {
                    if existing.as_os_str() == target.as_str() {
                        continue;
                    }
                    if let Err(e) = std::fs::remove_file(&link)
                        && !missing(&e)
                    {
                        continue;
                    }
                }
                Err(e) if !missing(&e) => continue,
                Err(_) => {}
            }
            let _ = node_fs::symlink(&target, &link);
        }
        let creds = node_path::join(&[&dir, ".credentials.json"]);
        if profile.kind() == AccountKind::OauthToken {
            let blob = serde_json::json!({"claudeAiOauth": {"accessToken": profile.secret()}});
            let tmp = self.tmp_name(&creds);
            node_fs::write_file(&tmp, &js::stringify_pretty(&blob), 0o600)?;
            if let Err(e) = node_fs::rename(&tmp, &creds) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.into());
            }
            let _ = node_fs::chmod(&creds, 0o600);
        } else {
            let _ = std::fs::remove_file(&creds);
        }
        Ok(dir)
    }
}

/// `env[key] = v` as the spawned CLI will see it: `String(v)`, and an
/// `undefined` value (`None`) leaves the variable out.
fn set_js(env: &mut HashMap<String, String>, key: &str, v: Option<&Value>) {
    match v {
        Some(v) => {
            env.insert(key.into(), js::to_string(Some(v)));
        }
        None => {
            env.remove(key);
        }
    }
}

/// `applyBedrockEnv`: `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_MANTLE`
/// removed, [`BEDROCK_CREDENTIAL_VARS`] cleared unless the auth is
/// `ambient`, then the auth's own variables, `AWS_REGION` (clearing
/// `AWS_DEFAULT_REGION`), and `ANTHROPIC_MODEL`,
/// `ANTHROPIC_BEDROCK_REGION_PREFIX`, `ANTHROPIC_BEDROCK_BASE_URL` set or
/// removed. Errors for a profile that isn't Bedrock.
pub fn apply_bedrock_env(
    env: &mut HashMap<String, String>,
    profile: &AccountProfile,
) -> Result<(), AccountsError> {
    let (AccountKind::Bedrock, Some(cfg)) = (profile.kind(), profile.bedrock()) else {
        return fail("applyBedrockEnv: not a bedrock profile");
    };
    let truthy = |k: &str| cfg.get(k).filter(|v| js::truthy(v));
    env.insert("CLAUDE_CODE_USE_BEDROCK".into(), "1".into());
    env.remove("CLAUDE_CODE_USE_MANTLE");
    let auth = cfg.get("auth").and_then(Value::as_str);
    if auth != Some("ambient") {
        for k in BEDROCK_CREDENTIAL_VARS {
            env.remove(k);
        }
    }
    match auth {
        Some("aws-profile") => set_js(env, "AWS_PROFILE", cfg.get("awsProfile")),
        Some("access-keys") => {
            set_js(env, "AWS_ACCESS_KEY_ID", cfg.get("accessKeyId"));
            env.insert("AWS_SECRET_ACCESS_KEY".into(), profile.secret().into());
            if let Some(token) = truthy("sessionToken") {
                set_js(env, "AWS_SESSION_TOKEN", Some(token));
            }
        }
        Some("bearer-token") => {
            env.insert("AWS_BEARER_TOKEN_BEDROCK".into(), profile.secret().into());
        }
        _ => {}
    }
    if let Some(region) = truthy("region") {
        set_js(env, "AWS_REGION", Some(region));
        env.remove("AWS_DEFAULT_REGION");
    }
    for (key, var) in [
        ("model", "ANTHROPIC_MODEL"),
        ("regionPrefix", "ANTHROPIC_BEDROCK_REGION_PREFIX"),
        ("baseUrl", "ANTHROPIC_BEDROCK_BASE_URL"),
    ] {
        match truthy(key) {
            Some(v) => set_js(env, var, Some(v)),
            None => {
                env.remove(var);
            }
        }
    }
    Ok(())
}
