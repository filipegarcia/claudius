//! JavaScript value semantics the SDK's wire output depends on.
//!
//! Where the TS SDK re-serializes data with `JSON.stringify` (for example the
//! `--settings` JSON after the sandbox merge), every number has been through
//! a JS `number`. So `1.0` prints as `1`, `1e2` as `100`, `1e21` as `1e+21`,
//! and integers past 2^53 lose precision. serde_json prints the source
//! representation instead, so [`stringify`] reproduces `JSON.stringify` byte
//! for byte. The other way round, [`json_parse`] and [`json_parse_error`]
//! mirror `JSON.parse`, down to the wording of V8's `SyntaxError`.

use serde_json::Value;

/// ECMAScript `Number::toString(x)` (radix 10) for a finite `x`, as
/// `JSON.stringify` emits it. Non-finite values print `null`, like
/// `JSON.stringify(NaN)`.
pub fn number_to_string(x: f64) -> String {
    if !x.is_finite() {
        return "null".into();
    }
    if x == 0.0 {
        return "0".into(); // `-0` too
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    // Rust's `{:e}` is the shortest round-trip digit string, the same digits
    // the spec's step 5 picks: "d.ddde±E".
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').expect("`{:e}` has an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("integer exponent") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e >= 0 { '+' } else { '-' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", e.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", e.abs())
        }
    }
}

/// `JSON.stringify(value)` with no replacer or indent. Strings and keys are
/// escaped exactly as serde_json does it, which matches JS for every Rust
/// string; JS only differs for lone surrogates, which a Rust `str` can't hold.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// `JSON.stringify` of a JS string given as UTF-16 units, appended to `out`:
/// `"`, `\` and controls escaped (the short forms where JSON has them, else
/// lower-case `\u00xx`), and lone surrogates as `\udxxx`.
pub fn stringify_utf16(units: &[u16], out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\r') => out.push_str("\\r"),
            Ok(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Number(n) => out.push_str(&number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string serializes")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, v)) in own_keys_order(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("key serializes"));
                out.push(':');
                write(v, out);
            }
            out.push('}');
        }
        Value::Null | Value::Bool(_) => out.push_str(&value.to_string()),
    }
}

/// `JSON.stringify(value, null, 2)`: [`stringify`] with each array item and
/// object member on its own line, indented two spaces per level, and `": "`
/// after keys. Empty arrays and objects stay `[]` / `{}`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, depth: usize, out: &mut String) {
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        out.push_str(&"  ".repeat(depth));
    };
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_pretty(item, depth + 1, out);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (i, (k, v)) in own_keys_order(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&serde_json::to_string(k).expect("key serializes"));
                out.push_str(": ");
                write_pretty(v, depth + 1, out);
            }
            newline(out, depth);
            out.push('}');
        }
        _ => write(value, out),
    }
}

/// `String(v)` for a JSON value, `None` being `undefined`, as template
/// literals and `"..." + v` print it: arrays join their items with `,`
/// (`null` items print empty), objects print `[object Object]`.
pub fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => to_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(v @ (Value::Null | Value::Bool(_))) => v.to_string(),
    }
}

/// `parseInt(s, 10)`: optional leading whitespace and sign, then the
/// longest run of ASCII digits; `NaN` when there are none.
pub fn parse_int(s: &str) -> f64 {
    let s = trim(s);
    let (neg, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return f64::NAN;
    }
    let x: f64 = rest[..digits].parse().expect("ASCII digits parse");
    if neg { -x } else { x }
}

/// The SDK's integer env parser (`Ic` over `dS`): the trimmed text, if at
/// most 32 UTF-16 units long, may be scientific notation (an integer value,
/// else `NaN`) or digits grouped in threes by one repeated separator (`_`,
/// `,`, NBSP, NNBSP or space); otherwise it's `parseInt(text, 10)`. `None`
/// is an unset variable, which parses as `parseInt("undefined")`: `NaN`.
pub fn env_int(raw: Option<&str>) -> f64 {
    let Some(raw) = raw else {
        return f64::NAN;
    };
    let t = trim(raw);
    if t.encode_utf16().count() <= 32 {
        if is_scientific(t) {
            let x: f64 = t.parse().expect("scientific notation parses");
            return if x.is_finite() && x.fract() == 0.0 {
                x
            } else {
                f64::NAN
            };
        }
        if let Some(sep) = grouped_separator(t) {
            return parse_int(&t.replace(sep, ""));
        }
    }
    parse_int(t)
}

