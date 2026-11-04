//! `Date.parse` as V8 (node 22, V8 12.4) reads a string, ported step for
//! step from `DateParser::Parse` (`src/date/dateparser.h`,
//! `dateparser-inl.h`, `dateparser.cc`) and `ParseDateTimeString`
//! (`src/builtins/builtins-date.cc`).
//!
//! - A tokenizer over the UTF-16 units: numbers (the first nine
//!   significant digits), the symbols `:` `-` `+` `.` `)`, words (units
//!   from `A` up that aren't JS whitespace, matched on their first three
//!   letters against the month, zone, `am` / `pm` and `t` keywords), one
//!   whitespace or line-terminator unit, a parenthesised run, or anything
//!   else. A NUL unit ends the input.
//! - First the ECMAScript date-time format (`ParseES5DateTime`): `YYYY`,
//!   `YYYY-MM`, `YYYY-MM-DD` or a signed 6-digit year, then an optional
//!   `THH:mm[:ss[.f…]]` and `Z` / `±HH:mm` / `±HHmm`. Date-only forms are
//!   UTC. `24:00` is the next midnight; the day is only checked to be 1–31.
//! - Whatever that leaves goes through V8's legacy parser, which keeps what
//!   the ES part already read: `Jan 2 2026 03:04:05`, `2026/01/02`,
//!   `2026-01-01 00:00Z`, `2026-1-01`, `Fri, 02 Jan 2026 03:04:05 GMT`,
//!   `12/31/2025 11:59 PM`, … (month / day / year order rules, two-digit
//!   years, `am` / `pm`, the US zone names, `±hh[mm]` / `±hh:` offsets).
//! - A time without a zone is local in the process's zone (`TZ` first,
//!   through jiff), with ICU's `UCAL_TZ_LOCAL_FORMER` choice at a DST edge
//!   (the offset before a gap, the earlier instant in a fold). Past years
//!   ±9000 it is moved by whole 400-year cycles, because jiff stops at
//!   ±9999 (D17).
//! - Out of `±8.64e15` ms is NaN (`None`).
//!
//! Recorded against node 22's `Date.parse` in `tests/date_parse_golden.rs`.

const MAX_TIME: i64 = 8_640_000_000_000_000;
const MS_PER_DAY: i64 = 86_400_000;
/// `kMaxTimeBeforeUTCInMs`: the local times V8 converts to UTC at all.
const MAX_TIME_BEFORE_UTC: i64 = MAX_TIME + 30 * MS_PER_DAY;
/// `kNone` (`kMaxInt`): a composer slot not set.
const NONE: i32 = i32::MAX;
/// `kMaxSignificantDigits`.
const MAX_SIGNIFICANT_DIGITS: usize = 9;
/// `Smi::kMaxValue` with node's 32-bit Smis (no pointer compression).
const SMI_MAX: u32 = i32::MAX as u32;

/// `IsWhiteSpace`: TAB, VT, FF, ZWNBSP and the `Zs` units.
fn is_white_space(c: u32) -> bool {
    matches!(
        c,
        0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0x1680 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    ) || (0x2000..=0x200A).contains(&c)
}

