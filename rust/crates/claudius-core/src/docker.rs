//! `app/api/docker/containers/route.ts` (D23): the Docker page's container
//! fleet. Two `execFileP` runs ([`crate::exec_file`]) start together:
//! `docker ps --format {{json .}}` (2 s) and `docker stats --no-stream
//! --format {{json .}}` (3.5 s), each with a 4 MiB `maxBuffer`, and the
//! answer waits for both. Their NDJSON rows are joined on the ID's first 12
//! UTF-16 units.
//!
//! The answer is always 200 JSON. `ps` failing is
//! `{status: "unavailable", reason, detail, containers: []}`, and so is a
//! `TypeError` while reading the rows (a non-string `ID`, `MemUsage`,
//! `BlockIO` or `NetIO`, or a value whose `String()` throws). The reason:
//! `docker-not-installed` for a spawn `ENOENT` (also a script whose
//! interpreter is missing); `docker-daemon-down` when stderr matches
//! `Cannot connect to the Docker daemon|connect: no such file or
//! directory|connection refused` (ASCII case-insensitive), with stderr's
//! first line; else `unknown` with the JS-trimmed stderr, or the error's
//! message when that is empty. `stats` failing only leaves the usage
//! fields `null`.
//!
//! Each line (split on `\n`, JS-trimmed, blanks skipped) is read the way
//! `JSON.parse` reads it, into a [`Js`] value: V8 decides what parses
//! ([`claudius_agent::js::json_parse_error_utf16`]), strings are UTF-16 (a
//! lone-surrogate escape survives, and so does a 12-unit ID cut through a
//! surrogate pair), numbers past f64 are ±Infinity, a repeated key keeps its
//! first position and its last value, and the passed-through fields are
//! written back as `JSON.stringify` writes them. `null` rows are skipped.
//! One limit: a line nested deeper than [`MAX_DEPTH`] is skipped, where V8
//! reads it (and overflows its stack printing such a value a little past
//! that depth).

use std::collections::HashMap;

use claudius_agent::js;
use indexmap::IndexMap;

use crate::exec_file::{self, ErrorCode, ExecFileError, ExecFileOptions, ExecFileOutput};

/// `DOCKER_PS_TIMEOUT_MS`.
pub const PS_TIMEOUT_MS: u64 = 2_000;
/// `DOCKER_STATS_TIMEOUT_MS`: stats samples for about a second.
pub const STATS_TIMEOUT_MS: u64 = 3_500;
/// Both runs' `maxBuffer`.
pub const MAX_BUFFER: usize = 4 * 1024 * 1024;
pub const PS_ARGS: [&str; 3] = ["ps", "--format", "{{json .}}"];
pub const STATS_ARGS: [&str; 4] = ["stats", "--no-stream", "--format", "{{json .}}"];
/// The deepest line read; see the module docs.
pub const MAX_DEPTH: usize = 1_000;

/// `(r.ID ?? "").slice(0, 12)` on a value without `slice`.
pub const PS_ID_NOT_A_FUNCTION: &str = "(r.ID ?? \"\").slice is not a function";
/// `s.ID.slice(0, 12)` on a truthy value without `slice`.
pub const STATS_ID_NOT_A_FUNCTION: &str = "s.ID.slice is not a function";
/// `s.split("/")` on a truthy non-string.
pub const SPLIT_NOT_A_FUNCTION: &str = "s.split is not a function";
/// `String(o)` for an object with its own (never callable) `toString`.
pub const CANNOT_CONVERT: &str = "Cannot convert object to primitive value";

// ---- JS values ----------------------------------------------------------------

/// A value `JSON.parse` made: strings are UTF-16 code units, numbers may be
/// ±Infinity, objects keep their keys in insertion order.
#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<Js>),
    Obj(IndexMap<Vec<u16>, Js>),
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

impl Js {
    /// `JSON.parse(text)`; `None` where it throws (or past [`MAX_DEPTH`]).
    pub fn parse(text: &str) -> Option<Js> {
        let s = units(text);
        if js::json_parse_error_utf16(&s).is_some() {
            return None;
        }
        Parser { s: &s, i: 0 }.value()
    }

