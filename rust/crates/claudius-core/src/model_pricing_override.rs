//! `lib/server/model-pricing-override.ts`: the `modelPricing` override layer
//! over the LiteLLM list prices ([`crate::litellm_pricing`]) — an org's
//! contracted $/MT rates and its multiplier (CC 2.1.243 / 2.1.271, the 1-hour
//! cache-write slice 2.1.300).
//!
//! The settings come from `settings.json` (user scope) or a managed tier
//! ([`crate::managed_settings::resolve_managed_model_pricing`]), so every
//! value here is arbitrary JSON and the TS reads it with plain JS member
//! access. Mirrored accordingly:
//! - `overrides` wins over the legacy `rates` when it has at least one own
//!   key (`Object.keys(...).length > 0`, so a string's code units and an
//!   array's indices count too); its `cacheWrite` becomes the internal
//!   `cacheWrite5m`, which then prices the 1-hour slice as well;
//! - an `overrides` entry that is `null` throws (`r.input` on `null`), which
//!   the Cost page's handler turns into Next's empty 500 — [`Thrown`];
//! - a rate is matched by exact key first, then by the first entry whose
//!   lower-cased key the lower-cased model id contains (`""` matches
//!   everything), and the exact lookup sees `Object.prototype`'s properties
//!   (`constructor`, `toString`, …), which carry no rates and so price 0;
//! - the exact branch needs a *truthy* entry, while the substring loop
//!   returns whatever it finds, and [`apply_model_pricing`] prices only a
//!   truthy one (`rates: {opus: 0}` keeps the list price);
//! - rate fields are coerced as the arithmetic coerces them (`null` /
//!   missing → 0, `"3"` → 3, `[5]` → 5, `{}` → NaN, an own `toString`
//!   throws), and the multiplier counts only as a finite number above 0,
//!   clamped to [`MODEL_PRICING_MULTIPLIER_MAX`].
//!
//! One difference: a `rates` (or `overrides`) that is a string or an array
//! mirrors its indices and its `length`, but not the rest of its prototype,
//! so a model id that happens to name a `String` / `Array` method (`trim`,
//! `map`) keeps the list price here where the TS prices it at 0. Only a
//! settings file that put a string or an array where the object goes can
//! reach it.
//!
//! `resolveManagedModelPricing` is already ported, in
//! [`crate::managed_settings`]. `cost-aggregate.ts` / `cost-overview.ts`
//! (D18b) are the callers.

use claudius_agent::js;
use serde_json::Value;

use crate::cost_pricing::MODEL_PRICING_MULTIPLIER_MAX;
use crate::litellm_pricing::OBJECT_PROTOTYPE_KEYS;
use crate::model_id::normalize_dotted_model_version;
use crate::{db_agents, js_string};

/// The message of what a call threw (the route answers Next's empty 500).
pub type Thrown = String;

/// The internal `ModelPricingRate` fields, in the order
/// `costFromOverrideRate` reads them. `None` is a key the entry doesn't have
/// (JS `undefined`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelPricingRate {
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub cache_read: Option<Value>,
    pub cache_write_5m: Option<Value>,
    pub cache_write_1h: Option<Value>,
}

/// What `matchModelPricingRate` found: an entry of its own, or a property
/// every plain object inherits (truthy, and without any rate).
#[derive(Clone, Debug, PartialEq)]
pub enum RateMatch {
    /// `rates[key]`, by an exact or a substring match.
    Entry {
        key: String,
        value: Value,
    },
    Inherited,
}

impl RateMatch {
    /// `rate ? … : baseUsd` — an inherited function is truthy.
    pub fn truthy(&self) -> bool {
        match self {
            RateMatch::Entry { value, .. } => js::truthy(value),
            RateMatch::Inherited => true,
        }
    }

    /// The entry as a rate: `r.input` and friends, which only a `null` entry
    /// throws on.
    pub fn rate(&self) -> Result<ModelPricingRate, Thrown> {
        let v = match self {
            // The inherited properties are functions (and `__proto__`'s
            // object), none of which has a rate field.
            RateMatch::Inherited => return Ok(ModelPricingRate::default()),
            RateMatch::Entry { value, .. } => value,
        };
        Ok(ModelPricingRate {
            input: prop(v, "input")?,
            output: prop(v, "output")?,
            cache_read: prop(v, "cacheRead")?,
            cache_write_5m: prop(v, "cacheWrite5m")?,
            cache_write_1h: prop(v, "cacheWrite1h")?,
        })
    }
}

/// `v.<key>` for a JSON value: a plain object's own property, `undefined`
/// for a number, a boolean or a string (a string's own `length` and indices
/// are never read here), and a `TypeError` for `null`.
fn prop(v: &Value, key: &str) -> Result<Option<Value>, Thrown> {
    match v {
        Value::Null => Err(format!(
            "TypeError: Cannot read properties of null (reading '{key}')"
        )),
        Value::Object(m) => Ok(m.get(key).cloned()),
        _ => Ok(None),
    }
}

