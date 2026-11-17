//! `lib/server/cost-aggregate.ts` (D18b): the per-workspace Cost page
//! (`GET /api/cost`), and the transcript rows and pricing that
//! [`crate::cost_overview`] (`GET /api/cost/overview`) shares.
//!
//! - [`summarize_project_dir`]: every `<id>.jsonl` of one
//!   `homedir()/.claude/projects/<dir>` plus its subagent transcripts, each
//!   distilled to one [`Row`] per assistant turn (the model, the local day,
//!   the token counts, the 1-hour slice of the cache writes, the record's own
//!   `costUSD`, `inference_geo`), through the dir's `.claudius-cost-cache.json`
//!   (v3): a file is parsed again only when its `mtimeMs` or `size` changed,
//!   entries of files that are gone are dropped, and the cache is rewritten
//!   (`JSON.stringify`) when anything changed. The cache is kept as the JSON
//!   value it was read as, so foreign keys and their order survive a rewrite.
//! - [`row_usd`]: the record's `costUSD`, else the LiteLLM list price
//!   ([`litellm_pricing::cost_from_usage`]: the 200k / 100k tiers, 1-hour
//!   cache writes at twice the tiered input rate) times the 1.1x US
//!   data-residency premium; then the `modelPricing` override
//!   ([`model_pricing_override::apply_model_pricing`]).
//! - [`aggregate`]: the report. Turns dedupe by `message.id:requestId` across
//!   files, oldest file first (then `localeCompare` on the path), so a
//!   resumed or forked transcript's replayed turns count once. Totals per
//!   day, per model and per session (a session's subagent transcripts fold
//!   into its row; its model is the most-used one), the session titles and
//!   account pins from the project's `.claudius.db`, and the today / rolling
//!   7-day / rolling 30-day sums by local day key.
//!
//! JS semantics mirrored: lines read as `JSON.parse` reads them (lone
//! surrogates, `1e400` as Infinity), token fields through `Number(x ?? 0)`
//! (strings, booleans and arrays coerce, an object coerces to NaN, one with
//! its own `toString` throws), a non-string `message.model` throws at
//! `startsWith`, NaN surviving into the totals (written as `null`), V8's
//! sort with its NaN comparisons, ICU `localeCompare`, a plain object's
//! histogram (a model named like an `Object.prototype` property never wins;
//! array-index model names come first), and every throw's `err.message`.
//!
//! Differences: a cache entry that matches a transcript's `mtimeMs` and
//! `size` but isn't shaped as Claudius writes it (its `rows` not an array of
//! row objects, a non-number token field, a non-string model or day) is
//! parsed again, where TS uses it as it is (and may throw on it).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use claudius_agent::js;
use indexmap::IndexMap;
use jiff::tz::TimeZone;
use serde_json::{Map, Value, json};

use crate::accounts::AccountsStore;
use crate::asset_list::v8_sort;
use crate::cost_pricing::inference_geo_multiplier;
use crate::litellm_pricing::{self, OBJECT_PROTOTYPE_KEYS, PricingTable, Usage};
use crate::model_pricing_override::{self as mpo, OverrideTokens};
use crate::settings::{self, Scope};
use crate::{
    collate, db_agents, js_date, js_num, js_string, managed_settings, node_fs, node_path, paths,
    session_accounts, sessions_db, usage_seed,
};

/// What a call threw: the `err.message` the route answers with.
pub type Thrown = String;

/// The cache file in each project dir.
pub const CACHE_FILE: &str = ".claudius-cost-cache.json";
/// `CACHE_VERSION`.
pub const CACHE_VERSION: f64 = 3.0;
const DAY_MS: f64 = 86_400_000.0;
/// `new Date(t)`'s `TimeClip` bound.
const MAX_TIME: f64 = 8.64e15;

/// The empty report's note.
pub const NOTE_EMPTY: &str = "No sessions recorded yet for this project.";
/// The note with a `modelPricing` override.
pub const NOTE_OVERRIDE: &str = "Cost uses your org's contracted modelPricing rates (settings.json) instead of list price where a rate matches; deduplicated by message+request id so resumed/forked sessions aren't double-counted.";
/// The note at list price.
pub const NOTE_LIST: &str = "Cost uses on-disk token counts priced with LiteLLM public list prices (1-hour cache writes at 2\u{d7} input, as Claude Code bills them), deduplicated by message+request id so resumed/forked sessions aren't double-counted.";

