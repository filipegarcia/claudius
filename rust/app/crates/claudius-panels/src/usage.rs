//! `PlanUsageCard.tsx`: the plan's rate-limit windows
//! (`lib/client/usage-windows.ts`: `collectUsageWindows`,
//! `shortUsageLabel`, `displayUsagePct`, `usageTone`), the live reset
//! countdown (`use-countdown.ts`'s `formatRemaining`, `limitHasReset`),
//! the minimized row and the "Slow your burn" levers.

use claudius_agent::js;
use claudius_client::types::RateLimitInfo;
use indexmap::IndexMap;
use serde_json::Value;

/// One window (`UsageWindow`).
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindow {
    pub key: String,
    pub label: String,
    /// 0 to 100, raw (may read above 100).
    pub pct: f64,
    pub resets_at_sec: Option<f64>,
    pub rejected: bool,
}

/// `UsageTone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UsageTone {
    Ok,
    Warning,
    Rejected,
}

impl UsageTone {
    pub fn as_str(self) -> &'static str {
        match self {
            UsageTone::Ok => "ok",
            UsageTone::Warning => "warning",
            UsageTone::Rejected => "rejected",
        }
    }
}

/// `PLAN_WINDOW_LABELS` (usage-windows.ts:37).
fn plan_window_label(key: &str) -> Option<&'static str> {
    Some(match key {
        "fiveHour" => "5-hour limit",
        "sevenDay" => "Weekly limit",
        "sevenDayOpus" => "Weekly Opus limit",
        "sevenDaySonnet" => "Weekly Sonnet limit",
        "sevenDayOauthApps" => "Weekly limit (OAuth apps)",
        _ => return None,
    })
}

/// `EVENT_WINDOWS` (usage-windows.ts:46).
fn event_window(rate_limit_type: &str) -> Option<(&'static str, &'static str)> {
    Some(match rate_limit_type {
        "five_hour" => ("fiveHour", "5-hour limit"),
        "seven_day" => ("sevenDay", "Weekly limit"),
        "seven_day_opus" => ("sevenDayOpus", "Weekly Opus limit"),
        "seven_day_sonnet" => ("sevenDaySonnet", "Weekly Sonnet limit"),
        "seven_day_overage_included" => ("sevenDayOverageIncluded", "Weekly limit (overage incl.)"),
        "overage" => ("overage", "Extra-usage limit"),
        _ => return None,
    })
}

/// `ORDER` (usage-windows.ts:56): the session window, the weekly ones,
/// then the rest.
const ORDER: [&str; 7] = [
    "fiveHour",
    "sevenDay",
    "sevenDayOpus",
    "sevenDaySonnet",
    "sevenDayOverageIncluded",
    "sevenDayOauthApps",
    "overage",
];

fn rank(key: &str) -> usize {
    ORDER.iter().position(|k| *k == key).unwrap_or(ORDER.len())
}

/// `isoToSec(iso)`: `Math.floor(new Date(iso).getTime() / 1000)`, none
/// for a falsy or unparsable string.
pub fn iso_to_sec(iso: Option<&Value>) -> Option<f64> {
    let s = iso?.as_str().filter(|s| !s.is_empty())?;
    let ms = claudius_core::js_date::date_parse(s)? as f64;
    Some((ms / 1000.0).floor())
}