/// `/^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/`
fn is_scientific(t: &str) -> bool {
    let digits = |s: &str| s.len() - s.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let s = t.strip_prefix(['+', '-']).unwrap_or(t);
    let int = digits(s);
    let mut rest = &s[int..];
    if let Some(r) = rest.strip_prefix('.') {
        let frac = digits(r);
        rest = &r[frac..];
        if int == 0 && frac == 0 {
            return false;
        }
    } else if int == 0 {
        return false;
    }
    let Some(exp) = rest.strip_prefix(['e', 'E']) else {
        return false;
    };
    let exp = exp.strip_prefix(['+', '-']).unwrap_or(exp);
    let n = digits(exp);
    n > 0 && n == exp.len()
}

/// `/^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/`: the separator.
fn grouped_separator(t: &str) -> Option<char> {
    let s = t.strip_prefix(['+', '-']).unwrap_or(t);
    let lead = s.chars().take_while(char::is_ascii_digit).count();
    if !(1..=3).contains(&lead) {
        return None;
    }
    let mut chars = s[lead..].chars();
    let sep = chars
        .next()
        .filter(|c| matches!(c, '_' | ',' | '\u{a0}' | '\u{202f}' | ' '))?;
    let rest: Vec<char> = chars.collect();
    // `\d{3}` then `(sep \d{3})*`: groups of 3 digits joined by `sep`.
    let mut groups = rest.split(|c| *c == sep);
    let ok = groups.all(|g| g.len() == 3 && g.iter().all(char::is_ascii_digit));
    ok.then_some(sep)
}

/// JS whitespace (`\s`, and what `trim` strips): Unicode `White_Space`
/// minus U+0085 (NEL), plus U+FEFF (BOM).
pub fn is_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_whitespace)
}

/// `Number(s)` (ECMAScript `StringToNumber`): trimmed with [`trim`]; `""` is
/// 0; a decimal literal with an optional sign, fraction and exponent;
/// `0x` / `0o` / `0b` integers with no sign; `[+-]Infinity`; anything else
/// (`inf`, `nan`, `1_0`, `0x`) is `NaN`.
pub fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let digits = &t[2..];
            if !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            // Exact up to 128 bits, then rounded once (as the spec does).
            return match u128::from_str_radix(digits, radix) {
                Ok(v) => v as f64,
                Err(_) => digits.chars().fold(0.0, |a, c| {
                    a * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                }),
            };
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // StrUnsignedDecimalLiteral: digits [. digits] | . digits, then [eE][+-]digits.
    let u = unsigned.as_bytes();
    let digits_at = |i: usize| u[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits_at(0);
    let mut i = int;
    let mut frac = 0;
    if u.get(i) == Some(&b'.') {
        frac = digits_at(i + 1);
        i += 1 + frac;
    }
    if int + frac == 0 {
        return f64::NAN;
    }
    if matches!(u.get(i), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(u.get(i + 1), Some(b'+' | b'-')));
        let exp = digits_at(i + 1 + sign);
        if exp == 0 {
            return f64::NAN;
        }
        i += 1 + sign + exp;
    }
    if i != u.len() {
        return f64::NAN;
    }
    // Rust's parser is correctly rounded, like the spec's; it reads `5.`,
    // `.5` and overflow to infinity the same way.
    t.parse().unwrap_or(f64::NAN)
}

/// The SDK's `yf(s, units)`: the last `units` UTF-16 code units of `s`. When
/// the cut splits a surrogate pair, the SDK drops the orphaned low surrogate,
/// so the whole character goes.
pub fn utf16_tail(s: &str, units: usize) -> &str {
    let mut n = 0;
    let mut start = s.len();
    for (i, c) in s.char_indices().rev() {
        n += c.len_utf16();
        if n > units {
            break;
        }
        start = i;
    }
    &s[start..]
}

