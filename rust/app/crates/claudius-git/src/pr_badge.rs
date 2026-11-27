//! The header's PR / MR badge (`lib/shared/pr-badge.ts`, page.tsx:1635).

use crate::types::{PrBadge, js_number};

/// `prBadgeLabel` (pr-badge.ts:109): `PR #123` / `MR !45`.
pub fn pr_badge_label(badge: &PrBadge) -> String {
    let github = badge.host == "github";
    let sigil = if github { "#" } else { "!" };
    let kind = if github { "PR" } else { "MR" };
    format!("{kind} {sigil}{}", js_number(badge.number))
}

/// The badge's `title` (page.tsx:1641): the label, ` — <title>` when it
/// has one, ` · <state>`, then ` · checks <checks>` unless `none`.
pub fn pr_badge_title(badge: &PrBadge) -> String {
    let mut t = pr_badge_label(badge);
    if let Some(title) = badge.title.as_deref().filter(|t| !t.is_empty()) {
        t.push_str(" — ");
        t.push_str(title);
    }
    t.push_str(" · ");
    t.push_str(&badge.state);
    if badge.checks != "none" {
        t.push_str(" · checks ");
        t.push_str(&badge.checks);
    }
    t
}

/// The badge's tone (page.tsx:1646): merged purple, closed red, draft
/// muted, anything else emerald.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeTone {
    Merged,
    Closed,
    Draft,
    Open,
}

pub fn pr_badge_tone(badge: &PrBadge) -> BadgeTone {
    match badge.state.as_str() {
        "merged" => BadgeTone::Merged,
        "closed" => BadgeTone::Closed,
        "draft" => BadgeTone::Draft,
        _ => BadgeTone::Open,
    }
}

/// The checks mark after the label: `✓` / `✗` / `•`, none for `none`.
pub fn pr_checks_mark(badge: &PrBadge) -> Option<&'static str> {
    match badge.checks.as_str() {
        "passing" => Some("✓"),
        "failing" => Some("✗"),
        "pending" => Some("•"),
        _ => None,
    }
}

/// `href={prBadge.url || undefined}`.
pub fn pr_badge_href(badge: &PrBadge) -> Option<&str> {
    (!badge.url.is_empty()).then_some(badge.url.as_str())
}