/// `collectUsageWindows(planUsage, rateLimitEvents, nowMs)`
/// (usage-windows.ts:88): both sources merged, a passed window dropped
/// from each before merging, in display order.
pub fn collect_usage_windows(
    plan_usage: &Value,
    events: &[RateLimitInfo],
    now_ms: f64,
) -> Vec<UsageWindow> {
    let live = |sec: Option<f64>| sec.is_none_or(|s| s * 1000.0 > now_ms);
    let mut by_key: IndexMap<String, UsageWindow> = IndexMap::new();
    for info in events {
        let Some((key, label)) = info
            .rate_limit_type
            .as_deref()
            .filter(|t| !t.is_empty())
            .and_then(event_window)
        else {
            continue;
        };
        if !live(info.resets_at) {
            continue;
        }
        let rejected = info.status.as_deref() == Some("rejected");
        if info.utilization.is_none() && !rejected {
            continue;
        }
        by_key.insert(
            key.to_owned(),
            UsageWindow {
                key: key.to_owned(),
                label: label.to_owned(),
                pct: info.utilization.map_or(100.0, |u| u * 100.0),
                resets_at_sec: info.resets_at,
                rejected,
            },
        );
    }
    let available = js::prop(Some(plan_usage), "rateLimitsAvailable").is_some_and(js::truthy);
    if available {
        let mut windows: Vec<(String, String, Option<&Value>)> = Vec::new();
        if let Some(Value::Object(m)) = js::prop(Some(plan_usage), "rateLimits") {
            for (k, w) in js::own_keys_order(m) {
                let label = plan_window_label(k).map_or_else(|| k.clone(), str::to_owned);
                windows.push((k.clone(), label, Some(w)));
            }
        }
        if let Some(Value::Array(list)) = js::prop(Some(plan_usage), "modelScoped") {
            for ms in list {
                let name = js::to_string(js::prop(Some(ms), "displayName"));
                windows.push((
                    format!("model:{name}"),
                    format!("Weekly {name} limit"),
                    Some(ms),
                ));
            }
        }
        for (key, label, w) in windows {
            let Some(w) = w.filter(|w| js::truthy(w)) else {
                continue;
            };
            let Some(pct) = js::prop(Some(w), "utilization").and_then(Value::as_f64) else {
                continue;
            };
            let resets = iso_to_sec(js::prop(Some(w), "resetsAt"));
            if !live(resets) {
                continue;
            }
            let from_event = by_key.get(&key);
            let w = UsageWindow {
                key: key.clone(),
                label,
                pct,
                resets_at_sec: resets.or_else(|| from_event.and_then(|e| e.resets_at_sec)),
                rejected: from_event.is_some_and(|e| e.rejected),
            };
            by_key.insert(key, w);
        }
    }
    let mut out: Vec<UsageWindow> = by_key.into_values().collect();
    out.sort_by_key(|w| rank(&w.key));
    out
}

/// `shortUsageLabel(w)` (usage-windows.ts:150).
pub fn short_usage_label(w: &UsageWindow) -> String {
    if let Some(rest) = w.key.strip_prefix("model:") {
        return rest.to_owned();
    }
    match w.key.as_str() {
        "fiveHour" => "5-hour",
        "sevenDay" => "Weekly",
        "sevenDayOpus" => "Opus",
        "sevenDaySonnet" => "Sonnet",
        "sevenDayOauthApps" => "OAuth apps",
        "sevenDayOverageIncluded" => "Weekly+",
        "overage" => "Extra",
        _ => return w.label.clone(),
    }
    .to_owned()
}

/// `clampPct(pct)` (usage-pct.ts).
pub fn clamp_pct(pct: f64) -> f64 {
    if !pct.is_finite() {
        return 0.0;
    }
    pct.clamp(0.0, 100.0)
}

/// `displayUsagePct(w)`: rounded, then clamped.
pub fn display_usage_pct(w: &UsageWindow) -> f64 {
    clamp_pct(claudius_core::image_size::js_round(w.pct))
}

/// `usageTone(w, thresholdPct)` (usage-windows.ts:172).
pub fn usage_tone(w: &UsageWindow, threshold_pct: f64) -> UsageTone {
    if w.rejected || w.pct >= 100.0 {
        UsageTone::Rejected
    } else if w.pct > 0.0 && w.pct >= threshold_pct {
        UsageTone::Warning
    } else {
        UsageTone::Ok
    }
}