/// An array index: a canonical decimal integer string below 2^32 - 1, the
/// keys an array's elements (and a string's code units) are read by.
pub fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// `OrdinaryOwnPropertyKeys`: a JS object enumerates array-index keys first,
/// ascending, then the other keys in insertion order. `JSON.stringify` (and
/// so every re-serialized JS object) follows it.
pub fn own_keys_order(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut named = Vec::new();
    for (k, v) in map {
        match array_index(k) {
            Some(n) => indexed.push((n, (k, v))),
            None => named.push((k, v)),
        }
    }
    indexed.sort_by_key(|(n, _)| *n);
    indexed.into_iter().map(|(_, kv)| kv).chain(named).collect()
}

/// JS truthiness of a JSON value (`!!v`).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Object.entries(v)` for a JSON value: own enumerable string-keyed
/// properties. Arrays yield `["0", item]` pairs, strings one pair per UTF-16
/// code unit (chars here; they only differ for astral characters, which are
/// irrelevant to every call site), and everything else nothing.
pub fn entries(v: &Value) -> Vec<(String, Value)> {
    match v {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(s) => s
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

/// `v?.[key]` where `v` came from JSON: a property of a plain object, or
/// `None` (JS `undefined`) for anything else. Present-but-`null` is
/// `Some(Null)`, distinct from absent, like `!== undefined`.
pub fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v?.as_object()?.get(key)
}

/// `[...new Set(items)]`: first occurrence wins. `Set` compares with
/// SameValueZero, so primitives dedupe by value (numbers numerically) while
/// every object or array is a distinct reference and is always kept.
pub fn dedupe(items: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(items.len());
    for item in items {
        let dup = match &item {
            Value::Array(_) | Value::Object(_) => false,
            Value::Number(n) => {
                let f = n.as_f64();
                out.iter()
                    .any(|o| matches!(o, Value::Number(m) if m.as_f64() == f))
            }
            prim => out.contains(prim),
        };
        if !dup {
            out.push(item);
        }
    }
    out
}

// ---- JSON.parse ---------------------------------------------------------------

/// `JSON.parse(text)` as a `serde_json` value, or the `message` of the
/// `SyntaxError` V8 throws ([`json_parse_error`]).
///
/// V8 also accepts what serde_json can't hold. A lone-surrogate escape
/// (`"\ud800"`) becomes U+FFFD, as it does when the JS string is written out
/// as UTF-8 (`Buffer.from`, a file, the CLI's stdin). A number out of `f64`
/// range (`1e400`, JS `Infinity`) becomes `null`, which is what
/// `JSON.stringify` writes for it. Nesting past serde_json's 127 levels is
/// still an `Err`, with serde_json's message, where V8 parses it.
pub fn json_parse(text: &str) -> Result<Value, String> {
    if let Some(message) = json_parse_error(text) {
        return Err(message);
    }
    serde_json::from_str(text)
        .or_else(|_| serde_json::from_str(&representable(text)))
        .map_err(|e| e.to_string())
}

/// The `message` of the `SyntaxError` node 22's `JSON.parse(text)` throws, or
/// `None` when V8 parses `text`. Positions and the source window around an
/// unexpected token count UTF-16 code units, like JS indices. Where V8's
/// message holds a lone surrogate (the token is half of an astral character,
/// or the window cuts through one), that unit is dropped, since a `String`
/// can't hold it; [`json_parse_error_utf16`] keeps it.
pub fn json_parse_error(text: &str) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let message = json_parse_error_utf16(&units)?;
    Some(char::decode_utf16(message).filter_map(Result::ok).collect())
}

/// [`json_parse_error`] on a JS string's UTF-16 code units, lone surrogates
/// included, with V8's message as code units.
pub fn json_parse_error_utf16(source: &[u16]) -> Option<Vec<u16>> {
    let mut p = JsonScanner {
        s: source,
        cursor: 0,
    };
    let fail = p.parse().err()?;
    Some(fail.message(source))
}

/// V8's `JsonToken` for one code unit (`one_char_json_tokens`; every unit
/// past Latin-1 is `ILLEGAL`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    Eos,
    String,
    Number,
    LBrace,
    RBrace,
    LBrack,
    RBrack,
    True,
    False,
    Null,
    Colon,
    Comma,
    Other,
}

