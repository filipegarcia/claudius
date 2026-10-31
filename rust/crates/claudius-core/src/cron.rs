//! `lib/shared/cron.ts`: `validateCron`, `nextFires`, `nextFireMs`,
//! `nextFireAfter`, on a port of cron-parser 5.5.0 (`CronExpressionParser`,
//! the fields, the forward half of `CronExpression`, `CronDate`) and of the
//! luxon 3.7 local-time arithmetic it runs on (`fixOffset`, `plus`, `set`,
//! `startOf`, `endOf`). Only forward iteration (`next()`) is ported: nothing
//! in the server walks backwards.
//!
//! cron-parser resolves times in the process's local zone unless given a
//! `tz`; [`Zone::Local`] is the system zone (`TZ` / `/etc/localtime`, as
//! Node's), [`Zone::Fixed`] a fixed offset, [`Zone::Tz`] an IANA zone. Quirks
//! kept on purpose, as the golden pins them: `1-2-3` reads as `1-2`, `0,0`
//! passes the duplicate check, fewer than six fields are padded from
//! `* * * * * 0` (three fields `a b c` read as `* * 0 a b c`), a search that
//! runs out of its 9 999 steps returns where it stopped without an error, and
//! an `L` weekday without a digit only fails once the iteration reaches it.

use std::sync::LazyLock;

use chrono::{Offset, TimeZone};
use claudius_agent::js;
use regex::Regex;

/// `FIRE_ANCHOR_MAX_AGE_MS`: a last fire older than this no longer anchors
/// the next one.
pub const FIRE_ANCHOR_MAX_AGE_MS: f64 = 25.0 * 60.0 * 60.0 * 1000.0;
const ANCHOR_SLOT_TOLERANCE_MS: f64 = 1_000.0;
const MAX_ANCHOR_STEPS: usize = 5_000;
/// cron-parser's `LOOP_LIMIT`.
const LOOP_LIMIT: u32 = 10_000;

// ---- zones ------------------------------------------------------------------

/// Where wall-clock times are resolved.
#[derive(Clone, Copy, Debug)]
pub enum Zone {
    /// The system zone, as luxon's `SystemZone` (`Date#getTimezoneOffset`).
    Local,
    /// A fixed offset east of UTC, in seconds (luxon's `FixedOffsetZone`).
    Fixed(i64),
    /// An IANA zone from the system tzdb (interned: see [`iana_zone`]).
    Tz(&'static jiff::tz::TimeZone),
}

/// An IANA zone or link by name, ASCII case-insensitive like `Intl`. Each
/// distinct zone is loaded once and kept for the process's life, so `Zone`
/// stays `Copy` (there are a few hundred at most; unknown names aren't kept).
fn iana_zone(name: &str) -> Option<&'static jiff::tz::TimeZone> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static ZONES: LazyLock<Mutex<HashMap<String, &'static jiff::tz::TimeZone>>> =
        LazyLock::new(Default::default);
    let key = name.to_ascii_lowercase();
    let mut zones = ZONES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tz) = zones.get(&key) {
        return Some(tz);
    }
    let tz: &'static jiff::tz::TimeZone = Box::leak(Box::new(jiff::tz::TimeZone::get(name).ok()?));
    zones.insert(key, tz);
    Some(tz)
}

/// luxon's `FixedOffsetZone.parseSpecifier` on the lowercased name:
/// `/^utc(?:([+-]\d{1,2})(?::(\d{2}))?)?$/i`, minutes signed like the hour
/// (`-0` included).
fn parse_specifier(lower: &str) -> Option<i64> {
    let rest = lower.strip_prefix("utc")?;
    let sign = match rest.as_bytes().first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let (hours, minutes) = match rest[1..].split_once(':') {
        Some((h, m)) => (h, Some(m)),
        None => (&rest[1..], None),
    };
    let digits = |s: &str, lens: std::ops::RangeInclusive<usize>| {
        lens.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
    };
    if !digits(hours, 1..=2) || minutes.is_some_and(|m| !digits(m, 2..=2)) {
        return None;
    }
    let h: i64 = hours.parse().ok()?;
    let m: i64 = minutes.map_or(Ok(0), str::parse).ok()?;
    Some(sign * (h * 60 + m) * 60)
}

/// An `Intl` offset time zone: `±HH`, `±HHMM` or `±HH:MM` (`−` too).
fn parse_offset_zone(name: &str) -> Option<i64> {
    let (sign, rest) = match name.strip_prefix('+') {
        Some(r) => (1, r),
        None => (-1, name.strip_prefix(['-', '\u{2212}'])?),
    };
    let (h, m) = match rest.as_bytes() {
        [h1, h2] => ([*h1, *h2], *b"00"),
        [h1, h2, m1, m2] | [h1, h2, b':', m1, m2] => ([*h1, *h2], [*m1, *m2]),
        _ => return None,
    };
    let two = |d: [u8; 2]| {
        d.iter()
            .all(u8::is_ascii_digit)
            .then(|| i64::from(d[0] - b'0') * 10 + i64::from(d[1] - b'0'))
    };
    let (h, m) = (two(h)?, two(m)?);
    (h <= 23 && m <= 59).then_some(sign * (h * 60 + m) * 60)
}