/// `Object.entries(v)`: an object's own keys (array indices first, then
/// insertion order), an array's indices, a string's code units.
fn entries(v: &Value) -> Vec<(String, Value)> {
    match v {
        Value::Object(m) => js::own_keys_order(m)
            .into_iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        v => js::entries(v),
    }
}

/// `Object.keys(v).length`.
fn key_count(v: &Value) -> usize {
    match v {
        Value::Object(m) => m.len(),
        Value::Array(a) => a.len(),
        Value::String(s) => js_string::len16(s),
        _ => 0,
    }
}

/// `pricing.<key>`: the settings object's own property, `undefined` for a
/// primitive, and a `TypeError` for `null` (the TS reads `pricing.overrides`
/// / `pricing.multiplier` before any check of its own; every caller here
/// guards with `if (!pricing)` first).
fn setting(pricing: &Value, key: &str) -> Result<Option<Value>, Thrown> {
    prop(pricing, key)
}

/// `effectiveOverrideRates(pricing)`: the SDK's `overrides` mapped into the
/// internal shape (its one `cacheWrite` becomes `cacheWrite5m`), else the
/// legacy `rates` as they are.
pub fn effective_override_rates(pricing: &Value) -> Result<Option<Value>, Thrown> {
    let overrides = setting(pricing, "overrides")?;
    if let Some(o) = &overrides
        && js::truthy(o)
        && key_count(o) > 0
    {
        let mut out = serde_json::Map::new();
        for (key, r) in entries(o) {
            // `{input: r.input, …}`: the four keys are always written, with
            // `undefined` for the ones the entry doesn't have — and those
            // `JSON.stringify` drops, so only the present ones go in here.
            let mut rate = serde_json::Map::new();
            for (to, from) in [
                ("input", "input"),
                ("output", "output"),
                ("cacheRead", "cacheRead"),
                ("cacheWrite5m", "cacheWrite"),
            ] {
                if let Some(v) = prop(&r, from)? {
                    rate.insert(to.to_owned(), v);
                }
            }
            out.insert(key, Value::Object(rate));
        }
        return Ok(Some(Value::Object(out)));
    }
    setting(pricing, "rates")
}

/// `effectiveMultiplier(pricing)`: `multiplier ?? discountMultiplier`.
pub fn effective_multiplier(pricing: &Value) -> Result<Option<Value>, Thrown> {
    match setting(pricing, "multiplier")? {
        Some(v) if !v.is_null() => Ok(Some(v)),
        _ => setting(pricing, "discountMultiplier"),
    }
}

/// `matchModelPricingRate(model, rates)`.
pub fn match_model_pricing_rate(model: &str, rates: Option<&Value>) -> Option<RateMatch> {
    let rates = rates.filter(|r| js::truthy(r))?;
    // `rates[model]`: an own property (a falsy one shadows the prototype's),
    // else an inherited one, which carries no rate.
    let own = match rates {
        Value::Object(m) => m.get(model).cloned(),
        other => entries(other)
            .into_iter()
            .find(|(k, _)| k == model)
            .map(|(_, v)| v),
    };
    match own {
        Some(v) => {
            if js::truthy(&v) {
                return Some(RateMatch::Entry {
                    key: model.to_owned(),
                    value: v,
                });
            }
        }
        // `length` on a string or an array is a truthy number here (the
        // falsy 0 of an empty one can't be reached: `rates` is truthy).
        None => {
            let length = matches!(rates, Value::String(_) | Value::Array(_)) && model == "length";
            if length || OBJECT_PROTOTYPE_KEYS.contains(&model) {
                return Some(RateMatch::Inherited);
            }
        }
    }
    // CC 2.1.314: dotted and dashed version spellings compare equal on both
    // sides (a `claude-opus-4-8` rate covers a gateway's `claude-opus-4.8`,
    // and the other way round). Substring order is unchanged.
    let lower = normalize_dotted_model_version(&model.to_lowercase()).into_owned();
    entries(rates)
        .into_iter()
        .find(|(key, _)| {
            js_string::contains16(&lower, &normalize_dotted_model_version(&key.to_lowercase()))
        })
        .map(|(key, value)| RateMatch::Entry { key, value })
}

/// Token counts for one turn, as `cost-aggregate.ts` carries them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OverrideTokens {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Every cache-write token (5 m + 1 h).
    pub cache_write: f64,
    /// The 1-hour slice of `cache_write`; `None` is `undefined`.
    pub cache_write_1h: Option<f64>,
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

/// A rate field in the arithmetic: `?? 0`, then `ToNumber` (an object with
/// its own `toString` throws).
fn rate_num(v: Option<&Value>) -> Result<f64, Thrown> {
    match v {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => {
            if let Some(f) = db_agents::infinity(v) {
                return Ok(f);
            }
            js_string::to_js_number(Some(v))
                .map_err(|_| "TypeError: Cannot convert object to primitive value".to_owned())
        }
    }
}

