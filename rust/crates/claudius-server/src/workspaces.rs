//! The workspace store's routes: port of `app/api/workspaces/route.ts`
//! (GET/POST), `reorder/route.ts` (POST), `[id]/route.ts`
//! (GET/PATCH/DELETE), `[id]/select/route.ts` (POST) and
//! `[id]/icon/route.ts` (GET/POST), over [`claudius_core::workspaces`].
//! `[id]/roots` is [`crate::workspace_roots`].
//!
//! Bodies are read like `await req.json()` (an empty or malformed body is
//! Next's bare 500) into JS values ([`js_string::parse`], lone surrogates
//! kept), and every answer is `JSON.stringify` of the TS value. Anything the
//! TS lets throw (an unreadable or `null` store, a store entry that is
//! `null`, a non-string `name`) is the bare 500 too.
//!
//! Cookies are Next's: the request's `Cookie` header(s) parsed like
//! `RequestCookies` (split on `/; */`, values `decodeURIComponent`d, a pair
//! that fails to decode skipped, the last duplicate winning), and the
//! `Set-Cookie`s `select` and `DELETE` send serialized like
//! `ResponseCookies`, in the order Next emits them.

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::js_string::{self, lossy};
use claudius_core::workspaces::{self as store, CreateInput};
use claudius_core::{log, node_path, now_ms};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces", get(list).post(create))
        .route("/api/workspaces/reorder", post(reorder))
        .route(
            "/api/workspaces/{id}",
            get(get_one).patch(patch_one).delete(delete_one),
        )
        .route("/api/workspaces/{id}/select", post(select))
        .route("/api/workspaces/{id}/icon", get(icon_get).post(icon_post))
}

pub(crate) const COOKIE: &str = "claudius.workspace";
pub(crate) const COOKIE_CUST: &str = "claudius.customization";
/// `60 * 60 * 24 * 365`.
pub(crate) const MAX_AGE: i64 = 31_536_000;
const MAX_ICON: usize = 2 * 1024 * 1024;

pub(crate) fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(body),
    )
        .into_response()
}

pub(crate) fn with_cookies(mut res: Response, cookies: Vec<String>) -> Response {
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(&c) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

fn bad(msg: &str) -> Response {
    json_text(StatusCode::BAD_REQUEST, &json!({"error": msg}))
}

fn not_found(msg: &str) -> Response {
    json_text(StatusCode::NOT_FOUND, &json!({"error": msg}))
}

/// What the TS let throw: Next's empty 500.
fn failed(route: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/workspaces{route}] {e:#}");
    thrown()
}

/// `await req.json()`; `None` is the uncaught `SyntaxError` ([`thrown`]).
fn read_json(bytes: &[u8]) -> Option<Value> {
    js_string::parse(&JsonBody::text(bytes)).ok()
}

// ---- cookies ------------------------------------------------------------------

/// The request's cookies as Next's `RequestCookies` reads them, in order:
/// Node joins repeated `Cookie` headers with `"; "` and reads the bytes as
/// latin1.
pub fn request_cookies(headers: &HeaderMap) -> Vec<(String, String)> {
    let values: Vec<String> = headers
        .get_all(header::COOKIE)
        .iter()
        .map(|v| v.as_bytes().iter().map(|&b| char::from(b)).collect())
        .collect();
    parse_cookie_header(&values.join("; "))
}

/// `parseCookie` on a `Cookie` header value (after `Headers` strips the
/// HTTP whitespace around it): split on `/; */`; a pair without `=` is
/// `"true"`; the value is `decodeURIComponent`d and the pair skipped when
/// that throws; a repeated name keeps its first place and its last value.
pub fn parse_cookie_header(header: &str) -> Vec<(String, String)> {
    let header = header.trim_matches(['\t', '\n', '\r', ' ']);
    let mut out: Vec<(String, String)> = Vec::new();
    if header.is_empty() {
        return out;
    }
    for (i, piece) in header.split(';').enumerate() {
        let pair = if i == 0 {
            piece
        } else {
            piece.trim_start_matches(' ')
        };
        if pair.is_empty() {
            continue;
        }
        let (name, value) = match pair.find('=') {
            None => (pair, "true".to_owned()),
            Some(at) => match js_string::decode_uri_component(&pair[at + 1..]) {
                Some(v) => (&pair[..at], v),
                None => continue,
            },
        };
        match out.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = value,
            None => out.push((name.to_owned(), value)),
        }
    }
    out
}

