//! CC 2.1.307's settings-only `NODE_EXTRA_CA_CERTS`: port of
//! `lib/server/extra-ca-certs.ts`.
//!
//! Node reads `NODE_EXTRA_CA_CERTS` from the real environment once, at
//! startup, into its default trust store. A value set only in the user
//! settings `env` block (`~/.claude/settings.json`, where Claude Code users
//! put it) never reaches that store, so the dictation socket
//! ([`crate::voice_ws`]) is handed the bundle itself:
//!
//! - the variable set (and not blank) in the real environment → `None`: the
//!   socket's default trust already has it (the process's roots,
//!   [`crate::extra_ca_env::process_roots`], read once at boot);
//! - else a non-blank string `env.NODE_EXTRA_CA_CERTS` in **user** settings
//!   (a project's settings must not add trust anchors for a socket that
//!   carries the user's OAuth token) → the file's text, when it reads and
//!   holds a `-----BEGIN CERTIFICATE-----`; the socket trusts it on top of
//!   the default roots (TS passes `[...rootCertificates, pem]` as `ca`);
//! - else, or on a settings file that doesn't load, a file that doesn't
//!   read (logged) or one without a certificate (logged) → `None`.
//!
//! The path is trimmed (JS `trim`), `~` and `~/…` expand to the home dir,
//! and a relative path resolves against the home dir, where the settings
//! file lives. Replayed against the TS by `tests/voice.rs` (server crate).

use claudius_agent::js;

use crate::settings::{self, Scope};
use crate::{log, node_err, node_path, paths};

/// `EXTRA_CA_ENV`.
pub const EXTRA_CA_ENV: &str = "NODE_EXTRA_CA_CERTS";

const PEM_MARKER: &str = "-----BEGIN CERTIFICATE-----";

/// `expandCaPath(raw, home)`.
pub fn expand_ca_path(raw: &str, home: &str) -> String {
    let t = js::trim(raw);
    if t == "~" {
        return home.to_owned();
    }
    if let Some(rest) = t.strip_prefix("~/") {
        return node_path::resolve(&[home, rest]);
    }
    if node_path::is_absolute(t) {
        node_path::resolve(&[t])
    } else {
        node_path::resolve(&[home, t])
    }
}

/// The real environment's `NODE_EXTRA_CA_CERTS`, as `process.env` holds it.
pub fn env_value() -> Option<String> {
    env_os_value().map(|v| v.to_string_lossy().into_owned())
}

/// The same, as the bytes Node's C++ side opens
/// ([`crate::extra_ca_env`]).
pub fn env_os_value() -> Option<std::ffi::OsString> {
    std::env::var_os(EXTRA_CA_ENV)
}

/// `Boolean(process.env.NODE_EXTRA_CA_CERTS)`: set and not empty (a blank
/// value counts here, though [`resolve_extra_ca_certs`] skips it).
pub fn env_set() -> bool {
    env_value().is_some_and(|v| !v.is_empty())
}

/// `resolveExtraCaCerts()`: the user-settings bundle's PEM text for the
/// dictation socket to trust besides its default roots, or `None`.
pub fn resolve_extra_ca_certs() -> Option<String> {
    let home = paths::home_dir().to_string_lossy().into_owned();
    resolve_with(env_value().as_deref(), &home, &mut |w| {
        tracing::warn!(target: log::API, "{w}");
    })
}

/// [`resolve_extra_ca_certs`] for a given `process.env` value and home dir,
/// handing the warnings TS logs to `warn`. The user settings are read where
/// `readSettings("user", …)` reads them ([`paths::claude_home`]).
pub fn resolve_with(
    process_env: Option<&str>,
    home: &str,
    warn: &mut dyn FnMut(String),
) -> Option<String> {
    if process_env.is_some_and(|v| !js::trim(v).is_empty()) {
        return None;
    }
    // `s.env && typeof s.env === "object" ? s.env : undefined`, then
    // `settingsEnv?.[EXTRA_CA_ENV]`; a settings file that throws (doesn't
    // parse, `null`) is default trust.
    let settings = settings::read_settings_value(Scope::User, home).ok()?;
    let raw = settings
        .as_object()?
        .get("env")?
        .as_object()?
        .get(EXTRA_CA_ENV)?;
    let raw = raw.as_str().filter(|r| !js::trim(r).is_empty())?;
    let path = expand_ca_path(raw, home);
    let pem = match node_err::fs::read_file(std::path::Path::new(&path)) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => {
            warn(format!(
                "[extra-ca-certs] {EXTRA_CA_ENV} from user settings could not be read ({path}): {}",
                e.message
            ));
            return None;
        }
    };
    if !pem.contains(PEM_MARKER) {
        warn(format!(
            "[extra-ca-certs] {path} has no PEM certificates — ignoring"
        ));
        return None;
    }
    Some(pem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_like_the_ts() {
        let h = "/home/u";
        assert_eq!(expand_ca_path("  ~  ", h), "/home/u");
        assert_eq!(expand_ca_path("~/certs/../ca.pem", h), "/home/u/ca.pem");
        assert_eq!(expand_ca_path("ca.pem", h), "/home/u/ca.pem");
        assert_eq!(expand_ca_path("/etc//ssl/./ca.pem", h), "/etc/ssl/ca.pem");
        assert_eq!(expand_ca_path("~user/ca.pem", h), "/home/u/~user/ca.pem");
    }

    #[test]
    fn a_set_env_wins() {
        let mut warned = Vec::new();
        assert_eq!(
            resolve_with(Some(" /x.pem "), "/nonexistent", &mut |w| warned.push(w)),
            None
        );
        assert!(warned.is_empty());
    }
}
