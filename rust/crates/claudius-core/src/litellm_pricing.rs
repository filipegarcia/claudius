//! `lib/server/litellm-pricing.ts`: the Cost page's LiteLLM list prices
//! (USD per token) and the turn pricer the cost aggregation runs on.
//!
//! - [`bundled`]: `lib/server/litellm-prices.json`, embedded at build time
//!   from the TS tree (as `build.rs` embeds the migrations) and read through
//!   `normalizeTable` ([`PricingTable::normalize`]: `_` keys, unpriced and
//!   non-object entries dropped; the twelve [`PRICE_FIELDS`] kept in their
//!   order when they're numbers, `Infinity` included).
//! - [`PricingCache`] is the module state: the memoised table
//!   ([`PricingCache::get_pricing_table`]: the bundle overlaid with the disk
//!   cache `homedir()/.claude/.claudius-litellm-prices.json`, plus the
//!   background refresh when the cache is missing or older than 24 h),
//!   [`PricingCache::refresh_pricing`] (the `refresh-prices` POST: fetch,
//!   keep the Claude entries, `JSON.stringify` them to the cache) and
//!   [`PricingCache::get_pricing_status`] (the GET). `CLAUDIUS_DISABLE_PRICE_REFRESH=1`
//!   turns every network refresh off.
//! - [`price_for_model`] / [`match_model`] (`priceForModel`: exact id, the
//!   part after the last `/`, the longest `claude-…` key the id contains,
//!   then the opus / sonnet / haiku / fable family) and [`cost_from_usage`]
//!   (`costFromUsage`: the >200k / >100k tiers, 1-hour cache writes at 2×
//!   input), what `cost-aggregate.ts` (D18b) prices turns with.
//!
//! The fetch goes through [`Fetch`] (production: the server's
//! `HttpsClient`), with the TS's 5 s budget over the request and the body.
//! JSON is read as `JSON.parse` reads it ([`db_agents::json_parse_js`]), so
//! keys keep lone surrogates and a price of `1e400` is `Infinity`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use claudius_agent::js;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::fetch::{Fetch, Request};
use crate::model_id::normalize_dotted_model_version;
use crate::{db_agents, js_date, js_num, js_string, node_fs, node_path};

/// `LITELLM_URL`.
pub const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/// The disk cache's name under `homedir()/.claude`.
pub const CACHE_FILE: &str = ".claudius-litellm-prices.json";
/// `REFRESH_TTL_MS`: a cache older than this is refreshed in the background.
pub const REFRESH_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// `FETCH_TIMEOUT_MS`: the abort timer over the fetch and its body.
pub const FETCH_TIMEOUT: Duration = Duration::from_millis(5_000);
/// `LONG_CONTEXT_THRESHOLD`.
pub const LONG_CONTEXT_THRESHOLD: f64 = 200_000.0;
/// `LONG_CONTEXT_THRESHOLD_100K`.
pub const LONG_CONTEXT_THRESHOLD_100K: f64 = 100_000.0;
/// `CACHE_WRITE_1H_INPUT_MULTIPLIER`.
pub const CACHE_WRITE_1H_INPUT_MULTIPLIER: f64 = 2.0;
/// Set to exactly `1`, no network refresh runs.
pub const DISABLE_ENV: &str = "CLAUDIUS_DISABLE_PRICE_REFRESH";

/// `PRICE_FIELDS`, in the TS order (also the order an entry is written in).
pub const PRICE_FIELDS: [&str; 12] = [
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_creation_input_token_cost",
    "cache_read_input_token_cost",
    "input_cost_per_token_above_100k_tokens",
    "output_cost_per_token_above_100k_tokens",
    "cache_creation_input_token_cost_above_100k_tokens",
    "cache_read_input_token_cost_above_100k_tokens",
    "input_cost_per_token_above_200k_tokens",
    "output_cost_per_token_above_200k_tokens",
    "cache_creation_input_token_cost_above_200k_tokens",
    "cache_read_input_token_cost_above_200k_tokens",
];