/// `readActiveCookie`: the `claudius.workspace` value, unless empty.
pub fn read_active_cookie(headers: &HeaderMap) -> Option<String> {
    request_cookies(headers)
        .into_iter()
        .find(|(n, _)| n == COOKIE)
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty())
}

/// `Date.prototype.toUTCString`: `Thu, 01 Jan 1970 00:00:00 GMT`.
pub fn utc_string(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{}, {day:02} {} {year:04} {:02}:{:02}:{:02} GMT",
        DAYS[(days + 4).rem_euclid(7) as usize],
        MONTHS[(month - 1) as usize],
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
    )
}

/// `cookies().delete(name)`.
pub(crate) fn deleted_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
}

/// The order Next sends modified cookies in: its response cookie jar starts
/// as a copy of the request's, so a name the request carried keeps that
/// place; the others follow in the order they were set.
pub(crate) fn in_next_order(headers: &HeaderMap, modified: Vec<(&str, String)>) -> Vec<String> {
    let names: Vec<String> = request_cookies(headers)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    let mut keyed: Vec<(usize, String)> = modified
        .into_iter()
        .enumerate()
        .map(|(i, (name, text))| {
            let at = names.iter().position(|n| n == name);
            (at.unwrap_or(names.len() + i), text)
        })
        .collect();
    keyed.sort_by_key(|(k, _)| *k);
    keyed.into_iter().map(|(_, t)| t).collect()
}

// ---- paths --------------------------------------------------------------------

/// `assertAbsoluteUserPath`: the resolved path, or the `PathInjectionError`
/// message the routes answer 400 with.
pub fn assert_absolute_user_path(input: &str) -> Result<String, &'static str> {
    if input.is_empty() {
        return Err("invalid path");
    }
    if input.contains('\0') {
        return Err("null byte in path");
    }
    if !node_path::is_absolute(input) {
        return Err("path must be absolute");
    }
    Ok(node_path::resolve(&[input]))
}

/// `fs.stat(path).isDirectory()`; `None` when the stat fails.
fn is_dir(path: &str) -> Option<bool> {
    std::fs::metadata(lossy(path).as_ref())
        .ok()
        .map(|m| m.is_dir())
}

/// `body?.[key]?.trim()`: `Ok(None)` for `undefined` / `null`, `Err` (a
/// `TypeError`: `trim` is not a function) for any other non-string.
fn optional_trim(body: &Value, key: &str) -> Result<Option<String>, ()> {
    match body.as_object().and_then(|m| m.get(key)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(js::trim(s).to_owned())),
        Some(_) => Err(()),
    }
}

// ---- /api/workspaces ----------------------------------------------------------

async fn list(headers: HeaderMap) -> Response {
    let cookie = read_active_cookie(&headers);
    let workspaces = match store::list_raw() {
        Ok(w) => w,
        Err(e) => return failed("", e),
    };
    let active = match store::resolve_active_raw(cookie.as_deref()) {
        Ok(a) => a,
        Err(e) => return failed("", e),
    };
    let active_id = active
        .as_ref()
        .and_then(|w| w.get("id"))
        .cloned()
        .unwrap_or(Value::Null);
    json_text(
        StatusCode::OK,
        &json!({"workspaces": workspaces, "activeId": active_id}),
    )
}

async fn create(body: Bytes) -> Response {
    let Some(b) = read_json(&body) else {
        return thrown();
    };
    let Ok(name) = optional_trim(&b, "name") else {
        return failed("", "body.name.trim is not a function");
    };
    let Some(name) = name.filter(|n| !n.is_empty()) else {
        return bad("name required");
    };
    let Ok(root) = optional_trim(&b, "rootPath") else {
        return failed("", "body.rootPath.trim is not a function");
    };
    let Some(root) = root.filter(|r| !r.is_empty()) else {
        return bad("rootPath required");
    };
    let root = match assert_absolute_user_path(&root) {
        Ok(r) => r,
        Err(msg) => return bad(msg),
    };
    match is_dir(&root) {
        Some(true) => {}
        Some(false) => return bad("rootPath is not a directory"),
        None => return bad("rootPath does not exist"),
    }
    let input = CreateInput {
        name,
        root_path: root,
        icon: b.get("icon").cloned(),
        defaults: b.get("defaults").cloned(),
    };
    match store::create_raw(input) {
        Ok(ws) => json_text(StatusCode::CREATED, &ws),
        Err(e) => failed("", e),
    }
}

