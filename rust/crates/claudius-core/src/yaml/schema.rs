//! Port of yaml 2.9.0's `schema/` (the `core` schema with its known tags,
//! and `yaml-1.1` for `%YAML 1.1` documents) and `doc/directives.js`.

use std::sync::LazyLock;

use regex::Regex;

use super::compose::{Kind, Node, Pair, Report, SeqItem};
use super::{SVal, U16s, eq_ascii, units_to_string};

pub(super) const MAP_TAG: &str = "tag:yaml.org,2002:map";
pub(super) const SEQ_TAG: &str = "tag:yaml.org,2002:seq";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tag {
    Map,
    Seq,
    Str,
    Null,
    Bool,
    IntOct,
    Int,
    IntHex,
    FloatNaN,
    FloatExp,
    Float,
    True11,
    False11,
    IntBin11,
    IntOct11,
    Int11,
    IntHex11,
    FloatExp11,
    Float11,
    Binary,
    Merge,
    OMap,
    Pairs,
    Set,
    IntTime,
    FloatTime,
    Timestamp,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Default {
    No,
    Yes,
    /// `default: 'key'`: only by test at a mapping key (the merge `<<`).
    Key,
}

macro_rules! re {
    ($name:ident, $src:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($src).expect("tag regex"));
    };
}

re!(NULL_RE, r"^(?:~|[Nn]ull|NULL)?$");
re!(BOOL_RE, r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$");
re!(INT_OCT_RE, r"^0o[0-7]+$");
re!(INT_RE, r"^[-+]?[0-9]+$");
re!(INT_HEX_RE, r"^0x[0-9a-fA-F]+$");
re!(
    FLOAT_NAN_RE,
    r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"
);
re!(
    FLOAT_EXP_RE,
    r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$"
);
re!(FLOAT_RE, r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$");
re!(TRUE11_RE, r"^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$");
re!(FALSE11_RE, r"^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$");
re!(INT_BIN11_RE, r"^[-+]?0b[0-1_]+$");
re!(INT_OCT11_RE, r"^[-+]?0[0-7_]+$");
re!(INT11_RE, r"^[-+]?[0-9][0-9_]*$");
re!(INT_HEX11_RE, r"^[-+]?0x[0-9a-fA-F_]+$");
re!(
    FLOAT_EXP11_RE,
    r"^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$"
);
re!(FLOAT11_RE, r"^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$");
re!(MERGE_RE, r"^<<$");
re!(INT_TIME_RE, r"^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$");
re!(
    FLOAT_TIME_RE,
    r"^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$"
);
re!(
    TIMESTAMP_RE,
    r"^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\.[0-9]+)?)(?:[ \t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"
);

impl Tag {
    pub(super) fn name(self) -> &'static str {
        match self {
            Tag::Map => MAP_TAG,
            Tag::Seq => SEQ_TAG,
            Tag::Str => "tag:yaml.org,2002:str",
            Tag::Null => "tag:yaml.org,2002:null",
            Tag::Bool | Tag::True11 | Tag::False11 => "tag:yaml.org,2002:bool",
            Tag::IntOct
            | Tag::Int
            | Tag::IntHex
            | Tag::IntBin11
            | Tag::IntOct11
            | Tag::Int11
            | Tag::IntHex11 => "tag:yaml.org,2002:int",
            Tag::IntTime => "tag:yaml.org,2002:int",
            Tag::FloatNaN
            | Tag::FloatExp
            | Tag::Float
            | Tag::FloatExp11
            | Tag::Float11
            | Tag::FloatTime => "tag:yaml.org,2002:float",
            Tag::Binary => "tag:yaml.org,2002:binary",
            Tag::Merge => "tag:yaml.org,2002:merge",
            Tag::OMap => "tag:yaml.org,2002:omap",
            Tag::Pairs => "tag:yaml.org,2002:pairs",
            Tag::Set => "tag:yaml.org,2002:set",
            Tag::Timestamp => "tag:yaml.org,2002:timestamp",
        }
    }

    /// `tag.format` (a resolved scalar keeps it, and the stringifier picks
    /// the tag with the same format).
    pub(super) fn format(self) -> Option<&'static str> {
        match self {
            Tag::IntOct | Tag::IntOct11 => Some("OCT"),
            Tag::IntHex | Tag::IntHex11 => Some("HEX"),
            Tag::IntBin11 => Some("BIN"),
            Tag::FloatExp | Tag::FloatExp11 => Some("EXP"),
            Tag::IntTime | Tag::FloatTime => Some("TIME"),
            _ => None,
        }
    }

    /// One of yaml's `coreKnownTags`, which a `core` document adds to its
    /// schema's tags the first time it resolves one by name.
    pub(super) fn is_core_known(self) -> bool {
        CORE_KNOWN.contains(&self)
    }

    /// `tag.collection`: `Some(true)` for `'map'`, `Some(false)` for `'seq'`.
    fn collection(self) -> Option<bool> {
        match self {
            Tag::Map | Tag::Set => Some(true),
            Tag::Seq | Tag::OMap | Tag::Pairs => Some(false),
            _ => None,
        }
    }

    fn default(self) -> Default {
        match self {
            Tag::Binary | Tag::OMap | Tag::Pairs | Tag::Set => Default::No,
            Tag::Merge => Default::Key,
            _ => Default::Yes,
        }
    }

    /// `tag.test?.test(value)`; `None` when the tag has no test.
    pub(super) fn test(self, value: &str) -> Option<bool> {
        let re: &Regex = match self {
            Tag::Null => &NULL_RE,
            Tag::Bool => &BOOL_RE,
            Tag::IntOct => &INT_OCT_RE,
            Tag::Int => &INT_RE,
            Tag::IntHex => &INT_HEX_RE,
            Tag::FloatNaN => &FLOAT_NAN_RE,
            Tag::FloatExp => &FLOAT_EXP_RE,
            Tag::Float => &FLOAT_RE,
            Tag::True11 => &TRUE11_RE,
            Tag::False11 => &FALSE11_RE,
            Tag::IntBin11 => &INT_BIN11_RE,
            Tag::IntOct11 => &INT_OCT11_RE,
            Tag::Int11 => &INT11_RE,
            Tag::IntHex11 => &INT_HEX11_RE,
            Tag::FloatExp11 => &FLOAT_EXP11_RE,
            Tag::Float11 => &FLOAT11_RE,
            Tag::Merge => &MERGE_RE,
            Tag::IntTime => &INT_TIME_RE,
            Tag::FloatTime => &FLOAT_TIME_RE,
            Tag::Timestamp => &TIMESTAMP_RE,
            Tag::Map | Tag::Seq | Tag::Str | Tag::Binary | Tag::OMap | Tag::Pairs | Tag::Set => {
                return None;
            }
        };
        Some(re.is_match(value))
    }
}