    /// `o.key` on a row: own properties of objects only (the keys read here
    /// are never ones strings or arrays have).
    fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Obj(m) => m.get(&units(key)),
            _ => None,
        }
    }

    /// `JSON.stringify(v)`.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Js::Null => out.push_str("null"),
            Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Js::Num(n) => out.push_str(&js::number_to_string(*n)),
            Js::Str(s) => write_str(s, out),
            Js::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Js::Obj(m) => {
                // Array-index keys first, ascending; then insertion order.
                let mut keys: Vec<(Option<u32>, &Vec<u16>, &Js)> = m
                    .iter()
                    .map(|(k, v)| {
                        let index = String::from_utf16(k).ok().and_then(|k| js::array_index(&k));
                        (index, k, v)
                    })
                    .collect();
                keys.sort_by_key(|(index, ..)| index.map_or((1, 0), |n| (0, n)));
                out.push('{');
                for (i, (_, k, v)) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    /// `String(v)`; `Err` is the `TypeError` an object with its own
    /// `toString` throws (`OrdinaryToPrimitive` finds nothing callable).
    fn to_js_string(&self, out: &mut Vec<u16>) -> Result<(), &'static str> {
        match self {
            Js::Null => out.extend(units("null")),
            Js::Bool(b) => out.extend(units(if *b { "true" } else { "false" })),
            Js::Num(n) if n.is_finite() => out.extend(units(&js::number_to_string(*n))),
            Js::Num(n) => out.extend(units(if *n > 0.0 { "Infinity" } else { "-Infinity" })),
            Js::Str(s) => out.extend_from_slice(s),
            // `join(",")`: `null` items print empty.
            Js::Arr(items) => {
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(u16::from(b','));
                    }
                    if *item != Js::Null {
                        item.to_js_string(out)?;
                    }
                }
            }
            Js::Obj(m) if m.contains_key(&units("toString")) => return Err(CANNOT_CONVERT),
            Js::Obj(_) => out.extend(units("[object Object]")),
        }
        Ok(())
    }
}

/// `!!v`, `None` being `undefined`.
fn truthy(v: Option<&Js>) -> bool {
    match v {
        None | Some(Js::Null) => false,
        Some(Js::Bool(b)) => *b,
        Some(Js::Num(n)) => *n != 0.0,
        Some(Js::Str(s)) => !s.is_empty(),
        Some(Js::Arr(_) | Js::Obj(_)) => true,
    }
}

/// `v.slice(0, 12)`: strings by UTF-16 unit, arrays by item; `None` for
/// the values without a `slice` to call.
fn slice12(v: &Js) -> Option<Js> {
    match v {
        Js::Str(s) => Some(Js::Str(s[..s.len().min(12)].to_vec())),
        Js::Arr(a) => Some(Js::Arr(a[..a.len().min(12)].to_vec())),
        _ => None,
    }
}

