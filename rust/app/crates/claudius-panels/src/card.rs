//! The rail's always-on group: `SessionCard.tsx` (the model, effort,
//! workflows / fast / advisor badges, mode, cwd, turns and time; its
//! ModelPicker is the status line's, see the view), `ContextBar.tsx`,
//! `TokenMeter.tsx` and `PermissionPending.tsx`.

use claudius_agent::js;
use claudius_client::shared::pretty_model_name;
use serde_json::Value;

use crate::format::{fmt_elapsed_sec, fmt_path, fmt_tokens, fmt_usd, locale_number, to_fixed};
use crate::look::{Ink, Look, Paint};

/// `EFFORT_LABEL` (SessionCard.tsx:509).
pub fn effort_label(level: &str) -> Option<&'static str> {
    Some(match level {
        "auto" => "auto",
        "low" => "low",
        "medium" => "med",
        "high" => "high",
        "xhigh" => "very high",
        "max" => "max",
        _ => return None,
    })
}

/// `MODE_LABEL[mode] ?? mode` (SessionCard.tsx:98).
pub fn mode_label(mode: &str) -> String {
    match mode {
        "default" => "default",
        "acceptEdits" => "accept edits",
        "plan" => "plan",
        "bypassPermissions" => "bypass",
        other => other,
    }
    .to_owned()
}

/// `ModePill`'s tone (SessionCard.tsx:458): the one loud slot.
pub fn mode_look(mode: &str) -> Look {
    match mode {
        "plan" => Look::tint("violet-500", 30., 15., "violet-200"),
        "bypassPermissions" => Look::tint("red-500", 30., 10., "red-200"),
        "acceptEdits" => Look::tint("emerald-500", 30., 10., "emerald-200"),
        _ => Look {
            border: Ink::of(Paint::Border),
            bg: Ink::of(Paint::Panel),
            text: Ink::of(Paint::Muted),
        },
    }
}

/// `EFFORT_WAIT_NOTE` (effort-wait-note.ts).
pub const EFFORT_WAIT_NOTE: &str = "may wait for your next message";

/// The effort pill (`EffortPill`, SessionCard.tsx:533).
#[derive(Clone, Debug, PartialEq)]
pub struct EffortPill {
    /// `EFFORT_LABEL[shown]` (none for an unknown level: an empty pill).
    pub label: Option<&'static str>,
    /// `data-effort`: the applied level, else the pick.
    pub shown: String,
    pub title: String,
    /// `· may wait for your next message`.
    pub waits: bool,
}

pub fn effort_pill(effort: &str, applied: Option<&str>, waits: bool) -> EffortPill {
    let shown = applied.unwrap_or(effort);
    let label = |l: &str| effort_label(l).unwrap_or("undefined").to_owned();
    let note = match applied {
        Some(_) if effort == "auto" => " (default)".to_owned(),
        Some(a) if a != effort => format!(" ({} requested)", label(effort)),
        _ => String::new(),
    };
    let wait = if waits {
        format!(" \u{2014} changed during a task, so it {EFFORT_WAIT_NOTE}")
    } else {
        String::new()
    };
    EffortPill {
        label: effort_label(shown),
        shown: shown.to_owned(),
        title: format!("Reasoning effort: {}{note}{wait}", label(shown)),
        waits,
    }
}

/// `badgeAdvisorLabel(raw)` (advisor.ts:319): the advisor pill's text,
/// none when no advisor is set.
pub fn badge_advisor_label(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|r| !r.is_empty())?;
    Some(match raw {
        // `ADVISOR_ACTIVE_SENTINEL` and the pickable values (advisor.ts:33).
        "(active)" => "on".into(),
        "claude-opus-5-5" => "opus 5.5".into(),
        "claude-opus-4-8" => "opus 4.8".into(),
        "claude-sonnet-5" => "sonnet".into(),
        "claude-fable-5" => "fable".into(),
        _ => {
            let short = raw.strip_prefix("claude-").unwrap_or(raw);
            // `/-\d{8}$/`: an 8-digit date suffix.
            let b = short.as_bytes();
            let short = if b.len() >= 9
                && b[b.len() - 9] == b'-'
                && b[b.len() - 8..].iter().all(u8::is_ascii_digit)
            {
                &short[..short.len() - 9]
            } else {
                short
            };
            let u = claudius_core::js_string::units(short);
            if u.len() > 16 {
                format!("{}\u{2026}", claudius_core::js_string::from_units(&u[..14]))
            } else {
                short.to_owned()
            }
        }
    })
}