/// `Date.now()` and the process's time zone, which the day keys use.
#[derive(Clone, Debug)]
pub struct Clock {
    pub now_ms: f64,
    pub tz: TimeZone,
}

impl Clock {
    /// The real clock in the system zone (`TZ` first).
    pub fn system() -> Clock {
        Clock {
            now_ms: crate::now_ms() as f64,
            tz: TimeZone::system(),
        }
    }
}

// ───────────────────────────── day keys ─────────────────────────────

/// The UTC offset (ms) in force at `utc_ms`. jiff stops at years ±9999, so
/// past ±9000 the instant is moved by whole 400-year Gregorian cycles (the
/// zone's final rule repeats with them), as `js_date` does.
fn offset_ms(tz: &TimeZone, utc_ms: i64) -> i64 {
    const CYCLE: i64 = 146_097 * 86_400_000;
    const EDGE: i64 = 221_845_392_000_000; // 9000-01-01T00:00:00Z
    let cycles = if utc_ms > EDGE {
        (utc_ms - EDGE) / CYCLE + 1
    } else if utc_ms < -EDGE {
        -((-EDGE - utc_ms) / CYCLE + 1)
    } else {
        0
    };
    let secs = (utc_ms - cycles * CYCLE).div_euclid(1000);
    jiff::Timestamp::from_second(secs).map_or(0, |ts| i64::from(tz.to_offset(ts).seconds()) * 1000)
}

/// Days since 1970-01-01 to the civil date.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `dayKey(ms)` in `tz`: `${getFullYear()}-${MM}-${dd}` (the year
/// unpadded, `-5` before year 1), `NaN-NaN-NaN` for an invalid date.
pub fn day_key_in(ms: f64, tz: &TimeZone) -> String {
    if !ms.is_finite() || ms.abs() > MAX_TIME {
        return "NaN-NaN-NaN".into();
    }
    let t = ms.trunc() as i64;
    let local = t + offset_ms(tz, t);
    let (y, m, d) = civil(local.div_euclid(86_400_000));
    format!("{y}-{m:02}-{d:02}")
}

// ───────────────────────────── rows ─────────────────────────────

/// One assistant turn (`Row`). Token fields are JS numbers (NaN and
/// Infinity included); a `null` read back from the cache is 0, as JS
/// arithmetic takes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// `message.id:requestId`; `None` for `null` (or another falsy key).
    pub k: Option<String>,
    pub m: String,
    pub d: String,
    pub i: f64,
    pub o: f64,
    pub cr: f64,
    pub cw: f64,
    /// `row.cw1h ?? 0`.
    pub cw1h: f64,
    pub u: Option<f64>,
    pub geo: Option<String>,
}

/// `FileSummary`, as the aggregation reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct FileSummary {
    pub path: String,
    pub first_seen_ms: f64,
    pub last_seen_ms: f64,
    pub rows: Vec<Row>,
}

/// `Math.min(a, b)`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// A JS number's truthiness.
fn truthy_num(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

const NO_PRIMITIVE: &str = "Cannot convert object to primitive value";

/// `Number(v ?? 0)` (`None` is `undefined`).
fn number_or_zero(v: Option<&Value>) -> Result<f64, Thrown> {
    match v {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => {
            if let Some(f) = db_agents::infinity(v) {
                return Ok(f);
            }
            js_string::to_js_number(Some(v)).map_err(|_| NO_PRIMITIVE.to_owned())
        }
    }
}

/// `obj.key` for a value read as an object: a plain object's own property,
/// `undefined` for anything else (none of the keys read here is on a
/// primitive's prototype).
fn get<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v?.as_object()?.get(key)
}

