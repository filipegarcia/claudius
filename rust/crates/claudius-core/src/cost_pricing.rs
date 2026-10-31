//! `lib/shared/cost-pricing.ts`: the approximate list prices (USD per
//! million tokens) used to back-compute cost where only token counts were
//! persisted, i.e. a session's historical usage estimate
//! ([`crate::usage_seed`]). The Cost page's LiteLLM table is D18.

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
const FABLE_5_1: Pricing = p(10.0, 50.0, 0.25, 12.5, 20.0);
const FABLE_5: Pricing = p(10.0, 50.0, 1.0, 12.5, 20.0);

/// `priceFor(model)`: the first family whose marker the lowercased id
/// contains, the specific generations first; Sonnet for anything else.
pub fn price_for(model: Option<&str>) -> Pricing {
    let m = model.unwrap_or_default().to_lowercase();
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
    } else if has("fable-5-1") || has("fable-5.1") {
        FABLE_5_1
    } else if has("fable") {
        FABLE_5
    } else if has("sonnet-5-5") || has("sonnet-5.5") {
        SONNET_5_5
    } else if has("sonnet-5") {
        SONNET_5
    } else {
        SONNET
    }
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