fn token(c: Option<u16>) -> Token {
    let Some(c) = c else { return Token::Eos };
    match u8::try_from(c).map(char::from) {
        Ok('"') => Token::String,
        Ok('-' | '0'..='9') => Token::Number,
        Ok('{') => Token::LBrace,
        Ok('}') => Token::RBrace,
        Ok('[') => Token::LBrack,
        Ok(']') => Token::RBrack,
        Ok('t') => Token::True,
        Ok('f') => Token::False,
        Ok('n') => Token::Null,
        Ok(':') => Token::Colon,
        Ok(',') => Token::Comma,
        _ => Token::Other,
    }
}

/// Which V8 template a failure uses.
enum Template {
    /// `Unexpected end of JSON input`.
    End,
    /// `<reason> at position P (line L column C)`.
    At(&'static str),
    /// `Unexpected token 'T', …` with the source or a window of it, the
    /// token being the code unit at the position.
    Token(u16),
}

struct Fail {
    pos: usize,
    template: Template,
}

const UNEXPECTED_NUMBER: &str = "Unexpected number in JSON";
const UNEXPECTED_STRING: &str = "Unexpected string in JSON";
const EXPECTED_PROPERTY_NAME: &str = "Expected property name or '}' in JSON";
const EXPECTED_COMMA_OR_RBRACK: &str = "Expected ',' or ']' after array element in JSON";
const EXPECTED_COMMA_OR_RBRACE: &str = "Expected ',' or '}' after property value in JSON";
const EXPECTED_COLON: &str = "Expected ':' after property name in JSON";
const EXPECTED_QUOTED_NAME: &str = "Expected double-quoted property name in JSON";
const TRAILING: &str = "Unexpected non-whitespace character after JSON";
const BAD_ESCAPE: &str = "Bad escaped character in JSON";
const BAD_CONTROL: &str = "Bad control character in string literal in JSON";
const BAD_UNICODE_ESCAPE: &str = "Bad Unicode escape in JSON";
const UNTERMINATED_STRING: &str = "Unterminated string in JSON";
const NO_NUMBER_AFTER_MINUS: &str = "No number after minus sign in JSON";
const UNTERMINATED_FRACTION: &str = "Unterminated fractional number in JSON";
const EXPONENT_MISSING: &str = "Exponent part is missing a number in JSON";

/// Sources of fewer units than this are quoted whole; longer ones get a
/// window of `CONTEXT` units on each side of the token
/// (`kMinOriginalSourceLengthForContext`, `kMaxContextCharacters`).
const MIN_LENGTH_FOR_CONTEXT: usize = 21;
const CONTEXT: usize = 10;

/// V8's iterative `JsonParser::ParseJsonValue` reduced to validation: the
/// same steps in the same order, so every error lands where V8's does.
struct JsonScanner<'a> {
    s: &'a [u16],
    cursor: usize,
}