/// `Object.getOwnPropertyNames(Object.prototype)`: what `table[id]` finds
/// on a plain object without an own entry.
pub const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

static BUNDLED_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../lib/server/litellm-prices.json"
));

static BUNDLED: LazyLock<PricingTable> = LazyLock::new(|| {
    PricingTable::normalize(
        &db_agents::json_parse_js(BUNDLED_JSON).expect("lib/server/litellm-prices.json parses"),
    )
});

/// `bundled`: `normalizeTable(bundledRaw)`.
pub fn bundled() -> &'static PricingTable {
    &BUNDLED
}

// ───────────────────────────── the table ─────────────────────────────

/// `LiteLlmPricing`: one model's prices, USD per token; `None` is a field
/// the entry doesn't have (or that isn't a number).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LiteLlmPricing {
    pub input_cost_per_token: Option<f64>,
    pub output_cost_per_token: Option<f64>,
    pub cache_creation_input_token_cost: Option<f64>,
    pub cache_read_input_token_cost: Option<f64>,
    pub input_cost_per_token_above_100k_tokens: Option<f64>,
    pub output_cost_per_token_above_100k_tokens: Option<f64>,
    pub cache_creation_input_token_cost_above_100k_tokens: Option<f64>,
    pub cache_read_input_token_cost_above_100k_tokens: Option<f64>,
    pub input_cost_per_token_above_200k_tokens: Option<f64>,
    pub output_cost_per_token_above_200k_tokens: Option<f64>,
    pub cache_creation_input_token_cost_above_200k_tokens: Option<f64>,
    pub cache_read_input_token_cost_above_200k_tokens: Option<f64>,
}

impl LiteLlmPricing {
    /// The fields in [`PRICE_FIELDS`] order.
    pub fn fields(&self) -> [Option<f64>; 12] {
        [
            self.input_cost_per_token,
            self.output_cost_per_token,
            self.cache_creation_input_token_cost,
            self.cache_read_input_token_cost,
            self.input_cost_per_token_above_100k_tokens,
            self.output_cost_per_token_above_100k_tokens,
            self.cache_creation_input_token_cost_above_100k_tokens,
            self.cache_read_input_token_cost_above_100k_tokens,
            self.input_cost_per_token_above_200k_tokens,
            self.output_cost_per_token_above_200k_tokens,
            self.cache_creation_input_token_cost_above_200k_tokens,
            self.cache_read_input_token_cost_above_200k_tokens,
        ]
    }

    fn field_mut(&mut self, i: usize) -> &mut Option<f64> {
        match i {
            0 => &mut self.input_cost_per_token,
            1 => &mut self.output_cost_per_token,
            2 => &mut self.cache_creation_input_token_cost,
            3 => &mut self.cache_read_input_token_cost,
            4 => &mut self.input_cost_per_token_above_100k_tokens,
            5 => &mut self.output_cost_per_token_above_100k_tokens,
            6 => &mut self.cache_creation_input_token_cost_above_100k_tokens,
            7 => &mut self.cache_read_input_token_cost_above_100k_tokens,
            8 => &mut self.input_cost_per_token_above_200k_tokens,
            9 => &mut self.output_cost_per_token_above_200k_tokens,
            10 => &mut self.cache_creation_input_token_cost_above_200k_tokens,
            _ => &mut self.cache_read_input_token_cost_above_200k_tokens,
        }
    }

    /// The entry as JSON, fields in [`PRICE_FIELDS`] order (`Infinity` is
    /// written `null`, as `JSON.stringify` writes it).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        for (name, v) in PRICE_FIELDS.iter().zip(self.fields()) {
            if let Some(v) = v {
                m.insert((*name).to_owned(), js_num(v));
            }
        }
        Value::Object(m)
    }
}

/// `PricingTable`: model id → prices, in JS property order (array-index keys
/// first, ascending, then insertion order).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PricingTable {
    entries: IndexMap<String, LiteLlmPricing>,
}

