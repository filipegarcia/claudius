//! The server half of the community chat (D24): `app/api/community/prefs`,
//! `admin/check` and `admin/[...path]` (the proxy routes are
//! `claudius_server::community`), and `lib/shared/community-client.ts`.
//!
//! * [`get_prefs`] / [`put_prefs`]: the two user-scope settings keys behind
//!   the consent modal and the nickname picker, `communityConsent` and
//!   `communityNick`, on whatever JSON value `~/.claude/settings.json` holds.
//!   TS assigns into that value, so a `null` file throws V8's `TypeError`s
//!   (after the write, for a PUT that changes nothing), a string, number or
//!   boolean file throws on an assignment, and an array keeps the keys only
//!   in memory: they are answered but `JSON.stringify` doesn't write them.
//! * `admin/check` is [`admin_configured`].
//! * [`catch_all_segments`], [`admin_target`], [`with_client_param`]: where
//!   the admin proxy forwards to.
//!
//! The settings: `NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL` is inlined into
//! the route bundles by next.config.ts's `env` as `process.env.X ??
//! "https://chat.claudius.network"`, so unset means that default and an
//! empty value turns the community off ([`chat_server_url`]).
//! `CLAUDIUS_CHAT_ADMIN_TOKEN` and `CLAUDIUS_ELECTRON` are read at each
//! request. [`claudius_version`] is `lib/shared/version.ts`'s
//! `CLAUDIUS_VERSION`: package.json's `version` (compiled in, as Next
//! bundles `@/package.json`) and next.config.ts's release counter, which
//! Next bakes in when it builds (at `next dev` start too):
//! `NEXT_PUBLIC_CLAUDIUS_RELEASE` when it isn't empty (the process's, else
//! the one `cargo build` saw, for a release build that set it), else the
//! highest `N` among the `v<version>.N` git tags in the working directory,
//! as `scripts/claudius-release.mjs` finds it, else 0; worked out once.
//! Next also reads `.env*` files into its environment; this reads only the
//! process's own.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::js_string;
use crate::settings::{self, Scope};

/// next.config.ts's default for [`CHAT_SERVER_URL_ENV`].
pub const DEFAULT_CHAT_SERVER_URL: &str = "https://chat.claudius.network";
pub const CHAT_SERVER_URL_ENV: &str = "NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL";
pub const ADMIN_TOKEN_ENV: &str = "CLAUDIUS_CHAT_ADMIN_TOKEN";
pub const RELEASE_ENV: &str = "NEXT_PUBLIC_CLAUDIUS_RELEASE";
pub const ELECTRON_ENV: &str = "CLAUDIUS_ELECTRON";

/// `process.env[name]` (a value that isn't UTF-8 is read lossily).
fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
}

/// The chat server URL the routes see (see the module docs).
pub fn chat_server_url() -> String {
    configured_chat_server_url(env(CHAT_SERVER_URL_ENV))
}

/// next.config.ts: `process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ??
/// "https://chat.claudius.network"`.
pub fn configured_chat_server_url(var: Option<String>) -> String {
    var.unwrap_or_else(|| DEFAULT_CHAT_SERVER_URL.to_owned())
}

/// `process.env.CLAUDIUS_CHAT_ADMIN_TOKEN ?? ""`.
pub fn admin_token() -> String {
    env(ADMIN_TOKEN_ENV).unwrap_or_default()
}

/// `admin/check`: `!!token && !!url`.
pub fn admin_configured(token: &str, url: &str) -> bool {
    !token.is_empty() && !url.is_empty()
}

/// The admin proxy's `serverUrl()`: `.replace(/\/+$/, "")`.
pub fn server_base(url: &str) -> &str {
    url.trim_end_matches('/')
}

// ---- the client id -------------------------------------------------------------

/// package.json, as Next bundles `@/package.json` into `version.ts`.
const PACKAGE_JSON: &str = include_str!("../../../../package.json");

/// package.json's `version`.
pub fn package_version() -> &'static str {
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| {
        serde_json::from_str::<Value>(PACKAGE_JSON)
            .ok()
            .and_then(|p| p["version"].as_str().map(str::to_owned))
            .unwrap_or_default()
    })
}

/// `CLAUDIUS_VERSION`: `` `${pkg.version}.${release}` `` (see the module
/// docs), worked out on first use.
pub fn claudius_version() -> &'static str {
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| {
        let version = package_version();
        let release = env(RELEASE_ENV)
            .filter(|r| !r.is_empty())
            .or_else(|| {
                option_env!("NEXT_PUBLIC_CLAUDIUS_RELEASE")
                    .filter(|r| !r.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| git_release(Path::new("."), version));
        format!("{version}.{release}")
    })
}