/// What the card reads (SessionCard's props, from `useSession()`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CardInput {
    pub model: Option<String>,
    pub effort: String,
    pub applied_effort: Option<String>,
    pub effort_change_waits: bool,
    pub permission_mode: String,
    pub cwd: Option<String>,
    /// `usage?.numTurns`, when a number.
    pub num_turns: Option<f64>,
    /// `usage?.durationMs`, when a number.
    pub duration_ms: Option<f64>,
    /// Assistant messages in the transcript.
    pub historical_turn_count: usize,
    pub ultracode: bool,
    pub fast_mode: bool,
    pub advisor_model: Option<String>,
}

/// The card as it draws.
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    /// `shortModel(model)`: the friendly name, or an em dash.
    pub model: String,
    pub effort: EffortPill,
    pub ultracode: bool,
    pub fast: bool,
    pub advisor: Option<(String, String)>,
    pub mode: String,
    pub mode_look: Look,
    /// `fmtPath(cwd, 32)` and the whole cwd.
    pub cwd: Option<(String, String)>,
    /// `3 turns`.
    pub turns: String,
    pub elapsed: String,
}

/// The card's header and metrics (SessionCard.tsx:159 on). `bound_at` is
/// when the card first saw a bound session (its wall clock).
pub fn card(i: &CardInput, bound_at: Option<f64>, now: f64) -> Card {
    let elapsed = match i.duration_ms.filter(|d| crate::tasks::num_truthy(Some(*d))) {
        Some(d) => d / 1000.0,
        None => match bound_at.filter(|b| crate::tasks::num_truthy(Some(*b))) {
            Some(b) => (now - b) / 1000.0,
            None => 0.0,
        },
    };
    let turns = i.num_turns.unwrap_or(i.historical_turn_count as f64);
    Card {
        model: match i.model.as_deref().filter(|m| !m.is_empty()) {
            Some(m) => pretty_model_name(Some(m)),
            None => "\u{2014}".into(),
        },
        effort: effort_pill(
            &i.effort,
            i.applied_effort.as_deref(),
            i.effort_change_waits,
        ),
        ultracode: i.ultracode,
        fast: i.fast_mode,
        advisor: badge_advisor_label(i.advisor_model.as_deref()).map(|label| {
            let raw = i.advisor_model.clone().unwrap_or_else(|| label.clone());
            (label, format!("Advisor: {raw}"))
        }),
        mode: mode_label(&i.permission_mode),
        mode_look: mode_look(&i.permission_mode),
        cwd: i
            .cwd
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(|c| (fmt_path(c, 32), c.to_owned())),
        turns: format!(
            "{} turn{}",
            crate::format::number_to_string(turns),
            if turns == 1.0 { "" } else { "s" }
        ),
        elapsed: fmt_elapsed_sec(elapsed),
    }
}

/// `useContextWatcher`'s summary (the parts ContextBar reads).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContextSummary {
    pub percentage: f64,
    pub total_tokens: Option<f64>,
    pub max_tokens: Option<f64>,
}

/// `ContextBar.tsx`.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextBar {
    /// `62%`, or an em dash before the first reading.
    pub label: String,
    /// The fill's width, 2 to 100 (%).
    pub width_pct: f64,
    pub fill: Ink,
    pub title: String,
}

pub fn context_bar(summary: Option<&ContextSummary>) -> ContextBar {
    let pct = summary.map_or(0.0, |s| s.percentage);
    let fill = if pct > 95.0 {
        Ink::of(Paint::Step("red-500"))
    } else if pct > 80.0 {
        Ink::of(Paint::Step("amber-500"))
    } else if pct > 50.0 {
        Ink::of(Paint::Accent)
    } else {
        Ink::at(Paint::Muted, 60.)
    };
    let title = match summary {
        Some(s) => {
            let n = |v: Option<f64>| locale_number(v.unwrap_or(0.0));
            format!(
                "{} / {} tokens ({}%)",
                n(s.total_tokens),
                n(s.max_tokens),
                to_fixed(pct, 1)
            )
        }
        None => "Context usage \u{2014} measuring\u{2026}".into(),
    };
    ContextBar {
        label: match summary {
            Some(_) => format!("{}%", to_fixed(pct, 0)),
            None => "\u{2014}".into(),
        },
        width_pct: pct.clamp(2.0, 100.0),
        fill,
        title,
    }
}