// ---- /api/workspaces/reorder --------------------------------------------------

async fn reorder(body: Bytes) -> Response {
    let Some(b) = read_json(&body) else {
        return thrown();
    };
    let Some(ids) = b.get("ids").and_then(Value::as_array) else {
        return bad("ids array required");
    };
    match store::reorder_raw(ids) {
        Ok(Ok(())) => json_text(StatusCode::OK, &json!({"ok": true})),
        Ok(Err(msg)) => bad(&msg),
        Err(e) => failed("/reorder", e),
    }
}

// ---- /api/workspaces/:id ------------------------------------------------------

async fn get_one(Path(id): Path<String>) -> Response {
    match store::get_raw(&id) {
        Ok(Some(ws)) => json_text(StatusCode::OK, &ws),
        Ok(None) => not_found("not found"),
        Err(e) => failed("/[id]", e),
    }
}

/// `navOrder`: an array of at most 64 strings, each 1–64 UTF-16 units.
fn valid_nav_order(v: &Value) -> bool {
    v.as_array().is_some_and(|items| {
        items.len() <= 64
            && items.iter().all(|i| {
                i.as_str()
                    .is_some_and(|s| (1..=64).contains(&js_string::len16(s)))
            })
    })
}

async fn patch_one(Path(id): Path<String>, body: Bytes) -> Response {
    let Some(mut b) = read_json(&body) else {
        return thrown();
    };
    // `body.navOrder` (no `?.`): a `null` body throws here.
    if let Some(nav) = tri!(js_member(&b, "navOrder"))
        && !valid_nav_order(nav)
    {
        return bad("invalid navOrder");
    }
    if let Some(Value::String(raw)) = b.get("rootPath") {
        let root = match assert_absolute_user_path(raw) {
            Ok(r) => r,
            Err(msg) => return bad(msg),
        };
        match is_dir(&root) {
            Some(true) => {}
            Some(false) => return bad("rootPath not a directory"),
            None => return bad("rootPath does not exist"),
        }
        // `body.rootPath = assertAbsoluteUserPath(body.rootPath)`: in place.
        b["rootPath"] = Value::String(root);
    }
    match store::update_raw(&id, &b) {
        Ok(Some(ws)) => json_text(StatusCode::OK, &ws),
        Ok(None) => not_found("not found"),
        Err(e) => failed("/[id]", e),
    }
}

async fn delete_one(Path(id): Path<String>, headers: HeaderMap) -> Response {
    match store::delete_raw(&id) {
        Ok(true) => {}
        Ok(false) => return not_found("not found"),
        Err(e) => return failed("/[id]", e),
    }
    let res = json_text(StatusCode::OK, &json!({"ok": true}));
    if read_active_cookie(&headers).as_deref() == Some(id.as_str()) {
        return with_cookies(res, vec![deleted_cookie(COOKIE)]);
    }
    res
}

// ---- /api/workspaces/:id/select -------------------------------------------------

async fn select(Path(id): Path<String>, headers: HeaderMap) -> Response {
    match store::get_raw(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return not_found("not found"),
        Err(e) => return failed("/[id]/select", e),
    }
    if let Err(e) = store::set_active_id(Some(&id)) {
        return failed("/[id]/select", e);
    }
    // `writeActiveCookie`: set (Max-Age plus the Expires Next derives from
    // it), then delete the customization cookie.
    let Some(value) = js_string::encode_uri_component(&id) else {
        return failed("/[id]/select", "URIError: URI malformed");
    };
    let set = format!(
        "{COOKIE}={value}; Path=/; Expires={}; Max-Age={MAX_AGE}; SameSite=lax",
        utc_string(now_ms() + MAX_AGE * 1000)
    );
    let cookies = in_next_order(
        &headers,
        vec![(COOKIE, set), (COOKIE_CUST, deleted_cookie(COOKIE_CUST))],
    );
    with_cookies(
        json_text(StatusCode::OK, &json!({"ok": true, "id": id})),
        cookies,
    )
}

