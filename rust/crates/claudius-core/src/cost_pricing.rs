//! `lib/shared/cost-pricing.ts`: the approximate list prices (USD per
//! million tokens) used to back-compute cost where only token counts were
//! persisted, i.e. a session's historical usage estimate
//! ([`crate::usage_seed`]). The Cost page's LiteLLM table is D18.

use crate::model_id::normalize_dotted_model_version;

/// `Pricing`: $/MT for each token kind.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Cache write with the 5-minute TTL.
    pub cache_write_5m: f64,
    /// Cache write with the 1-hour TTL.
    pub cache_write_1h: f64,
}

const fn p(
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
) -> Pricing {
    Pricing {
        input,
        output,
        cache_read,
        cache_write_5m,
        cache_write_1h,
    }
}

const SONNET: Pricing = p(3.0, 15.0, 0.3, 3.75, 6.0);
const OPUS: Pricing = p(15.0, 75.0, 1.5, 18.75, 30.0);
const HAIKU: Pricing = p(1.0, 5.0, 0.1, 1.25, 2.0);
const OPUS_5_5: Pricing = p(4.0, 20.0, 0.2, 5.0, 8.0);
const OPUS_5: Pricing = p(5.0, 25.0, 0.5, 6.25, 10.0);
const HAIKU_5_5: Pricing = p(0.1, 0.5, 0.01, 0.125, 0.2);
const SONNET_5: Pricing = p(2.0, 10.0, 0.2, 2.5, 4.0);
/// `{ ...SONNET_5, cacheRead: 0.1 }`.
const SONNET_5_5: Pricing = Pricing {
    cache_read: 0.1,
    ..SONNET_5
};
/// Fable 5.2, the default Fable since CC 2.1.321: $8 / $40, $0.20 cache
/// reads, writes at 1.25x (5 m) / 2x (1 h).
const FABLE_5_2: Pricing = p(8.0, 40.0, 0.2, 10.0, 16.0);
/// Fable 5.1, the prior generation. Fable 5 differs only in cache reads.
const FABLE_5_1: Pricing = p(10.0, 50.0, 0.25, 12.5, 20.0);
const FABLE_5: Pricing = p(10.0, 50.0, 1.0, 12.5, 20.0);

/// `priceFor(model)`: the first family whose marker the lowercased id
/// contains, the specific generations first; Sonnet for anything else.
pub fn price_for(model: Option<&str>) -> Pricing {
    // CC 2.1.314: a gateway's dotted id (`claude-opus-5.5`) hits the same
    // entry as the dashed one instead of the older `opus-5`.
    let m = normalize_dotted_model_version(&model.unwrap_or_default().to_lowercase()).into_owned();
    let has = |s: &str| m.contains(s);
    if has("opus-5-5") {
        OPUS_5_5
    } else if has("opus-5") {
        OPUS_5
    } else if has("opus") {
        OPUS
    } else if has("haiku-5") {
        HAIKU_5_5
    } else if has("haiku") {
        HAIKU
    } else if fable_5_2(&m) {
        // CC 2.1.321, with a digit boundary: a dated Fable 5 id
        // (`claude-fable-5-20260101`) isn't Fable 5.2.
        FABLE_5_2
    } else if has("fable-5-1") {
        FABLE_5_1
    } else if has("fable-5") {
        FABLE_5
    } else if has("fable") {
        // The bare `fable` alias, or an unknown Fable id, is the current
        // default Fable: Fable 5.2 since CC 2.1.321.
        FABLE_5_2
    } else if has("sonnet-5-5") {
        SONNET_5_5
    } else if has("sonnet-5") {
        SONNET_5
    } else {
        SONNET
    }
}

/// `/fable-5-2(?!\d)/.test(m)`: some `fable-5-2` not followed by an ASCII
/// digit (`\d` without the `u` flag).
fn fable_5_2(m: &str) -> bool {
    m.match_indices("fable-5-2")
        .any(|(i, s)| !m[i + s.len()..].starts_with(|c: char| c.is_ascii_digit()))
}

/// `TokenBreakdown`: one turn's token counts.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TokenBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
}

/// `costFromTokens(model, t)` in USD, summed in the TS order so the
/// floating-point result is the same.
pub fn cost_from_tokens(model: Option<&str>, t: &TokenBreakdown) -> f64 {
    let p = price_for(model);
    (t.input * p.input
        + t.output * p.output
        + t.cache_read * p.cache_read
        + t.cache_write_5m * p.cache_write_5m
        + t.cache_write_1h * p.cache_write_1h)
        / 1_000_000.0
}

/// `MODEL_PRICING_MULTIPLIER_MAX`: the `modelPricing` multiplier's ceiling.
pub const MODEL_PRICING_MULTIPLIER_MAX: f64 = 10.0;

/// `inferenceGeoMultiplier(geo)`: the 1.1× US-only inference premium, for
/// exactly `"us"` in any case.
pub fn inference_geo_multiplier(geo: Option<&str>) -> f64 {
    if geo.is_some_and(|g| g.to_lowercase() == "us") {
        1.1
    } else {
        1.0
    }
}