const CORE: &[Tag] = &[
    Tag::Map,
    Tag::Seq,
    Tag::Str,
    Tag::Null,
    Tag::Bool,
    Tag::IntOct,
    Tag::Int,
    Tag::IntHex,
    Tag::FloatNaN,
    Tag::FloatExp,
    Tag::Float,
];

const YAML11: &[Tag] = &[
    Tag::Map,
    Tag::Seq,
    Tag::Str,
    Tag::Null,
    Tag::True11,
    Tag::False11,
    Tag::IntBin11,
    Tag::IntOct11,
    Tag::Int11,
    Tag::IntHex11,
    Tag::FloatNaN,
    Tag::FloatExp11,
    Tag::Float11,
    Tag::Binary,
    Tag::Merge,
    Tag::OMap,
    Tag::Pairs,
    Tag::Set,
    Tag::IntTime,
    Tag::FloatTime,
    Tag::Timestamp,
];

/// `coreKnownTags` (resolved only for the 1.2 `core` schema).
const CORE_KNOWN: &[Tag] = &[
    Tag::Binary,
    Tag::Merge,
    Tag::OMap,
    Tag::Pairs,
    Tag::Set,
    Tag::Timestamp,
];

/// A document's `Schema`: `core` (with `resolveKnownTags`) or `yaml-1.1`.
///
/// yaml pushes a copy of each known tag it resolves into `schema.tags`, with
/// `default: false` (and no `test` for scalars); those copies resolve the
/// same way and are never picked by test, so they aren't modelled.
#[derive(Debug, Clone, Copy)]
pub(super) struct Schema {
    pub yaml11: bool,
}