// ---- /api/workspaces/:id/icon -------------------------------------------------

/// `MIME_FOR_EXT[ext] ?? "application/octet-stream"`, where a plain-object
/// lookup also finds `Object.prototype`'s members, which the `Headers`
/// constructor then stringifies.
pub fn mime_for(ext: &str) -> String {
    match ext {
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "webp" => "image/webp".into(),
        "__proto__" => "[object Object]".into(),
        "constructor" => "function Object() { [native code] }".into(),
        "toString"
        | "valueOf"
        | "hasOwnProperty"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "toLocaleString"
        | "__defineGetter__"
        | "__defineSetter__"
        | "__lookupGetter__"
        | "__lookupSetter__" => format!("function {ext}() {{ [native code] }}"),
        _ => "application/octet-stream".into(),
    }
}

/// `sniffExt`: magic bytes (`buf.toString("ascii")` drops each byte's top
/// bit, so `RIFF`/`WEBP` match with it set too).
pub fn sniff_ext(buf: &[u8]) -> Option<&'static str> {
    let ascii = |r: std::ops::Range<usize>| buf[r].iter().map(|b| b & 0x7F).collect::<Vec<u8>>();
    if buf.len() > 8 && buf[..4] == [0x89, 0x50, 0x4E, 0x47] {
        Some("png")
    } else if buf.len() > 3 && buf[..3] == [0xFF, 0xD8, 0xFF] {
        Some("jpg")
    } else if buf.len() > 12 && ascii(0..4) == b"RIFF" && ascii(8..12) == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// `unbase64`: both alphabets; anything else (`=` included) is illegal.
fn unbase64(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => 255,
    }
}

/// `Buffer.from(s, "base64")`, Node's lenient decoder: each UTF-16 unit is
/// read as its low byte, characters outside both alphabets are skipped, the
/// first `=` ends the data, and a final lone sextet is dropped.
pub fn base64_decode(s: &str) -> Vec<u8> {
    let src: Vec<u8> = js_string::units(s).into_iter().map(|u| u as u8).collect();
    let mut out = Vec::with_capacity(src.len() / 4 * 3 + 3);
    let mut i = 0;
    'groups: while i < src.len() {
        let mut prev = 0u8;
        for slot in 0..4 {
            let lo = loop {
                let c = src[i];
                let lo = unbase64(c);
                i += 1;
                if lo < 64 {
                    break lo;
                }
                if c == b'=' || i >= src.len() {
                    break 'groups;
                }
            };
            match slot {
                1 => out.push((prev << 2) | (lo >> 4)),
                2 => out.push(((prev & 0x0F) << 4) | (lo >> 2)),
                3 => out.push(((prev & 0x03) << 6) | lo),
                _ => {}
            }
            prev = lo;
            if i >= src.len() {
                break 'groups;
            }
        }
    }
    out
}

/// Why `Buffer.from(data, "base64")` gave no buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BufferError {
    /// It threw (the TS 500).
    Throws(&'static str),
    /// An array-like object longer than `limit`: TS allocates it and then
    /// answers "too large" (or runs out of memory); this doesn't allocate.
    TooLarge,
}

/// `ToUint8(ToNumber(v))`.
fn to_uint8(v: Option<&Value>) -> Result<u8, BufferError> {
    let n = js_string::to_js_number(v)
        .map_err(|_| BufferError::Throws("Cannot convert object to primitive value"))?;
    if !n.is_finite() {
        return Ok(0);
    }
    let m = n.trunc() % 256.0;
    Ok(if m < 0.0 { m + 256.0 } else { m } as u8)
}

