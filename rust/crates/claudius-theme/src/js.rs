//! The few JS string and number semantics the client logic leans on, kept
//! here so the crate has no dependencies.

/// ECMAScript `WhiteSpace` + `LineTerminator` (`String.prototype.trim`,
/// `Number()`, `parseFloat`): Unicode `White_Space` without U+0085, plus
/// U+FEFF.
pub fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The longest prefix of `s` that is a `StrUnsignedDecimalLiteral` body
/// (`digits [. digits] [e[+-]digits]`, or `. digits …`), in bytes.
fn decimal_prefix(s: &str) -> usize {
    let b = s.as_bytes();
    let digits = |mut i: usize| {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        i
    };
    let int_end = digits(0);
    let mut end = int_end;
    // A lone `.` (no digit on either side) counts here, and `str::parse`
    // then rejects it, so it reads as NaN, as in JS.
    if end < b.len() && b[end] == b'.' {
        end = digits(end + 1);
    }
    if end == 0 {
        return 0;
    }
    if end < b.len() && (b[end] == b'e' || b[end] == b'E') {
        let mut i = end + 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_end = digits(i);
        if exp_end > i {
            end = exp_end;
        }
    }
    end
}

fn signed(sign: &str, v: f64) -> f64 {
    if sign == "-" { -v } else { v }
}

fn split_sign(s: &str) -> (&str, &str) {
    match s.as_bytes().first() {
        Some(b'+') | Some(b'-') => s.split_at(1),
        _ => ("", s),
    }
}

fn radix(digits: &str, base: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut v = 0.0f64;
    for c in digits.chars() {
        match c.to_digit(base) {
            Some(d) => v = v * f64::from(base) + f64::from(d),
            None => return f64::NAN,
        }
    }
    v
}

/// `Number(string)`: the whole trimmed string must be a numeric literal
/// (empty is 0; `0x` / `0o` / `0b` unsigned; `Infinity` with a sign).
pub fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, base) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(d) = t.strip_prefix(prefix) {
            return radix(d, base);
        }
    }
    let (sign, body) = split_sign(t);
    if body == "Infinity" {
        return signed(sign, f64::INFINITY);
    }
    if decimal_prefix(body) != body.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |v| signed(sign, v))
}

/// `parseFloat(string)`: the longest decimal (or `Infinity`) prefix after
/// leading whitespace; `NaN` when there is none.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_space);
    let (sign, body) = split_sign(t);
    if body.starts_with("Infinity") {
        return signed(sign, f64::INFINITY);
    }
    let n = decimal_prefix(body);
    if n == 0 {
        return f64::NAN;
    }
    body[..n]
        .parse::<f64>()
        .map_or(f64::NAN, |v| signed(sign, v))
}

/// `String(n)` for the numbers the client writes: the chat-size bounds keep
/// them in 13..=400, where JS never uses an exponent and Rust's shortest
/// round-trip digits are the same.
pub fn number_to_string(n: f64) -> String {
    format!("{n}")
}
