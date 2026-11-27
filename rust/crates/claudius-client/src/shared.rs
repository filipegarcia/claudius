//! The small `lib/shared` reads the hook makes, most of them the server's
//! ports re-exported (each pinned against the TS on the client path by
//! `tests/client_modules_golden.rs`):
//!
//! - `system-informational.ts` `classifyInformationalLevel`;
//! - `hook-events.ts` `hookEventGetsDurablePill`;
//! - `fast-mode.ts` `isFastModeCreditsRejectedNotice` (server port), and
//!   the Opus 4.8 fast-mode deprecation (CC 2.1.316): `notificationColor`,
//!   `OPUS48_FAST_DEPRECATION_KEY`, `opus48FastDeprecationText` (R14c);
//! - `advisor.ts` `canonicalModelId`, which the deprecation reads, and
//!   `prettyModelName` (R14c);
//! - `advisor.ts` `ADVISOR_ACTIVE_SENTINEL`;
//! - `cost-pricing.ts` `costFromTokens` (server port);
//! - `parse-tasklist-result.ts` `parseTaskListResult` (server port; its
//!   rows feed `blocks::coerce_todos`).
//!
//! `fastModeDisabledReasonLabel` and the rest of `advisor.ts` and
//! `hook-events.ts` are display copy and the settings editors', not state.

pub use claudius_core::cost_pricing::{TokenBreakdown, cost_from_tokens};
pub use claudius_core::fast_mode::is_fast_mode_credits_rejected_notice;
pub use claudius_core::todos::parse_task_list_result;

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// `ADVISOR_ACTIVE_SENTINEL`: the advisor model the hook shows when the
/// init's tools have the advisor but no model id is known ("on, model
/// unknown"). Never sent to the server.
pub const ADVISOR_ACTIVE_SENTINEL: &str = "(active)";

/// `InformationalLevel`: the pill tones of a `system/informational`.
pub const INFORMATIONAL_LEVELS: [&str; 3] = ["notice", "suggestion", "warning"];

/// `classifyInformationalLevel(level)`: `(hidden, infoLevel)`. `info` is
/// transcript-only upstream, so hidden; `notice` / `suggestion` /
/// `warning` tone the pill; anything else (absent, unknown, a non-string)
/// shows untoned.
pub fn classify_informational_level(level: Option<&str>) -> (bool, Option<&'static str>) {
    match level {
        Some("info") => (true, None),
        Some(l) => (
            false,
            INFORMATIONAL_LEVELS.iter().copied().find(|k| *k == l),
        ),
        None => (false, None),
    }
}

/// `HOOK_PILL_EVENTS`: the one-time lifecycle hooks whose completion always
/// gets a durable pill.
pub const HOOK_PILL_EVENTS: [&str; 4] = ["SessionStart", "Setup", "SubagentStart", "SessionEnd"];

/// `hookEventGetsDurablePill(event, failed)`: a failed hook, or a lifecycle
/// one.
pub fn hook_event_gets_durable_pill(event: &str, failed: bool) -> bool {
    failed || HOOK_PILL_EVENTS.contains(&event)
}

/// `OPUS48_FAST_DEPRECATION_KEY`: the `system/notification` key of the
/// engine's "Opus 4.8 fast mode is deprecated" notice (CC 2.1.316). The
/// client raises the same text itself (`opus48_fast_deprecation_text`), and
/// the key lets the transcript skip the engine's copy.
pub const OPUS48_FAST_DEPRECATION_KEY: &str = "opus48-fast-mode-deprecation";

/// `notificationColor(msg)`: the pill tone of a `system/notification`, its
/// `color` when that is `warning` / `error`, else `warning` for the Opus 4.8
/// deprecation (whose `immediate` priority alone would tone it red), else
/// none (toned by priority). The hook passes the SDK message; a non-object
/// has no fields, so no tone.
pub fn notification_color(msg: &Value) -> Option<&'static str> {
    match msg.get("color").and_then(Value::as_str) {
        Some("warning") => Some("warning"),
        Some("error") => Some("error"),
        _ if msg.get("key").and_then(Value::as_str) == Some(OPUS48_FAST_DEPRECATION_KEY) => {
            Some("warning")
        }
        _ => None,
    }
}