impl PricingTable {
    /// `normalizeTable(raw)`.
    pub fn normalize(raw: &Value) -> PricingTable {
        // `!raw || typeof raw !== "object"`: only objects and arrays list
        // entries (`Object.entries`, own-keys order).
        let entries: Vec<(String, &Value)> = match raw {
            Value::Object(m) => js::own_keys_order(m)
                .into_iter()
                .map(|(k, v)| (k.clone(), v))
                .collect(),
            Value::Array(a) => a
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v))
                .collect(),
            _ => Vec::new(),
        };
        let mut out = IndexMap::new();
        for (model, entry) in entries {
            // `_meta` and friends (and `__proto__`, which as an assignment
            // would set the prototype rather than add an entry).
            if model.starts_with('_') {
                continue;
            }
            // An array entry has none of the fields.
            let Value::Object(src) = entry else { continue };
            if src
                .get("input_cost_per_token")
                .and_then(db_agents::number)
                .is_none()
            {
                continue; // not a priced model
            }
            let mut picked = LiteLlmPricing::default();
            for (i, f) in PRICE_FIELDS.iter().enumerate() {
                *picked.field_mut(i) = src.get(*f).and_then(db_agents::number);
            }
            out.insert(model, picked);
        }
        PricingTable { entries: out }
    }

    /// `{ ...self, ...over }`: `over`'s entries replace `self`'s in place,
    /// new ones go last, and array-index keys move to the front.
    pub fn merged(&self, over: &PricingTable) -> PricingTable {
        let mut entries = self.entries.clone();
        for (k, v) in &over.entries {
            entries.insert(k.clone(), *v);
        }
        PricingTable {
            entries: js_order(entries),
        }
    }

    /// `filterToClaude(table)`: the ids whose lowercase holds `claude`.
    pub fn filter_to_claude(&self) -> PricingTable {
        PricingTable {
            entries: self
                .entries
                .iter()
                .filter(|(k, _)| k.to_lowercase().contains("claude"))
                .map(|(k, v)| (k.clone(), *v))
                .collect(),
        }
    }

    /// `Object.keys(table).length`.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The own entry for `model`.
    pub fn get(&self, model: &str) -> Option<&LiteLlmPricing> {
        self.entries.get(model)
    }

    /// The ids, in order.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }

    /// The entries, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &LiteLlmPricing)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// The table as JSON (`JSON.stringify` it with [`js_string::stringify`]).
    pub fn to_json(&self) -> Value {
        Value::Object(
            self.entries
                .iter()
                .map(|(k, v)| (k.clone(), v.to_json()))
                .collect(),
        )
    }
}

/// JS property order: array-index keys first, ascending, then the rest in
/// insertion order.
fn js_order(map: IndexMap<String, LiteLlmPricing>) -> IndexMap<String, LiteLlmPricing> {
    if !map.keys().any(|k| js::array_index(k).is_some()) {
        return map;
    }
    let (mut indexed, named): (Vec<_>, Vec<_>) = map
        .into_iter()
        .partition(|(k, _)| js::array_index(k).is_some());
    indexed.sort_by_key(|(k, _)| js::array_index(k));
    indexed.into_iter().chain(named).collect()
}

// ───────────────────────────── lookup and cost ─────────────────────────────

/// What `priceForModel` returned: an own entry, or a property every plain
/// object inherits (`constructor`, `__proto__`, …), which carries none of
/// the price fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceMatch<'a> {
    Key(&'a str),
    Inherited,
}

/// `table[key]` when it's truthy.
fn lookup<'a>(table: &'a PricingTable, key: &str) -> Option<PriceMatch<'a>> {
    if let Some((k, _)) = table.entries.get_key_value(key) {
        return Some(PriceMatch::Key(k));
    }
    OBJECT_PROTOTYPE_KEYS
        .contains(&key)
        .then_some(PriceMatch::Inherited)
}