/// `TokenMeter.tsx`'s four tiles: in, out, cache, cost.
pub fn token_tiles(usage: &Value) -> [(&'static str, String); 4] {
    let n = |k: &str| js::prop(Some(usage), k).and_then(Value::as_f64);
    [
        ("in", fmt_tokens(n("inputTokens"))),
        ("out", fmt_tokens(n("outputTokens"))),
        ("cache", fmt_tokens(n("cacheReadInputTokens"))),
        ("$", fmt_usd(n("totalCostUsd"))),
    ]
}

/// `PermissionPending.tsx`: the waiting tool's name, when a permission
/// prompt is up.
pub fn permission_pending(request: Option<&Value>) -> Option<String> {
    let r = request?;
    Some(js::to_string(js::prop(Some(r), "toolName")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_effort_pill_shows_the_applied_level_and_says_where_it_came_from() {
        let p = effort_pill("auto", Some("high"), false);
        assert_eq!(p.label, Some("high"));
        assert_eq!(p.title, "Reasoning effort: high (default)");
        let p = effort_pill("max", Some("xhigh"), false);
        assert_eq!(p.title, "Reasoning effort: very high (max requested)");
        let p = effort_pill("medium", None, true);
        assert_eq!(p.label, Some("med"));
        assert_eq!(
            p.title,
            "Reasoning effort: med \u{2014} changed during a task, so it may wait for your next message"
        );
        assert_eq!(effort_pill("weird", None, false).label, None);
    }

    #[test]
    fn the_card_counts_turns_and_time() {
        let mut i = CardInput {
            effort: "auto".into(),
            permission_mode: "default".into(),
            historical_turn_count: 1,
            ..CardInput::default()
        };
        let c = card(&i, Some(1000.0), 66_000.0);
        assert_eq!(c.model, "\u{2014}");
        assert_eq!(c.turns, "1 turn");
        assert_eq!(c.elapsed, "1m 5s");
        i.num_turns = Some(3.0);
        i.duration_ms = Some(125_000.0);
        let c = card(&i, Some(1000.0), 66_000.0);
        assert_eq!(c.turns, "3 turns");
        assert_eq!(c.elapsed, "2m 5s");
        assert_eq!(card(&i, None, 0.0).elapsed, "2m 5s");
        i.duration_ms = None;
        assert_eq!(card(&i, None, 9e9).elapsed, "0s");
    }

    #[test]
    fn mode_pill_labels_and_tones() {
        assert_eq!(mode_label("acceptEdits"), "accept edits");
        assert_eq!(mode_label("bypassPermissions"), "bypass");
        assert_eq!(mode_label("auto"), "auto");
        assert_eq!(mode_look("plan").text, Ink::of(Paint::Step("violet-200")));
        assert_eq!(mode_look("default").text, Ink::of(Paint::Muted));
    }

    #[test]
    fn the_context_bar_steps_its_fill() {
        assert_eq!(context_bar(None).label, "\u{2014}");
        assert_eq!(context_bar(None).width_pct, 2.0);
        let s = ContextSummary {
            percentage: 96.4,
            total_tokens: Some(192_800.0),
            max_tokens: Some(200_000.0),
        };
        let b = context_bar(Some(&s));
        assert_eq!(b.label, "96%");
        assert_eq!(b.fill, Ink::of(Paint::Step("red-500")));
        assert_eq!(b.title, "192,800 / 200,000 tokens (96.4%)");
    }

    #[test]
    fn token_tiles_read_the_usage() {
        let t = token_tiles(
            &json!({ "inputTokens": 1234, "outputTokens": 56, "totalCostUsd": 0.4821 }),
        );
        assert_eq!(t[0].1, "1.2k");
        assert_eq!(t[1].1, "56");
        assert_eq!(t[2].1, "0");
        assert_eq!(t[3].1, "$0.482");
        assert_eq!(token_tiles(&Value::Null)[3].1, "$0.00");
    }
}