impl Zone {
    /// A `tz` as luxon's `normalizeZone` reads it: `default` / `local` /
    /// `system`, `utc` / `gmt`, `utc±H[:MM]`, else a name `Intl` accepts: an
    /// IANA zone or link (ASCII case-insensitive) or an offset like `+05:30`.
    /// ICU's extra legacy IDs (`PST`, `AET`, `SystemV/…`) aren't known here.
    pub fn named(name: &str) -> Option<Zone> {
        let lower = name.to_ascii_lowercase();
        if matches!(lower.as_str(), "default" | "local" | "system") {
            return Some(Zone::Local);
        }
        if lower == "utc" || lower == "gmt" {
            return Some(Zone::Fixed(0));
        }
        if let Some(secs) = parse_specifier(&lower).or_else(|| parse_offset_zone(name)) {
            return Some(Zone::Fixed(secs));
        }
        iana_zone(name).map(Zone::Tz)
    }

    /// The UTC offset at `ts` (epoch ms), in seconds.
    fn offset_sec(&self, ts: i64) -> i64 {
        match self {
            Zone::Fixed(secs) => *secs,
            Zone::Local => chrono::DateTime::from_timestamp_millis(ts).map_or(0, |at| {
                i64::from(
                    chrono::Local
                        .offset_from_utc_datetime(&at.naive_utc())
                        .fix()
                        .local_minus_utc(),
                )
            }),
            Zone::Tz(tz) => {
                // jiff's range ends at ±9999 years; JS dates go on past it.
                let at = jiff::Timestamp::from_millisecond(ts).unwrap_or(if ts < 0 {
                    jiff::Timestamp::MIN
                } else {
                    jiff::Timestamp::MAX
                });
                i64::from(tz.to_offset(at).seconds())
            }
        }
    }
}

// ---- calendar arithmetic (JS `Date.UTC` and luxon) --------------------------