/// `priceForModel(model, table)`, as the entry it picks.
pub fn match_model<'a>(model: Option<&str>, table: &'a PricingTable) -> Option<PriceMatch<'a>> {
    let model = model.filter(|m| !m.is_empty())?;
    let raw = js::trim(model);
    if let Some(hit) = lookup(table, raw) {
        return Some(hit);
    }
    // CC 2.1.314: after the raw exact match (the table has dotted aggregator
    // keys such as `openrouter/anthropic/claude-opus-4.6`), the dashed
    // spelling, so `claude-opus-5.5` finds `claude-opus-5-5` rather than the
    // longest dashed key it contains (`claude-opus-5`).
    let dashed = normalize_dotted_model_version(raw);
    let m: &str = &dashed;
    if let Some(hit) = lookup(table, m) {
        return Some(hit);
    }
    if let Some(slash) = m.rfind('/')
        && let Some(hit) = lookup(table, &m[slash + 1..])
    {
        return Some(hit);
    }
    let lower = m.to_lowercase();
    // The longest canonical key the id contains (first on a tie). The TS
    // compares the lowercased key's length with the original's.
    let mut canonical: Option<&str> = None;
    for key in table.keys() {
        let k = key.to_lowercase();
        if k.starts_with("claude-")
            && js_string::contains16(&lower, &k)
            && canonical.is_none_or(|c| js_string::len16(&k) > js_string::len16(c))
        {
            canonical = Some(key);
        }
    }
    if let Some(c) = canonical {
        return Some(PriceMatch::Key(c));
    }
    for family in ["opus", "sonnet", "haiku", "fable"] {
        if !lower.contains(family) {
            continue;
        }
        let prefix = format!("claude-{family}");
        let mut fallback = None;
        for key in table.keys() {
            let k = key.to_lowercase();
            if !k.contains(family) {
                continue;
            }
            if k.starts_with(&prefix) {
                return Some(PriceMatch::Key(key));
            }
            fallback.get_or_insert(key);
        }
        if let Some(f) = fallback {
            return Some(PriceMatch::Key(f));
        }
    }
    None
}

/// `priceForModel(model, table)`. An inherited hit is an entry without
/// prices (so it costs 0, as in TS).
pub fn price_for_model(model: Option<&str>, table: &PricingTable) -> Option<LiteLlmPricing> {
    match match_model(model, table)? {
        PriceMatch::Key(k) => table.get(k).copied(),
        PriceMatch::Inherited => Some(LiteLlmPricing::default()),
    }
}

/// `Usage`: one turn's token counts.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Usage {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Every cache-creation token (5 m + 1 h).
    pub cache_creation: f64,
    /// The 1-hour slice of `cache_creation`; `None` is `undefined`.
    pub cache_creation_1h: Option<f64>,
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

/// `costFromUsage(pricing, usage)`, in the TS's order of operations.
pub fn cost_from_usage(pricing: Option<&LiteLlmPricing>, usage: &Usage) -> f64 {
    let Some(p) = pricing else { return 0.0 };
    let footprint = usage.input + usage.cache_read + usage.cache_creation;
    let above200k = footprint > LONG_CONTEXT_THRESHOLD;
    let above100k = footprint > LONG_CONTEXT_THRESHOLD_100K;
    let rate = |base: Option<f64>, tier100k: Option<f64>, tier200k: Option<f64>| {
        tier200k
            .filter(|_| above200k)
            .or(tier100k.filter(|_| above100k))
            .or(base)
            .unwrap_or(0.0)
    };
    let input_rate = rate(
        p.input_cost_per_token,
        p.input_cost_per_token_above_100k_tokens,
        p.input_cost_per_token_above_200k_tokens,
    );
    let output_rate = rate(
        p.output_cost_per_token,
        p.output_cost_per_token_above_100k_tokens,
        p.output_cost_per_token_above_200k_tokens,
    );
    let cache_read_rate = rate(
        p.cache_read_input_token_cost,
        p.cache_read_input_token_cost_above_100k_tokens,
        p.cache_read_input_token_cost_above_200k_tokens,
    );
    let cache_write_rate = rate(
        p.cache_creation_input_token_cost,
        p.cache_creation_input_token_cost_above_100k_tokens,
        p.cache_creation_input_token_cost_above_200k_tokens,
    );
    let cw1h = js_min(usage.cache_creation_1h.unwrap_or(0.0), usage.cache_creation);
    let cache_write_usd = if cw1h > 0.0 {
        cw1h * input_rate * CACHE_WRITE_1H_INPUT_MULTIPLIER
            + (usage.cache_creation - cw1h) * cache_write_rate
    } else {
        usage.cache_creation * cache_write_rate
    };
    usage.input * input_rate
        + usage.output * output_rate
        + usage.cache_read * cache_read_rate
        + cache_write_usd
}