/// `scripts/claudius-release.mjs` (`computeRelease`) in `dir`, for
/// `version`: `git tag --list "v<version>.*"`, then [`release_from_tags`];
/// `"0"` for an empty version or when git fails.
pub fn git_release(dir: &Path, version: &str) -> String {
    if version.is_empty() {
        return "0".to_owned();
    }
    let out = Command::new("git")
        .args(["tag", "--list", &format!("v{version}.*")])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            release_from_tags(version, &String::from_utf8_lossy(&o.stdout))
        }
        _ => "0".to_owned(),
    }
}

/// `String(computeRelease())` over `git tag`'s output: the largest `N` of
/// the lines `v<version>.N` with `N` all ASCII digits (as a JS number, so
/// leading zeros don't count and a run of digits past f64 is skipped), or
/// 0.
pub fn release_from_tags(version: &str, tags: &str) -> String {
    let out = js::trim(tags);
    let prefix = format!("v{version}.");
    let mut max = -1.0_f64;
    for tag in out.split('\n') {
        let Some(n) = tag.strip_prefix(&prefix) else {
            continue;
        };
        if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let value: f64 = n.parse().unwrap_or(f64::NAN);
        // `Number.isInteger(value) && value > max`.
        if value.is_finite() && value > max {
            max = value;
        }
    }
    js::number_to_string(if max >= 0.0 { max } else { 0.0 })
}

/// `PLATFORM_LABELS[raw] ?? raw`.
pub fn platform_label(platform: &str) -> &str {
    match platform {
        "darwin" => "mac",
        "win32" => "windows",
        "linux" => "linux",
        other => other,
    }
}

/// `getCommunityClient()` on the server, where `isElectron()` is
/// `process.env.CLAUDIUS_ELECTRON === "1"` and the platform is
/// `process.platform`.
pub fn community_client(electron: Option<&str>, platform: &str, version: &str) -> String {
    if electron != Some("1") {
        return format!("claudius/web:{version}");
    }
    format!("claudius/electron-{}:{version}", platform_label(platform))
}

/// [`community_client`] for this process.
pub fn this_client() -> String {
    community_client(
        env(ELECTRON_ENV).as_deref(),
        crate::tcc_protected::platform(),
        claudius_version(),
    )
}

/// `withCommunityClientParam(url)`: `client=<encodeURIComponent(id)>`
/// after a `?`, or after a `&` when the URL already holds a `?`.
pub fn with_client_param(url: &str, client: &str) -> String {
    let id = js_string::encode_uri_component(client).unwrap_or_default();
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}client={id}")
}

// ---- the admin proxy's target ------------------------------------------------

/// The `path` param Next hands `admin/[...path]` for the raw (still
/// percent-encoded) rest of the request path: each `/`-separated segment
/// through `decodeURIComponent`, less one leading `_NEXTSEP_`
/// (`getRouteMatcher`'s `stripParameterSeparators`).
///
/// `None` where Next doesn't simply do that, so the request is left to
/// Next: a trailing or repeated slash or a backslash (Next redirects with a
/// 308), a segment that doesn't decode (`DecodeError`, a 400), one that
/// decodes to `.` or `..` (normalized away before routing), and one holding
/// `.rsc` or `[` (`normalizeRscURL` and the route's default-value check
/// rewrite or drop those params).
pub fn catch_all_segments(raw: &str) -> Option<Vec<String>> {
    if raw.is_empty() || raw.ends_with('/') || raw.contains("//") || raw.contains('\\') {
        return None;
    }
    raw.split('/')
        .map(|seg| {
            let d = js_string::decode_uri_component(seg)?;
            let next_rewrites = d == "." || d == ".." || d.contains(".rsc") || d.contains('[');
            let d = d.strip_prefix("_NEXTSEP_").map(str::to_owned).unwrap_or(d);
            (!next_rewrites).then_some(d)
        })
        .collect()
}

/// `` `${server}/admin/${path.map(encodeURIComponent).join("/")}` ``. A
/// decoded segment is never a lone surrogate, so every one encodes.
pub fn admin_target(server: &str, segments: &[String]) -> String {
    let encoded: Vec<String> = segments
        .iter()
        .map(|s| js_string::encode_uri_component(s).unwrap_or_default())
        .collect();
    format!("{server}/admin/{}", encoded.join("/"))
}