const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1–12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// luxon's `daysInMonth` (the month may overflow).
fn days_in_month(year: i64, month: i64) -> i64 {
    let mod_month = (month - 1).rem_euclid(12) + 1;
    let mod_year = year + (month - mod_month) / 12;
    match mod_month {
        2 if is_leap(mod_year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// A luxon calendar object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Civil {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
}

/// `objToLocalTS`: `Date.UTC`, overflowing fields carried.
fn obj_to_local_ts(c: &Civil) -> i64 {
    let ym = c.year + (c.month - 1).div_euclid(12);
    let mn = (c.month - 1).rem_euclid(12) + 1;
    let day = days_from_civil(ym, mn, 1) + c.day - 1;
    day * DAY_MS + c.hour * 3_600_000 + c.minute * 60_000 + c.second * 1000 + c.ms
}

/// `tsToObj`.
fn ts_to_obj(ts: i64, offset_sec: i64) -> Civil {
    let t = ts + offset_sec * 1000;
    let (year, month, day) = civil_from_days(t.div_euclid(DAY_MS));
    let rem = t.rem_euclid(DAY_MS);
    Civil {
        year,
        month,
        day,
        hour: rem / 3_600_000,
        minute: rem / 60_000 % 60,
        second: rem / 1000 % 60,
        ms: rem % 1000,
    }
}

/// luxon's `fixOffset`: the instant for a local time, starting from a guess
/// of its offset; in a gap, the local time moves forward by the jump.
fn fix_offset(local_ts: i64, o: i64, zone: &Zone) -> (i64, i64) {
    let mut utc_guess = local_ts - o * 1000;
    let o2 = zone.offset_sec(utc_guess);
    if o == o2 {
        return (utc_guess, o);
    }
    utc_guess -= (o2 - o) * 1000;
    let o3 = zone.offset_sec(utc_guess);
    if o2 == o3 {
        return (utc_guess, o2);
    }
    (local_ts - o2.min(o3) * 1000, o2.max(o3))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unit {
    Second,
    Minute,
    Hour,
    Day,
    Month,
}

/// A luxon `DateTime`: the instant and the offset it was resolved with
/// (which a gap leaves different from the zone's offset at that instant).
#[derive(Clone, Copy, Debug)]
struct Lux {
    ts: i64,
    o: i64,
    zone: Zone,
}

impl Lux {
    fn from_millis(ts: i64, zone: Zone) -> Lux {
        Lux {
            ts,
            o: zone.offset_sec(ts),
            zone,
        }
    }

    fn c(&self) -> Civil {
        ts_to_obj(self.ts, self.o)
    }

    fn with(&self, (ts, o): (i64, i64)) -> Lux {
        Lux {
            ts,
            o,
            zone: self.zone,
        }
    }

    /// `set(values)`. Luxon clamps an overflowing day when `values` has no
    /// `day`, but every caller here sets only the time of day (or `day: 1`),
    /// so the day is always already valid.
    fn set(&self, f: impl FnOnce(&mut Civil)) -> Lux {
        let mut mixed = self.c();
        f(&mut mixed);
        self.with(fix_offset(obj_to_local_ts(&mixed), self.o, &self.zone))
    }

    /// `plus({months, days})` (`adjustTime`'s calendar half).
    fn plus_calendar(&self, months: i64, days: i64) -> Lux {
        let c = self.c();
        let month = c.month + months;
        let shifted = Civil {
            month,
            day: c.day.min(days_in_month(c.year, month)) + days,
            ..c
        };
        self.with(fix_offset(obj_to_local_ts(&shifted), self.o, &self.zone))
    }

    /// `plus({milliseconds})` (`adjustTime`'s exact half): the instant moved
    /// and its offset re-read. Luxon first re-resolves the same local time
    /// with `fixOffset`, which is the identity here: `o` is always the zone's
    /// offset at `ts`.
    fn plus_ms(&self, ms: i64) -> Lux {
        let ts = self.ts + ms;
        Lux {
            ts,
            o: self.zone.offset_sec(ts),
            zone: self.zone,
        }
    }

    fn start_of(&self, unit: Unit) -> Lux {
        self.set(|c| {
            if unit == Unit::Month {
                c.day = 1;
            }
            if matches!(unit, Unit::Month | Unit::Day) {
                c.hour = 0;
            }
            if matches!(unit, Unit::Month | Unit::Day | Unit::Hour) {
                c.minute = 0;
            }
            if unit != Unit::Second {
                c.second = 0;
            }
            c.ms = 0;
        })
    }
}

// ---- CronDate -----------------------------------------------------------------

/// cron-parser's `CronDate`: a luxon date plus the DST markers the hour
/// stepping leaves behind.
#[derive(Clone, Copy, Debug)]
struct CronDate {
    d: Lux,
    dst_start: Option<i64>,
    dst_end: Option<i64>,
}

impl CronDate {
    fn date(&self) -> i64 {
        self.d.c().day
    }
    fn month0(&self) -> i64 {
        self.d.c().month - 1
    }
    fn hours(&self) -> i64 {
        self.d.c().hour
    }
    fn minutes(&self) -> i64 {
        self.d.c().minute
    }
    fn seconds(&self) -> i64 {
        self.d.c().second
    }
    fn millis(&self) -> i64 {
        self.d.c().ms
    }
    /// `getDay()`: 0 = Sunday, from the local date.
    fn day(&self) -> i64 {
        let c = self.d.c();
        (days_from_civil(c.year, c.month, c.day) + 4).rem_euclid(7)
    }

    fn add(&mut self, unit: Unit) {
        self.d = match unit {
            Unit::Month => self.d.plus_calendar(1, 0).start_of(Unit::Month),
            Unit::Day => self.d.plus_calendar(0, 1).start_of(Unit::Day),
            Unit::Hour => self.d.plus_ms(3_600_000).start_of(Unit::Hour),
            Unit::Minute => self.d.plus_ms(60_000).start_of(Unit::Minute),
            Unit::Second => self.d.plus_ms(1000),
        };
    }

    /// `applyDateOperation(Add, unit, hoursLength)`: a step that jumped two
    /// hours marks a DST start, one that stayed on a whole hour a DST end
    /// (unless every hour is allowed).
    fn apply(&mut self, unit: Unit, hours_len: usize) {
        if matches!(unit, Unit::Month | Unit::Day) {
            self.add(unit);
            return;
        }
        let previous = self.hours();
        self.add(unit);
        let current = self.hours();
        let diff = current - previous;
        if diff == 2 {
            if hours_len != 24 {
                self.dst_start = Some(current);
            }
        } else if diff == 0 && self.minutes() == 0 && self.seconds() == 0 && hours_len != 24 {
            self.dst_end = Some(current);
        }
    }

    // A field value may be fractional (`H/30.5` keeps `59.5`): `Date.UTC`
    // truncates it.
    fn set_hours(&mut self, h: f64) {
        self.d = self.d.set(|c| c.hour = h as i64);
    }
    fn set_minutes(&mut self, m: f64) {
        self.d = self.d.set(|c| c.minute = m as i64);
    }
    fn set_seconds(&mut self, s: f64) {
        self.d = self.d.set(|c| c.second = s as i64);
    }
    fn set_millis(&mut self, ms: i64) {
        self.d = self.d.set(|c| c.ms = ms);
    }

    fn last_day(&self) -> i64 {
        let c = self.d.c();
        match c.month {
            2 if is_leap(c.year) => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        }
    }
    fn is_last_day_of_month(&self) -> bool {
        self.date() == self.last_day()
    }
    fn is_last_weekday_of_month(&self) -> bool {
        self.date() > self.last_day() - 7
    }
}

// ---- fields -----------------------------------------------------------------

/// A field value: a number, or a string carrying `L`.
#[derive(Clone, Debug, PartialEq)]
enum Val {
    /// A JS number: whole, except where `H(...)` padding left a fraction.
    Num(f64),
    Str(String),
}

impl std::fmt::Display for Val {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Val::Num(n) => f.write_str(&num(*n)),
            Val::Str(s) => f.write_str(s),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldKind {
    Second,
    Minute,
    Hour,
    DayOfMonth,
    Month,
    DayOfWeek,
}

impl FieldKind {
    fn min(self) -> i64 {
        match self {
            FieldKind::DayOfMonth | FieldKind::Month => 1,
            _ => 0,
        }
    }
    fn max(self) -> i64 {
        match self {
            FieldKind::Second | FieldKind::Minute => 59,
            FieldKind::Hour => 23,
            FieldKind::DayOfMonth => 31,
            FieldKind::Month => 12,
            FieldKind::DayOfWeek => 7,
        }
    }
    /// `chars`: the special values the field takes.
    fn has_l(self) -> bool {
        matches!(self, FieldKind::DayOfMonth | FieldKind::DayOfWeek)
    }
    fn class_name(self) -> &'static str {
        match self {
            FieldKind::Second => "CronSecond",
            FieldKind::Minute => "CronMinute",
            FieldKind::Hour => "CronHour",
            FieldKind::DayOfMonth => "CronDayOfMonth",
            FieldKind::Month => "CronMonth",
            FieldKind::DayOfWeek => "CronDayOfWeek",
        }
    }
    /// `validChars`.
    fn valid_chars(self, value: &str) -> bool {
        static H_FORMS: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"^.*H\([0-9]+-[0-9]+\)/[0-9]+.*$|^.*H\([0-9]+-[0-9]+\).*$|^.*H/[0-9]+.*$")
                .unwrap()
        });
        let plain = |extra: &str| {
            !value.is_empty()
                && value
                    .chars()
                    .all(|c| "?,*H/-".contains(c) || c.is_ascii_digit() || extra.contains(c))
        };
        let simple = match self {
            // `#parseNthDay` has already cut a weekday's `#n`.
            FieldKind::DayOfMonth | FieldKind::DayOfWeek => plain("L"),
            _ => plain(""),
        };
        simple || H_FORMS.is_match(value)
    }
}