// ───────────────────────────── module state ─────────────────────────────

/// `PriceRefreshResult`: the `refresh-prices` POST's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct PriceRefreshResult {
    pub ok: bool,
    pub models: usize,
    /// [`LITELLM_URL`], or `disabled`.
    pub source: String,
    pub fetched_at: Option<String>,
    pub reason: Option<String>,
}

impl PriceRefreshResult {
    /// The TS object, in its key order.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), json!(self.ok));
        m.insert("models".into(), json!(self.models));
        m.insert("source".into(), json!(self.source));
        if let Some(at) = &self.fetched_at {
            m.insert("fetchedAt".into(), json!(at));
        }
        if let Some(r) = &self.reason {
            m.insert("reason".into(), json!(r));
        }
        Value::Object(m)
    }
}

/// `PricingStatus`: the `refresh-prices` GET's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct PricingStatus {
    /// `cache` or `bundle`.
    pub source: &'static str,
    pub models: usize,
    pub fetched_at: Option<String>,
}

impl PricingStatus {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("source".into(), json!(self.source));
        m.insert("models".into(), json!(self.models));
        if let Some(at) = &self.fetched_at {
            m.insert("fetchedAt".into(), json!(at));
        }
        Value::Object(m)
    }
}

type Clock = Box<dyn Fn() -> f64 + Send + Sync>;
type Switch = Box<dyn Fn() -> bool + Send + Sync>;

/// The module state of `litellm-pricing.ts` (`memo`, `refreshing`, the disk
/// cache path) over a [`Fetch`].
pub struct PricingCache {
    cache_path: String,
    fetch: Arc<dyn Fetch>,
    memo: Mutex<Option<Arc<PricingTable>>>,
    refreshing: AtomicBool,
    fetch_timeout: Duration,
    now: Clock,
    disabled: Switch,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// `process.env.CLAUDIUS_DISABLE_PRICE_REFRESH === "1"`.
pub fn disabled_by_env(value: Option<&str>) -> bool {
    value == Some("1")
}

impl PricingCache {
    /// The state for `homedir()` = `home`, fetching through `fetch`, on the
    /// real clock and the real environment.
    pub fn new(home: &Path, fetch: Arc<dyn Fetch>) -> PricingCache {
        let home = home.to_string_lossy();
        PricingCache {
            cache_path: node_path::join(&[&home, ".claude", CACHE_FILE]),
            fetch,
            memo: Mutex::new(None),
            refreshing: AtomicBool::new(false),
            fetch_timeout: FETCH_TIMEOUT,
            now: Box::new(|| crate::now_ms() as f64),
            disabled: Box::new(|| disabled_by_env(std::env::var(DISABLE_ENV).ok().as_deref())),
            tasks: Mutex::new(Vec::new()),
        }
    }

    /// Tests: `Date.now()`.
    pub fn with_clock(mut self, now: impl Fn() -> f64 + Send + Sync + 'static) -> PricingCache {
        self.now = Box::new(now);
        self
    }