// ---- prefs ---------------------------------------------------------------------

/// What a prefs handler answers: `NextResponse.json(body, {status})`, or a
/// throw (Next's empty 500; the message is V8's or the settings error's).
#[derive(Debug, Clone, PartialEq)]
pub enum PrefsAnswer {
    Json(u16, Value),
    Threw(String),
}

fn bad(msg: &str) -> PrefsAnswer {
    PrefsAnswer::Json(400, json!({ "error": msg }))
}

/// The user settings value TS assigns into.
enum Doc {
    Object(Map<String, Value>),
    /// An array, and the keys assigned onto it (never written).
    Array(Value, Map<String, Value>),
    /// A string, number or boolean (or ±Infinity, which `read_settings_raw`
    /// reads as a non-literal `null`), and how V8's TypeError names it.
    Primitive(Value, String),
    /// A literal `null`.
    Null,
}

impl Doc {
    fn new(value: Value, null_literal: bool) -> Doc {
        match value {
            Value::Object(m) => Doc::Object(m),
            Value::Array(_) => Doc::Array(value, Map::new()),
            Value::Null if null_literal => Doc::Null,
            Value::Null => Doc::Primitive(value, "number 'Infinity'".to_owned()),
            Value::String(ref s) => {
                let what = format!("string '{s}'");
                Doc::Primitive(value, what)
            }
            Value::Number(ref n) => {
                let what = format!(
                    "number '{}'",
                    js::number_to_string(n.as_f64().unwrap_or(0.0))
                );
                Doc::Primitive(value, what)
            }
            Value::Bool(b) => Doc::Primitive(value, format!("boolean '{b}'")),
        }
    }

    /// `settings[key] = value` (strict mode).
    fn set(&mut self, key: &str, value: Value) -> Result<(), String> {
        match self {
            Doc::Object(m) | Doc::Array(_, m) => {
                m.insert(key.to_owned(), value);
                Ok(())
            }
            Doc::Primitive(_, what) => Err(format!("Cannot create property '{key}' on {what}")),
            Doc::Null => Err(format!("Cannot set properties of null (setting '{key}')")),
        }
    }

    /// `delete settings[key]`.
    fn delete(&mut self, key: &str) -> Result<(), String> {
        match self {
            Doc::Object(m) | Doc::Array(_, m) => {
                m.shift_remove(key);
                Ok(())
            }
            Doc::Primitive(..) => Ok(()),
            Doc::Null => Err("Cannot convert undefined or null to object".to_owned()),
        }
    }

    /// What `JSON.stringify` writes.
    fn json(&self) -> Value {
        match self {
            Doc::Object(m) => Value::Object(m.clone()),
            Doc::Array(v, _) | Doc::Primitive(v, _) => v.clone(),
            Doc::Null => Value::Null,
        }
    }

    /// `readPrefs(settings)`.
    fn prefs(&self) -> Result<Value, String> {
        let (consent, nick) = match self {
            Doc::Object(m) | Doc::Array(_, m) => {
                (m.get("communityConsent"), m.get("communityNick"))
            }
            Doc::Primitive(..) => (None, None),
            Doc::Null => return Err(settings::null_property_error("communityConsent")),
        };
        let consent = match consent {
            Some(Value::String(s)) if s == "yes" || s == "no" => Value::String(s.clone()),
            _ => Value::Null,
        };
        let nick = match nick {
            Some(Value::String(s)) if !s.is_empty() => Value::String(s.clone()),
            _ => Value::Null,
        };
        Ok(json!({ "consent": consent, "nick": nick }))
    }
}

/// `readSettings("user", …)` as a [`Doc`].
fn read_doc() -> Result<Doc, PrefsAnswer> {
    settings::read_settings_raw(Scope::User, "")
        .map(|(v, null)| Doc::new(v, null))
        .map_err(|e| PrefsAnswer::Threw(e.to_string()))
}

/// `GET /api/community/prefs`.
pub fn get_prefs() -> PrefsAnswer {
    let doc = match read_doc() {
        Ok(d) => d,
        Err(a) => return a,
    };
    match doc.prefs() {
        Ok(p) => PrefsAnswer::Json(200, p),
        Err(m) => PrefsAnswer::Threw(m),
    }
}

