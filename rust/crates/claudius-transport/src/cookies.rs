//! The page's cookies: what a browser stores from `Set-Cookie` and sends
//! back in `Cookie` for the one origin a transport talks to.
//!
//! The server's cookies are `claudius.workspace` and
//! `claudius.customization`, always `Path=/` and host-only, set with
//! `Max-Age` (plus `Expires`) and deleted with `Expires=Thu, 01 Jan 1970
//! 00:00:00 GMT`. So this keeps what RFC 6265 §5.2-5.4 says about those
//! and no more: a cookie is its name and value; `Max-Age` (which wins over
//! `Expires`, in any order) or `Expires` (an RFC 1123 date; another format
//! is ignored, as an unparsable one) gives its expiry, and one already
//! expired deletes the stored cookie of that name. `Domain`, `Path`,
//! `Secure`, `HttpOnly` and `SameSite` are not looked at. A cookie set
//! again keeps its place (its creation time), so `Cookie` lists them in
//! the order they were first set, as a browser orders cookies of equal path
//! length.

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use http::HeaderMap;
use http::header::SET_COOKIE;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cookie {
    name: String,
    value: String,
    /// `None`: a session cookie (lives as long as the jar).
    expires: Option<DateTime<Utc>>,
}

/// The cookies of one origin. Shared by the clones of a transport; hand
/// one jar to two transports to share a "browser profile".
#[derive(Debug, Default)]
pub struct CookieJar {
    cookies: Mutex<Vec<Cookie>>,
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `Cookie` header a request carries now (`a=1; b=2`), or `None`
    /// with no live cookie.
    pub fn header(&self) -> Option<String> {
        self.header_at(Utc::now())
    }

    pub(crate) fn header_at(&self, now: DateTime<Utc>) -> Option<String> {
        let mut cookies = self.cookies.lock().unwrap();
        cookies.retain(|c| c.expires.is_none_or(|e| e > now));
        let pairs: Vec<String> = cookies
            .iter()
            .map(|c| format!("{}={}", c.name, c.value))
            .collect();
        (!pairs.is_empty()).then(|| pairs.join("; "))
    }

    /// A live cookie's value.
    pub fn get(&self, name: &str) -> Option<String> {
        self.get_at(name, Utc::now())
    }

    pub(crate) fn get_at(&self, name: &str, now: DateTime<Utc>) -> Option<String> {
        self.cookies
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.name == name && c.expires.is_none_or(|e| e > now))
            .map(|c| c.value.clone())
    }

    /// Store every `Set-Cookie` of a response, in order.
    pub fn store_from(&self, headers: &HeaderMap) {
        let now = Utc::now();
        for v in headers.get_all(SET_COOKIE) {
            // A header value is bytes; a browser reads them as latin1.
            let text: String = v.as_bytes().iter().map(|&b| char::from(b)).collect();
            self.set_at(&text, now);
        }
    }

    /// Store one `Set-Cookie` header value.
    pub fn set(&self, set_cookie: &str) {
        self.set_at(set_cookie, Utc::now());
    }

    pub(crate) fn set_at(&self, set_cookie: &str, now: DateTime<Utc>) {
        let Some(cookie) = parse(set_cookie, now) else {
            return;
        };
        let mut cookies = self.cookies.lock().unwrap();
        let at = cookies.iter().position(|c| c.name == cookie.name);
        if cookie.expires.is_some_and(|e| e <= now) {
            if let Some(i) = at {
                cookies.remove(i);
            }
            return;
        }
        match at {
            Some(i) => cookies[i] = cookie,
            None => cookies.push(cookie),
        }
    }

    /// Forget every cookie.
    pub fn clear(&self) {
        self.cookies.lock().unwrap().clear();
    }
}

/// RFC 6265 §5.2's whitespace (`WSP`: space, tab).
fn trim_wsp(s: &str) -> &str {
    s.trim_matches([' ', '\t'])
}

/// RFC 6265 §5.2: the name-value pair and the expiry attributes.
fn parse(set_cookie: &str, now: DateTime<Utc>) -> Option<Cookie> {
    let mut parts = set_cookie.split(';');
    let pair = parts.next().unwrap_or_default();
    let (name, value) = pair.split_once('=')?;
    let (name, value) = (trim_wsp(name), trim_wsp(value));
    if name.is_empty() {
        return None;
    }
    let mut max_age: Option<DateTime<Utc>> = None;
    let mut expires: Option<DateTime<Utc>> = None;
    for attr in parts {
        let (key, val) = attr.split_once('=').unwrap_or((attr, ""));
        let (key, val) = (trim_wsp(key), trim_wsp(val));
        if key.eq_ignore_ascii_case("max-age") {
            if let Some(at) = max_age_expiry(val, now) {
                max_age = Some(at);
            }
        } else if key.eq_ignore_ascii_case("expires") {
            if let Ok(at) = DateTime::parse_from_rfc2822(val) {
                expires = Some(at.with_timezone(&Utc));
            }
        }
    }
    Some(Cookie {
        name: name.to_owned(),
        value: value.to_owned(),
        expires: max_age.or(expires),
    })
}