/// A JS string as `JSON.stringify` writes it: `"`, `\` and C0 controls
/// escaped (short forms where JSON has them, else `\u00xx`), lone
/// surrogates as `\udxxx`, everything else as is.
fn write_str(s: &[u16], out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(s.iter().copied()) {
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

/// A parser for text V8 has already accepted, so it only builds the value.
/// Containers are kept on an explicit stack, so depth costs no recursion.
struct Parser<'a> {
    s: &'a [u16],
    i: usize,
}

enum Frame {
    Arr(Vec<Js>),
    Obj(IndexMap<Vec<u16>, Js>, Vec<u16>),
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.i += 1;
        }
    }

    /// Past `c` (after whitespace), or `None`.
    fn eat(&mut self, c: u8) -> Option<()> {
        self.ws();
        (self.peek()? == u16::from(c)).then(|| self.i += 1)
    }

    fn string(&mut self) -> Option<Vec<u16>> {
        self.eat(b'"')?;
        let mut out = vec![];
        loop {
            let c = self.peek()?;
            self.i += 1;
            match c {
                0x22 => return Some(out),
                0x5c => {
                    let e = self.peek()?;
                    self.i += 1;
                    out.push(match e {
                        0x62 => 0x08,
                        0x66 => 0x0c,
                        0x6e => 0x0a,
                        0x72 => 0x0d,
                        0x74 => 0x09,
                        0x75 => {
                            let hex = String::from_utf16(self.s.get(self.i..self.i + 4)?).ok()?;
                            self.i += 4;
                            u16::from_str_radix(&hex, 16).ok()?
                        }
                        e => e, // `"`, `\`, `/`
                    });
                }
                c => out.push(c),
            }
        }
    }

    fn number(&mut self) -> Option<Js> {
        let start = self.i;
        while matches!(self.peek(), Some(c) if c < 0x80 && b"+-.eE0123456789".contains(&(c as u8)))
        {
            self.i += 1;
        }
        let text = String::from_utf16(&self.s[start..self.i]).ok()?;
        text.parse::<f64>().ok().map(Js::Num)
    }

    fn value(&mut self) -> Option<Js> {
        let mut stack: Vec<Frame> = vec![];
        loop {
            self.ws();
            let c = self.peek()?;
            if (c == 0x7b || c == 0x5b) && stack.len() >= MAX_DEPTH {
                return None;
            }
            let mut v = match c {
                0x7b => {
                    self.i += 1;
                    self.ws();
                    if self.peek()? == 0x7d {
                        self.i += 1;
                        Js::Obj(IndexMap::new())
                    } else {
                        let key = self.string()?;
                        self.eat(b':')?;
                        stack.push(Frame::Obj(IndexMap::new(), key));
                        continue;
                    }
                }
                0x5b => {
                    self.i += 1;
                    self.ws();
                    if self.peek()? == 0x5d {
                        self.i += 1;
                        Js::Arr(vec![])
                    } else {
                        stack.push(Frame::Arr(vec![]));
                        continue;
                    }
                }
                0x22 => Js::Str(self.string()?),
                0x74 => {
                    self.i += 4;
                    Js::Bool(true)
                }
                0x66 => {
                    self.i += 5;
                    Js::Bool(false)
                }
                0x6e => {
                    self.i += 4;
                    Js::Null
                }
                _ => self.number()?,
            };
            // Hand the finished value to its container, closing containers
            // until one wants another value.
            loop {
                match stack.last_mut() {
                    None => return Some(v),
                    Some(Frame::Arr(items)) => {
                        items.push(v);
                        if self.eat(b',').is_some() {
                            break;
                        }
                        self.eat(b']')?;
                        let Some(Frame::Arr(items)) = stack.pop() else {
                            return None;
                        };
                        v = Js::Arr(items);
                    }
                    Some(Frame::Obj(members, key)) => {
                        // A repeated key keeps its place and takes the new value.
                        members.insert(std::mem::take(key), v);
                        if self.eat(b',').is_some() {
                            *key = self.string()?;
                            self.eat(b':')?;
                            break;
                        }
                        self.eat(b'}')?;
                        let Some(Frame::Obj(members, _)) = stack.pop() else {
                            return None;
                        };
                        v = Js::Obj(members);
                    }
                }
            }
        }
    }
}

// ---- the route's parsers ----------------------------------------------------------

/// `Container["health"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    Healthy,
    Unhealthy,
    Starting,
}

impl Health {
    pub fn as_str(self) -> &'static str {
        match self {
            Health::Healthy => "healthy",
            Health::Unhealthy => "unhealthy",
            Health::Starting => "starting",
        }
    }
}

/// `s` (UTF-16) starting with `pat` in ASCII case-insensitive terms, as a
/// non-unicode `/i` regex compares: no other character folds to an ASCII one.
fn starts_with_ci(s: &[u16], pat: &str) -> bool {
    s.len() >= pat.len()
        && s.iter()
            .zip(pat.bytes())
            .all(|(&c, p)| c < 0x80 && (c as u8).eq_ignore_ascii_case(&p))
}

/// `parseHealth`: `/\((healthy|unhealthy|health: starting)\)/i`, leftmost.
pub fn parse_health(status: &[u16]) -> Option<Health> {
    (0..status.len()).find_map(|i| {
        let rest = &status[i..];
        if starts_with_ci(rest, "(healthy)") {
            Some(Health::Healthy)
        } else if starts_with_ci(rest, "(unhealthy)") {
            Some(Health::Unhealthy)
        } else if starts_with_ci(rest, "(health: starting)") {
            Some(Health::Starting)
        } else {
            None
        }
    })
}

fn is_digit(s: &[u16], i: usize) -> bool {
    s.get(i).is_some_and(|&c| (0x30..=0x39).contains(&c))
}