/// `PUT /api/community/prefs` for a body `req.json()` parsed (the caller
/// answers 400 `invalid json` for one it couldn't).
pub fn put_prefs(body: &Value) -> PrefsAnswer {
    // `typeof body !== "object" || body === null`: arrays pass.
    let fields = match body {
        Value::Object(m) => Some(m),
        Value::Array(_) => None,
        _ => return bad("invalid body"),
    };
    let mut doc = match read_doc() {
        Ok(d) => d,
        Err(a) => return a,
    };
    // `"consent" in body`: an own key (the names aren't on any prototype).
    let field = |k: &str| fields.and_then(|m| m.get(k));
    if let Some(consent) = field("consent") {
        let done = match consent {
            Value::String(s) if s == "yes" || s == "no" => {
                doc.set("communityConsent", consent.clone())
            }
            Value::Null => doc.delete("communityConsent"),
            _ => return bad("consent must be 'yes', 'no', or null"),
        };
        if let Err(m) = done {
            return PrefsAnswer::Threw(m);
        }
    }
    if let Some(nick) = field("nick") {
        let done = match nick {
            Value::String(s) if !s.is_empty() => {
                // `body.nick.length > 64`: UTF-16 units.
                if s.encode_utf16().count() > 64 {
                    return bad("nick too long");
                }
                doc.set("communityNick", nick.clone())
            }
            Value::Null | Value::String(_) => doc.delete("communityNick"),
            _ => return bad("nick must be a string or null"),
        };
        if let Err(m) = done {
            return PrefsAnswer::Threw(m);
        }
    }
    if let Err(e) = settings::write_settings_value(Scope::User, "", &doc.json()) {
        return PrefsAnswer::Threw(e.to_string());
    }
    match doc.prefs() {
        Ok(p) => PrefsAnswer::Json(200, p),
        Err(m) => PrefsAnswer::Threw(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_counts_the_version_tags() {
        let r = |tags: &str| release_from_tags("1.2.3", tags);
        assert_eq!(r(""), "0");
        assert_eq!(r("  \n"), "0");
        assert_eq!(r("v1.2.3.0"), "0");
        assert_eq!(r("v1.2.3.4\nv1.2.3.12\nv1.2.3.9\n"), "12");
        assert_eq!(
            r("v1.2.3.007\nv1.2.3.x\nv1.2.3.1.5\nv1.2.3.\nv1.2.30.99"),
            "7"
        );
        assert_eq!(r("v1.2.3.99999999999999999999"), "100000000000000000000");
        assert_eq!(r(&format!("v1.2.3.{}\nv1.2.3.2", "9".repeat(400))), "2");
        assert_eq!(r("v1.2.3.5\r\nv1.2.3.3"), "3");
    }

    #[test]
    fn client_ids() {
        assert_eq!(
            community_client(None, "darwin", "1.2.3.4"),
            "claudius/web:1.2.3.4"
        );
        assert_eq!(
            community_client(Some("true"), "darwin", "1"),
            "claudius/web:1"
        );
        assert_eq!(
            community_client(Some("1"), "darwin", "1"),
            "claudius/electron-mac:1"
        );
        assert_eq!(
            community_client(Some("1"), "win32", "1"),
            "claudius/electron-windows:1"
        );
        assert_eq!(
            community_client(Some("1"), "freebsd", "1"),
            "claudius/electron-freebsd:1"
        );
        assert_eq!(
            with_client_param("http://h/a?b", "claudius/web:1.2"),
            "http://h/a?b&client=claudius%2Fweb%3A1.2"
        );
        assert_eq!(
            with_client_param("http://h/a", "x y"),
            "http://h/a?client=x%20y"
        );
    }

    #[test]
    fn catch_all_like_next() {
        let s = |raw: &str| catch_all_segments(raw);
        assert_eq!(s("bans"), Some(vec!["bans".to_owned()]));
        assert_eq!(
            s("a%2Fb/c%20d"),
            Some(vec!["a/b".to_owned(), "c d".to_owned()])
        );
        assert_eq!(
            s("_NEXTSEP_x/%5FNEXTSEP__NEXTSEP_y"),
            Some(vec!["x".to_owned(), "_NEXTSEP_y".to_owned()])
        );
        for left in [
            "",
            "a/",
            "a//b",
            "a\\b",
            "%E0",
            "a/%2e%2E",
            "..",
            ".",
            "x.rsc",
            "%5B...path%5D",
        ] {
            assert_eq!(s(left), None, "{left:?}");
        }
        assert_eq!(
            admin_target("http://h", &["a/b".to_owned(), "é!'()*~".to_owned()]),
            "http://h/admin/a%2Fb/%C3%A9!'()*~"
        );
    }
}
