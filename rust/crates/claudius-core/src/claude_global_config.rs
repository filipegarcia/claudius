//! Port of `lib/server/claude-global-config.ts`: the `oauthAccount` block of
//! the Claude Code global config (`~/.claude.json`, which `claude /login`
//! writes), the fallback identity behind the account switcher's profile
//! lookup ([`crate::account_profile`]).

use std::sync::{Arc, Mutex, OnceLock};

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::accounts::Clock;
use crate::{node_fs, node_path};

/// Env var that moves the file (tests).
pub const CONFIG_PATH_ENV: &str = "CLAUDIUS_CLAUDE_CONFIG_PATH";

/// How long a read (or a failed one) is reused.
pub const CACHE_TTL_MS: i64 = 30_000;

/// The string fields kept, in output order (`hasExtraUsageEnabled`, a
/// boolean, comes last).
const STRING_FIELDS: [&str; 8] = [
    "accountUuid",
    "emailAddress",
    "displayName",
    "organizationUuid",
    "organizationName",
    "billingType",
    "accountCreatedAt",
    "subscriptionCreatedAt",
];

/// `configPath()` for an override value and a home dir.
pub fn config_path_for(override_path: Option<&str>, home: &str) -> String {
    match override_path {
        Some(p) if !p.is_empty() => p.to_owned(),
        _ => node_path::join(&[home, ".claude.json"]),
    }
}

type Cached = Option<(Option<Map<String, Value>>, i64)>;

/// One reader with its 30 s cache (TS: module state, see [`global`]).
pub struct ClaudeGlobalConfig {
    path: String,
    now: Clock,
    cached: Mutex<Cached>,
}

impl ClaudeGlobalConfig {
    pub fn new(path: impl Into<String>) -> ClaudeGlobalConfig {
        ClaudeGlobalConfig {
            path: path.into(),
            now: Arc::new(crate::now_ms),
            cached: Mutex::new(None),
        }
    }

    /// `$CLAUDIUS_CLAUDE_CONFIG_PATH`, else `~/.claude.json`.
    pub fn from_env() -> ClaudeGlobalConfig {
        let over = std::env::var_os(CONFIG_PATH_ENV).map(|v| v.to_string_lossy().into_owned());
        let home = crate::paths::home_dir().to_string_lossy().into_owned();
        ClaudeGlobalConfig::new(config_path_for(over.as_deref(), &home))
    }

    pub fn with_clock(mut self, now: Clock) -> ClaudeGlobalConfig {
        self.now = now;
        self
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// `readClaudeGlobalOauthAccount`: the whitelisted fields of
    /// `oauthAccount` (strings, and the boolean `hasExtraUsageEnabled`), or
    /// `None` when the file is missing, unreadable or malformed, or
    /// `oauthAccount` isn't an object (an array gives an empty one). Either
    /// answer is reused for [`CACHE_TTL_MS`] unless `skip_cache`.
    pub fn read_oauth_account(&self, skip_cache: bool) -> Option<Map<String, Value>> {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if !skip_cache
            && let Some((value, at)) = cached.as_ref()
            && (self.now)() - at < CACHE_TTL_MS
        {
            return value.clone();
        }
        let value = self.read_file();
        *cached = Some((value.clone(), (self.now)()));
        value
    }

    fn read_file(&self) -> Option<Map<String, Value>> {
        let text = node_fs::read_to_string(&self.path).ok()?;
        let parsed = js::json_parse(&text).ok()?;
        let acct =
            js::prop(Some(&parsed), "oauthAccount").filter(|a| a.is_object() || a.is_array())?;
        let mut out = Map::new();
        for key in STRING_FIELDS {
            if let Some(v @ Value::String(_)) = js::prop(Some(acct), key) {
                out.insert(key.into(), v.clone());
            }
        }
        if let Some(v @ Value::Bool(_)) = js::prop(Some(acct), "hasExtraUsageEnabled") {
            out.insert("hasExtraUsageEnabled".into(), v.clone());
        }
        Some(out)
    }

    /// `__resetClaudeGlobalConfigCache`.
    pub fn reset_cache(&self) {
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// The process-wide reader (TS module state), at the path the environment
/// names when it's first used.
pub fn global() -> &'static ClaudeGlobalConfig {
    global_shared()
}

/// [`global`] as the `Arc` a [`ProfileInfoResolver`](crate::account_profile::ProfileInfoResolver)
/// holds, so the profile lookup and the splash share one 30 s cache, as TS's
/// module does.
pub fn global_shared() -> &'static Arc<ClaudeGlobalConfig> {
    static G: OnceLock<Arc<ClaudeGlobalConfig>> = OnceLock::new();
    G.get_or_init(|| Arc::new(ClaudeGlobalConfig::from_env()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One reader per process: the splash and the profile lookup share its
    /// cache. (Building it reads nothing: the file is read on first use.)
    #[test]
    fn global_is_the_shared_reader() {
        assert!(Arc::ptr_eq(global_shared(), global_shared()));
        assert!(std::ptr::eq(global(), &**global_shared()));
    }
}