/// A parsed field (`CronField`).
#[derive(Clone, Debug)]
struct Field {
    /// Sorted: numbers ascending, then strings.
    values: Vec<Val>,
    nums: Vec<f64>,
    wildcard: bool,
    has_last_char: bool,
}

impl Field {
    /// The constructor: sort, then `validate()`.
    fn new(kind: FieldKind, mut values: Vec<Val>, raw: &str) -> Result<Field, String> {
        if values.is_empty() {
            return Err(format!(
                "{} Validation error, values contains no values",
                kind.class_name()
            ));
        }
        values.sort_by(|a, b| match (a, b) {
            (Val::Num(x), Val::Num(y)) => x.total_cmp(y),
            (Val::Str(x), Val::Str(y)) => x.cmp(y),
            (Val::Num(_), Val::Str(_)) => std::cmp::Ordering::Less,
            (Val::Str(_), Val::Num(_)) => std::cmp::Ordering::Greater,
        });
        let in_range = |v: &Val| match v {
            Val::Num(n) => (kind.min() as f64..=kind.max() as f64).contains(n),
            // `/^\d{0,2}L$/`
            Val::Str(s) => {
                kind.has_l()
                    && s.strip_suffix('L')
                        .is_some_and(|d| d.len() <= 2 && d.bytes().all(|b| b.is_ascii_digit()))
            }
        };
        if let Some(bad) = values.iter().find(|v| !in_range(v)) {
            let chars = if kind.has_l() { " or chars L" } else { "" };
            return Err(format!(
                "{} Validation error, got value {bad} expected range {}-{}{chars}",
                kind.class_name(),
                kind.min(),
                kind.max()
            ));
        }
        // The first value seen before, if truthy (a duplicate `0` passes).
        let dup = values
            .iter()
            .enumerate()
            .find(|(i, v)| values.iter().position(|w| w == *v) != Some(*i))
            .map(|(_, v)| v);
        if let Some(d) = dup
            && *d != Val::Num(0.0)
            && *d != Val::Str(String::new())
        {
            return Err(format!(
                "{} Validation error, duplicate values found: {d}",
                kind.class_name()
            ));
        }
        let nums = values
            .iter()
            .filter_map(|v| match v {
                Val::Num(n) => Some(*n),
                Val::Str(_) => None,
            })
            .collect();
        Ok(Field {
            has_last_char: raw.contains('L') || values.contains(&Val::Str("L".into())),
            wildcard: raw == "*" || raw == "?",
            values,
            nums,
        })
    }

    fn contains(&self, n: i64) -> bool {
        self.nums.contains(&(n as f64))
    }

    /// `findNearestValue(current)`: the first value after it.
    fn nearest_after(&self, current: i64) -> Option<f64> {
        self.nums.iter().copied().find(|&v| v > current as f64)
    }

    fn min_value(&self) -> f64 {
        // `values[0]`: always a number for the time fields.
        self.nums.first().copied().unwrap_or(0.0)
    }
}

// ---- parsing ----------------------------------------------------------------

fn predefined(expr: &str) -> Option<&'static str> {
    Some(match expr {
        "@yearly" | "@annually" => "0 0 0 1 1 *",
        "@monthly" => "0 0 0 1 * *",
        "@weekly" => "0 0 0 * * 0",
        "@daily" => "0 0 0 * * *",
        "@hourly" => "0 0 * * * *",
        "@minutely" => "0 * * * * *",
        "@secondly" => "* * * * * *",
        "@weekdays" => "0 0 0 * * 1-5",
        "@weekends" => "0 0 0 * * 0,6",
        _ => return None,
    })
}

/// `s.trim().split(/\s+/)` (JS whitespace; `""` splits to `[""]`).
fn split_fields(s: &str) -> Vec<&str> {
    let t = js::trim(s);
    if t.is_empty() {
        return vec![""];
    }
    t.split(js::is_whitespace)
        .filter(|p| !p.is_empty())
        .collect()
}

/// cron-parser's `seededRandom()` without a seed: mulberry32 from a random
/// seed (only `H` uses it).
struct Mulberry(u32);

/// A `Math.random()` stand-in: uniform in [0, 1). Not for anything secret.
pub(crate) fn math_random() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let bits = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