impl Schema {
    pub(super) fn tags(self) -> &'static [Tag] {
        if self.yaml11 { YAML11 } else { CORE }
    }

    pub(super) fn known_tag(self, name: &[u16]) -> Option<Tag> {
        if self.yaml11 {
            return None;
        }
        CORE_KNOWN
            .iter()
            .copied()
            .find(|t| eq_ascii(name, t.name()))
    }

    /// `findScalarTagByTest(ctx, value, token, onError)` (no `compat`).
    pub(super) fn find_by_test(self, value: &[u16], at_key: bool) -> Tag {
        let v = units_to_string(value);
        self.tags()
            .iter()
            .copied()
            .find(|t| {
                (t.default() == Default::Yes || (at_key && t.default() == Default::Key))
                    && t.test(&v) == Some(true)
            })
            .unwrap_or(Tag::Str)
    }

    /// The tag `findScalarTagByName` settles on, `None` being "Unresolved
    /// tag" (the caller reports it and falls back to `str`).
    pub(super) fn find_by_name(self, value: &[u16], name: &[u16]) -> Option<Tag> {
        let v = units_to_string(value);
        let mut with_test: Vec<Tag> = Vec::new();
        for &tag in self.tags() {
            if tag.collection().is_none() && eq_ascii(name, tag.name()) {
                if tag.default() != Default::No && tag.test(&v).is_some() {
                    with_test.push(tag);
                } else {
                    return Some(tag);
                }
            }
        }
        if let Some(tag) = with_test.into_iter().find(|t| t.test(&v) == Some(true)) {
            return Some(tag);
        }
        self.known_tag(name).filter(|kt| kt.collection().is_none())
    }

    /// `schema.tags.find(t => t.tag === tagName && t.collection === expType)`,
    /// then the known tag of that collection type.
    pub(super) fn find_collection(self, name: &[u16], is_map: bool) -> Option<Tag> {
        self.tags()
            .iter()
            .copied()
            .find(|t| eq_ascii(name, t.name()) && t.collection() == Some(is_map))
            .or_else(|| {
                self.known_tag(name)
                    .filter(|kt| kt.collection() == Some(is_map))
            })
    }

    /// `tags.some(tag => tag.default && tag.tag !== str && tag.test?.test(s))`:
    /// would `s` written plain read back as something other than a string?
    pub(super) fn reads_as_non_string(self, s: &str) -> bool {
        self.tags()
            .iter()
            .any(|t| t.default() != Default::No && *t != Tag::Str && t.test(s) == Some(true))
    }

    /// The null tag's `stringify`: the source when it reads as null.
    pub(super) fn null_source_ok(s: &str) -> bool {
        NULL_RE.is_match(s)
    }

    /// The bool tag's `stringify`: whether the source reads back as `value`.
    pub(super) fn bool_source_ok(self, s: &str, value: bool) -> bool {
        if s.is_empty() {
            return false;
        }
        if self.yaml11 {
            if value {
                TRUE11_RE.is_match(s)
            } else {
                FALSE11_RE.is_match(s)
            }
        } else {
            BOOL_RE.is_match(s) && matches!(s.as_bytes()[0], b't' | b'T') == value
        }
    }

    /// Whether `<<` keys merge by default (`yaml-1.1`'s merge tag).
    pub(super) fn merge_default(self) -> bool {
        self.yaml11
    }
}

/// `tag.resolve(value, onError, options)` for a scalar tag: the value and
/// whether it's the merge key (`addToJSMap`); `Err` when it throws.
pub(super) fn resolve_scalar(
    tag: Tag,
    value: &[u16],
    _schema: &Schema,
) -> Result<(SVal, bool), ()> {
    let s = units_to_string(value);
    let num = |n: f64| Ok((SVal::Num(n), false));
    match tag {
        Tag::Str | Tag::Map | Tag::Seq | Tag::OMap | Tag::Pairs | Tag::Set => {
            Ok((SVal::Str(value.to_vec()), false))
        }
        Tag::Null => Ok((SVal::Null, false)),
        Tag::Bool => Ok((
            SVal::Bool(matches!(s.as_bytes().first(), Some(b't' | b'T'))),
            false,
        )),
        Tag::True11 => Ok((SVal::Bool(true), false)),
        Tag::False11 => Ok((SVal::Bool(false), false)),
        Tag::IntOct => num(js_parse_int(s.get(2..).unwrap_or(""), 8)),
        Tag::Int => num(js_parse_int(&s, 10)),
        Tag::IntHex => num(js_parse_int(s.get(2..).unwrap_or(""), 16)),
        Tag::IntBin11 => num(int11(&s, 2, 2)),
        Tag::IntOct11 => num(int11(&s, 1, 8)),
        Tag::Int11 => num(int11(&s, 0, 10)),
        Tag::IntHex11 => num(int11(&s, 2, 16)),
        Tag::FloatNaN => {
            let lower = s
                .get(s.len().saturating_sub(3)..)
                .unwrap_or("")
                .to_ascii_lowercase();
            num(if lower == "nan" {
                f64::NAN
            } else if s.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            })
        }
        Tag::FloatExp | Tag::Float => num(js_parse_float(&s)),
        Tag::FloatExp11 | Tag::Float11 => num(js_parse_float(&s.replace('_', ""))),
        Tag::IntTime | Tag::FloatTime => num(parse_sexagesimal(&s)),
        Tag::Binary => Ok((SVal::Buffer(node_base64_decode(value)), false)),
        Tag::Merge => Ok((SVal::Sym, true)),
        Tag::Timestamp => timestamp(&s).map(|t| (SVal::Date(t), false)),
    }
}