    /// Tests: whether the refresh is switched off (instead of the env).
    pub fn with_disabled(mut self, f: impl Fn() -> bool + Send + Sync + 'static) -> PricingCache {
        self.disabled = Box::new(f);
        self
    }

    /// Tests: another abort timer than [`FETCH_TIMEOUT`].
    pub fn with_fetch_timeout(mut self, d: Duration) -> PricingCache {
        self.fetch_timeout = d;
        self
    }

    /// `DISK_CACHE`.
    pub fn cache_path(&self) -> &str {
        &self.cache_path
    }

    fn refresh_disabled(&self) -> bool {
        (self.disabled)()
    }

    /// `__resetPricingMemo()`.
    pub fn reset_memo(&self) {
        *self.memo.lock().unwrap() = None;
    }

    /// Tests: wait for every background refresh started so far.
    pub async fn settle(&self) {
        loop {
            let tasks: Vec<_> = std::mem::take(&mut *self.tasks.lock().unwrap());
            if tasks.is_empty() {
                return;
            }
            for t in tasks {
                let _ = t.await;
            }
        }
    }

    fn spawn(&self, f: impl Future<Output = ()> + Send + 'static) {
        let mut tasks = self.tasks.lock().unwrap();
        tasks.retain(|t| !t.is_finished());
        tasks.push(tokio::spawn(f));
    }

    /// `Promise.all([fs.readFile(DISK_CACHE, "utf8"), fs.stat(DISK_CACHE)])`:
    /// the text and `stat.mtimeMs`.
    fn read_cache(&self) -> Option<(String, f64)> {
        let text = node_fs::read_to_string(&self.cache_path).ok()?;
        let modified = std::fs::metadata(&self.cache_path).ok()?.modified().ok()?;
        Some((text, node_fs::mtime_ms(modified)))
    }

    /// `fetchTableFromNetwork()`.
    async fn fetch_table(&self) -> Option<PricingTable> {
        let req = Request {
            method: "GET".into(),
            url: LITELLM_URL.into(),
            headers: Vec::new(),
            body: None,
        };
        let res = tokio::time::timeout(self.fetch_timeout, self.fetch.fetch(&req))
            .await
            .ok()?
            .ok()?;
        if !res.ok() {
            return None;
        }
        let raw = db_agents::json_parse_js(&res.text().ok()?).ok()?;
        let table = PricingTable::normalize(&raw).filter_to_claude();
        (!table.is_empty()).then_some(table) // ignore garbage
    }

    /// `persistTable(table)`: the cache file, then the memo.
    fn persist_table(&self, table: &PricingTable) -> Result<(), String> {
        node_fs::mkdir_recursive(&node_path::dirname(&self.cache_path), 0o777)
            .map_err(|e| e.message)?;
        node_fs::write_file(
            &self.cache_path,
            &js_string::stringify(&table.to_json()),
            0o666,
        )
        .map_err(|e| e.message)?;
        *self.memo.lock().unwrap() = Some(Arc::new(bundled().merged(table)));
        Ok(())
    }

    /// The body of `refreshFromNetwork()` once it has set `refreshing`.
    async fn refresh_body(&self) {
        if let Some(table) = self.fetch_table().await {
            let _ = self.persist_table(&table);
        }
        self.refreshing.store(false, Ordering::SeqCst);
    }

    /// `void refreshFromNetwork()`: the guard runs now, the rest in the
    /// background.
    fn start_refresh(self: &Arc<Self>) {
        if self.refreshing.load(Ordering::SeqCst) || self.refresh_disabled() {
            return;
        }
        self.refreshing.store(true, Ordering::SeqCst);
        let me = self.clone();
        self.spawn(async move { me.refresh_body().await });
    }

    /// `void maybeRefresh()`.
    fn start_maybe_refresh(self: &Arc<Self>) {
        let me = self.clone();
        self.spawn(async move {
            let stale = match std::fs::metadata(&me.cache_path).and_then(|m| m.modified()) {
                Ok(t) => (me.now)() - node_fs::mtime_ms(t) > REFRESH_TTL_MS,
                Err(_) => true,
            };
            // `await refreshFromNetwork()`.
            if stale && !me.refreshing.load(Ordering::SeqCst) && !me.refresh_disabled() {
                me.refreshing.store(true, Ordering::SeqCst);
                me.refresh_body().await;
            }
        });
    }