/// `OPUS48_FAST_REMOVAL_ISO` (`2026-11-30`) as `Date.parse` reads it: UTC
/// midnight.
pub const OPUS48_FAST_REMOVAL_MS: f64 = 1_795_996_800_000.0;

/// The removal date as the TS formats it (`en-US`, short month, numeric
/// day, UTC).
const OPUS48_FAST_REMOVAL_LABEL: &str = "Nov 30";

/// `opus48FastDeprecationText(model, now)`: the engine's notice for turning
/// fast mode on with `model`, or none when it isn't Opus 4.8 once
/// canonicalized, or at / after the removal instant. `now` is `Date.now()`
/// unless the caller passes one; a NaN `now` compares false, so it shows.
pub fn opus48_fast_deprecation_text(model: Option<&str>, now: f64) -> Option<String> {
    if canonical_model_id(model).as_deref() != Some("claude-opus-4-8") {
        return None;
    }
    if now >= OPUS48_FAST_REMOVAL_MS {
        return None;
    }
    Some(format!(
        "Opus 4.8 fast mode is deprecated and will be removed on {OPUS48_FAST_REMOVAL_LABEL}"
    ))
}

/// The head of `canonicalModelId`'s pattern,
/// `/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d)(?!\d))?(?!\d)/`.
/// The lookaheads are applied by hand: the greedy `\d+` always takes every
/// digit (fewer would leave a digit for the final `(?!\d)`), so a match
/// starts wherever this one does. `\d` without the `u` flag is ASCII. A
/// fixed pattern, never built from input.
static CANONICAL_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"claude-(opus|sonnet|haiku|fable|mythos)-([0-9]+)")
        .expect("CANONICAL_HEAD compiles")
});

/// `canonicalModelId(raw)` (`advisor.ts`): the `claude-<family>-<major>[-<minor>]`
/// a model id names, found anywhere in its lower-cased form (`[1m]` tags,
/// date suffixes and Bedrock / Vertex wrappers drop away, a dotted minor
/// reads as a dashed one), or none for an empty or unrecognized id. The
/// minor is one digit followed by a non-digit; `claude-opus-4-80` is
/// `claude-opus-4`.
pub fn canonical_model_id(raw: Option<&str>) -> Option<String> {
    let lower = raw.filter(|r| !r.is_empty())?.to_lowercase();
    let caps = CANONICAL_HEAD.captures(&lower)?;
    let (family, major) = (&caps[1], &caps[2]);
    let rest = &lower.as_bytes()[caps.get(0)?.end()..];
    let minor = match rest {
        [b'-' | b'.', d, tail @ ..]
            if d.is_ascii_digit() && !tail.first().is_some_and(u8::is_ascii_digit) =>
        {
            Some(*d as char)
        }
        _ => None,
    };
    Some(match minor {
        Some(m) => format!("claude-{family}-{major}-{m}"),
        None => format!("claude-{family}-{major}"),
    })
}

/// `prettyModelName(id)` (`advisor.ts`): `claude-sonnet-5-5` → `Sonnet 5.5`,
/// for warning copy. An id `canonical_model_id` doesn't recognize comes
/// back as given (`""` for none).
pub fn pretty_model_name(id: Option<&str>) -> String {
    let Some(c) = canonical_model_id(id) else {
        return id.unwrap_or_default().to_owned();
    };
    // `c` is `claude-<family>-<major>[-<minor>]`, the family ASCII
    // lowercase.
    let mut parts = c["claude-".len()..].split('-');
    let (family, major, minor) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next(),
    );
    let mut chars = family.chars();
    let head = chars
        .next()
        .map(|ch| ch.to_ascii_uppercase())
        .into_iter()
        .collect::<String>();
    let minor = minor.map(|m| format!(".{m}")).unwrap_or_default();
    format!("{head}{} {major}{minor}", chars.as_str())
}