/// `tag.resolve(coll, onError)` for a collection tag; the number of
/// `onError` calls (each a `TAG_RESOLVE_FAILED` error).
pub(super) fn resolve_collection(tag: Tag, coll: &mut Node, next_id: &mut usize) -> usize {
    match tag {
        Tag::Set => {
            let ok = match &coll.kind {
                Kind::Map { items, .. } => items.iter().all(|p| match p.value.as_deref() {
                    None => true,
                    Some(n) => {
                        matches!(
                            n.kind,
                            Kind::Scalar {
                                value: SVal::Null,
                                ..
                            }
                        ) && n.comment_before.is_empty()
                            && n.comment.is_empty()
                            && n.tag.is_none()
                    }
                }),
                _ => false,
            };
            usize::from(!ok)
        }
        Tag::OMap | Tag::Pairs => {
            let mut errors = resolve_pairs(coll, next_id);
            if tag == Tag::OMap
                && let Kind::Seq { items, .. } = &coll.kind
            {
                let mut seen: Vec<&SVal> = Vec::new();
                for item in items {
                    if let SeqItem::Pair(Pair { key, .. }) = item
                        && let Kind::Scalar { value, .. } = &key.kind
                    {
                        if seen.iter().any(|s| same_value_zero(s, value)) {
                            errors += 1;
                        } else {
                            seen.push(value);
                        }
                    }
                }
            }
            errors
        }
        _ => 0,
    }
}

/// `seenKeys.includes(key.value)` (SameValueZero; objects never repeat).
fn same_value_zero(a: &SVal, b: &SVal) -> bool {
    match (a, b) {
        (SVal::Null, SVal::Null) => true,
        (SVal::Bool(x), SVal::Bool(y)) => x == y,
        (SVal::Num(x), SVal::Num(y)) => x == y || (x.is_nan() && y.is_nan()),
        (SVal::Str(x), SVal::Str(y)) => x == y,
        _ => false,
    }
}

/// `resolvePairs(seq, onError)`: every item becomes a `Pair`.
fn resolve_pairs(coll: &mut Node, next_id: &mut usize) -> usize {
    let Kind::Seq { items, .. } = &mut coll.kind else {
        return 1;
    };
    let mut errors = 0;
    let old = std::mem::take(items);
    for item in old {
        let item = match item {
            SeqItem::Pair(p) => SeqItem::Pair(p),
            SeqItem::Node(node) => match node.kind {
                Kind::Map { items: pairs, .. } => {
                    if pairs.len() > 1 {
                        errors += 1;
                    }
                    match pairs.into_iter().next() {
                        Some(p) => SeqItem::Pair(p),
                        None => {
                            let id = *next_id;
                            *next_id += 1;
                            let key = Node {
                                id,
                                kind: Kind::Scalar {
                                    value: SVal::Null,
                                    ty: None,
                                    merge: false,
                                    source: Vec::new(),
                                    rtag: Tag::Null,
                                },
                                anchor: None,
                                tag: None,
                                comment: Vec::new(),
                                comment_before: Vec::new(),
                                space_before: false,
                                range: [0, 0, 0],
                            };
                            SeqItem::Pair(Pair {
                                key: Box::new(key),
                                value: None,
                            })
                        }
                    }
                }
                _ => SeqItem::Pair(Pair {
                    key: Box::new(node),
                    value: None,
                }),
            },
        };
        items.push(item);
    }
    errors
}

// ---- numbers ------------------------------------------------------------------