impl Mulberry {
    /// `mulberry32(Math.floor(r * 10_000_000_000))`, `r` being what
    /// `Math.random()` returned. The seed only matters modulo 2³², where
    /// `Math.imul` and `>>>` read it.
    fn from_random(r: f64) -> Mulberry {
        Mulberry(((r * 10_000_000_000.0).floor() as u64 % (1 << 32)) as u32)
    }
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// `value.replace(/[a-z]{3}/gi, alias)` for month and weekday names.
fn replace_aliases(value: &str) -> Result<String, String> {
    let mut out = String::new();
    let b = value.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if i + 3 <= b.len() && b[i..i + 3].iter().all(u8::is_ascii_alphabetic) {
            let name = value[i..i + 3].to_ascii_lowercase();
            let n = MONTHS
                .iter()
                .position(|m| *m == name)
                .map(|p| p + 1)
                .or_else(|| DAYS.iter().position(|d| *d == name));
            match n {
                Some(n) => out.push_str(&n.to_string()),
                None => return Err(format!("Validation error, cannot resolve alias \"{name}\"")),
            }
            i += 3;
        } else {
            let c = value[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    Ok(out)
}

/// `String(x)` for a number, as the error messages interpolate it.
fn num(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        js::number_to_string(x)
    }
}

/// `#parseHashed`.
fn parse_hashed(value: &str, kind: FieldKind, rand: &mut Mulberry) -> Result<String, String> {
    static H: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"H(?:\(([0-9]+)-([0-9]+)\))?(?:/([0-9]+))?").unwrap());
    let r = rand.next();
    let (cmin, cmax) = (kind.min() as f64, kind.max() as f64);
    let mut out = String::new();
    let mut last = 0;
    for caps in H.captures_iter(value) {
        let m = caps.get(0).unwrap();
        out.push_str(&value[last..m.start()]);
        last = m.end();
        let int = |i: usize| caps.get(i).map(|g| js::parse_int(g.as_str()));
        let steps = |start: f64, max: f64, step: f64, floor_min: f64| -> String {
            let offset = (r * step).floor();
            let mut values = Vec::new();
            let mut i = (floor_min / step).floor() * step + offset;
            while i <= max {
                if i >= start {
                    values.push(num(i));
                }
                i += step;
            }
            values.join(",")
        };
        let replaced = match (int(1), int(2), int(3)) {
            (Some(lo), Some(hi), Some(step)) => {
                if lo > hi {
                    return Err(format!("Invalid range: {}-{}, min > max", num(lo), num(hi)));
                }
                if step <= 0.0 {
                    return Err(format!("Invalid step: {}, must be positive", num(step)));
                }
                let start = lo.max(cmin);
                steps(start, hi, step, start)
            }
            (Some(lo), Some(hi), None) => {
                if lo > hi {
                    return Err(format!("Invalid range: {}-{}, min > max", num(lo), num(hi)));
                }
                num((r * (hi - lo + 1.0)).floor() + lo)
            }
            (_, _, Some(step)) => {
                if step <= 0.0 {
                    return Err(format!("Invalid step: {}, must be positive", num(step)));
                }
                steps(cmin, cmax, step, cmin)
            }
            _ => num((r * (cmax - cmin + 1.0) + cmin).floor()),
        };
        out.push_str(&replaced);
    }
    out.push_str(&value[last..]);
    Ok(out)
}

/// What `#parseRange` returns: a list, or one value (a number or the raw
/// text).
enum Ranged {
    List(Vec<i64>),
    One(Val),
}

/// JS `Number(s)` (`+s`): trimmed; `""` is 0; decimal with an optional
/// fraction and exponent, `0x` / `0o` / `0b` integers, `Infinity`; else NaN.
fn js_to_number(s: &str) -> f64 {
    let t = js::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| {
        t.strip_prefix(p)
            .or_else(|| t.strip_prefix(&p.to_ascii_uppercase()))
            .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_digit(r)))
            .map(|d| {
                d.chars().fold(0.0, |a, c| {
                    a * f64::from(r) + f64::from(c.to_digit(r).unwrap())
                })
            })
    };
    if let Some(v) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return v;
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$").unwrap()
    });
    if DECIMAL.is_match(t) {
        return t.parse().unwrap_or(f64::NAN);
    }
    f64::NAN
}

/// `isNaN(+s) ? s : +s`: a number unless NaN.
fn unary_plus(s: &str) -> Option<f64> {
    let n = js_to_number(s);
    (!n.is_nan()).then_some(n)
}

fn parse_range(kind: FieldKind, val: &str, repeat: f64) -> Result<Ranged, String> {
    let atoms: Vec<&str> = val.split('-').collect();
    if atoms.len() <= 1 {
        return Ok(Ranged::One(match unary_plus(val) {
            Some(n) => Val::Num(n),
            None => Val::Str(val.to_owned()),
        }));
    }
    let (lo, hi) = (js::parse_int(atoms[0]), js::parse_int(atoms[1]));
    let (cmin, cmax) = (kind.min() as f64, kind.max() as f64);
    if !(!lo.is_nan() && !hi.is_nan() && lo >= cmin && hi <= cmax) {
        return Err(format!(
            "Constraint error, got range {}-{} expected range {}-{}",
            num(lo),
            num(hi),
            kind.min(),
            kind.max()
        ));
    }
    if lo > hi {
        return Err(format!(
            "Invalid range: {0}-{1}, min({0}) > max({1})",
            num(lo),
            num(hi)
        ));
    }
    if !(!repeat.is_nan() && repeat > 0.0) {
        return Err(format!(
            "Constraint error, cannot repeat at every {} time.",
            num(repeat)
        ));
    }
    let mut stack = Vec::new();
    if kind == FieldKind::DayOfWeek && (hi as i64) % 7 == 0 {
        stack.push(0);
    }
    let mut i = lo;
    while i <= hi {
        if !stack.contains(&(i as i64)) {
            stack.push(i as i64);
        }
        i += repeat;
    }
    Ok(Ranged::List(stack))
}

fn parse_repeat(kind: FieldKind, val: &str) -> Result<Ranged, String> {
    let atoms: Vec<&str> = val.split('/').collect();
    if atoms.len() > 2 {
        return Err(format!("Invalid repeat: {val}"));
    }
    if atoms.len() == 2 {
        let first = if js::parse_int(atoms[0]).is_nan() {
            atoms[0].to_owned()
        } else {
            format!("{}-{}", atoms[0], kind.max())
        };
        return parse_range(kind, &first, js::parse_int(atoms[1]));
    }
    parse_range(kind, val, 1.0)
}