impl JsonScanner<'_> {
    fn current(&self) -> Option<u16> {
        self.s.get(self.cursor).copied()
    }

    fn is(&self, c: u8) -> bool {
        self.current() == Some(u16::from(c))
    }

    fn is_digit(&self) -> bool {
        self.current().is_some_and(|c| (0x30..=0x39).contains(&c))
    }

    fn skip_digits(&mut self) {
        while self.is_digit() {
            self.cursor += 1;
        }
    }

    fn at(&self, reason: &'static str) -> Fail {
        Fail {
            pos: self.cursor,
            template: Template::At(reason),
        }
    }

    /// `ReportUnexpectedCharacter(CurrentCharacter())`: a digit or `-` reads
    /// "Unexpected number", a quote "Unexpected string", the end of input
    /// "Unexpected end", anything else the token form.
    fn unexpected(&self) -> Fail {
        let template = match self.current() {
            None => Template::End,
            Some(c) => match token(Some(c)) {
                Token::Number => Template::At(UNEXPECTED_NUMBER),
                Token::String => Template::At(UNEXPECTED_STRING),
                _ => Template::Token(c),
            },
        };
        Fail {
            pos: self.cursor,
            template,
        }
    }

    /// `SkipWhitespace`: JSON's four whitespace characters only.
    fn skip_whitespace(&mut self) -> Token {
        while matches!(self.current(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.cursor += 1;
        }
        token(self.current())
    }

    /// `Check(token)`.
    fn check(&mut self, t: Token) -> bool {
        let found = self.skip_whitespace() == t;
        if found {
            self.cursor += 1;
        }
        found
    }

    /// `ExpectNext(token, message)`: the message whatever the token was,
    /// the end of input included.
    fn expect(&mut self, t: Token, reason: &'static str) -> Result<(), Fail> {
        if self.check(t) {
            Ok(())
        } else {
            Err(self.at(reason))
        }
    }

    fn parse(&mut self) -> Result<(), Fail> {
        // `true` for an object, `false` for an array.
        let mut open: Vec<bool> = Vec::new();
        loop {
            // Produce a value.
            match self.skip_whitespace() {
                Token::String => {
                    self.cursor += 1;
                    self.string()?;
                }
                Token::Number => self.number()?,
                Token::LBrace => {
                    self.cursor += 1;
                    if !self.check(Token::RBrace) {
                        open.push(true);
                        self.expect(Token::String, EXPECTED_PROPERTY_NAME)?;
                        self.string()?;
                        self.expect(Token::Colon, EXPECTED_COLON)?;
                        continue;
                    }
                }
                Token::LBrack => {
                    self.cursor += 1;
                    if !self.check(Token::RBrack) {
                        open.push(false);
                        continue;
                    }
                }
                Token::True => self.literal(b"true")?,
                Token::False => self.literal(b"false")?,
                Token::Null => self.literal(b"null")?,
                _ => return Err(self.unexpected()),
            }
            // Consume it: close finished containers, or move to the next
            // element or property.
            loop {
                match open.last() {
                    None => {
                        return if self.check(Token::Eos) {
                            Ok(())
                        } else {
                            Err(self.at(TRAILING))
                        };
                    }
                    Some(true) => {
                        if self.check(Token::Comma) {
                            self.expect(Token::String, EXPECTED_QUOTED_NAME)?;
                            self.string()?;
                            self.expect(Token::Colon, EXPECTED_COLON)?;
                            break;
                        }
                        self.expect(Token::RBrace, EXPECTED_COMMA_OR_RBRACE)?;
                    }
                    Some(false) => {
                        if self.check(Token::Comma) {
                            break;
                        }
                        self.expect(Token::RBrack, EXPECTED_COMMA_OR_RBRACK)?;
                    }
                }
                open.pop();
            }
        }
    }

    /// `ScanJsonString`, from just past the opening quote.
    fn string(&mut self) -> Result<(), Fail> {
        loop {
            match self.current() {
                None => return Err(self.at(UNTERMINATED_STRING)),
                Some(0x22) => {
                    self.cursor += 1;
                    return Ok(());
                }
                Some(0x5c) => {
                    self.cursor += 1;
                    match self.current().map(u8::try_from) {
                        // The end, or a unit past Latin-1, after the backslash.
                        None | Some(Err(_)) => return Err(self.unexpected()),
                        Some(Ok(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't')) => {}
                        Some(Ok(b'u')) => {
                            for _ in 0..4 {
                                self.cursor += 1;
                                let hex = self.current().map(u8::try_from);
                                if !matches!(hex, Some(Ok(h)) if h.is_ascii_hexdigit()) {
                                    return Err(self.at(BAD_UNICODE_ESCAPE));
                                }
                            }
                        }
                        Some(Ok(_)) => return Err(self.at(BAD_ESCAPE)),
                    }
                    self.cursor += 1;
                }
                Some(c) if c < 0x20 => return Err(self.at(BAD_CONTROL)),
                Some(_) => self.cursor += 1,
            }
        }
    }

    /// `ParseJsonNumber`, from the `-` or first digit.
    fn number(&mut self) -> Result<(), Fail> {
        if self.is(b'-') {
            self.cursor += 1;
        }
        if self.is(b'0') {
            self.cursor += 1;
            if self.is_digit() {
                return Err(self.at(UNEXPECTED_NUMBER));
            }
        } else if self.is_digit() {
            self.skip_digits();
        } else {
            return Err(self.at(NO_NUMBER_AFTER_MINUS));
        }
        if self.is(b'.') {
            self.cursor += 1;
            if !self.is_digit() {
                return Err(self.at(UNTERMINATED_FRACTION));
            }
            self.skip_digits();
        }
        if self.is(b'e') || self.is(b'E') {
            self.cursor += 1;
            if self.is(b'+') || self.is(b'-') {
                self.cursor += 1;
            }
            if !self.is_digit() {
                return Err(self.at(EXPONENT_MISSING));
            }
            self.skip_digits();
        }
        Ok(())
    }

    /// `ScanLiteral`: the first unit already matched its token.
    fn literal(&mut self, word: &[u8]) -> Result<(), Fail> {
        for &b in &word[1..] {
            self.cursor += 1;
            if !self.is(b) {
                return Err(self.unexpected());
            }
        }
        self.cursor += 1;
        Ok(())
    }
}