/// One transcript line as a row, `Ok(None)` when it isn't an API call.
fn parse_line(line: &str, tz: &TimeZone) -> Result<Option<(Row, f64)>, Thrown> {
    if !line.starts_with('{') {
        return Ok(None);
    }
    let Ok(r) = db_agents::json_parse_js(line) else {
        return Ok(None);
    };
    let r = Some(&r);
    if get(r, "type").and_then(db_agents::as_str) != Some("assistant") {
        return Ok(None);
    }
    let message = get(r, "message");
    // `if (!message?.usage) continue;`
    let Some(u) = get(message, "usage").filter(|u| js::truthy(u)) else {
        return Ok(None);
    };
    let ts = match get(r, "timestamp").and_then(db_agents::as_str) {
        Some(s) => js_date::date_parse(s),
        None => None,
    };
    let Some(ts) = ts else { return Ok(None) };
    let model = match get(message, "model") {
        None | Some(Value::Null) => "(unknown)".to_owned(),
        Some(v) => match db_agents::as_str(v) {
            Some(s) => s.to_owned(),
            None => return Err("model.startsWith is not a function".into()),
        },
    };
    if model.starts_with("<synthetic>") {
        return Ok(None);
    }
    let u = Some(u);
    let cc = get(u, "cache_creation");
    let total = number_or_zero(get(u, "cache_creation_input_tokens"))?;
    let cache_write = if truthy_num(total) {
        total
    } else {
        number_or_zero(get(cc, "ephemeral_5m_input_tokens"))?
            + number_or_zero(get(cc, "ephemeral_1h_input_tokens"))?
    };
    let one_hour = number_or_zero(get(cc, "ephemeral_1h_input_tokens"))?;
    let cw1h = js_min(
        if truthy_num(one_hour) { one_hour } else { 0.0 },
        cache_write,
    );
    let msg_id = get(message, "id").and_then(db_agents::as_str);
    let req_id = get(r, "requestId").and_then(db_agents::as_str);
    let cost = get(r, "costUSD").and_then(db_agents::number);
    let k = match (msg_id, req_id) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => Some(format!("{a}:{b}")),
        _ => None,
    };
    let d = day_key_in(ts as f64, tz);
    let i = number_or_zero(get(u, "input_tokens"))?;
    let o = number_or_zero(get(u, "output_tokens"))?;
    let cr = number_or_zero(get(u, "cache_read_input_tokens"))?;
    let geo = get(u, "inference_geo")
        .and_then(db_agents::as_str)
        .map(str::to_owned);
    Ok(Some((
        Row {
            k,
            m: model,
            d,
            i,
            o,
            cr,
            cw: cache_write,
            cw1h,
            u: cost,
            geo,
        },
        ts as f64,
    )))
}

/// A row as `JSON.stringify` writes it into the cache.
fn row_json(r: &Row) -> Value {
    json!({
        "k": r.k,
        "m": r.m,
        "d": r.d,
        "i": js_num(r.i),
        "o": js_num(r.o),
        "cr": js_num(r.cr),
        "cw": js_num(r.cw),
        "cw1h": js_num(r.cw1h),
        "u": r.u.map_or(Value::Null, js_num),
        "geo": r.geo,
    })
}

/// `summarizeFile(path, mtimeMs, size)`: the summary and its cache entry.
fn summarize_file(
    path: &str,
    mtime_ms: f64,
    size: f64,
    tz: &TimeZone,
) -> Result<(FileSummary, Value), Thrown> {
    let mut s = FileSummary {
        path: path.to_owned(),
        first_seen_ms: f64::INFINITY,
        last_seen_ms: 0.0,
        rows: Vec::new(),
    };
    match node_fs::read_to_string(path) {
        Ok(text) => {
            for line in text.split('\n') {
                let Some((row, ts)) = parse_line(line, tz)? else {
                    continue;
                };
                s.rows.push(row);
                if ts < s.first_seen_ms {
                    s.first_seen_ms = ts;
                }
                if ts > s.last_seen_ms {
                    s.last_seen_ms = ts;
                }
            }
            if s.first_seen_ms == f64::INFINITY {
                s.first_seen_ms = 0.0;
            }
        }
        Err(_) => s.first_seen_ms = 0.0,
    }
    let value = json!({
        "path": path,
        "mtimeMs": js_num(mtime_ms),
        "size": js_num(size),
        "firstSeenMs": js_num(s.first_seen_ms),
        "lastSeenMs": js_num(s.last_seen_ms),
        "rows": s.rows.iter().map(row_json).collect::<Vec<_>>(),
    });
    Ok((s, value))
}