fn parse_sequence(kind: FieldKind, val: &str) -> Result<Vec<Val>, String> {
    let mut stack = Vec::new();
    for atom in val.split(',') {
        if atom.is_empty() {
            return Err("Invalid list value format".into());
        }
        match parse_repeat(kind, atom)? {
            Ranged::List(l) => stack.extend(l.into_iter().map(|n| Val::Num(n as f64))),
            Ranged::One(v) => {
                // Only the day fields accept `L` (`valid_chars`).
                if v.to_string().contains('L') {
                    stack.push(v);
                    continue;
                }
                let n = js::parse_int(&v.to_string());
                if !(n >= kind.min() as f64 && n <= kind.max() as f64) {
                    return Err(format!(
                        "Constraint error, got value {v} expected range {}-{}",
                        kind.min(),
                        kind.max()
                    ));
                }
                stack.push(match (kind, v) {
                    (FieldKind::DayOfWeek, _) => Val::Num(n % 7.0),
                    (_, v) => v,
                });
            }
        }
    }
    Ok(stack)
}

fn parse_field(kind: FieldKind, raw: &str, rand: &mut Mulberry) -> Result<Vec<Val>, String> {
    let value = if matches!(kind, FieldKind::Month | FieldKind::DayOfWeek) {
        replace_aliases(raw)?
    } else {
        raw.to_owned()
    };
    if !kind.valid_chars(&value) {
        return Err(format!("Invalid characters, got value: {value}"));
    }
    let wild = value.replace(['*', '?'], &format!("{}-{}", kind.min(), kind.max()));
    let hashed = parse_hashed(&wild, kind, rand)?;
    parse_sequence(kind, &hashed)
}

/// `#parseNthDay` on the raw weekday field.
/// The occurrence is `+text`, so `1#2.0`, `1#0x2` and `1#2.5` pass (the
/// last never matches).
fn parse_nth_day(val: &str) -> Result<(&str, f64), String> {
    let atoms: Vec<&str> = val.split('#').collect();
    if atoms.len() <= 1 {
        return Ok((atoms[0], 0.0));
    }
    let last = atoms[atoms.len() - 1];
    let nth = js_to_number(last);
    // `/([,-/])/`: the range `,` to `/`.
    if let Some(c) = val.chars().find(|c| (','..='/').contains(c)) {
        return Err(format!(
            "Constraint error, invalid dayOfWeek `#` and `{c}` special characters are incompatible"
        ));
    }
    if !(atoms.len() <= 2 && !nth.is_nan() && (1.0..=5.0).contains(&nth)) {
        return Err("Constraint error, invalid dayOfWeek occurrence number (#)".into());
    }
    Ok((atoms[0], nth))
}

/// A parsed expression (`CronFieldCollection`).
#[derive(Clone, Debug)]
struct Fields {
    second: Field,
    minute: Field,
    hour: Field,
    dom: Field,
    month: Field,
    dow: Field,
    nth_day: f64,
}

/// `CronExpressionParser.parse(expression)` (non-strict), `random` standing
/// in for the `Math.random()` that seeds `H`.
fn parse(expression: &str, random: f64) -> Result<Fields, String> {
    let mut rand = Mulberry::from_random(random);
    let expression = predefined(expression).unwrap_or(expression);
    let expression = if expression.is_empty() {
        "0 * * * * *"
    } else {
        expression
    };
    let mut atoms = split_fields(expression);
    if atoms.len() > 6 {
        return Err("Invalid cron expression, too many fields".into());
    }
    const DEFAULTS: [&str; 6] = ["*", "*", "*", "*", "*", "0"];
    if atoms.len() < 6 {
        let mut full: Vec<&str> = DEFAULTS[atoms.len()..].to_vec();
        full.append(&mut atoms);
        atoms = full;
    }
    let [s, mi, h, dom, mo, dow] = [atoms[0], atoms[1], atoms[2], atoms[3], atoms[4], atoms[5]];
    let second = parse_field(FieldKind::Second, s, &mut rand)?;
    let minute = parse_field(FieldKind::Minute, mi, &mut rand)?;
    let hour = parse_field(FieldKind::Hour, h, &mut rand)?;
    let month = parse_field(FieldKind::Month, mo, &mut rand)?;
    let day_of_month = parse_field(FieldKind::DayOfMonth, dom, &mut rand)?;
    let (dow_value, nth_day) = parse_nth_day(dow)?;
    let day_of_week = parse_field(FieldKind::DayOfWeek, dow_value, &mut rand)?;
    let fields = Fields {
        second: Field::new(FieldKind::Second, second, s)?,
        minute: Field::new(FieldKind::Minute, minute, mi)?,
        hour: Field::new(FieldKind::Hour, hour, h)?,
        dom: Field::new(FieldKind::DayOfMonth, day_of_month, dom)?,
        month: Field::new(FieldKind::Month, month, mo)?,
        dow: Field::new(FieldKind::DayOfWeek, day_of_week, dow)?,
        nth_day,
    };
    if fields.month.values.len() == 1 && !fields.dom.has_last_char {
        const DAYS_IN_MONTH: [f64; 12] = [
            31.0, 29.0, 31.0, 30.0, 31.0, 30.0, 31.0, 31.0, 30.0, 31.0, 30.0, 31.0,
        ];
        let first = js::parse_int(&fields.dom.values[0].to_string());
        // `DAYS_IN_MONTH[month - 1]`: `undefined` (NaN) for a fraction.
        let month = fields.month.min_value();
        let max = (month.fract() == 0.0)
            .then(|| usize::try_from(month as i64 - 1).ok())
            .flatten()
            .and_then(|i| DAYS_IN_MONTH.get(i))
            .copied()
            .unwrap_or(f64::NAN);
        // NaN on either side fails too.
        if first.partial_cmp(&max).is_none_or(|o| o.is_gt()) {
            return Err("Invalid explicit day of month definition".into());
        }
    }
    Ok(fields)
}