/// `parseInt(s, radix)` for an ASCII digit string with an optional sign:
/// the longest run of valid digits, `NaN` when there is none. Radix 10 is
/// correctly rounded (as V8's strtod), and so are the power-of-two radixes.
pub(super) fn js_parse_int(s: &str, radix: u32) -> f64 {
    let s = claudius_agent::js::trim(s);
    let (neg, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let mut rest = rest;
    if radix == 16 && (rest.starts_with("0x") || rest.starts_with("0X")) {
        rest = &rest[2..];
    }
    let digits: &str =
        &rest[..rest.len() - rest.trim_start_matches(|c: char| c.is_digit(radix)).len()];
    if digits.is_empty() {
        return f64::NAN;
    }
    let x = if radix == 10 {
        digits.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        pow2_digits_to_f64(digits, radix)
    };
    if neg { -x } else { x }
}

/// Digits in radix 2, 4, 8, 16 or 32 to the nearest `f64` (ties to even).
fn pow2_digits_to_f64(digits: &str, radix: u32) -> f64 {
    let bits_per = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::new();
    for c in digits.chars() {
        let d = c.to_digit(radix).unwrap_or(0);
        for b in (0..bits_per).rev() {
            bits.push((d >> b) & 1 == 1);
        }
    }
    let Some(first) = bits.iter().position(|b| *b) else {
        return 0.0;
    };
    let bits = &bits[first..];
    let n = bits.len();
    if n <= 53 {
        let mut m: u64 = 0;
        for b in bits {
            m = (m << 1) | u64::from(*b);
        }
        return m as f64;
    }
    let mut m: u64 = 0;
    for b in &bits[..53] {
        m = (m << 1) | u64::from(*b);
    }
    let round = bits[53];
    let sticky = bits[54..].iter().any(|b| *b);
    if round && (sticky || m & 1 == 1) {
        m += 1;
    }
    let exp = (n - 53) as i32;
    if exp > 1100 {
        return f64::INFINITY;
    }
    (m as f64) * 2f64.powi(exp)
}

/// yaml-1.1's `intResolve`: sign, prefix, `_` separators, then `parseInt`.
fn int11(s: &str, offset: usize, radix: u32) -> f64 {
    let sign = s.as_bytes().first().copied();
    let off = if matches!(sign, Some(b'-' | b'+')) {
        offset + 1
    } else {
        offset
    };
    let digits = s.get(off..).unwrap_or("").replace('_', "");
    let n = js_parse_int(&digits, radix);
    if sign == Some(b'-') { -n } else { n }
}

/// `parseFloat(s)`: the longest `StrDecimalLiteral` prefix after leading
/// white space, `NaN` when there is none.
pub(super) fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(claudius_agent::js::is_whitespace);
    let b = t.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i = 1;
    }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits_from = |j: usize| b[j..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits_from(i);
    let mut j = i + int;
    let mut frac = 0;
    if b.get(j) == Some(&b'.') {
        frac = digits_from(j + 1);
        if int + frac > 0 {
            j += 1 + frac;
        }
    }
    if int + frac == 0 {
        return f64::NAN;
    }
    if matches!(b.get(j), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(j + 1), Some(b'+' | b'-')));
        let exp = digits_from(j + 1 + sign);
        if exp > 0 {
            j += 1 + sign + exp;
        }
    }
    t[..j].parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseSexagesimal(str, false)`.
fn parse_sexagesimal(s: &str) -> f64 {
    let sign = s.as_bytes().first().copied();
    let parts = if matches!(sign, Some(b'-' | b'+')) {
        &s[1..]
    } else {
        s
    };
    let res = parts
        .replace('_', "")
        .split(':')
        .fold(0.0, |res, p| res * 60.0 + claudius_agent::js::to_number(p));
    if sign == Some(b'-') { -res } else { res }
}

// ---- timestamps -----------------------------------------------------------

const MS_PER_DAY: f64 = 86_400_000.0;

/// The stringify of the tag `getTagObject` picks for a number that `rtag`
/// resolved from `source` (`explicit`: the node's own tag): `0o`/`0x`/`0b`
/// integers, exponentials and sexagesimals keep their format, and floats
/// their trailing fraction zeros.
pub(super) fn number_string(n: f64, rtag: Tag, source: &[u16], explicit: Option<&[u16]>) -> String {
    let radix = |bits: u32, prefix: &str, signed: bool| {
        if n.fract() != 0.0 || !n.is_finite() || (!signed && n < 0.0) {
            return stringify_number(n, 0);
        }
        let digits = pow2_radix(n.abs(), bits);
        if n < 0.0 {
            format!("-{prefix}{digits}")
        } else {
            format!("{prefix}{digits}")
        }
    };
    match rtag {
        Tag::IntOct => radix(3, "0o", false),
        Tag::IntHex => radix(4, "0x", false),
        Tag::IntBin11 => radix(1, "0b", true),
        Tag::IntOct11 => radix(3, "0", true),
        Tag::IntHex11 => radix(4, "0x", true),
        Tag::FloatExp | Tag::FloatExp11 if n.is_finite() => {
            let e = format!("{n:e}");
            match e.split_once('e') {
                Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}"),
                _ => e,
            }
        }
        Tag::IntTime | Tag::FloatTime => sexagesimal(n),
        Tag::Float | Tag::Float11
            if explicit.is_none_or(|t| eq_ascii(t, "tag:yaml.org,2002:float")) =>
        {
            let src = units_to_string(source);
            let frac = src.find('.').map_or(String::new(), |dot| {
                let f = &src[dot + 1..];
                if rtag == Tag::Float11 {
                    f.replace('_', "")
                } else {
                    f.to_string()
                }
            });
            let min = if src.contains('.') && frac.ends_with('0') {
                frac.len()
            } else {
                0
            };
            stringify_number(n, min)
        }
        _ => stringify_number(n, 0),
    }
}

/// `stringifyNumber(node)`.
fn stringify_number(n: f64, min_fraction_digits: usize) -> String {
    if !n.is_finite() {
        return if n.is_nan() {
            ".nan".into()
        } else if n < 0.0 {
            "-.inf".into()
        } else {
            ".inf".into()
        };
    }
    let mut s = if n == 0.0 && n.is_sign_negative() {
        "-0".to_string()
    } else {
        claudius_agent::js::number_to_string(n)
    };
    if min_fraction_digits > 0 && !s.contains('e') {
        let i = match s.find('.') {
            Some(i) => i,
            None => {
                s.push('.');
                s.len() - 1
            }
        };
        let have = s.len() - i - 1;
        for _ in have..min_fraction_digits {
            s.push('0');
        }
    }
    s
}

/// `n.toString(2 ** bits)` for a non-negative integer (exact, as V8's is
/// for power-of-two radixes).
fn pow2_radix(n: f64, bits: u32) -> String {
    if n == 0.0 {
        return "0".into();
    }
    let raw = n.to_bits();
    let exp = ((raw >> 52) & 0x7ff) as i64 - 1075;
    let mut mant = (raw & ((1u64 << 52) - 1)) | (1u64 << 52);
    let mut zeros = 0usize;
    if exp < 0 {
        mant >>= -exp;
    } else {
        zeros = exp as usize;
    }
    let mut bin = format!("{mant:b}");
    bin.extend(std::iter::repeat_n('0', zeros));
    let k = bits as usize;
    let pad = (k - bin.len() % k) % k;
    let bin = format!("{}{bin}", "0".repeat(pad));
    bin.as_bytes()
        .chunks(k)
        .map(|c| {
            let v = c.iter().fold(0u32, |a, b| a * 2 + u32::from(b - b'0'));
            char::from_digit(v, 1 << bits).expect("digit")
        })
        .collect()
}

/// yaml-1.1's `stringifySexagesimal(node)`.
fn sexagesimal(n: f64) -> String {
    if !n.is_finite() {
        return stringify_number(n, 0);
    }
    let (sign, mut value) = if n < 0.0 { ("-", -n) } else { ("", n) };
    let mut parts = vec![value % 60.0];
    if value < 60.0 {
        parts.insert(0, 0.0);
    } else {
        value = (value - parts[0]) / 60.0;
        parts.insert(0, value % 60.0);
        if value >= 60.0 {
            value = (value - parts[0]) / 60.0;
            parts.insert(0, value);
        }
    }
    let joined = parts
        .iter()
        .map(|p| format!("{:0>2}", claudius_agent::js::number_to_string(*p)))
        .collect::<Vec<_>>()
        .join(":");
    static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"000000\d*$").expect("tail regex"));
    format!("{sign}{}", TAIL.replace(&joined, ""))
}

/// Days from 1970-01-01 to `y`-(`m0` + 1)-01, proleptic Gregorian, `m0` in
/// 0..12 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m0: i64) -> i64 {
    let m = m0 + 1;
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `MakeDay(year, month, date)`.
fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !year.is_finite() || !month.is_finite() || !date.is_finite() {
        return f64::NAN;
    }
    let (y, m, dt) = (year.trunc(), month.trunc(), date.trunc());
    let ym = y + (m / 12.0).floor();
    if ym.abs() > 400_000.0 {
        return f64::NAN;
    }
    let mn = m.rem_euclid(12.0);
    days_from_civil(ym as i64, mn as i64) as f64 + dt - 1.0
}

/// `MakeTime(hour, min, sec, ms)`.
fn make_time(h: f64, m: f64, s: f64, ms: f64) -> f64 {
    if !h.is_finite() || !m.is_finite() || !s.is_finite() || !ms.is_finite() {
        return f64::NAN;
    }
    h.trunc() * 3_600_000.0 + m.trunc() * 60_000.0 + s.trunc() * 1000.0 + ms.trunc()
}

fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return f64::NAN;
    }
    t.trunc() + 0.0
}

/// `Date.UTC(y, m, d, h, min, s, ms)`.
fn date_utc(y: f64, m: f64, d: f64, h: f64, min: f64, s: f64, ms: f64) -> f64 {
    let yr = if !y.is_nan() && (0.0..=99.0).contains(&y.trunc()) {
        1900.0 + y.trunc()
    } else {
        y
    };
    time_clip(make_day(yr, m, d) * MS_PER_DAY + make_time(h, min, s, ms))
}

/// The timestamp tag's `resolve(str)`: the `Date`'s time value, `Err` when
/// it throws (no `yyyy-mm-dd` match).
fn timestamp(s: &str) -> Result<f64, ()> {
    let caps = TIMESTAMP_RE.captures(s).ok_or(())?;
    let num = |i: usize| {
        caps.get(i)
            .map_or(f64::NAN, |m| claudius_agent::js::to_number(m.as_str()))
    };
    let or0 = |v: f64| if v.is_nan() || v == 0.0 { 0.0 } else { v };
    let (year, month, day) = (num(1), num(2), num(3));
    let (hour, minute, second) = (num(4), num(5), num(6));
    let millisec = match caps.get(7) {
        Some(m) => {
            let padded = format!("{}00", m.as_str());
            claudius_agent::js::to_number(padded.get(1..4).unwrap_or(""))
        }
        None => 0.0,
    };
    let mut date = date_utc(
        year,
        month - 1.0,
        day,
        or0(hour),
        or0(minute),
        or0(second),
        millisec,
    );
    if let Some(tz) = caps.get(8)
        && tz.as_str() != "Z"
    {
        let mut d = parse_sexagesimal(tz.as_str());
        if d.abs() < 30.0 {
            d *= 60.0;
        }
        date -= 60000.0 * d;
    }
    Ok(time_clip(date))
}

/// The civil date of a time value: (year, month 1-12, day, h, m, s, ms,
/// weekday 0 = Sunday).
pub(super) fn civil(t: f64) -> (i64, i64, i64, i64, i64, i64, i64, i64) {
    let t = t as i64;
    let days = t.div_euclid(86_400_000);
    let ms_of_day = t.rem_euclid(86_400_000);
    // civil_from_days
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let weekday = (days + 4).rem_euclid(7);
    (
        y,
        m,
        d,
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1000 % 60,
        ms_of_day % 1000,
        weekday,
    )
}

/// `Date.prototype.toISOString` (`None` for an invalid date).
pub(super) fn date_iso(t: f64) -> Option<String> {
    if t.is_nan() {
        return None;
    }
    let (y, mo, d, h, mi, s, ms, _) = civil(t);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    Some(format!(
        "{year}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z"
    ))
}

/// `Date.prototype.toString` in UTC. (The JS prints local time with the
/// zone's name; the port assumes `TZ=UTC`.)
pub(super) fn date_string(t: f64) -> String {
    if t.is_nan() {
        return "Invalid Date".into();
    }
    let (y, mo, d, h, mi, s, _, wd) = civil(t);
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let year = if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("{y:04}")
    };
    format!(
        "{} {} {d:02} {year} {h:02}:{mi:02}:{s:02} GMT+0000 (Coordinated Universal Time)",
        DAYS[wd as usize],
        MONTHS[(mo - 1) as usize]
    )
}

// ---- base64 ---------------------------------------------------------------

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

/// `Buffer.from(src, 'base64')` (node's forgiving decoder): characters
/// outside the base64 / base64url alphabets are skipped, `=` ends the
/// input, and each UTF-16 unit is read by its low byte.
pub(super) fn node_base64_decode(src: &[u16]) -> Vec<u8> {
    let srclen = src.len();
    let eq = u16::from(b'=');
    // Base64DecodedSize
    let decoded_size = if srclen < 2 {
        0
    } else {
        let mut size = srclen;
        if src[size - 1] == eq {
            size -= 1;
            if src[size - 1] == eq {
                size -= 1;
            }
        }
        let rem = size % 4;
        let mut s = size / 4 * 3;
        if rem != 0 {
            if s == 0 && rem == 1 {
                s = 0;
            } else {
                s += 1 + usize::from(rem == 3);
            }
        }
        s
    };
    // base64ByteLength on the JS side
    let dstlen = {
        let mut bytes = srclen;
        if bytes >= 1 && src[bytes - 1] == eq {
            bytes -= 1;
        }
        if bytes > 1 && src[bytes - 1] == eq {
            bytes -= 1;
        }
        (bytes * 3) >> 2
    };
    let cap = dstlen.min(decoded_size);
    let mut out: Vec<u8> = Vec::with_capacity(cap);
    let mut n = 0usize;
    let mut hi = 0u8;
    for &unit in src {
        if out.len() >= cap {
            break;
        }
        let c = unit as u8;
        let lo = unbase64(c);
        if lo >= 64 {
            if c == b'=' {
                break;
            }
            continue;
        }
        match n % 4 {
            0 => {}
            1 => out.push(((hi & 0x3F) << 2) | ((lo & 0x30) >> 4)),
            2 => out.push(((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2)),
            _ => out.push(((hi & 0x03) << 6) | (lo & 0x3F)),
        }
        hi = lo;
        n += 1;
    }
    out
}

// ---- directives -------------------------------------------------------------

/// `Directives`: the `%YAML` version and `%TAG` handles in force.
#[derive(Clone, Debug)]
pub(super) struct Directives {
    pub explicit: bool,
    pub version: &'static str,
    tags: Vec<(U16s, U16s)>,
    at_next_document: bool,
}

fn default_tags() -> Vec<(U16s, U16s)> {
    vec![(
        "!!".encode_utf16().collect(),
        "tag:yaml.org,2002:".encode_utf16().collect(),
    )]
}

fn is_js_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(claudius_agent::js::is_whitespace)
}

impl Directives {
    /// `this.tags` as `Object.entries` lists them: `(handle, prefix)`.
    pub(super) fn tags(&self) -> &[(U16s, U16s)] {
        &self.tags
    }

    pub(super) fn new() -> Self {
        Directives {
            explicit: false,
            version: "1.2",
            tags: default_tags(),
            at_next_document: false,
        }
    }

    /// `atDocument()`: this document's directives; the stream's reset for
    /// the next one (1.2) or on its next directive (1.1).
    pub(super) fn at_document(&mut self) -> Directives {
        let res = Directives {
            explicit: self.explicit,
            version: self.version,
            tags: self.tags.clone(),
            at_next_document: false,
        };
        match self.version {
            "1.1" => self.at_next_document = true,
            _ => {
                self.at_next_document = false;
                self.explicit = false;
                self.version = "1.2";
                self.tags = default_tags();
            }
        }
        res
    }

    /// `add(line, onError)`, reporting `BAD_DIRECTIVE`.
    pub(super) fn add(&mut self, line: &[u16], report: &mut Report) {
        if self.at_next_document {
            self.explicit = false;
            self.version = "1.1";
            self.tags = default_tags();
            self.at_next_document = false;
        }
        let mut s = 0;
        let mut e = line.len();
        while s < e && is_js_space(line[s]) {
            s += 1;
        }
        while e > s && is_js_space(line[e - 1]) {
            e -= 1;
        }
        let parts: Vec<&[u16]> = line[s..e]
            .split(|u| *u == 0x20 || *u == 0x09)
            .filter(|p| !p.is_empty())
            .collect();
        let (name, parts) = match parts.split_first() {
            Some((n, rest)) => (*n, rest),
            None => (&[][..], &[][..]),
        };
        if eq_ascii(name, "%TAG") {
            if parts.len() != 2 {
                report.on_error("BAD_DIRECTIVE", false);
                if parts.len() < 2 {
                    return;
                }
            }
            let (handle, prefix) = (parts[0].to_vec(), parts[1].to_vec());
            match self.tags.iter_mut().find(|(h, _)| *h == handle) {
                Some(slot) => slot.1 = prefix,
                None => self.tags.push((handle, prefix)),
            }
        } else if eq_ascii(name, "%YAML") {
            self.explicit = true;
            if parts.len() != 1 {
                report.on_error("BAD_DIRECTIVE", false);
                return;
            }
            let v = parts[0];
            if eq_ascii(v, "1.1") {
                self.version = "1.1";
            } else if eq_ascii(v, "1.2") {
                self.version = "1.2";
            } else {
                let vs = units_to_string(v);
                let valid = vs.split_once('.').is_some_and(|(a, b)| {
                    !a.is_empty()
                        && !b.is_empty()
                        && a.bytes().all(|c| c.is_ascii_digit())
                        && b.bytes().all(|c| c.is_ascii_digit())
                });
                report.on_error("BAD_DIRECTIVE", valid);
            }
        } else {
            report.on_error("BAD_DIRECTIVE", true);
        }
    }

    /// `tagName(source, onError)`; `on_error` is called for each error.
    pub(super) fn tag_name(&self, source: &[u16], on_error: &mut dyn FnMut()) -> Option<U16s> {
        let bang = u16::from(b'!');
        if source == [bang] {
            return Some(source.to_vec()); // non-specific tag
        }
        if source.first() != Some(&bang) {
            on_error();
            return None;
        }
        if source.get(1) == Some(&u16::from(b'<')) {
            let verbatim: &[u16] = if source.len() >= 3 {
                &source[2..source.len() - 1]
            } else {
                &[]
            };
            if eq_ascii(verbatim, "!") || eq_ascii(verbatim, "!!") {
                on_error();
                return None;
            }
            if source.last() != Some(&u16::from(b'>')) {
                on_error();
            }
            return Some(verbatim.to_vec());
        }
        let last_bang = source.iter().rposition(|u| *u == bang).unwrap_or(0);
        let (handle, suffix) = source.split_at(last_bang + 1);
        if suffix.is_empty() {
            on_error();
        }
        if let Some((_, prefix)) = self.tags.iter().find(|(h, _)| h == handle) {
            return match decode_uri_component(suffix) {
                Ok(decoded) => {
                    let mut out = prefix.clone();
                    out.extend(decoded);
                    Some(out)
                }
                Err(()) => {
                    on_error();
                    None
                }
            };
        }
        if handle == [bang] {
            return Some(source.to_vec()); // local tag
        }
        on_error();
        None
    }
}

/// `decodeURIComponent(s)` on UTF-16 units; `Err` is the `URIError`.
fn decode_uri_component(s: &[u16]) -> Result<U16s, ()> {
    let hex = |i: usize| -> Option<u8> {
        let a = char::from_u32(u32::from(*s.get(i)?))?.to_digit(16)?;
        let b = char::from_u32(u32::from(*s.get(i + 1)?))?.to_digit(16)?;
        Some((a * 16 + b) as u8)
    };
    let mut out: U16s = Vec::with_capacity(s.len());
    let mut k = 0;
    while k < s.len() {
        if s[k] != u16::from(b'%') {
            out.push(s[k]);
            k += 1;
            continue;
        }
        if k + 2 >= s.len() {
            return Err(());
        }
        let b = hex(k + 1).ok_or(())?;
        k += 2;
        if b & 0x80 == 0 {
            out.push(u16::from(b));
            k += 1;
            continue;
        }
        let n = b.leading_ones() as usize;
        if n == 1 || n > 4 {
            return Err(());
        }
        let mut octets = vec![b];
        if k + 3 * (n - 1) >= s.len() {
            return Err(());
        }
        for _ in 1..n {
            k += 1;
            if s[k] != u16::from(b'%') {
                return Err(());
            }
            let b = hex(k + 1).ok_or(())?;
            if b & 0xC0 != 0x80 {
                return Err(());
            }
            k += 2;
            octets.push(b);
        }
        let st = std::str::from_utf8(&octets).map_err(|_| ())?;
        out.extend(st.encode_utf16());
        k += 1;
    }
    Ok(out)
}