/// The leftmost `(-?\d+(?:\.\d+)?)`: its text and where it ends.
fn find_number(s: &[u16]) -> Option<(String, usize)> {
    (0..s.len()).find_map(|i| {
        let digits = if s[i] == u16::from(b'-') && is_digit(s, i + 1) {
            i + 1
        } else if is_digit(s, i) {
            i
        } else {
            return None;
        };
        let mut j = digits;
        while is_digit(s, j) {
            j += 1;
        }
        if s.get(j) == Some(&u16::from(b'.')) && is_digit(s, j + 1) {
            j += 1;
            while is_digit(s, j) {
                j += 1;
            }
        }
        // ASCII only, so the units are the text.
        let text = s[i..j].iter().map(|&c| c as u8 as char).collect();
        Some((text, j))
    })
}

/// `Number(text)` for a match of `-?\d+(\.\d+)?`, kept when finite.
fn finite(text: &str) -> Option<f64> {
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// `parsePercent`: falsy → `null`; else the first number in `String(v)`
/// (`"1.23%"` → 1.23), `null` when there is none or it isn't finite.
pub fn parse_percent(v: Option<&Js>) -> Result<Option<f64>, &'static str> {
    if !truthy(v) {
        return Ok(None);
    }
    let mut s = vec![];
    if let Some(v) = v {
        v.to_js_string(&mut s)?;
    }
    Ok(find_number(&s).and_then(|(text, _)| finite(&text)))
}

/// `SUFFIXES[unit] ?? 1`.
fn suffix(unit: &str) -> f64 {
    match unit {
        "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "KIB" => 1024.0,
        "MIB" => 1024f64.powi(2),
        "GIB" => 1024f64.powi(3),
        "TIB" => 1024f64.powi(4),
        _ => 1.0, // `B`, and any unit it doesn't know
    }
}

/// `parseSize`: the first number, then after any JS whitespace an optional
/// run of ASCII letters as the unit (`B` without one), times its factor.
/// (TS trims first and returns `null` for `""`; neither changes the match.)
pub fn parse_size(s: Option<&[u16]>) -> Option<f64> {
    let s = s?;
    let (text, mut end) = find_number(s)?;
    let n = finite(&text)?;
    while s
        .get(end)
        .is_some_and(|&c| char::from_u32(u32::from(c)).is_some_and(js::is_whitespace))
    {
        end += 1;
    }
    let unit: String = s[end..]
        .iter()
        .take_while(|&&c| c < 0x80 && (c as u8).is_ascii_alphabetic())
        .map(|&c| (c as u8).to_ascii_uppercase() as char)
        .collect();
    Some(n * suffix(&unit))
}

/// `s.split("/")` for a truthy `s`; `Err` for a non-string.
fn split_slash(v: &Js) -> Result<Vec<&[u16]>, &'static str> {
    match v {
        Js::Str(s) => Ok(s.split(|&c| c == u16::from(b'/')).collect()),
        _ => Err(SPLIT_NOT_A_FUNCTION),
    }
}

/// `parseUsage`: `"23.4MiB / 1.95GiB"` → (used, limit).
pub fn parse_usage(v: Option<&Js>) -> Result<(Option<f64>, Option<f64>), &'static str> {
    match v {
        Some(v) if truthy(Some(v)) => {
            let parts = split_slash(v)?;
            Ok((
                parse_size(parts.first().copied()),
                parse_size(parts.get(1).copied()),
            ))
        }
        _ => Ok((None, None)),
    }
}

/// `parseIOSum`: every `/`-separated size added up, an unreadable one as 0.
pub fn parse_io_sum(v: Option<&Js>) -> Result<Option<f64>, &'static str> {
    match v {
        Some(v) if truthy(Some(v)) => {
            Ok(Some(split_slash(v)?.into_iter().fold(0.0, |sum, p| {
                sum + parse_size(Some(p)).unwrap_or(0.0)
            })))
        }
        _ => Ok(None),
    }
}

/// `parseNdjson`: one value per JS-trimmed line; lines that don't parse
/// (blank ones too) and `null`s are skipped.
pub fn parse_ndjson(stdout: &str) -> Vec<Js> {
    stdout
        .split('\n')
        .map(js::trim)
        .filter_map(Js::parse)
        .filter(|v| *v != Js::Null)
        .collect()
}

// ---- the response ----------------------------------------------------------------