/// `IsWhiteSpaceOrLineTerminator`.
fn is_white_space_or_line_terminator(c: u32) -> bool {
    is_white_space(c) || matches!(c, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// `InputReader`: the current unit is `ch`, 0 past the end (and for a NUL).
struct Reader {
    buf: Vec<u16>,
    index: usize,
    ch: u32,
}

impl Reader {
    fn new(text: &str) -> Self {
        let mut r = Reader {
            buf: text.encode_utf16().collect(),
            index: 0,
            ch: 0,
        };
        r.next();
        r
    }

    fn next(&mut self) {
        self.ch = self.buf.get(self.index).map_or(0, |&c| u32::from(c));
        self.index += 1;
    }

    fn is_end(&self) -> bool {
        self.ch == 0
    }

    fn is_digit(&self) -> bool {
        (0x30..=0x39).contains(&self.ch)
    }

    fn is_word_char(&self) -> bool {
        self.ch >= u32::from(b'A') && !is_white_space(self.ch)
    }

    fn skip(&mut self, c: u8) -> bool {
        let hit = self.ch == u32::from(c);
        if hit {
            self.next();
        }
        hit
    }

    /// `ReadUnsignedNumeral`: leading zeros skipped, then the first nine
    /// digits' value; the rest are read and dropped.
    fn read_unsigned_numeral(&mut self) -> i32 {
        while self.ch == u32::from(b'0') {
            self.next();
        }
        let (mut n, mut i) = (0i32, 0);
        while self.is_digit() {
            if i < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + (self.ch - u32::from(b'0')) as i32;
            }
            i += 1;
            self.next();
        }
        n
    }

    /// `ReadWord`: the word's first three units lowercased like
    /// `AsciiAlphaToLower` (`| 0x20`), zero-padded, and its length.
    fn read_word(&mut self) -> ([u32; 3], usize) {
        let mut prefix = [0u32; 3];
        let mut len = 0;
        while self.is_word_char() {
            if len < 3 {
                prefix[len] = self.ch | 0x20;
            }
            self.next();
            len += 1;
        }
        (prefix, len)
    }

    /// `SkipParentheses`: through the matching `)`, or to the end.
    fn skip_parentheses(&mut self) -> bool {
        if self.ch != u32::from(b'(') {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch == u32::from(b')') {
                balance -= 1;
            } else if self.ch == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if balance <= 0 || self.ch == 0 {
                return true;
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Keyword {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tag {
    Invalid,
    Unknown,
    WhiteSpace,
    Number,
    Symbol,
    EndOfInput,
    Keyword(Keyword),
}

/// `DateToken`.
#[derive(Clone, Copy, Debug)]
struct Token {
    tag: Tag,
    length: usize,
    value: i32,
}

impl Token {
    const END: Token = Token {
        tag: Tag::EndOfInput,
        length: 0,
        value: -1,
    };
    const INVALID: Token = Token {
        tag: Tag::Invalid,
        length: 0,
        value: -1,
    };
    const UNKNOWN: Token = Token {
        tag: Tag::Unknown,
        length: 1,
        value: -1,
    };

    fn is_number(&self) -> bool {
        self.tag == Tag::Number
    }
    fn is_symbol(&self, c: u8) -> bool {
        self.tag == Tag::Symbol && self.value == i32::from(c)
    }
    fn is_fixed_length_number(&self, len: usize) -> bool {
        self.is_number() && self.length == len
    }
    fn is_ascii_sign(&self) -> bool {
        self.is_symbol(b'+') || self.is_symbol(b'-')
    }
    /// `ascii_sign`: 1 for `+`, -1 for `-`.
    fn ascii_sign(&self) -> i32 {
        44 - self.value
    }
    fn is_keyword_z(&self) -> bool {
        self.tag == Tag::Keyword(Keyword::TimeZoneName) && self.length == 1 && self.value == 0
    }
}

/// `KeywordTable::array`: a three-letter prefix (zero-padded), its type and
/// value.
const KEYWORDS: [(&[u8; 3], Keyword, i32); 27] = [
    (b"jan", Keyword::MonthName, 1),
    (b"feb", Keyword::MonthName, 2),
    (b"mar", Keyword::MonthName, 3),
    (b"apr", Keyword::MonthName, 4),
    (b"may", Keyword::MonthName, 5),
    (b"jun", Keyword::MonthName, 6),
    (b"jul", Keyword::MonthName, 7),
    (b"aug", Keyword::MonthName, 8),
    (b"sep", Keyword::MonthName, 9),
    (b"oct", Keyword::MonthName, 10),
    (b"nov", Keyword::MonthName, 11),
    (b"dec", Keyword::MonthName, 12),
    (b"am\0", Keyword::AmPm, 0),
    (b"pm\0", Keyword::AmPm, 12),
    (b"ut\0", Keyword::TimeZoneName, 0),
    (b"utc", Keyword::TimeZoneName, 0),
    (b"z\0\0", Keyword::TimeZoneName, 0),
    (b"gmt", Keyword::TimeZoneName, 0),
    (b"cdt", Keyword::TimeZoneName, -5),
    (b"cst", Keyword::TimeZoneName, -6),
    (b"edt", Keyword::TimeZoneName, -4),
    (b"est", Keyword::TimeZoneName, -5),
    (b"mdt", Keyword::TimeZoneName, -6),
    (b"mst", Keyword::TimeZoneName, -7),
    (b"pdt", Keyword::TimeZoneName, -7),
    (b"pst", Keyword::TimeZoneName, -8),
    (b"t\0\0", Keyword::TimeSeparator, 0),
];

/// `KeywordTable::Lookup`: the first entry whose prefix matches; a word
/// longer than three units only matches a month.
fn lookup(prefix: &[u32; 3], len: usize) -> (Keyword, i32) {
    KEYWORDS
        .iter()
        .find(|(pre, kind, _)| {
            pre.iter().zip(prefix).all(|(&a, &b)| u32::from(a) == b)
                && (len <= 3 || *kind == Keyword::MonthName)
        })
        .map_or((Keyword::Invalid, 0), |&(_, kind, value)| (kind, value))
}

/// `DateStringTokenizer`: one token of lookahead.
struct Tokenizer {
    input: Reader,
    next: Token,
}

impl Tokenizer {
    fn new(text: &str) -> Self {
        let mut t = Tokenizer {
            input: Reader::new(text),
            next: Token::END,
        };
        t.next = t.scan();
        t
    }

    fn next(&mut self) -> Token {
        let result = self.next;
        self.next = self.scan();
        result
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn skip_symbol(&mut self, c: u8) -> bool {
        let hit = self.next.is_symbol(c);
        if hit {
            self.next = self.scan();
        }
        hit
    }

    fn scan(&mut self) -> Token {
        let start = self.input.index;
        let input = &mut self.input;
        if input.is_end() {
            return Token::END;
        }
        if input.is_digit() {
            let value = input.read_unsigned_numeral();
            return Token {
                tag: Tag::Number,
                length: input.index - start,
                value,
            };
        }
        for c in *b":-+.)" {
            if input.skip(c) {
                return Token {
                    tag: Tag::Symbol,
                    length: 1,
                    value: i32::from(c),
                };
            }
        }
        if input.is_word_char() {
            let (prefix, length) = input.read_word();
            let (kind, value) = lookup(&prefix, length);
            return Token {
                tag: Tag::Keyword(kind),
                length,
                value,
            };
        }
        if is_white_space_or_line_terminator(input.ch) {
            input.next();
            return Token {
                tag: Tag::WhiteSpace,
                length: input.index - start,
                value: -1,
            };
        }
        if !input.skip_parentheses() {
            input.next();
        }
        Token::UNKNOWN
    }
}

/// `ReadMilliseconds`: the first three significant digits of the numeral,
/// from its value and digit count.
fn read_milliseconds(token: Token) -> i32 {
    let (mut number, mut length) = (token.value, token.length);
    if length == 1 {
        number *= 100;
    } else if length == 2 {
        number *= 10;
    } else if length > 3 {
        length = length.min(MAX_SIGNIFICANT_DIGITS);
        number /= 10i32.pow(length as u32 - 3);
    }
    number
}

fn between(x: i32, lo: i32, hi: i32) -> bool {
    (lo..=hi).contains(&x)
}
fn is_month(x: i32) -> bool {
    between(x, 1, 12)
}
fn is_day(x: i32) -> bool {
    between(x, 1, 31)
}
fn is_hour(x: i32) -> bool {
    between(x, 0, 23)
}
fn is_minute(x: i32) -> bool {
    between(x, 0, 59)
}

/// `DayComposer`.
struct Day {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    iso: bool,
}

impl Day {
    fn add(&mut self, n: i32) -> bool {
        if self.index < 3 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }

    /// `Write`: (year, month 1–12, day), or `None`. The missing slots are 1
    /// and, as in V8, filling them also sets the count to 3, so the
    /// `index_ == 1` branch never runs (`Jan 2` is 2001).
    fn write(&mut self) -> Option<(i32, i32, i32)> {
        if self.index < 1 {
            return None;
        }
        while self.index < 3 {
            self.comp[self.index] = 1;
            self.index += 1;
        }
        let c = self.comp;
        let (mut year, month, day) = if self.named_month == NONE {
            if self.iso || !is_day(c[0]) {
                (c[0], c[1], c[2])
            } else {
                (c[2], c[0], c[1])
            }
        } else if !is_day(c[0]) {
            (c[0], self.named_month, c[1])
        } else {
            (c[1], self.named_month, c[0])
        };
        if !self.iso {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        // `Smi::IsValid(year)` holds for every i32 with 32-bit Smis.
        (is_month(month) && is_day(day)).then_some((year, month, day))
    }
}

/// `TimeComposer`.
struct Time {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl Time {
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn is_expecting(&self, n: i32) -> bool {
        (self.index == 1 && is_minute(n))
            || (self.index == 2 && is_minute(n))
            || (self.index == 3 && between(n, 0, 999))
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 4 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }
    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        true
    }

    /// `Write`: ms into the day, or `None`. `am` / `pm` need an hour of
    /// 0–12; a 24th hour only with nothing after it.
    fn write(&mut self) -> Option<i64> {
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, ms] = self.comp;
        if self.hour_offset != NONE {
            if !between(hour, 0, 12) {
                return None;
            }
            hour = hour % 12 + self.hour_offset;
        }
        if !(is_hour(hour) && is_minute(minute) && is_minute(second) && between(ms, 0, 999))
            && (hour != 24 || minute != 0 || second != 0 || ms != 0)
        {
            return None;
        }
        Some(
            ((i64::from(hour) * 60 + i64::from(minute)) * 60 + i64::from(second)) * 1000
                + i64::from(ms),
        )
    }
}

/// `TimeZoneComposer`.
struct Zone {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl Zone {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }
    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }
    fn is_expecting(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(n)
    }
    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }
    fn is_empty(&self) -> bool {
        self.hour == NONE
    }

    /// `Write`: the offset in seconds (`Some(None)` for none), or `None`
    /// when it doesn't fit a Smi (computed in wrapping unsigned arithmetic,
    /// as V8 does).
    fn write(&self) -> Option<Option<i32>> {
        if self.sign == NONE {
            return Some(None);
        }
        let hour = if self.hour == NONE { 0 } else { self.hour };
        let minute = if self.minute == NONE { 0 } else { self.minute };
        let total = (hour as u32)
            .wrapping_mul(3600)
            .wrapping_add((minute as u32).wrapping_mul(60));
        if total > SMI_MAX {
            return None;
        }
        let total = total as i32;
        Some(Some(if self.sign < 0 { -total } else { total }))
    }
}

/// `ParseES5DateTime`: the token the legacy parser continues with,
/// `EndOfInput` when the ES form took the whole string, `Invalid` when it
/// failed past the point of no return.
fn parse_es5(scanner: &mut Tokenizer, day: &mut Day, time: &mut Time, tz: &mut Zone) -> Token {
    if scanner.peek().is_ascii_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().value;
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().value);
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().value) {
            return scanner.next();
        }
        day.add(scanner.next().value);
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().value) {
                return scanner.next();
            }
            day.add(scanner.next().value);
        }
    }
    if scanner.peek().tag != Tag::Keyword(Keyword::TimeSeparator) {
        if scanner.peek().tag != Tag::EndOfInput {
            return scanner.next();
        }
    } else {
        scanner.next();
        let fixed2 = |t: Token| t.is_fixed_length_number(2);
        if !fixed2(scanner.peek()) || !between(scanner.peek().value, 0, 24) {
            return Token::INVALID;
        }
        let hour_is_24 = scanner.peek().value == 24;
        time.add(scanner.next().value);
        if !scanner.skip_symbol(b':') {
            return Token::INVALID;
        }
        let p = scanner.peek();
        if !fixed2(p) || !is_minute(p.value) || (hour_is_24 && p.value > 0) {
            return Token::INVALID;
        }
        time.add(scanner.next().value);
        if scanner.skip_symbol(b':') {
            let p = scanner.peek();
            if !fixed2(p) || !is_minute(p.value) || (hour_is_24 && p.value > 0) {
                return Token::INVALID;
            }
            time.add(scanner.next().value);
            if scanner.skip_symbol(b'.') {
                let p = scanner.peek();
                if !p.is_number() || (hour_is_24 && p.value > 0) {
                    return Token::INVALID;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_ascii_sign() {
            tz.set_sign(if scanner.next().is_symbol(b'+') {
                1
            } else {
                -1
            });
            if scanner.peek().is_fixed_length_number(4) {
                let hourmin = scanner.next().value;
                let (hour, min) = (hourmin / 100, hourmin % 100);
                if !is_hour(hour) || !is_minute(min) {
                    return Token::INVALID;
                }
                tz.hour = hour;
                tz.minute = min;
            } else {
                if !fixed2(scanner.peek()) || !is_hour(scanner.peek().value) {
                    return Token::INVALID;
                }
                tz.hour = scanner.next().value;
                if !scanner.skip_symbol(b':') {
                    return Token::INVALID;
                }
                if !fixed2(scanner.peek()) || !is_minute(scanner.peek().value) {
                    return Token::INVALID;
                }
                tz.minute = scanner.next().value;
            }
        }
        if scanner.peek().tag != Tag::EndOfInput {
            return Token::INVALID;
        }
    }
    // "When the time zone offset is absent, date-only forms are interpreted
    // as a UTC time and date-time forms are interpreted as a local time."
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.iso = true;
    Token::END
}

/// What `DateParser::Parse` writes: the date, the ms into the day and the
/// UTC offset in seconds (`None`: local time).
struct Parsed {
    year: i32,
    month: i32,
    day: i32,
    time: i64,
    offset: Option<i32>,
}

/// `DateParser::Parse`: the ES form, then the legacy rules over what it
/// left.
fn parse(text: &str) -> Option<Parsed> {
    let mut scanner = Tokenizer::new(text);
    let mut tz = Zone {
        sign: NONE,
        hour: NONE,
        minute: NONE,
    };
    let mut time = Time {
        comp: [0; 4],
        index: 0,
        hour_offset: NONE,
    };
    let mut day = Day {
        comp: [0; 3],
        index: 0,
        named_month: NONE,
        iso: false,
    };
    let mut token = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
    if token.tag == Tag::Invalid {
        return None;
    }
    let mut has_read_number = day.index > 0;
    while token.tag != Tag::EndOfInput {
        match token.tag {
            Tag::Number => {
                has_read_number = true;
                let n = token.value;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        // n + "::"
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        // n + ":"
                        if !time.add(n) {
                            return None;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    // (A `.` that isn't a time's is consumed all the same.)
                    time.add(n);
                    if !scanner.peek().is_number() {
                        return None;
                    }
                    time.add_final(read_milliseconds(scanner.next()));
                } else if tz.is_expecting(n) {
                    tz.minute = n;
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    // End, white space, "Z", "+" or "-" right after a time.
                    let peek = scanner.peek();
                    if peek.tag != Tag::EndOfInput
                        && peek.tag != Tag::WhiteSpace
                        && !peek.is_keyword_z()
                        && !peek.is_ascii_sign()
                    {
                        return None;
                    }
                } else {
                    if !day.add(n) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Tag::Keyword(kind) => {
                let value = token.value;
                if kind == Keyword::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == Keyword::MonthName {
                    day.named_month = value;
                    scanner.skip_symbol(b'-');
                } else if kind == Keyword::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    // Garbage words are illegal once a number has been read,
                    // and must be separated from the first number.
                    if has_read_number || scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            _ if token.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) => {
                // A UTC offset (only after UTC or a time); the number may be
                // missing.
                tz.set_sign(token.ascii_sign());
                let (mut n, mut length) = (0, 0);
                if scanner.peek().is_number() {
                    let t = scanner.next();
                    (n, length) = (t.value, t.length);
                }
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = n;
                    tz.minute = NONE;
                } else if length == 1 || length == 2 {
                    // GMT-8
                    tz.hour = n;
                    tz.minute = 0;
                } else if length == 3 || length == 4 {
                    // hhmm
                    tz.hour = n / 100;
                    tz.minute = n % 100;
                } else {
                    return None;
                }
            }
            _ if (token.is_ascii_sign() || token.is_symbol(b')')) && has_read_number => {
                return None;
            }
            // Other characters and whitespace are ignored.
            _ => {}
        }
        token = scanner.next();
    }
    let (year, month, day) = day.write()?;
    let time = time.write()?;
    let offset = tz.write()?;
    Some(Parsed {
        year,
        month,
        day,
        time,
        offset,
    })
}

/// Days from 1970-01-01 to the first of `month` (1–12) in `year`.
fn days_from_civil(year: i64, month: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.parse(text)`, or `None` for NaN.
pub fn date_parse(text: &str) -> Option<i64> {
    let p = parse(text)?;
    // `MakeDay` takes years within ±1 000 000 only.
    if !(-1_000_000..=1_000_000).contains(&p.year) {
        return None;
    }
    let days = days_from_civil(i64::from(p.year), i64::from(p.month)) + i64::from(p.day) - 1;
    let date = days * MS_PER_DAY + p.time;
    let t = match p.offset {
        Some(off) => date - i64::from(off) * 1000,
        None if date.abs() <= MAX_TIME_BEFORE_UTC => local_to_utc(date),
        None => return None,
    };
    (t.abs() <= MAX_TIME).then_some(t)
}

/// A local wall-clock time (ms as if UTC) to UTC, in the process's zone.
fn local_to_utc(local: i64) -> i64 {
    local - zone_offset_ms(&jiff::tz::TimeZone::system(), local)
}

/// The offset (ms) to subtract from the local time `local_ms` to get UTC.
/// jiff's `Compatible` picks the offset in force before the change for a
/// skipped time and the earlier instant for a repeated one. (chrono's
/// `Local` calls the first instant after a fold, `2026-11-01T02:00` in New
/// York, ambiguous.)
fn zone_offset_ms(tz: &jiff::tz::TimeZone, local_ms: i64) -> i64 {
    // jiff stops at years ±9999. Past ±9000 a time is moved by whole
    // 400-year Gregorian cycles (same dates, same weekdays) to one with the
    // same offset: the zone's final rule after its last change, its first
    // offset before its first, as ICU applies them at any year.
    const CYCLE: i64 = 146_097 * 86_400_000;
    const EDGE: i64 = 221_845_392_000_000; // 9000-01-01T00:00:00Z
    let cycles = if local_ms > EDGE {
        (local_ms - EDGE) / CYCLE + 1
    } else if local_ms < -EDGE {
        -((-EDGE - local_ms) / CYCLE + 1)
    } else {
        0
    };
    let secs = (local_ms - cycles * CYCLE).div_euclid(1000);
    let zoned = jiff::Timestamp::from_second(secs).and_then(|ts| {
        tz.to_ambiguous_zoned(ts.to_zoned(jiff::tz::TimeZone::UTC).datetime())
            .disambiguate(jiff::tz::Disambiguation::Compatible)
    });
    zoned.map_or(0, |z| (secs - z.timestamp().as_second()) * 1000)
}

/// `new Date(t).toISOString()` for a number `t`: `TimeClip` (NaN past
/// ±8.64e15 ms, else truncated toward zero), then `YYYY-MM-DDTHH:mm:ss.sssZ`
/// with a signed six-digit year outside 0000–9999. `None` where it throws
/// (`RangeError: Invalid time value`).
pub fn to_iso_string(t: f64) -> Option<String> {
    if !t.is_finite() || t.abs() > MAX_TIME as f64 {
        return None;
    }
    let t = t.trunc() as i64;
    let (days, ms) = (t.div_euclid(MS_PER_DAY), t.rem_euclid(MS_PER_DAY));
    // Days → civil date (the inverse of `days_from_civil`).
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let year = match year {
        0..=9999 => format!("{year:04}"),
        y if y < 0 => format!("-{:06}", -y),
        y => format!("+{y:06}"),
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::date_parse;

    #[test]
    fn to_iso_string_is_date_to_iso_string() {
        use super::to_iso_string as iso;
        assert_eq!(iso(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso(-0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso(-1.0).as_deref(), Some("1969-12-31T23:59:59.999Z"));
        assert_eq!(iso(-0.5).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(
            iso(1_700_000_000_123.9).as_deref(),
            Some("2023-11-14T22:13:20.123Z")
        );
        assert_eq!(
            iso(951_782_400_000.0).as_deref(),
            Some("2000-02-29T00:00:00.000Z")
        );
        assert_eq!(
            iso(253_402_300_800_000.0).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso(-62_198_755_200_000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(iso(8.64e15).as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(
            iso(-8.64e15).as_deref(),
            Some("-271821-04-20T00:00:00.000Z")
        );
        assert_eq!(iso(8.64e15 + 1.0), None);
        assert_eq!(iso(f64::NAN), None);
        assert_eq!(iso(f64::INFINITY), None);
    }

    #[test]
    fn es_forms() {
        for (s, want) in [
            ("2026-01-01T00:00:00.000Z", Some(1_767_225_600_000)),
            ("2026", Some(1_767_225_600_000)),
            ("2026-02-30", Some(1_772_409_600_000)),
            ("2026-01-01T24:00Z", Some(1_767_312_000_000)),
            ("2026-01-01t00:00:00z", Some(1_767_225_600_000)),
            (
                "2026-01-01T00:00:00.000123456789123Z",
                Some(1_767_225_600_123),
            ),
            ("2026-01-01T00:00:00.0123Z", Some(1_767_225_600_012)),
            ("2026-01-01T00:00:00+0130", Some(1_767_220_200_000)),
            ("-271821-04-20T00:00:00Z", Some(-8_640_000_000_000_000)),
            ("-271821-04-19T23:59:59.999Z", None),
            ("2026-01-01T24:00:00.0001Z", None),
            ("2026-01-01T10:00:00+2400", None),
            ("-000000-01-01T00:00:00Z", None),
            ("2026-01-01T00:00:00Zjunk", None),
            ("2026-01-01Tx", None),
            ("", None),
        ] {
            assert_eq!(date_parse(s), want, "{s}");
        }
    }

    /// Zoned legacy forms (no local time, so no `TZ` needed).
    #[test]
    fn legacy_forms() {
        for (s, want) in [
            ("2026-01-01 00:00Z", Some(1_767_225_600_000)),
            ("Fri, 02 Jan 2026 03:04:05 GMT", Some(1_767_323_045_000)),
            (
                "Thu Jan 01 2026 22:04:05 GMT-0500 (Eastern Standard Time)",
                Some(1_767_323_045_000),
            ),
            ("2026-01-02 03:04:05.678 +05:30", Some(1_767_303_245_678)),
            ("Jan 2 2026 10:00 PM UTC", Some(1_767_391_200_000)),
            ("2 January 2026 00:00 EST", Some(1_767_330_000_000)),
            ("Jan 2 2026 13:00 PM UTC", None),
            // A word longer than three letters is a month by its prefix.
            ("Jan 2 2026 10:00 GMT+0100junk", Some(1_780_390_800_000)),
            ("Jan 2 2026 10:00 GMT+0100xyz", None),
            ("2026-01-02\u{0} junk", Some(1_767_312_000_000)),
            (
                "Sat Sep 13 275760 00:00:00 GMT+0000",
                Some(8_640_000_000_000_000),
            ),
        ] {
            assert_eq!(date_parse(s), want, "{s}");
        }
    }
}