impl Fail {
    /// The `SyntaxError` message, as `ReportUnexpectedToken` builds it.
    fn message(&self, s: &[u16]) -> Vec<u16> {
        let mut out = Vec::new();
        let text = |out: &mut Vec<u16>, t: &str| out.extend(t.encode_utf16());
        let pos = self.pos;
        match self.template {
            Template::End => text(&mut out, "Unexpected end of JSON input"),
            Template::At(reason) => {
                let (line, column) = line_column(s, pos);
                text(
                    &mut out,
                    &format!("{reason} at position {pos} (line {line} column {column})"),
                );
            }
            Template::Token(_) if is_special_source(s) => {
                text(&mut out, "\"");
                out.extend_from_slice(s);
                text(&mut out, "\" is not valid JSON");
            }
            Template::Token(c) => {
                // The short form, or the start / surrounding / end window.
                let len = s.len();
                let (open, window, close) = if len < MIN_LENGTH_FOR_CONTEXT {
                    ("\"", s, "\"")
                } else if pos < CONTEXT {
                    ("\"", &s[..pos + CONTEXT], "\"...")
                } else if pos < len - CONTEXT {
                    ("...\"", &s[pos - CONTEXT..pos + CONTEXT], "\"...")
                } else {
                    ("...\"", &s[pos - CONTEXT..], "\"")
                };
                text(&mut out, "Unexpected token '");
                out.push(c);
                text(&mut out, "', ");
                text(&mut out, open);
                out.extend_from_slice(window);
                text(&mut out, close);
                text(&mut out, " is not valid JSON");
            }
        }
        out
    }
}

/// `JsonParser::IsSpecialString`: sources V8 quotes whole, with no token
/// (what `JSON.parse` gets from `String(x)` of an object, `undefined`,
/// `Infinity` or `NaN`).
fn is_special_source(s: &[u16]) -> bool {
    ["[object Object]", "undefined", "Infinity", "NaN"]
        .iter()
        .any(|special| s.iter().copied().eq(special.encode_utf16()))
}

/// `JsonParser::CalculateFileLocation`: 1-based line and column of `pos`.
/// Only `\r` and `\n` break lines, and `\r\n` counts once.
fn line_column(s: &[u16], pos: usize) -> (usize, usize) {
    let (mut line, mut line_start, mut i) = (1, 0, 0);
    while i < pos {
        if s[i] == 0x0d && i + 1 < pos && s[i + 1] == 0x0a {
            i += 1;
        }
        if s[i] == 0x0d || s[i] == 0x0a {
            line += 1;
            line_start = i + 1;
        }
        i += 1;
    }
    (line, 1 + pos - line_start)
}