/// `Container`, in its key order.
#[derive(Clone, Debug, PartialEq)]
pub struct Container {
    pub id: Js,
    pub name: Js,
    pub image: Js,
    pub status: Js,
    pub state: Js,
    pub ports: Js,
    pub running_for: Js,
    pub health: Option<Health>,
    pub cpu_pct: Option<f64>,
    pub mem_pct: Option<f64>,
    pub mem_usage_bytes: Option<f64>,
    pub mem_limit_bytes: Option<f64>,
    pub block_io_bytes: Option<f64>,
    pub net_io_bytes: Option<f64>,
}

fn write_num(n: Option<f64>, out: &mut String) {
    match n {
        // Infinity / NaN print `null` too.
        Some(n) => out.push_str(&js::number_to_string(n)),
        None => out.push_str("null"),
    }
}

impl Container {
    fn write(&self, out: &mut String) {
        for (i, (key, v)) in [
            ("id", &self.id),
            ("name", &self.name),
            ("image", &self.image),
            ("status", &self.status),
            ("state", &self.state),
            ("ports", &self.ports),
            ("runningFor", &self.running_for),
        ]
        .into_iter()
        .enumerate()
        {
            out.push_str(if i == 0 { "{\"" } else { ",\"" });
            out.push_str(key);
            out.push_str("\":");
            v.write(out);
        }
        out.push_str(",\"health\":");
        match self.health {
            Some(h) => {
                out.push('"');
                out.push_str(h.as_str());
                out.push('"');
            }
            None => out.push_str("null"),
        }
        for (key, n) in [
            ("cpuPct", self.cpu_pct),
            ("memPct", self.mem_pct),
            ("memUsageBytes", self.mem_usage_bytes),
            ("memLimitBytes", self.mem_limit_bytes),
            ("blockIOBytes", self.block_io_bytes),
            ("netIOBytes", self.net_io_bytes),
        ] {
            out.push_str(",\"");
            out.push_str(key);
            out.push_str("\":");
            write_num(n, out);
        }
        out.push('}');
    }
}

/// Joins the rows as the handler's `try` block does; `Err` is the message
/// of the `TypeError` it throws on the first row it can't read.
pub fn containers(
    ps_stdout: &str,
    stats_stdout: Option<&str>,
) -> Result<Vec<Container>, &'static str> {
    let ps_rows = parse_ndjson(ps_stdout);
    let stats_rows = stats_stdout.map(parse_ndjson).unwrap_or_default();
    // `if (s.ID) statsById.set(s.ID.slice(0, 12), s)`: the last row wins; an
    // array ID makes a key no lookup can find.
    let mut stats_by_id: HashMap<Vec<u16>, &Js> = HashMap::new();
    for s in &stats_rows {
        let id = s.get("ID");
        if truthy(id) {
            match id.and_then(slice12) {
                Some(Js::Str(key)) => {
                    stats_by_id.insert(key, s);
                }
                Some(_) => {}
                None => return Err(STATS_ID_NOT_A_FUNCTION),
            }
        }
    }
    let empty = Js::Str(vec![]);
    // `x ?? ""`.
    let or_empty = |v: Option<&Js>| match v {
        None | Some(Js::Null) => empty.clone(),
        Some(v) => v.clone(),
    };
    let mut out = Vec::with_capacity(ps_rows.len());
    for r in &ps_rows {
        let id = slice12(&or_empty(r.get("ID"))).ok_or(PS_ID_NOT_A_FUNCTION)?;
        let stats = match &id {
            Js::Str(key) => stats_by_id.get(key).copied(),
            _ => None,
        };
        let field = |key: &str| stats.and_then(|s| s.get(key));
        let (mem_usage_bytes, mem_limit_bytes) = parse_usage(field("MemUsage"))?;
        let status = or_empty(r.get("Status"));
        let mut status_text = vec![];
        status.to_js_string(&mut status_text)?;
        out.push(Container {
            name: or_empty(r.get("Names")),
            image: or_empty(r.get("Image")),
            state: or_empty(r.get("State")),
            ports: or_empty(r.get("Ports")),
            running_for: or_empty(r.get("RunningFor")),
            health: parse_health(&status_text),
            cpu_pct: parse_percent(field("CPUPerc"))?,
            mem_pct: parse_percent(field("MemPerc"))?,
            mem_usage_bytes,
            mem_limit_bytes,
            block_io_bytes: parse_io_sum(field("BlockIO"))?,
            net_io_bytes: parse_io_sum(field("NetIO"))?,
            status,
            id,
        });
    }
    Ok(out)
}