    /// `getPricingTable()`: the memo (re-checking the cache's age in the
    /// background), else the bundle overlaid with the disk cache.
    pub async fn get_pricing_table(self: &Arc<Self>) -> Arc<PricingTable> {
        if let Some(memo) = self.memo.lock().unwrap().clone() {
            self.start_maybe_refresh();
            return memo;
        }
        let mut table = bundled().clone();
        match self
            .read_cache()
            .and_then(|(text, mtime)| Some((db_agents::json_parse_js(&text).ok()?, mtime)))
        {
            Some((raw, mtime)) => {
                table = bundled().merged(&PricingTable::normalize(&raw));
                if (self.now)() - mtime > REFRESH_TTL_MS {
                    self.start_refresh();
                }
            }
            // No cache yet (or not JSON): the bundle, and populate it.
            None => self.start_refresh(),
        }
        let table = Arc::new(table);
        *self.memo.lock().unwrap() = Some(table.clone());
        table
    }

    /// `refreshPricing()`. `Err` is what it threw (writing the cache
    /// failed): the route's empty 500.
    pub async fn refresh_pricing(&self) -> Result<PriceRefreshResult, String> {
        let current = self
            .memo
            .lock()
            .unwrap()
            .as_ref()
            .map_or(bundled().len(), |m| m.len());
        if self.refresh_disabled() {
            return Ok(PriceRefreshResult {
                ok: false,
                models: current,
                source: "disabled".into(),
                fetched_at: None,
                reason: Some(
                    "Price refresh is disabled (CLAUDIUS_DISABLE_PRICE_REFRESH=1).".into(),
                ),
            });
        }
        self.refreshing.store(true, Ordering::SeqCst);
        let out = match self.fetch_table().await {
            None => Ok(PriceRefreshResult {
                ok: false,
                models: current,
                source: LITELLM_URL.into(),
                fetched_at: None,
                reason: Some(
                    "Could not fetch pricing from LiteLLM (offline, blocked, or rate-limited)."
                        .into(),
                ),
            }),
            Some(table) => self.persist_table(&table).map(|()| PriceRefreshResult {
                ok: true,
                models: table.len(),
                source: LITELLM_URL.into(),
                fetched_at: js_date::to_iso_string((self.now)()),
                reason: None,
            }),
        };
        self.refreshing.store(false, Ordering::SeqCst);
        out
    }

    /// `getPricingStatus()`: the disk cache when it parses to at least one
    /// priced model (`fetchedAt` from its mtime), else the bundle.
    pub fn get_pricing_status(&self) -> PricingStatus {
        if let Some((text, mtime)) = self.read_cache()
            && let Ok(raw) = db_agents::json_parse_js(&text)
        {
            let models = PricingTable::normalize(&raw).len();
            // `toISOString()` throwing is caught too.
            if models > 0
                && let Some(at) = js_date::to_iso_string(mtime)
            {
                return PricingStatus {
                    source: "cache",
                    models,
                    fetched_at: Some(at),
                };
            }
        }
        PricingStatus {
            source: "bundle",
            models: bundled().len(),
            fetched_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_is_the_ts_snapshot() {
        let b = bundled();
        assert_eq!(b.len(), 219);
        assert!(b.get("_meta").is_none());
        let opus = b.get("claude-opus-4-7").unwrap();
        assert_eq!(opus.input_cost_per_token, Some(5e-6));
    }

    #[test]
    fn js_min_is_math_min() {
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(js_min(-0.0, 0.0).is_sign_negative());
        assert!(!js_min(0.0, 0.0).is_sign_negative());
        assert_eq!(js_min(3.0, 2.0), 2.0);
    }
}