/// Rewrites text V8 accepts so serde_json can hold it: a `\u` escape of a
/// lone surrogate becomes `\ufffd`, a number out of `f64` range `null`.
fn representable(text: &str) -> String {
    let b = text.as_bytes();
    // The code unit of the `\uXXXX` escape at `i` (V8 checked its digits).
    let unit = |i: usize| u32::from_str_radix(&text[i + 2..i + 6], 16).ok();
    let is_low =
        |i: usize| text[i..].starts_with("\\u") && matches!(unit(i), Some(0xdc00..=0xdfff));
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut i, mut in_string) = (0, 0, false);
    while i < b.len() {
        match (in_string, b[i]) {
            (true, b'"') => in_string = false,
            (true, b'\\') if b[i + 1] == b'u' => {
                let u = unit(i);
                if matches!(u, Some(0xd800..=0xdbff)) && is_low(i + 6) {
                    i += 6; // a pair: keep both escapes
                } else if matches!(u, Some(0xd800..=0xdfff)) {
                    out.push_str(&text[copied..i]);
                    out.push_str("\\ufffd");
                    copied = i + 6;
                }
                i += 5;
            }
            (true, b'\\') => i += 1,
            (false, b'"') => in_string = true,
            (false, b'-' | b'0'..=b'9') => {
                let len = b[i..]
                    .iter()
                    .take_while(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                    .count();
                if text[i..i + len].parse::<f64>().is_ok_and(f64::is_infinite) {
                    out.push_str(&text[copied..i]);
                    out.push_str("null");
                    copied = i + len;
                }
                i += len - 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_js() {
        // Expected values from node: `String(x)` / `JSON.stringify(x)`.
        for (x, js) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (100.0, "100"),
            (123456789.0, "123456789"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (2f64.powi(60), "1152921504606847000"),
            (12345678901234567890.0, "12345678901234567000"),
            (0.000001, "0.000001"),
            (0.00000123, "0.00000123"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (f64::NAN, "null"),
            (f64::INFINITY, "null"),
        ] {
            assert_eq!(number_to_string(x), js, "{x:e}");
        }
    }

    #[test]
    fn stringify_normalizes_numbers_and_keeps_order() {
        let v: Value =
            serde_json::from_str(r#"{"b":1.0,"a":[1e2,-0,1E21,12345678901234567890],"s":"é\n\u001f\"","n":null,"t":true}"#)
                .unwrap();
        assert_eq!(
            stringify(&v),
            r#"{"b":1,"a":[100,0,1e+21,12345678901234567000],"s":"é\n\u001f\"","n":null,"t":true}"#
        );
    }

    #[test]
    fn integer_keys_enumerate_first() {
        // node: JSON.stringify(JSON.parse(this))
        let v: Value = serde_json::from_str(
            r#"{"b":1,"10":2,"2":3,"01":4,"-1":5,"4294967295":6,"4294967294":7,"0":8}"#,
        )
        .unwrap();
        assert_eq!(
            stringify(&v),
            r#"{"0":8,"2":3,"10":2,"4294967294":7,"b":1,"01":4,"-1":5,"4294967295":6}"#
        );
    }

    #[test]
    fn to_string_matches_js_string() {
        // node: String(JSON.parse(this)), and String(undefined).
        assert_eq!(to_string(None), "undefined");
        for (raw, js) in [
            (r#""a b""#, "a b"),
            ("null", "null"),
            ("true", "true"),
            ("1.0", "1"),
            ("1e21", "1e+21"),
            (
                r#"["a",2,null,[3,[4,null]],{"x":1},true]"#,
                "a,2,,3,4,,[object Object],true",
            ),
            ("[]", ""),
            ("[null]", ""),
            (r#"{"a":1}"#, "[object Object]"),
        ] {
            assert_eq!(
                to_string(Some(&serde_json::from_str(raw).unwrap())),
                js,
                "{raw}"
            );
        }
    }

    #[test]
    fn truthiness_entries_prop_dedupe() {
        for falsy in [json!(null), json!(false), json!(0), json!(0.0), json!("")] {
            assert!(!truthy(&falsy), "{falsy}");
        }
        for t in [json!(true), json!(1), json!("0"), json!([]), json!({})] {
            assert!(truthy(&t), "{t}");
        }
        assert_eq!(
            entries(&json!(["x", 2])),
            [("0".into(), json!("x")), ("1".into(), json!(2))]
        );
        assert_eq!(entries(&json!("ab")).len(), 2);
        assert_eq!(trim("\u{feff}\u{a0} {x}\n\u{2028}"), "{x}");
        assert_eq!(trim("\u{85}{x}"), "\u{85}{x}");
        assert!(entries(&json!(5)).is_empty());
        let o = json!({"a": null, "b": {"c": 1}});
        assert_eq!(prop(Some(&o), "a"), Some(&Value::Null));
        assert_eq!(prop(Some(&o), "z"), None);
        assert_eq!(prop(prop(Some(&o), "b"), "c"), Some(&json!(1)));
        assert_eq!(prop(Some(&json!([1])), "0"), None);
        assert_eq!(prop(None, "a"), None);
        assert_eq!(
            dedupe(vec![
                json!("a"),
                json!(1),
                json!("a"),
                json!(1.0),
                json!({"x": 1}),
                json!({"x": 1}),
                json!(null),
                json!(null)
            ]),
            [
                json!("a"),
                json!(1),
                json!({"x": 1}),
                json!({"x": 1}),
                json!(null)
            ]
        );
    }
}