/// `limitHasReset(resetsAtSec, nowMs)` (rate-limit-cta.ts:67).
pub fn limit_has_reset(resets_at_sec: Option<f64>, now_ms: f64) -> bool {
    match resets_at_sec {
        Some(r) if r.is_finite() && r > 0.0 => (r - now_ms / 1000.0).floor() <= 0.0,
        _ => false,
    }
}

fn pad2(n: f64) -> String {
    let s = crate::format::number_to_string(n);
    if s.encode_utf16().count() < 2 {
        format!("0{s}")
    } else {
        s
    }
}

/// `formatRemaining(totalSec)` (use-countdown.ts:48): `05m 09s`,
/// `2h 05m 09s`, `3d 4h 05m`.
pub fn format_remaining(total_sec: f64) -> String {
    let h = (total_sec / 3600.0).floor();
    let m = ((total_sec % 3600.0) / 60.0).floor();
    let s = total_sec % 60.0;
    if h > 0.0 {
        if h >= 24.0 {
            let d = (h / 24.0).floor();
            let hh = h % 24.0;
            return format!(
                "{}d {}h {}m",
                crate::format::number_to_string(d),
                crate::format::number_to_string(hh),
                pad2(m)
            );
        }
        return format!(
            "{}h {}m {}s",
            crate::format::number_to_string(h),
            pad2(m),
            pad2(s)
        );
    }
    format!("{}m {}s", pad2(m), pad2(s))
}

/// `useCountdownSeconds(resetsAtSec)` at `now_ms`.
pub fn countdown(resets_at_sec: Option<f64>, now_ms: f64) -> Option<String> {
    let r = resets_at_sec.filter(|r| crate::tasks::num_truthy(Some(*r)))?;
    if limit_has_reset(Some(r), now_ms) {
        return Some("Available now".into());
    }
    Some(format_remaining((r - now_ms / 1000.0).floor()))
}

/// `formatReset(sec)` (PlanUsageCard.tsx:101): `toLocaleString` with a
/// short weekday and the time, en-US: `Sun 3:00 AM`.
pub fn format_reset<Tz: chrono::TimeZone>(resets_at_sec: f64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let ms = resets_at_sec * 1000.0;
    if !ms.is_finite() {
        return "Invalid Date".into();
    }
    match tz.timestamp_millis_opt(ms as i64).single() {
        Some(at) => at.format("%a %-I:%M %p").to_string(),
        None => "Invalid Date".into(),
    }
}

/// `toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })`:
/// `3:00 AM`.
pub fn format_clock<Tz: chrono::TimeZone>(ms: f64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    if !ms.is_finite() {
        return "Invalid Date".into();
    }
    match tz.timestamp_millis_opt(ms as i64).single() {
        Some(at) => at.format("%-I:%M %p").to_string(),
        None => "Invalid Date".into(),
    }
}

/// `useRateLimitWarningPct()`'s read of `claudius.rateLimitWarningPct`:
/// `parseInt`, clamped to 0–100 and rounded, 50 by default.
pub fn rate_limit_warning_pct(raw: Option<&str>) -> f64 {
    let Some(raw) = raw else { return 50.0 };
    let n = js::parse_int(raw);
    if !n.is_finite() {
        return 50.0;
    }
    if n < 0.0 {
        0.0
    } else if n > 100.0 {
        100.0
    } else {
        claudius_core::image_size::js_round(n)
    }
}

/// `localStorage` key of the threshold.
pub const RATE_LIMIT_WARNING_KEY: &str = "claudius.rateLimitWarningPct";
/// `localStorage` key of the minimized state.
pub const PLAN_USAGE_COLLAPSED_KEY: &str = "claudius.activity.plan-usage.collapsed";
/// `OPUS_OVERLOAD_NUDGE_SONNET_TARGET`.
pub const SONNET_TARGET: &str = "sonnet";

/// A window's row in the open card (`UsageRow`).
#[derive(Clone, Debug, PartialEq)]
pub struct UsageRow {
    pub key: String,
    pub label: String,
    /// `limit hit` or `42% used`.
    pub value: String,
    /// The bar's fill, 2 to 100 (%), off the raw figure.
    pub bar_pct: f64,
    pub tone: UsageTone,
    /// `resets Sun 3:00 AM` and the countdown.
    pub reset: Option<(String, Option<String>)>,
}