/// RFC 6265 §5.2.2: `-`? digits; zero or less is "the earliest time".
fn max_age_expiry(val: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let digits = val.strip_prefix('-').unwrap_or(val);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if val.starts_with('-') {
        return Some(DateTime::<Utc>::MIN_UTC);
    }
    // A huge value is "the latest time"; zero is `now`, as expired as "the
    // earliest time" (a cookie expiring at `now` is gone at `now`).
    let secs: i64 = digits.parse().unwrap_or(i64::MAX);
    Some(
        chrono::TimeDelta::try_seconds(secs)
            .and_then(|d| now.checked_add_signed(d))
            .unwrap_or(DateTime::<Utc>::MAX_UTC),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn the_servers_cookies_round_trip() {
        let jar = CookieJar::new();
        let now = t("2026-11-26T12:00:00Z");
        assert_eq!(jar.header_at(now), None);
        jar.set_at(
            "claudius.workspace=wks_aaaaaaaaaaaa; Path=/; Expires=Fri, 26 Nov 2027 12:00:00 GMT; Max-Age=31536000; SameSite=lax",
            now,
        );
        jar.set_at("claudius.customization=c1; Path=/", now);
        assert_eq!(
            jar.header_at(now).as_deref(),
            Some("claudius.workspace=wks_aaaaaaaaaaaa; claudius.customization=c1")
        );
        // Set again: same place, new value.
        jar.set_at("claudius.workspace=wks_bbbbbbbbbbbb; Path=/", now);
        assert_eq!(
            jar.header_at(now).as_deref(),
            Some("claudius.workspace=wks_bbbbbbbbbbbb; claudius.customization=c1")
        );
        // The server's delete.
        jar.set_at(
            "claudius.workspace=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            now,
        );
        assert_eq!(
            jar.header_at(now).as_deref(),
            Some("claudius.customization=c1")
        );
        assert_eq!(jar.get("claudius.workspace"), None);
        assert_eq!(jar.get("claudius.customization").as_deref(), Some("c1"));
    }

    #[test]
    fn max_age_wins_over_expires_in_any_order() {
        let now = t("2026-11-26T12:00:00Z");
        let jar = CookieJar::new();
        jar.set_at(
            "a=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            now,
        );
        jar.set_at(
            "b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=60",
            now,
        );
        assert_eq!(jar.header_at(now).as_deref(), Some("a=1; b=2"));
        // ... and they expire on time.
        assert_eq!(
            jar.header_at(t("2026-11-26T12:00:59Z")).as_deref(),
            Some("a=1; b=2")
        );
        // Expired but not yet dropped (only `header_at` drops): not there.
        assert_eq!(
            jar.get_at("a", t("2026-11-26T12:00:59Z")).as_deref(),
            Some("1")
        );
        assert_eq!(jar.get_at("a", t("2026-11-26T12:01:00Z")), None);
        assert_eq!(jar.header_at(t("2026-11-26T12:01:00Z")), None);
    }

    #[test]
    fn expiry_rules() {
        let now = t("2026-11-26T12:00:00Z");
        let jar = CookieJar::new();
        for c in ["z=1", "y=1", "x=1", "w=1", "v=1"] {
            jar.set_at(c, now);
        }
        jar.set_at("z=; Max-Age=0", now);
        jar.set_at("y=; Max-Age=-5", now);
        // Not a number: ignored, so a session cookie.
        jar.set_at("x=2; Max-Age=soon", now);
        jar.set_at("w=2; Max-Age=1.5", now);
        // A date `parse_from_rfc2822` can't read is ignored too.
        jar.set_at("v=2; Expires=yesterday", now);
        assert_eq!(jar.header_at(now).as_deref(), Some("x=2; w=2; v=2"));
        // A huge Max-Age is "the latest time".
        jar.set_at("u=1; Max-Age=99999999999999999999999", now);
        assert_eq!(jar.get("u").as_deref(), Some("1"));
        // Deleting a cookie that isn't there is nothing.
        jar.set_at("nope=; Max-Age=0", now);
        assert_eq!(jar.header_at(now).as_deref(), Some("x=2; w=2; v=2; u=1"));
        jar.clear();
        assert_eq!(jar.header_at(now), None);
    }

    #[test]
    fn a_deleted_cookie_set_again_goes_last() {
        let now = t("2026-11-26T12:00:00Z");
        let jar = CookieJar::new();
        jar.set_at("a=1", now);
        jar.set_at("b=2", now);
        jar.set_at("a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", now);
        jar.set_at("a=3", now);
        assert_eq!(jar.header_at(now).as_deref(), Some("b=2; a=3"));
    }

    #[test]
    fn the_pair_rules() {
        let now = t("2026-11-26T12:00:00Z");
        let jar = CookieJar::new();
        // No `=`, or an empty name: ignored.
        jar.set_at("novalue", now);
        jar.set_at("=v; Path=/", now);
        jar.set_at("  ", now);
        assert_eq!(jar.header_at(now), None);
        // Whitespace around name and value goes; the value keeps its `=`.
        jar.set_at(" a \t= b=c ; Path=/", now);
        jar.set_at("e=", now);
        assert_eq!(jar.header_at(now).as_deref(), Some("a=b=c; e="));
    }

    #[test]
    fn set_cookie_headers_are_read_in_order() {
        let jar = CookieJar::new();
        let mut h = HeaderMap::new();
        h.append(SET_COOKIE, "a=1; Path=/".parse().unwrap());
        h.append(SET_COOKIE, "b=2; Path=/".parse().unwrap());
        h.append(
            SET_COOKIE,
            "a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT".parse().unwrap(),
        );
        jar.store_from(&h);
        assert_eq!(jar.header().as_deref(), Some("b=2"));
        jar.set("c=3");
        assert_eq!(jar.header().as_deref(), Some("b=2; c=3"));
    }
}
