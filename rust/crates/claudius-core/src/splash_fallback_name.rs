//! Port of `lib/server/splash-fallback-name.ts`: the name in the splash
//! greeting ("Good evening, <name>") when the workspace has no override
//! ([`crate::splash_examples::get_splash_display_name`]).
//!
//! - Two or more accounts: the active profile's label (with no active
//!   profile, nothing).
//! - Otherwise the `displayName` of `~/.claude.json`'s `oauthAccount` when it
//!   is a non-empty string (a blank one still wins, and gives nothing), else
//!   the single account's label, else nothing.
//!
//! Only the first word is used, split on JS whitespace after a JS `trim`.
//! Every read is best-effort: an unreadable or malformed `accounts.json`
//! counts as no accounts, a bad `~/.claude.json` as no name.

use claudius_agent::js;

use crate::accounts::AccountsStore;
use crate::claude_global_config::{self, ClaudeGlobalConfig};

/// `resolveSplashFallbackName()` on the stores the app uses
/// ([`AccountsStore::from_env`], [`claude_global_config::global`]).
pub fn resolve_splash_fallback_name() -> Option<String> {
    resolve_splash_fallback_name_with(&AccountsStore::from_env(), claude_global_config::global())
}

/// `resolveSplashFallbackName()` on the given stores.
pub fn resolve_splash_fallback_name_with(
    accounts: &AccountsStore,
    global: &ClaudeGlobalConfig,
) -> Option<String> {
    let accounts = accounts.read_raw().ok();
    if let Some(state) = &accounts
        && state.profiles.len() >= 2
    {
        let active = state
            .profiles
            .iter()
            .find(|p| Some(p.id()) == state.active_profile_id.as_deref());
        return first_word(active.map(|p| p.label()));
    }
    let display_name = global
        .read_oauth_account(false)
        .and_then(|acct| acct.get("displayName")?.as_str().map(str::to_owned));
    if let Some(name) = display_name.filter(|n| !n.is_empty()) {
        return first_word(Some(&name));
    }
    match &accounts {
        Some(state) if state.profiles.len() == 1 => first_word(Some(state.profiles[0].label())),
        _ => None,
    }
}

/// `firstWord(s)`: `s.trim().split(/\s+/)[0]`, `None` for a missing or blank `s`.
fn first_word(s: Option<&str>) -> Option<String> {
    let trimmed = js::trim(s?);
    let word = trimmed.split(js::is_whitespace).next()?;
    (!word.is_empty()).then(|| word.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_word_splits_on_js_whitespace() {
        assert_eq!(first_word(None), None);
        assert_eq!(first_word(Some("")), None);
        assert_eq!(first_word(Some(" \t\u{3000} ")), None);
        assert_eq!(first_word(Some("  Ana  Maria ")).as_deref(), Some("Ana"));
        assert_eq!(first_word(Some("Jo\u{2028}Smith")).as_deref(), Some("Jo"));
        assert_eq!(
            first_word(Some("Jo\u{85}Smith")).as_deref(),
            Some("Jo\u{85}Smith")
        );
        assert_eq!(first_word(Some("\u{feff}Jo Smith")).as_deref(), Some("Jo"));
    }
}