/// `reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NotInstalled,
    DaemonDown,
    Unknown,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::NotInstalled => "docker-not-installed",
            Reason::DaemonDown => "docker-daemon-down",
            Reason::Unknown => "unknown",
        }
    }
}

/// What the handler's `catch` got: `ps`'s rejection, or a `TypeError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    Exec(ExecFileError),
    TypeError(&'static str),
}

/// `classifyError`.
pub fn classify(failure: &Failure) -> (Reason, String) {
    let (enoent, stderr, message) = match failure {
        Failure::Exec(e) => (
            e.code == ErrorCode::Name("ENOENT".into()),
            e.stderr.as_str(),
            e.message.as_str(),
        ),
        Failure::TypeError(m) => (false, "", *m),
    };
    if enoent {
        return (Reason::NotInstalled, "`docker` not found on PATH".into());
    }
    let lower = stderr.to_ascii_lowercase();
    if [
        "cannot connect to the docker daemon",
        "connect: no such file or directory",
        "connection refused",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        let first = stderr.split('\n').next().unwrap_or_default();
        return (Reason::DaemonDown, first.to_owned());
    }
    let trimmed = js::trim(stderr);
    let detail = if trimmed.is_empty() { message } else { trimmed };
    (Reason::Unknown, detail.to_owned())
}

/// `DockerResponse`.
#[derive(Clone, Debug, PartialEq)]
pub enum DockerResponse {
    Ok {
        containers: Vec<Container>,
        sampled_at: i64,
    },
    Unavailable {
        reason: Reason,
        detail: String,
    },
}