/// A window in the minimized row.
#[derive(Clone, Debug, PartialEq)]
pub struct MiniWindow {
    pub key: String,
    pub label: String,
    /// `hit` or `42%`.
    pub value: String,
    pub tone: UsageTone,
}

/// The card.
#[derive(Clone, Debug, PartialEq)]
pub enum PlanCard {
    Collapsed {
        worst: UsageTone,
        stale: bool,
        shown: Vec<MiniWindow>,
        title: String,
    },
    Open {
        worst: UsageTone,
        stale: bool,
        subscription: Option<String>,
        /// `as of 3:00 AM` when stale.
        as_of: Option<String>,
        rows: Vec<UsageRow>,
        sonnet: bool,
        effort: bool,
        threshold: bool,
    },
}

/// What the card reads.
#[derive(Clone, Copy, Debug)]
pub struct PlanInput<'a> {
    pub plan_usage: &'a Value,
    pub events: &'a [RateLimitInfo],
    pub model: Option<&'a str>,
    pub effort: &'a str,
    pub threshold_pct: f64,
    pub collapsed: bool,
    /// The minute clock the windows are filtered with.
    pub filter_now_ms: f64,
    /// The second clock the countdowns read.
    pub now_ms: f64,
}

/// `PlanUsageCard` (PlanUsageCard.tsx:177): none without a window.
pub fn plan_card<Tz: chrono::TimeZone>(i: &PlanInput<'_>, tz: &Tz) -> Option<PlanCard>
where
    Tz::Offset: std::fmt::Display,
{
    let windows = collect_usage_windows(i.plan_usage, i.events, i.filter_now_ms);
    if windows.is_empty() {
        return None;
    }
    let tones: Vec<UsageTone> = windows
        .iter()
        .map(|w| usage_tone(w, i.threshold_pct))
        .collect();
    let worst = tones.iter().copied().fold(UsageTone::Ok, UsageTone::max);
    let stale = js::prop(Some(i.plan_usage), "stale").is_some_and(js::truthy);
    let value = |w: &UsageWindow| {
        if w.rejected {
            "limit hit".to_owned()
        } else {
            format!(
                "{}% used",
                crate::format::number_to_string(display_usage_pct(w))
            )
        }
    };
    if i.collapsed {
        let summary: Vec<String> = windows
            .iter()
            .map(|w| {
                let reset = match w
                    .resets_at_sec
                    .filter(|r| crate::tasks::num_truthy(Some(*r)))
                {
                    Some(r) => format!(" \u{b7} resets {}", format_reset(r, tz)),
                    None => String::new(),
                };
                format!("{}: {}{reset}", w.label, value(w))
            })
            .collect();
        let title = format!(
            "{}{}\n\nClick to expand",
            summary.join("\n"),
            if stale { "\n(last known values)" } else { "" }
        );
        return Some(PlanCard::Collapsed {
            worst,
            stale,
            shown: windows
                .iter()
                .zip(&tones)
                .take(2)
                .map(|(w, t)| MiniWindow {
                    key: w.key.clone(),
                    label: short_usage_label(w),
                    value: if w.rejected {
                        "hit".into()
                    } else {
                        format!("{}%", crate::format::number_to_string(display_usage_pct(w)))
                    },
                    tone: *t,
                })
                .collect(),
            title,
        });
    }
    let hot = worst != UsageTone::Ok;
    let subscription = js::prop(Some(i.plan_usage), "subscriptionType")
        .filter(|v| js::truthy(v))
        .map(|v| capitalize(&js::to_string(Some(v))));
    let as_of = (stale && js::truthy(i.plan_usage)).then(|| {
        let at = js::prop(Some(i.plan_usage), "fetchedAt");
        let ms = at.map_or(f64::NAN, |v| match v {
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::String(s) => {
                claudius_core::js_date::date_parse(s).map_or(f64::NAN, |v| v as f64)
            }
            _ => f64::NAN,
        });
        format!("as of {}", format_clock(ms, tz))
    });
    Some(PlanCard::Open {
        worst,
        stale,
        subscription,
        as_of,
        rows: windows
            .iter()
            .zip(&tones)
            .map(|(w, t)| UsageRow {
                key: w.key.clone(),
                label: w.label.clone(),
                value: value(w),
                bar_pct: w.pct.clamp(2.0, 100.0),
                tone: *t,
                reset: w
                    .resets_at_sec
                    .filter(|r| crate::tasks::num_truthy(Some(*r)))
                    .map(|r| {
                        (
                            format!("resets {}", format_reset(r, tz)),
                            countdown(Some(r), i.now_ms),
                        )
                    }),
            })
            .collect(),
        sonnet: hot
            && i.model
                .is_some_and(|m| claudius_core::js_string::to_lower(m).contains("opus")),
        effort: hot && matches!(i.effort, "high" | "xhigh" | "max"),
        threshold: worst == UsageTone::Warning,
    })
}

/// CSS `text-transform: capitalize`: each word's first letter upper case.
fn capitalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut start = true;
    for c in s.chars() {
        if start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
            start = false;
        } else {
            if c.is_whitespace() {
                start = true;
            } else if c.is_alphanumeric() {
                start = false;
            }
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collect_usage_windows_merges_the_snapshot_over_the_events() {
        let plan = json!({
            "rateLimitsAvailable": true,
            "rateLimits": {
                "sevenDay": { "utilization": 81, "resetsAt": "2026-11-29T03:00:00Z" },
                "fiveHour": { "utilization": 12, "resetsAt": null },
                "sevenDayOpus": null,
            },
        });
        let ev = RateLimitInfo {
            status: Some("rejected".into()),
            rate_limit_type: Some("seven_day".into()),
            utilization: Some(0.5),
            ..RateLimitInfo::default()
        };
        let w = collect_usage_windows(&plan, &[ev], 0.0);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].key, "fiveHour");
        assert_eq!(w[1].key, "sevenDay");
        assert_eq!(w[1].pct, 81.0);
        assert!(w[1].rejected);
        assert_eq!(usage_tone(&w[0], 50.0), UsageTone::Ok);
        assert_eq!(usage_tone(&w[1], 50.0), UsageTone::Rejected);
    }

    #[test]
    fn format_remaining_pads_and_switches_to_days() {
        assert_eq!(format_remaining(309.0), "05m 09s");
        assert_eq!(format_remaining(7509.0), "2h 05m 09s");
        assert_eq!(
            format_remaining(3.0 * 86400.0 + 4.0 * 3600.0 + 300.0),
            "3d 4h 05m"
        );
    }

    #[test]
    fn countdown_says_available_once_the_reset_passed() {
        assert_eq!(countdown(None, 0.0), None);
        assert_eq!(
            countdown(Some(10.0), 10_000.0).as_deref(),
            Some("Available now")
        );
        assert_eq!(countdown(Some(70.0), 10_000.0).as_deref(), Some("01m 00s"));
    }

    #[test]
    fn the_threshold_reads_the_stored_percent() {
        assert_eq!(rate_limit_warning_pct(None), 50.0);
        assert_eq!(rate_limit_warning_pct(Some("75")), 75.0);
        assert_eq!(rate_limit_warning_pct(Some("x")), 50.0);
        assert_eq!(rate_limit_warning_pct(Some("150")), 100.0);
        assert_eq!(rate_limit_warning_pct(Some("-3")), 0.0);
    }

    #[test]
    fn format_reset_reads_a_weekday_and_a_time() {
        // 2026-11-29T03:00:00Z is a Sunday.
        assert_eq!(format_reset(1_795_921_200.0, &chrono::Utc), "Sun 3:00 AM");
    }
}