/// A cached token field: missing is `undefined` (NaN in the sums), `null`
/// is 0; anything but a number is a shape Claudius doesn't write.
fn cached_num(o: &Map<String, Value>, key: &str) -> Option<f64> {
    match o.get(key) {
        None => Some(f64::NAN),
        Some(Value::Null) => Some(0.0),
        Some(v) => db_agents::number(v),
    }
}

/// A cached row as the aggregation reads it, `None` when it isn't shaped as
/// Claudius writes it.
fn cached_row(v: &Value) -> Option<Row> {
    let o = v.as_object()?;
    let k = match o.get("k") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let s = db_agents::as_str(v)?;
            (!s.is_empty()).then(|| s.to_owned())
        }
    };
    let cw1h = match o.get("cw1h") {
        None | Some(Value::Null) => 0.0,
        Some(v) => db_agents::number(v)?,
    };
    let u = match o.get("u") {
        None | Some(Value::Null) => None,
        Some(v) => Some(db_agents::number(v)?),
    };
    Some(Row {
        k,
        m: db_agents::as_str(o.get("m")?)?.to_owned(),
        d: db_agents::as_str(o.get("d")?)?.to_owned(),
        i: cached_num(o, "i")?,
        o: cached_num(o, "o")?,
        cr: cached_num(o, "cr")?,
        cw: cached_num(o, "cw")?,
        cw1h,
        u,
        geo: o.get("geo").and_then(db_agents::as_str).map(str::to_owned),
    })
}

/// A cache entry as a summary, `None` when it isn't shaped as Claudius
/// writes it.
fn cached_summary(v: &Value) -> Option<FileSummary> {
    let o = v.as_object()?;
    Some(FileSummary {
        path: db_agents::as_str(o.get("path")?)?.to_owned(),
        first_seen_ms: db_agents::number(o.get("firstSeenMs")?)?,
        last_seen_ms: db_agents::number(o.get("lastSeenMs")?)?,
        rows: o
            .get("rows")?
            .as_array()?
            .iter()
            .map(cached_row)
            .collect::<Option<Vec<_>>>()?,
    })
}

/// `cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size`.
fn is_hit(cached: Option<&Value>, mtime_ms: f64, size: f64) -> bool {
    let Some(o) = cached.and_then(Value::as_object) else {
        return false;
    };
    o.get("mtimeMs").and_then(db_agents::number) == Some(mtime_ms)
        && o.get("size").and_then(db_agents::number) == Some(size)
}

/// `readCache(dir)`: the parsed file when its `version` is 3 and its
/// `files` truthy, else a fresh `{version: 3, files: {}}`.
fn read_cache(dir: &str) -> Map<String, Value> {
    let path = node_path::join(&[dir, CACHE_FILE]);
    if let Ok(text) = node_fs::read_to_string(&path)
        && let Ok(Value::Object(m)) = db_agents::json_parse_js(&text)
        && m.get("version").and_then(Value::as_f64) == Some(CACHE_VERSION)
        && m.get("files").is_some_and(js::truthy)
    {
        return m;
    }
    let mut m = Map::new();
    m.insert("version".into(), json!(3));
    m.insert("files".into(), json!({}));
    m
}

/// `writeCache(dir, cache)`, best effort.
fn write_cache(dir: &str, cache: &Value) {
    let path = node_path::join(&[dir, CACHE_FILE]);
    if node_fs::mkdir_recursive(&node_path::dirname(&path), 0o777).is_err() {
        return;
    }
    let text = js_string::stringify(&settings::plain(cache));
    let _ = node_fs::write_file(&path, &text, 0o666);
}

/// `String(v)` of a primitive, for V8's `Cannot create property` message.
fn primitive_text(v: &Value) -> (&'static str, String) {
    if let Some(f) = db_agents::infinity(v) {
        return (
            "number",
            if f > 0.0 { "Infinity" } else { "-Infinity" }.into(),
        );
    }
    match v {
        Value::Bool(b) => ("boolean", b.to_string()),
        Value::Number(n) => (
            "number",
            js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        ),
        Value::String(s) => ("string", s.clone()),
        _ => ("object", String::new()),
    }
}

