//! Account pinning (S30): which account profile a session runs under, and
//! the escape hatches. Ports session.ts `resolveAccountProfile`, `start()`'s
//! account block (with accounts-store.ts `buildEnvForProfile`, G02a),
//! `moveToActiveAccount`, `noteAccountAutoRotateObservation` with
//! `isRateLimitHitSdkMessage`, and lib/shared/rate-limit-prefixes.ts
//! `matchesUsageLimitPrefix`.
//!
//! A session is pinned to the profile it first spawned under: the id is
//! kept in its state bag (`sessions.state.accountProfileId`), and every
//! later start of the same id (a reaped tab resumed, a restart in place)
//! prefers it over the active profile, so a resumed conversation keeps the
//! identity and billing it started on. A pin whose profile was deleted falls
//! back to the active profile and is rewritten. `moveToActiveAccount`
//! (`POST /api/sessions/:id/account`) re-pins to the active profile; the
//! route then rebuilds the session so the new credential takes effect.
//!
//! The pin itself and the drift from the active profile live in
//! [`crate::account_drift::AccountPin`] (G02c); this module decides them.

use std::collections::HashMap;

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::account_drift::{AccountPin, AccountRef};
use crate::accounts::{AccountProfile, AccountsError, AccountsStore};
use crate::sessions_db;

/// The state-bag key of the pin.
pub const PIN_KEY: &str = "accountProfileId";