/// `costFromOverrideRate(rate, tokens)`: the $/MT rates against the token
/// counts, in the TS's order of operations.
pub fn cost_from_override_rate(
    rate: &ModelPricingRate,
    tokens: &OverrideTokens,
) -> Result<f64, Thrown> {
    let cw1h = js_min(tokens.cache_write_1h.unwrap_or(0.0), tokens.cache_write);
    let cw5m = tokens.cache_write - cw1h;
    let one_hour = match &rate.cache_write_1h {
        Some(v) if !v.is_null() => rate_num(Some(v))?,
        _ => rate_num(rate.cache_write_5m.as_ref())?,
    };
    Ok((tokens.input * rate_num(rate.input.as_ref())?
        + tokens.output * rate_num(rate.output.as_ref())?
        + tokens.cache_read * rate_num(rate.cache_read.as_ref())?
        + cw5m * rate_num(rate.cache_write_5m.as_ref())?
        + cw1h * one_hour)
        / 1_000_000.0)
}

/// `applyModelPricing(baseUsd, model, tokens, pricing)`: a matched rate
/// replaces `base_usd`, then the multiplier scales it either way.
pub fn apply_model_pricing(
    base_usd: f64,
    model: &str,
    tokens: &OverrideTokens,
    pricing: Option<&Value>,
) -> Result<f64, Thrown> {
    let Some(pricing) = pricing.filter(|p| js::truthy(p)) else {
        return Ok(base_usd);
    };
    let rates = effective_override_rates(pricing)?;
    let rate = match_model_pricing_rate(model, rates.as_ref());
    let usd = match rate.filter(RateMatch::truthy) {
        Some(r) => cost_from_override_rate(&r.rate()?, tokens)?,
        None => base_usd,
    };
    let Some(mult) = effective_multiplier(pricing)? else {
        return Ok(usd);
    };
    // `typeof mult !== "number" || !Number.isFinite(mult) || mult <= 0`.
    match db_agents::number(&mult) {
        Some(m) if m.is_finite() && m > 0.0 => Ok(usd * js_min(m, MODEL_PRICING_MULTIPLIER_MAX)),
        _ => Ok(usd),
    }
}

/// `hasModelPricingOverride(pricing)`: anything configured worth a note in
/// the UI.
pub fn has_model_pricing_override(pricing: Option<&Value>) -> Result<bool, Thrown> {
    let Some(pricing) = pricing.filter(|p| js::truthy(p)) else {
        return Ok(false);
    };
    let mult = effective_multiplier(pricing)?;
    let rates = effective_override_rates(pricing)?;
    let by_mult = mult
        .as_ref()
        .and_then(db_agents::number)
        .is_some_and(|m| m > 0.0);
    let by_rates = rates.is_some_and(|r| js::truthy(&r) && key_count(&r) > 0);
    Ok(by_mult || by_rates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(value: Value) -> RateMatch {
        RateMatch::Entry {
            key: "m".into(),
            value,
        }
    }

    fn tokens(cache_write: f64, cache_write_1h: Option<f64>) -> OverrideTokens {
        OverrideTokens {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write,
            cache_write_1h,
        }
    }

    #[test]
    fn the_1h_slice_uses_the_1h_rate() {
        let rates = json!({"cacheWrite5m": 3.75, "cacheWrite1h": 6});
        let rate = entry(rates).rate().unwrap();
        let usd = cost_from_override_rate(&rate, &tokens(1_000_000.0, Some(400_000.0))).unwrap();
        assert!((usd - (0.6 * 3.75 + 0.4 * 6.0)).abs() < 1e-12);
    }

    #[test]
    fn without_a_1h_rate_the_5m_rate_prices_both() {
        let rate = entry(json!({"cacheWrite5m": 3.75})).rate().unwrap();
        let usd = cost_from_override_rate(&rate, &tokens(1_000_000.0, Some(1_000_000.0))).unwrap();
        assert!((usd - 3.75).abs() < 1e-12);
    }

    #[test]
    fn an_exact_key_wins_over_a_substring() {
        let rates = json!({"opus": {"input": 10}, "claude-opus-4-8": {"input": 9}});
        let got = match_model_pricing_rate("claude-opus-4-8", Some(&rates)).unwrap();
        assert_eq!(got.rate().unwrap().input, Some(json!(9)));
        let got = match_model_pricing_rate("claude-OPUS-4-8", Some(&rates)).unwrap();
        assert_eq!(got.rate().unwrap().input, Some(json!(10)));
        assert_eq!(match_model_pricing_rate("gpt-4o", Some(&rates)), None);
        assert_eq!(match_model_pricing_rate("gpt-4o", None), None);
    }

    #[test]
    fn the_multiplier_clamps_at_ten() {
        let p = json!({"multiplier": 1e9});
        assert_eq!(
            apply_model_pricing(2.0, "m", &tokens(0.0, None), Some(&p)).unwrap(),
            20.0
        );
        let p = json!({"discountMultiplier": 0.5});
        assert_eq!(
            apply_model_pricing(2.0, "m", &tokens(0.0, None), Some(&p)).unwrap(),
            1.0
        );
    }

    #[test]
    fn a_null_override_entry_throws() {
        let p = json!({"overrides": {"m": null}});
        assert_eq!(
            apply_model_pricing(1.0, "m", &tokens(0.0, None), Some(&p)),
            Err("TypeError: Cannot read properties of null (reading 'input')".into())
        );
    }
}