// ---- iteration (`CronExpression#next`) ----------------------------------------

struct CronIter {
    fields: Fields,
    current: CronDate,
    dst_day: Option<((i64, i64, i64), bool)>,
}

impl CronIter {
    fn new(fields: Fields, from_ms: i64, zone: Zone) -> CronIter {
        CronIter {
            fields,
            current: CronDate {
                d: Lux::from_millis(from_ms, zone),
                dst_start: None,
                dst_end: None,
            },
            dst_day: None,
        }
    }

    /// `#checkDstTransition`, cached per local calendar day.
    fn is_dst_transition_day(&mut self, d: &CronDate) -> bool {
        let c = d.d.c();
        let key = (c.year, c.month, c.day);
        if let Some((k, v)) = self.dst_day
            && k == key
        {
            return v;
        }
        let start = d.d.start_of(Unit::Day);
        let end = d.d.plus_calendar(0, 1).start_of(Unit::Day).plus_ms(-1);
        let v = start.o != end.o;
        self.dst_day = Some((key, v));
        v
    }

    /// `#isLastWeekdayOfMonthMatch`.
    fn last_weekday_match(&self, d: &CronDate) -> Result<bool, String> {
        let is_last = d.is_last_weekday_of_month();
        for v in &self.fields.dow.values {
            let text = v.to_string();
            let weekday = js::parse_int(text.get(..1).unwrap_or(""));
            if weekday.is_nan() {
                return Err(format!("Invalid last weekday of the month expression: {v}"));
            }
            if d.day() == weekday as i64 % 7 && is_last {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `#matchDayOfMonth`: with both fields restricted, either may match.
    fn match_day(&self, d: &CronDate) -> Result<bool, String> {
        let f = &self.fields;
        let dom_wild = f.dom.wildcard;
        let dow_wild = f.dow.wildcard;
        let matched_dom =
            f.dom.contains(d.date()) || (f.dom.has_last_char && d.is_last_day_of_month());
        let matched_dow =
            f.dow.contains(d.day()) || (f.dow.has_last_char && self.last_weekday_match(d)?);
        Ok((!dom_wild && !dow_wild && (matched_dom || matched_dow))
            || (matched_dom && dow_wild)
            || (dom_wild && !dow_wild && matched_dow))
    }

    /// `#matchHour` (forward).
    fn match_hour(&mut self, d: &mut CronDate) -> bool {
        let hours_len = self.fields.hour.values.len();
        let current = d.hours();
        if d.dst_start == Some(current) {
            if self.fields.hour.contains(current - 1) {
                return true;
            }
            d.add(Unit::Hour);
            return false;
        }
        if d.dst_end == Some(current) {
            d.dst_end = None;
            d.apply(Unit::Hour, hours_len);
            return false;
        }
        if self.fields.hour.contains(current) {
            return true;
        }
        d.dst_start = None;
        let Some(next) = self.fields.hour.nearest_after(current) else {
            d.apply(Unit::Day, hours_len);
            return false;
        };
        if self.is_dst_transition_day(d) {
            // `for (i = 0; i < next - current; i++)`
            for _ in 0..(next - current as f64).ceil() as i64 {
                d.apply(Unit::Hour, hours_len);
            }
        } else {
            d.set_hours(next);
        }
        d.set_minutes(self.fields.minute.min_value());
        d.set_seconds(self.fields.second.min_value());
        false
    }

    /// `next()` → epoch ms.
    fn next(&mut self) -> Result<i64, String> {
        let hours_len = self.fields.hour.values.len();
        let mut d = self.current;
        let start = d.d.ts;
        let mut step = 0;
        loop {
            step += 1;
            if step >= LOOP_LIMIT {
                break;
            }
            if !self.match_day(&d)? {
                d.apply(Unit::Day, hours_len);
                continue;
            }
            let nth = self.fields.nth_day;
            if !(nth <= 0.0 || ((d.date() + 6) / 7) as f64 == nth) {
                d.apply(Unit::Day, hours_len);
                continue;
            }
            if !self.fields.month.contains(d.month0() + 1) {
                d.apply(Unit::Month, hours_len);
                continue;
            }
            if !self.match_hour(&mut d) {
                continue;
            }
            if !self.fields.minute.contains(d.minutes()) {
                match self.fields.minute.nearest_after(d.minutes()) {
                    Some(m) => {
                        d.set_minutes(m);
                        d.set_seconds(self.fields.second.min_value());
                    }
                    None => {
                        d.apply(Unit::Hour, hours_len);
                        d.set_minutes(self.fields.minute.min_value());
                        d.set_seconds(self.fields.second.min_value());
                    }
                }
                continue;
            }
            if !self.fields.second.contains(d.seconds()) {
                match self.fields.second.nearest_after(d.seconds()) {
                    Some(s) => d.set_seconds(s),
                    None => {
                        d.apply(Unit::Minute, hours_len);
                        d.set_seconds(self.fields.second.min_value());
                    }
                }
                continue;
            }
            if start == d.d.ts {
                d.apply(Unit::Second, hours_len);
                continue;
            }
            break;
        }
        if d.millis() != 0 {
            d.set_millis(0);
        }
        self.current = d;
        Ok(d.d.ts)
    }
}

// ---- lib/shared/cron.ts -------------------------------------------------------

/// `validateCron`: five fields that cron-parser accepts; the trimmed text.
pub fn validate_cron(input: &str) -> Result<String, String> {
    let trimmed = js::trim(input);
    if trimmed.is_empty() {
        return Err("cron expression is required".into());
    }
    let parts = split_fields(trimmed);
    if parts.len() != 5 {
        return Err(format!("expected 5 fields, got {}", parts.len()));
    }
    parse(trimmed, math_random()).map(|_| trimmed.to_owned())
}

/// `new Date(ms)`: the time value truncated to whole milliseconds; `None`
/// for an invalid date (NaN, or beyond ±8.64e15), which cron-parser's
/// `CronDate` rejects.
fn date_ms(ms: f64) -> Option<i64> {
    (ms.abs() <= 8.64e15).then(|| ms.trunc() as i64)
}

/// `nextFires(cron, count, from)` in `zone`: `[]` if cron-parser rejects
/// the expression or the date, or fails while iterating.
pub fn next_fires_in(cron: &str, count: usize, from_ms: f64, zone: Zone) -> Vec<i64> {
    next_fires_seeded(cron, count, from_ms, zone, math_random())
}

/// [`next_fires_in`] with `Math.random()` pinned to `random`, so `H` is
/// reproducible (the golden replays cron-parser's hashing with it).
#[doc(hidden)]
pub fn next_fires_seeded(
    cron: &str,
    count: usize,
    from_ms: f64,
    zone: Zone,
    random: f64,
) -> Vec<i64> {
    let Ok(fields) = parse(cron, random) else {
        return vec![];
    };
    let Some(from) = date_ms(from_ms) else {
        return vec![];
    };
    let mut it = CronIter::new(fields, from, zone);
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        match it.next() {
            Ok(t) => out.push(t),
            Err(_) => return vec![],
        }
    }
    out
}

/// `nextFires(cron, count, from)` in the local zone.
pub fn next_fires(cron: &str, count: usize, from_ms: f64) -> Vec<i64> {
    next_fires_in(cron, count, from_ms, Zone::Local)
}

/// `nextFireMs(cron, from)` in `zone`.
pub fn next_fire_ms_in(cron: &str, from_ms: f64, zone: Zone) -> Option<i64> {
    next_fires_in(cron, 1, from_ms, zone).first().copied()
}

/// `nextFireMs(cron, from)` in the local zone.
pub fn next_fire_ms(cron: &str, from_ms: f64) -> Option<i64> {
    next_fire_ms_in(cron, from_ms, Zone::Local)
}

/// `nextFireAfter(cron, anchorMs, nowMs, tz)`, `local` standing in for the
/// process's zone: the next slot after `now`, stepping from the last fire so
/// a DST fall-back can't repeat or advance it. An unknown `tz` is `None`.
pub fn next_fire_after_in(
    cron: &str,
    anchor_ms: Option<f64>,
    now_ms: f64,
    tz: Option<&str>,
    local: Zone,
) -> Option<i64> {
    let anchor =
        anchor_ms.filter(|a| a.is_finite() && *a <= now_ms && now_ms - *a < FIRE_ANCHOR_MAX_AGE_MS);
    let start = anchor.unwrap_or(now_ms);
    let zone = match tz.filter(|t| !t.is_empty()).map(Zone::named) {
        Some(None) => return None,
        Some(Some(Zone::Local)) | None => local,
        Some(Some(zone)) => zone,
    };
    let fields = parse(cron, math_random()).ok()?;
    let mut it = CronIter::new(fields, date_ms(start)?, zone);
    let mut prev = f64::NEG_INFINITY;
    for _ in 0..MAX_ANCHOR_STEPS {
        let t = it.next().ok()?;
        let tf = t as f64;
        // A stalled iterator hands back the same slot forever.
        if tf <= prev {
            break;
        }
        prev = tf;
        if tf <= now_ms {
            continue;
        }
        if let Some(a) = anchor
            && tf - a < ANCHOR_SLOT_TOLERANCE_MS
        {
            continue;
        }
        return Some(t);
    }
    next_fire_ms_in(cron, now_ms, local)
}

/// `nextFireAfter(cron, anchorMs, nowMs, tz)` in the local zone.
pub fn next_fire_after(
    cron: &str,
    anchor_ms: Option<f64>,
    now_ms: f64,
    tz: Option<&str>,
) -> Option<i64> {
    next_fire_after_in(cron, anchor_ms, now_ms, tz, Zone::Local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_round_trips() {
        for days in [-800_000, -1, 0, 1, 19_000, 20_513, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days, "{days}");
        }
        let c = Civil {
            year: 2026,
            month: 13,
            day: 32,
            hour: 25,
            minute: 0,
            second: 0,
            ms: 0,
        };
        // `Date.UTC(2026, 12, 32, 25)` in V8: 2027-02-02T01:00Z (month 13 is
        // January, its day 32 February 1st, hour 25 the next day's 01:00).
        assert_eq!(obj_to_local_ts(&c), 1_801_530_000_000);
    }

    #[test]
    fn utc_and_gmt_are_luxons_fixed_utc_zone() {
        // Not the tzdb's `Etc/UTC` / `GMT` links: luxon maps both names to
        // `FixedOffsetZone.utcInstance` before asking `Intl`.
        for name in ["utc", "UTC", "gmt", "GMT", "Gmt"] {
            assert!(matches!(Zone::named(name), Some(Zone::Fixed(0))), "{name}");
        }
        assert!(matches!(Zone::named("Etc/GMT"), Some(Zone::Tz(_))));
    }
}