/// `Buffer.from(value, "base64")` for a JSON value: a string decodes as
/// base64; an object's own falsy `valueOf` that is a string stands in for
/// it (a truthy one isn't callable and throws); an object with a `length`
/// is array-like (an empty buffer unless it's a number, then that many
/// elements, each `ToUint8(Number(v))`), as is the `data` array of
/// `{type: "Buffer"}`; arrays are array-like; anything else throws.
pub fn buffer_from(v: &Value, limit: usize) -> Result<Vec<u8>, BufferError> {
    const BAD_ARG: &str = "The first argument must be of type string or an instance of \
                           Buffer, ArrayBuffer, or Array or an Array-like Object.";
    match v {
        Value::String(s) => Ok(base64_decode(s)),
        Value::Array(items) => items.iter().map(|i| to_uint8(Some(i))).collect(),
        Value::Object(m) => {
            if let Some(value_of) = m.get("valueOf") {
                if js::truthy(value_of) {
                    return Err(BufferError::Throws("value.valueOf is not a function"));
                }
                if let Value::String(s) = value_of {
                    return Ok(base64_decode(s));
                }
            }
            if let Some(length) = m.get("length") {
                let Some(n) = length.as_f64() else {
                    return Ok(Vec::new());
                };
                if n <= 0.0 {
                    return Ok(Vec::new());
                }
                let len = n.trunc();
                // Every present element converts (and may throw) first.
                for (k, item) in m {
                    if js::array_index(k).is_some_and(|i| f64::from(i) < len) {
                        to_uint8(Some(item))?;
                    }
                }
                if len > limit as f64 {
                    return Err(BufferError::TooLarge);
                }
                let len = len as usize;
                let mut out = vec![0u8; len];
                for (k, item) in m {
                    if let Some(i) = js::array_index(k).filter(|i| (*i as usize) < len) {
                        out[i as usize] = to_uint8(Some(item))?;
                    }
                }
                return Ok(out);
            }
            match (m.get("type"), m.get("data")) {
                (Some(Value::String(t)), Some(Value::Array(items))) if t == "Buffer" => {
                    items.iter().map(|i| to_uint8(Some(i))).collect()
                }
                _ => Err(BufferError::Throws(BAD_ARG)),
            }
        }
        _ => Err(BufferError::Throws(BAD_ARG)),
    }
}

async fn icon_get(Path(id): Path<String>) -> Response {
    let Some((buf, ext)) = store::read_icon(&id) else {
        return not_found("no icon");
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime_for(&ext)),
            (header::CONTENT_LENGTH, buf.len().to_string()),
            (header::CACHE_CONTROL, "public, max-age=300".into()),
        ],
        buf,
    )
        .into_response()
}

async fn icon_post(Path(id): Path<String>, body: Bytes) -> Response {
    let Some(b) = read_json(&body) else {
        return thrown();
    };
    let Some(data) = b.get("data").filter(|d| js::truthy(d)) else {
        return bad("data (base64) required");
    };
    let buf = match buffer_from(data, MAX_ICON) {
        Ok(buf) => buf,
        Err(BufferError::TooLarge) => return bad("image too large (>2MB)"),
        Err(BufferError::Throws(msg)) => return failed("/[id]/icon", msg),
    };
    if buf.len() > MAX_ICON {
        return bad("image too large (>2MB)");
    }
    let Some(ext) = sniff_ext(&buf) else {
        return bad("unsupported image (PNG/JPEG/WebP only)");
    };
    match store::write_icon(&id, ext, &buf) {
        Ok(()) => json_text(StatusCode::OK, &json!({"ok": true, "ext": ext})),
        Err(e) => failed("/[id]/icon", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_string_formats_like_js() {
        // node: new Date(ms).toUTCString()
        assert_eq!(utc_string(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(
            utc_string(1_700_070_000_210 + MAX_AGE * 1000),
            "Thu, 14 Nov 2024 17:40:00 GMT"
        );
        assert_eq!(utc_string(951_782_400_000), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(utc_string(-1), "Wed, 31 Dec 1969 23:59:59 GMT");
    }

    #[test]
    fn modified_cookies_keep_the_request_order() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            "claudius.customization=c; x=1".parse().unwrap(),
        );
        let out = in_next_order(&h, vec![(COOKIE, "w".into()), (COOKIE_CUST, "c".into())]);
        assert_eq!(out, vec!["c", "w"]);
        let out = in_next_order(
            &HeaderMap::new(),
            vec![(COOKIE, "w".into()), (COOKIE_CUST, "c".into())],
        );
        assert_eq!(out, vec!["w", "c"]);
    }
}