/// `summarizeProjectDir(dir)`: the summaries of every transcript in `dir`
/// (`Object.values(cache.files)`), `None` when `dir` is missing or not a
/// directory. Any other `readdir` failure throws.
pub fn summarize_project_dir(dir: &str, tz: &TimeZone) -> Result<Option<Vec<FileSummary>>, Thrown> {
    let entries = match node_fs::readdir(dir) {
        Ok(e) => e,
        Err(e) => {
            let fe = node_fs::FsError::new(&e, "scandir", Some(dir), None);
            if matches!(fe.code.as_deref(), Some("ENOENT" | "ENOTDIR")) {
                return Ok(None);
            }
            return Err(fe.message);
        }
    };
    let mut cache = read_cache(dir);
    let mut seen: HashSet<String> = HashSet::new();
    let mut dirty = false;

    let mut transcripts = Vec::new();
    for name in &entries {
        let Some(id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        transcripts.push(node_path::join(&[dir, name]));
        transcripts.extend(usage_seed::subagent_transcripts(Path::new(dir), id));
    }

    // Taken out and put back in place: `JSON.stringify` keeps the parsed
    // key order.
    let mut files = cache
        .get_mut("files")
        .map(std::mem::take)
        .unwrap_or_default();
    let text_files = db_agents::as_str(&files).is_some_and(|s| !s.is_empty());
    // The summaries parsed now (an array cache keeps them as its own
    // properties, which `JSON.stringify` doesn't write).
    let mut fresh: HashMap<String, FileSummary> = HashMap::new();
    let mut array_props: Vec<FileSummary> = Vec::new();
    for path in transcripts {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        seen.insert(path.clone());
        let mtime = meta.modified().map_or(0.0, node_fs::mtime_ms);
        let size = meta.len() as f64;
        match &mut files {
            Value::Object(m) => {
                let cached = m.get(&path);
                if is_hit(cached, mtime, size) && cached.and_then(cached_summary).is_some() {
                    continue;
                }
                let (summary, value) = summarize_file(&path, mtime, size, tz)?;
                m.insert(path.clone(), value);
                fresh.insert(path, summary);
            }
            Value::Array(_) => {
                let (summary, _) = summarize_file(&path, mtime, size, tz)?;
                array_props.push(summary);
            }
            other => {
                summarize_file(&path, mtime, size, tz)?;
                let (kind, text) = primitive_text(other);
                return Err(format!(
                    "Cannot create property '{path}' on {kind} '{text}'"
                ));
            }
        }
        dirty = true;
    }

    let out = match &mut files {
        Value::Object(m) => {
            let gone: Vec<String> = js::own_keys_order(m)
                .into_iter()
                .map(|(k, _)| k.clone())
                .filter(|k| !seen.contains(k))
                .collect();
            for k in gone {
                m.shift_remove(&k);
                dirty = true;
            }
            js::own_keys_order(m)
                .into_iter()
                .filter_map(|(k, v)| fresh.remove(k).or_else(|| cached_summary(v)))
                .collect()
        }
        Value::Array(items) => {
            // Every index is deleted (none is a transcript path); the array
            // keeps its length, so it's written as that many `null`s.
            if !items.is_empty() {
                dirty = true;
                items.iter_mut().for_each(|v| *v = Value::Null);
            }
            array_props
        }
        _ if text_files => {
            return Err("Cannot delete property '0' of [object String]".into());
        }
        _ => Vec::new(),
    };
    if let Some(slot) = cache.get_mut("files") {
        *slot = files;
    }

    if dirty {
        write_cache(dir, &Value::Object(cache));
    }
    Ok(Some(out))
}

/// The sort key `(a, b) => a.firstSeenMs - b.firstSeenMs ||
/// a.path.localeCompare(b.path)`.
pub(crate) fn file_order(a: &FileSummary, b: &FileSummary) -> f64 {
    let d = a.first_seen_ms - b.first_seen_ms;
    if truthy_num(d) {
        d
    } else {
        ordering(collate::locale_compare(&a.path, &b.path))
    }
}

fn ordering(o: std::cmp::Ordering) -> f64 {
    match o {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// `localeCompare` as a sort result.
pub(crate) fn locale_order(a: &str, b: &str) -> f64 {
    ordering(collate::locale_compare(a, b))
}

/// `sessionIdForTranscript(dir, path)`: the first segment of the path
/// relative to `dir`, without a trailing `.jsonl`.
pub fn session_id_for_transcript(dir: &str, path: &str) -> String {
    let rel = node_path::relative(dir, path);
    let first = rel.split('/').next().unwrap_or("");
    first.strip_suffix(".jsonl").unwrap_or(first).to_owned()
}

/// A model pricing error's `message` (V8's `TypeError: ` prefix dropped).
pub(crate) fn message(e: mpo::Thrown) -> Thrown {
    e.strip_prefix("TypeError: ")
        .map_or_else(|| e.clone(), str::to_owned)
}

/// `rowUsd(row, table, pricing)`.
pub fn row_usd(row: &Row, table: &PricingTable, pricing: Option<&Value>) -> Result<f64, Thrown> {
    let base = match row.u {
        Some(u) => u,
        None => {
            let price = litellm_pricing::price_for_model(Some(&row.m), table);
            litellm_pricing::cost_from_usage(
                price.as_ref(),
                &Usage {
                    input: row.i,
                    output: row.o,
                    cache_read: row.cr,
                    cache_creation: row.cw,
                    cache_creation_1h: Some(row.cw1h),
                },
            ) * inference_geo_multiplier(row.geo.as_deref())
        }
    };
    let Some(pricing) = pricing.filter(|p| js::truthy(p)) else {
        return Ok(base);
    };
    mpo::apply_model_pricing(
        base,
        &row.m,
        &OverrideTokens {
            input: row.i,
            output: row.o,
            cache_read: row.cr,
            cache_write: row.cw,
            cache_write_1h: Some(row.cw1h),
        },
        Some(pricing),
    )
    .map_err(message)
}

/// `resolvePricing(cwd)`: a truthy managed `modelPricing`, else the user
/// settings' (`undefined` when they don't read).
pub fn resolve_pricing(cwd: &str) -> Option<Value> {
    let user = settings::read_settings_twin(Scope::User, cwd)
        .ok()
        .and_then(|v| {
            settings::get_twin(&v, "modelPricing")
                .ok()
                .flatten()
                .cloned()
        });
    managed_settings::resolve_managed_model_pricing(cwd)
        .filter(js::truthy)
        .or(user)
}

/// `hasModelPricingOverride(pricing)`.
pub fn has_override(pricing: Option<&Value>) -> Result<bool, Thrown> {
    mpo::has_model_pricing_override(pricing).map_err(message)
}

/// `homedir()/.claude/projects/<encodeProjectDir(cwd)>`.
pub fn project_dir(cwd: &str) -> String {
    let home = paths::home_dir().to_string_lossy().into_owned();
    node_path::join(&[
        &home,
        ".claude",
        "projects",
        &paths::encode_project_dir(cwd),
    ])
}

/// The today / rolling-week / rolling-month sums over `(day, usd)`s in
/// their order.
pub(crate) fn windows<'a>(
    days: impl Iterator<Item = (&'a str, f64)>,
    clock: &Clock,
) -> (f64, f64, f64) {
    let key = |i: f64| day_key_in(clock.now_ms - i * DAY_MS, &clock.tz);
    let today = key(0.0);
    let week: HashSet<String> = (0..7).map(|i| key(f64::from(i))).collect();
    let month: HashSet<String> = (0..30).map(|i| key(f64::from(i))).collect();
    let (mut t, mut w, mut m) = (0.0, 0.0, 0.0);
    for (date, usd) in days {
        if date == today {
            t += usd;
        }
        if week.contains(date) {
            w += usd;
        }
        if month.contains(date) {
            m += usd;
        }
    }
    (t, w, m)
}

/// A plain object's keys in JS order: array indices ascending, then the
/// rest in insertion order.
fn js_order(m: &IndexMap<String, f64>) -> Vec<(&String, f64)> {
    let (mut indexed, named): (Vec<_>, Vec<_>) = m
        .iter()
        .map(|(k, v)| (k, *v))
        .partition(|(k, _)| js::array_index(k).is_some());
    indexed.sort_by_key(|(k, _)| js::array_index(k));
    indexed.into_iter().chain(named).collect()
}

struct SessionAcc {
    first: f64,
    last: f64,
    usd: f64,
    turns: f64,
    hist: IndexMap<String, f64>,
}

/// `emptyReport()`.
pub fn empty_report() -> Value {
    json!({
        "totalUsd": 0,
        "todayUsd": 0,
        "weekUsd": 0,
        "monthUsd": 0,
        "byDay": [],
        "bySession": [],
        "byModel": [],
        "pricingOverrideActive": false,
        "accountsConfigured": 0,
        "note": NOTE_EMPTY,
    })
}

/// `aggregate(cwd)`: the Cost page's report. `table` is `getPricingTable()`,
/// called once the project dir has been read (not for an empty report).
pub fn aggregate(
    cwd: &str,
    clock: &Clock,
    table: &mut dyn FnMut() -> Arc<PricingTable>,
) -> Result<Value, Thrown> {
    let dir = project_dir(cwd);
    let Some(summaries) = summarize_project_dir(&dir, &clock.tz)? else {
        return Ok(empty_report());
    };
    let table = table();
    let pricing = resolve_pricing(cwd);

    let mut files: Vec<&FileSummary> = summaries.iter().filter(|f| !f.rows.is_empty()).collect();
    v8_sort(&mut files, |a, b| file_order(a, b));

    let mut dedup: HashSet<&str> = HashSet::new();
    let mut by_day: IndexMap<String, [f64; 3]> = IndexMap::new();
    let mut by_model: IndexMap<String, [f64; 5]> = IndexMap::new();
    let mut sessions: IndexMap<String, SessionAcc> = IndexMap::new();
    let mut total = 0.0;

    for file in &files {
        let mut session_usd = 0.0;
        let mut session_turns = 0.0;
        let mut hist: IndexMap<String, f64> = IndexMap::new();
        for row in &file.rows {
            if let Some(k) = &row.k
                && !dedup.insert(k)
            {
                continue;
            }
            let usd = row_usd(row, &table, pricing.as_ref())?;
            total += usd;
            let day = by_day.entry(row.d.clone()).or_insert([0.0; 3]);
            day[0] += usd;
            day[1] += row.i;
            day[2] += row.o;
            let mb = by_model.entry(row.m.clone()).or_insert([0.0; 5]);
            mb[0] += usd;
            mb[1] += row.i;
            mb[2] += row.o;
            mb[3] += row.cr;
            mb[4] += row.cw;
            session_usd += usd;
            session_turns += 1.0;
            // `modelHist[row.m] = (modelHist[row.m] ?? 0) + 1` on a plain
            // object: an inherited property makes it a string (or, for
            // `__proto__`, nothing), which never wins the vote.
            if !OBJECT_PROTOTYPE_KEYS.contains(&row.m.as_str()) {
                *hist.entry(row.m.clone()).or_insert(0.0) += 1.0;
            }
        }
        if session_turns == 0.0 {
            continue; // fully duplicated elsewhere
        }
        let id = session_id_for_transcript(&dir, &file.path);
        match sessions.get_mut(&id) {
            None => {
                sessions.insert(
                    id,
                    SessionAcc {
                        first: file.first_seen_ms,
                        last: file.last_seen_ms,
                        usd: session_usd,
                        turns: session_turns,
                        hist,
                    },
                );
            }
            Some(acc) => {
                acc.first = js_min(acc.first, file.first_seen_ms);
                acc.last = js_max(acc.last, file.last_seen_ms);
                acc.usd += session_usd;
                acc.turns += session_turns;
                for (m, n) in js_order(&hist) {
                    *acc.hist.entry(m.clone()).or_insert(0.0) += n;
                }
            }
        }
    }

    #[derive(Clone)]
    struct Session {
        id: String,
        first: f64,
        last: f64,
        turns: f64,
        usd: f64,
        model: Option<String>,
        title: Option<String>,
        account: Option<session_accounts::SessionAccountRef>,
    }
    let mut by_session: Vec<Session> = sessions
        .into_iter()
        .map(|(id, acc)| {
            let mut best = None;
            let mut best_n = 0.0;
            for (m, n) in js_order(&acc.hist) {
                if n > best_n {
                    best = Some(m.clone());
                    best_n = n;
                }
            }
            Session {
                id,
                first: acc.first,
                last: acc.last,
                turns: acc.turns,
                usd: acc.usd,
                model: best,
                title: None,
                account: None,
            }
        })
        .collect();

    let mut days: Vec<(String, [f64; 3])> = by_day.into_iter().collect();
    v8_sort(&mut days, |a, b| locale_order(&a.0, &b.0));
    let mut models: Vec<(String, [f64; 5])> = by_model.into_iter().collect();
    v8_sort(&mut models, |a, b| b.1[0] - a.1[0]);
    v8_sort(&mut by_session, |a, b| b.last - a.last);

    let ids: Vec<String> = by_session.iter().map(|s| s.id.clone()).collect();
    let pairs: Vec<(Option<&str>, &str)> = ids.iter().map(|id| (Some(cwd), id.as_str())).collect();
    // Title lookup is best-effort: a failure leaves every row untitled.
    if let Ok(titles) = sessions_db::get_session_titles_by_cwd(&pairs) {
        let found: Vec<Option<String>> = by_session
            .iter()
            .map(|s| {
                titles
                    .get(&format!("{cwd}:{}", s.id))
                    .or_else(|| titles.get(&format!("*:{}", s.id)))
                    .filter(|t| !t.is_empty())
                    .cloned()
            })
            .collect();
        for (s, t) in by_session.iter_mut().zip(found) {
            s.title = t;
        }
    }
    let (by_key, accounts_configured) =
        session_accounts::resolve_session_accounts(&AccountsStore::from_env(), &pairs);
    let accounts: Vec<_> = by_session
        .iter()
        .map(|s| session_accounts::lookup_session_account(&by_key, Some(cwd), &s.id).cloned())
        .collect();
    for (s, a) in by_session.iter_mut().zip(accounts) {
        s.account = a;
    }

    let (today, week, month) = windows(days.iter().map(|(d, v)| (d.as_str(), v[0])), clock);
    let active = has_override(pricing.as_ref())?;
    let by_session: Vec<Value> = by_session
        .into_iter()
        .map(|s| {
            let mut o = Map::new();
            o.insert("sessionId".into(), json!(s.id));
            o.insert("firstSeenMs".into(), js_num(s.first));
            o.insert("lastSeenMs".into(), js_num(s.last));
            o.insert("numTurns".into(), js_num(s.turns));
            o.insert("totalUsd".into(), js_num(s.usd));
            if let Some(m) = s.model {
                o.insert("model".into(), json!(m));
            }
            if let Some(t) = s.title {
                o.insert("title".into(), json!(t));
            }
            if let Some(a) = s.account {
                o.insert("accountId".into(), json!(a.account_id));
                o.insert("accountLabel".into(), json!(a.account_label));
            }
            Value::Object(o)
        })
        .collect();
    Ok(json!({
        "totalUsd": js_num(total),
        "todayUsd": js_num(today),
        "weekUsd": js_num(week),
        "monthUsd": js_num(month),
        "byDay": days.iter().map(|(date, v)| json!({
            "date": date,
            "usd": js_num(v[0]),
            "inputTokens": js_num(v[1]),
            "outputTokens": js_num(v[2]),
        })).collect::<Vec<_>>(),
        "bySession": by_session,
        "byModel": models.iter().map(|(model, v)| json!({
            "model": model,
            "usd": js_num(v[0]),
            "inputTokens": js_num(v[1]),
            "outputTokens": js_num(v[2]),
            "cacheReadTokens": js_num(v[3]),
            "cacheWriteTokens": js_num(v[4]),
        })).collect::<Vec<_>>(),
        "pricingOverrideActive": active,
        "accountsConfigured": accounts_configured,
        "note": if active { NOTE_OVERRIDE } else { NOTE_LIST },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_keys_print_the_year_as_get_full_year() {
        let utc = TimeZone::UTC;
        assert_eq!(day_key_in(0.0, &utc), "1970-01-01");
        assert_eq!(day_key_in(-62198755200000.0, &utc), "-1-01-01");
        assert_eq!(day_key_in(8.64e15, &utc), "275760-09-13");
        assert_eq!(day_key_in(f64::NAN, &utc), "NaN-NaN-NaN");
    }

    #[test]
    fn session_ids_come_from_the_first_segment() {
        assert_eq!(session_id_for_transcript("/p", "/p/abc.jsonl"), "abc");
        assert_eq!(
            session_id_for_transcript("/p", "/p/abc/subagents/agent-1.jsonl"),
            "abc"
        );
        assert_eq!(
            session_id_for_transcript("/p", "/p/a.jsonl.jsonl"),
            "a.jsonl"
        );
    }
}