impl DockerResponse {
    /// `JSON.stringify(body)`.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        match self {
            DockerResponse::Ok {
                containers,
                sampled_at,
            } => {
                out.push_str(r#"{"status":"ok","containers":["#);
                for (i, c) in containers.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    c.write(&mut out);
                }
                out.push_str(r#"],"sampledAt":"#);
                out.push_str(&sampled_at.to_string());
                out.push('}');
            }
            DockerResponse::Unavailable { reason, detail } => {
                out.push_str(r#"{"status":"unavailable","reason":""#);
                out.push_str(reason.as_str());
                out.push_str(r#"","detail":"#);
                write_str(&units(detail), &mut out);
                out.push_str(r#","containers":[]}"#);
            }
        }
        out
    }
}

/// The handler after both runs settled: `ps` failing (or the rows
/// throwing) is the classified error; `stats` failing is no usage.
pub fn respond(
    sampled_at: i64,
    ps: Result<ExecFileOutput, ExecFileError>,
    stats: Result<ExecFileOutput, ExecFileError>,
) -> DockerResponse {
    let joined = match ps {
        Err(e) => Err(Failure::Exec(e)),
        Ok(ps) => containers(&ps.stdout, stats.ok().as_ref().map(|s| s.stdout.as_str()))
            .map_err(Failure::TypeError),
    };
    match joined {
        Ok(containers) => DockerResponse::Ok {
            containers,
            sampled_at,
        },
        Err(f) => {
            let (reason, detail) = classify(&f);
            DockerResponse::Unavailable { reason, detail }
        }
    }
}

fn options(timeout_ms: u64) -> ExecFileOptions<'static> {
    ExecFileOptions {
        cwd: None,
        timeout_ms,
        max_buffer: MAX_BUFFER,
    }
}

/// `GET /api/docker/containers`: `sampledAt` is taken before the runs
/// start, and both run at once (in the server's cwd and env).
pub async fn get_containers() -> DockerResponse {
    let sampled_at = crate::now_ms();
    let (ps, stats) = tokio::join!(
        exec_file::exec_file("docker", &PS_ARGS, options(PS_TIMEOUT_MS)),
        exec_file::exec_file("docker", &STATS_ARGS, options(STATS_TIMEOUT_MS)),
    );
    respond(sampled_at, ps, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec_error(code: ErrorCode, stderr: &str, message: &str) -> ExecFileError {
        ExecFileError {
            message: message.into(),
            code,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }

    fn deep(levels: usize) -> String {
        format!("{}1{}", "[".repeat(levels), "]".repeat(levels))
    }

    #[test]
    fn parses_like_json_parse() {
        let v = Js::parse(
            r#" {"b":1,"a":[true,false,null,"é\ud800",-0,1e400],"b":{"10":0,"2":1,"x":2}} "#,
        )
        .unwrap();
        assert_eq!(
            v.stringify(),
            r#"{"b":{"2":1,"10":0,"x":2},"a":[true,false,null,"é\ud800",0,null]}"#
        );
        assert_eq!(Js::parse("{"), None);
        assert_eq!(Js::parse("[1,]"), None);
        assert_eq!(Js::parse("null"), Some(Js::Null));
        assert_eq!(
            Js::parse(&deep(MAX_DEPTH)).map(|v| v == Js::Null),
            Some(false)
        );
        assert_eq!(Js::parse(&deep(MAX_DEPTH + 1)), None);
        let objects = |n: usize| format!("{}1{}", "{\"a\":".repeat(n), "}".repeat(n));
        assert!(Js::parse(&objects(MAX_DEPTH)).is_some());
        assert_eq!(Js::parse(&objects(MAX_DEPTH + 1)), None);
        assert_eq!(
            Js::parse("[1,\n2\n]").map(|v| v.stringify()),
            Some("[1,2]".into())
        );
        assert_eq!(
            Js::parse(&format!(
                "{}{}",
                "[".repeat(MAX_DEPTH + 1),
                "]".repeat(MAX_DEPTH + 1)
            )),
            None
        );
        let mut s = vec![];
        Js::parse(r#"[1,null,[2,[true]],{"a":1},-1e400]"#)
            .unwrap()
            .to_js_string(&mut s)
            .unwrap();
        assert_eq!(
            String::from_utf16(&s).unwrap(),
            "1,,2,true,[object Object],-Infinity"
        );
        assert_eq!(
            Js::parse(r#"[{"toString":1}]"#)
                .unwrap()
                .to_js_string(&mut vec![]),
            Err(CANNOT_CONVERT)
        );
    }

    #[test]
    fn classifies_in_ts_order() {
        // ENOENT before the daemon test, the daemon test before stderr.
        let f = |code, stderr, message| classify(&Failure::Exec(exec_error(code, stderr, message)));
        assert_eq!(
            f(ErrorCode::Name("ENOENT".into()), "connection refused", "m"),
            (Reason::NotInstalled, "`docker` not found on PATH".into())
        );
        assert_eq!(
            f(ErrorCode::Exit(1), "x\nCONNECTION refused\n", "m"),
            (Reason::DaemonDown, "x".into())
        );
        assert_eq!(
            f(
                ErrorCode::Name("EACCES".into()),
                " \u{a0}",
                "spawn docker EACCES"
            ),
            (Reason::Unknown, "spawn docker EACCES".into())
        );
        assert_eq!(
            classify(&Failure::TypeError(SPLIT_NOT_A_FUNCTION)),
            (Reason::Unknown, SPLIT_NOT_A_FUNCTION.into())
        );
    }

    #[test]
    fn stats_failing_only_drops_usage() {
        let ps = Ok(ExecFileOutput {
            stdout: "{\"ID\":\"a\"}\n".into(),
            stderr: String::new(),
        });
        let stats = |stdout: &str| ExecFileOutput {
            stdout: stdout.into(),
            stderr: String::new(),
        };
        let row = "{\"ID\":\"a\",\"CPUPerc\":\"5%\"}\n";
        let ok = respond(7, ps.clone(), Ok(stats(row)));
        let DockerResponse::Ok {
            containers,
            sampled_at,
        } = &ok
        else {
            panic!()
        };
        assert_eq!((containers[0].cpu_pct, *sampled_at), (Some(5.0), 7));
        let failed = exec_error(ErrorCode::Exit(1), "", "m");
        let degraded = respond(
            7,
            ps,
            Err(ExecFileError {
                stdout: row.into(),
                ..failed.clone()
            }),
        );
        let DockerResponse::Ok { containers, .. } = &degraded else {
            panic!()
        };
        assert_eq!(containers[0].cpu_pct, None);
        assert_eq!(
            respond(7, Err(failed), Ok(stats(row))).to_json(),
            r#"{"status":"unavailable","reason":"unknown","detail":"m","containers":[]}"#
        );
    }
}