/// `getSessionState(cwd, id).accountProfileId` when it is a non-empty
/// string; anything else reads as never pinned.
pub fn persisted_pin(cwd: &str, id: &str) -> Option<String> {
    match sessions_db::get_session_state(cwd, id).get(PIN_KEY) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `mergeSessionState(cwd, id, { accountProfileId })`.
fn write_pin(cwd: &str, id: &str, profile_id: &str) -> anyhow::Result<()> {
    let mut patch = Map::new();
    patch.insert(PIN_KEY.into(), Value::String(profile_id.to_owned()));
    sessions_db::merge_session_state(cwd, id, patch)
}

/// What `resolveAccountProfile()` decides: the profile, and the
/// `accountProfileLabel` / `accountDriftFromActive` it records.
#[derive(Clone, Debug, Default)]
pub struct Resolved {
    pub profile: Option<AccountProfile>,
    pub label: Option<String>,
    pub drift: Option<AccountRef>,
}

/// `resolveAccountProfile()`: the persisted pin when its profile still
/// exists (drifting from the active profile when that is another one), else
/// the active profile, which becomes the pin (a failed write leaves the
/// session unpinned). Fails only when the active profile can't be read (the
/// store is unreadable); a pin lookup that fails counts as a deleted
/// profile.
pub fn resolve_account_profile(
    store: &AccountsStore,
    cwd: &str,
    id: &str,
) -> Result<Resolved, AccountsError> {
    let active = store.get_active_profile()?;
    if let Some(pinned_id) = persisted_pin(cwd, id)
        && let Some(pinned) = store.get_profile_by_id(&pinned_id).ok().flatten()
    {
        let drift = active
            .as_ref()
            .filter(|a| a.id() != pinned.id())
            .map(AccountRef::of);
        return Ok(Resolved {
            label: Some(pinned.label().to_owned()),
            drift,
            profile: Some(pinned),
        });
    }
    if let Some(a) = &active {
        let _ = write_pin(cwd, id, a.id());
    }
    Ok(Resolved {
        label: active.as_ref().map(|a| a.label().to_owned()),
        drift: None,
        profile: active,
    })
}

/// What `start()` keeps of the account it spawns under.
#[derive(Clone, Debug, Default)]
pub struct StartAccount {
    /// `accountProfileId` / `accountProfileLabel` / `accountDriftFromActive`.
    pub pin: AccountPin,
    /// `activeProfileExpiresAt`: the resolved profile's numeric `expiresAt`.
    pub expires_at: Option<f64>,
    /// `envOverride`: the CLI's whole environment under the profile
    /// (`buildEnvForProfile`); `None` without a profile, when the CLI
    /// inherits the parent environment.
    pub env: Option<HashMap<String, String>>,
}

/// `start()`'s account block: [`resolve_account_profile`], where a store
/// that can't be read means no profile (the session starts on the ambient
/// environment), then the profile's environment over `base` (TS
/// `process.env`; `None` reads this process's). `buildEnvForProfile`'s
/// failure (the profile's config dir can't be provisioned) is the `Err`:
/// `start()` rejects with it.
pub fn start_account(
    store: &AccountsStore,
    cwd: &str,
    id: &str,
    base: Option<&HashMap<String, String>>,
) -> Result<StartAccount, AccountsError> {
    let Resolved {
        profile,
        label,
        drift,
    } = resolve_account_profile(store, cwd, id).unwrap_or_default();
    let env = match &profile {
        Some(p) => Some(match base {
            Some(base) => store.build_env_for_profile_from(p, base.clone())?,
            None => store.build_env_for_profile(p)?,
        }),
        None => None,
    };
    Ok(StartAccount {
        pin: AccountPin {
            id: profile.as_ref().map(|p| p.id().to_owned()),
            label,
            drift_from_active: drift,
        },
        expires_at: profile.as_ref().and_then(AccountProfile::expires_at),
        env,
    })
}

/// `moveToActiveAccount()`: re-pin the session to the active profile and
/// return it, `None` when no profile is active. The live query keeps its
/// credential; the caller rebuilds the session. A store that can't be read
/// or a pin that can't be written is the `Err` (its message).
pub fn move_to_active_account(
    store: &AccountsStore,
    cwd: &str,
    id: &str,
) -> Result<Option<AccountProfile>, String> {
    let Some(active) = store.get_active_profile().map_err(|e| e.0)? else {
        return Ok(None);
    };
    write_pin(cwd, id, active.id()).map_err(|e| e.to_string())?;
    Ok(Some(active))
}

/// `noteAccountAutoRotateObservation` once a message was a rate-limit wall
/// ([`is_rate_limit_hit_sdk_message`]) on a session that hasn't rotated yet:
/// with auto-rotate on and two or more profiles, the active profile moves to
/// the next one, and the `account_auto_rotated` event to broadcast comes
/// back. `None` for no rotation, a failure included (a store that can't be
/// read or written, or a profile whose public view throws after the write).
pub fn auto_rotate(store: &AccountsStore) -> Option<Value> {
    let cur = store.read_raw().ok()?;
    if !cur.auto_rotate_on_rate_limit || cur.profiles.len() < 2 {
        return None;
    }
    let rotated = store.rotate_to_next_profile().ok()??;
    Some(json!({
        "type": "account_auto_rotated",
        "fromLabel": rotated.from.get("label"),
        "toLabel": rotated.to.get("label"),
    }))
}

/// lib/shared/rate-limit-prefixes.ts `USAGE_LIMIT_ERROR_PREFIXES` (the SDK's).
pub const USAGE_LIMIT_ERROR_PREFIXES: [&str; 12] = [
    "You've hit your",
    "You've reached your",
    "You're out of usage credits",
    "Your org is out of usage \u{b7} add funds to continue",
    "Your org is out of usage \u{b7} contact your admin",
    "Your seat type doesn't include usage credits",
    "Your seat type doesn't include usage",
    "Your usage allocation has been disabled by your admin",
    "Your group's usage limit is set to $0",
    "Fable 5 requires usage credits",
    "You're out of extra usage",
    "Your seat type doesn't include extra usage",
];

/// `matchesUsageLimitPrefix`: the JS-trimmed text, curly single quotes made
/// straight, lower-cased, starts with a lower-cased prefix.
pub fn matches_usage_limit_prefix(text: &str) -> bool {
    let normalized = js::trim(text)
        .replace(['\u{2018}', '\u{2019}'], "'")
        .to_lowercase();
    USAGE_LIMIT_ERROR_PREFIXES
        .iter()
        .any(|p| normalized.starts_with(&p.to_lowercase()))
}

/// `isRateLimitHitSdkMessage`: a main-thread (no truthy
/// `parent_tool_use_id`) assistant message whose content is a non-empty
/// array of text blocks only, the first one's `text` a usage-limit wall.
pub fn is_rate_limit_hit_sdk_message(message: &Value) -> bool {
    let Some(m) = message.as_object() else {
        return false;
    };
    if m.get("type").and_then(Value::as_str) != Some("assistant") {
        return false;
    }
    if m.get("parent_tool_use_id").is_some_and(js::truthy) {
        return false;
    }
    let Some(Value::Array(content)) = m.get("message").and_then(|mm| mm.get("content")) else {
        return false;
    };
    if content.is_empty() {
        return false;
    }
    let all_text = content.iter().all(|b| {
        b.as_object()
            .is_some_and(|b| b.get("type").and_then(Value::as_str) == Some("text"))
    });
    if !all_text {
        return false;
    }
    match content[0].get("text") {
        Some(Value::String(t)) => matches_usage_limit_prefix(t),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_match_like_the_client() {
        assert!(matches_usage_limit_prefix(
            "  You\u{2019}ve hit your session limit"
        ));
        assert!(matches_usage_limit_prefix(
            "YOUR GROUP'S USAGE LIMIT IS SET TO $0."
        ));
        assert!(!matches_usage_limit_prefix("Hit your limit"));
        let wall = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "You've reached your limit"}]}});
        assert!(is_rate_limit_hit_sdk_message(&wall));
        let mut sub = wall.clone();
        sub["parent_tool_use_id"] = json!("toolu_1");
        assert!(!is_rate_limit_hit_sdk_message(&sub));
        let mut mixed = wall;
        mixed["message"]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type": "tool_use"}));
        assert!(!is_rate_limit_hit_sdk_message(&mixed));
    }
}
