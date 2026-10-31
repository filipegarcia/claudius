//! `lib/shared/settings-load-error.ts`: `sanitizeJsonParseReason`, which
//! turns V8's `JSON.parse` message into a reason safe to show (the echoed
//! source is dropped, since settings files hold secrets). Replayed against
//! the TS in `tests/settings_errors_golden.rs`.

use claudius_agent::js;

const SUFFIX: &str = "\" is not valid JSON";
const ECHO: &str = ", \"";
const CAP: usize = 160;

/// `sanitizeJsonParseReason(message)` on a JS string's UTF-16 units:
/// - cut at the first `, "` when the message ends with `" is not valid
///   JSON` (V8's echo of the source);
/// - every remaining `"…"` span (`/"[^"]*"/g`) becomes `"…"`;
/// - runs of JS whitespace (`\s`) become one space, then `trim()`;
/// - over 160 units, the first 159 and `…` (which can leave half a
///   surrogate pair);
/// - `invalid JSON` if nothing is left.
pub fn sanitize_json_parse_reason_utf16(message: &[u16]) -> Vec<u16> {
    let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    let (suffix, echo) = (units(SUFFIX), units(ECHO));
    let mut reason = message;
    if let Some(at) = reason
        .windows(echo.len())
        .position(|w| w == echo.as_slice())
        && reason.ends_with(&suffix)
    {
        reason = &reason[..at];
    }
    let quote = u16::from(b'"');
    let mut quoted = Vec::with_capacity(reason.len());
    let mut i = 0;
    while i < reason.len() {
        if reason[i] == quote
            && let Some(len) = reason[i + 1..].iter().position(|u| *u == quote)
        {
            quoted.extend(units("\"\u{2026}\""));
            i += len + 2;
            continue;
        }
        quoted.push(reason[i]);
        i += 1;
    }
    let space = |u: u16| char::from_u32(u32::from(u)).is_some_and(js::is_whitespace);
    let mut collapsed: Vec<u16> = Vec::with_capacity(quoted.len());
    let mut in_run = false;
    for u in quoted {
        if !space(u) {
            collapsed.push(u);
            in_run = false;
        } else if !in_run {
            collapsed.push(u16::from(b' '));
            in_run = true;
        }
    }
    let start = collapsed
        .iter()
        .position(|u| !space(*u))
        .unwrap_or(collapsed.len());
    let end = collapsed
        .iter()
        .rposition(|u| !space(*u))
        .map_or(start, |e| e + 1);
    let mut out = collapsed[start..end].to_vec();
    if out.len() > CAP {
        out.truncate(CAP - 1);
        out.push(0x2026);
    }
    if out.is_empty() {
        return units("invalid JSON");
    }
    out
}

/// [`sanitize_json_parse_reason_utf16`] on a `str`. A lone surrogate left
/// by the 160-unit cut is dropped, since a `String` can't hold it.
pub fn sanitize_json_parse_reason(message: &str) -> String {
    let units: Vec<u16> = message.encode_utf16().collect();
    char::decode_utf16(sanitize_json_parse_reason_utf16(&units))
        .filter_map(Result::ok)
        .collect()
}
