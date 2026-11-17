//! The hook's prose detectors and label tables (use-session.ts, above
//! `useSession`): the hard rate-limit wall (`isRateLimitHitText` over
//! `lib/shared/rate-limit-prefixes.ts`, `rateLimitTypeFromText`,
//! `rateLimitHitFromBlocks`), the Opus high-demand banner, the
//! model-unavailable rewrite, and the resume / startup-failure labels.

use std::sync::LazyLock;

use claudius_agent::js;
use claudius_core::js_string;
use regex::Regex;

use crate::text::{AsciiCi, js_pattern};
use crate::{DisplayBlock, RateLimitHit, RateLimitInfo};

/// `USAGE_LIMIT_ERROR_PREFIXES` (lib/shared/rate-limit-prefixes.ts): the
/// CLI's "you've hit a usage limit" templates.
pub const USAGE_LIMIT_ERROR_PREFIXES: &[&str] = &[
    "You've hit your",
    "You've reached your",
    "You're out of usage credits",
    "Your org is out of usage \u{b7} add funds to continue",
    "Your org is out of usage \u{b7} contact your admin",
    "Your seat type doesn't include usage credits",
    "Your seat type doesn't include usage",
    "Your usage allocation has been disabled by your admin",
    "Your group's usage limit is set to $0",
    "Fable 5 requires usage credits",
    "You're out of extra usage",
    "Your seat type doesn't include extra usage",
];

/// `matchesUsageLimitPrefix`: trimmed, curly apostrophes straightened,
/// lowercased, then a prefix match.
pub fn matches_usage_limit_prefix(text: &str) -> bool {
    let normalized = js_string::to_lower(&js::trim(text).replace(['\u{2018}', '\u{2019}'], "'"));
    USAGE_LIMIT_ERROR_PREFIXES
        .iter()
        .any(|p| normalized.starts_with(&js_string::to_lower(p)))
}

/// The first `text` block's text, if every block is text and there is one.
fn only_text_first(blocks: &[DisplayBlock]) -> Option<&str> {
    if blocks.is_empty() || !blocks.iter().all(|b| b.as_text().is_some()) {
        return None;
    }
    blocks.iter().find_map(DisplayBlock::as_text)
}

/// `isRateLimitHitText`: a text-only message that opens with a usage-limit
/// template.
pub fn is_rate_limit_hit_text(blocks: &[DisplayBlock]) -> bool {
    only_text_first(blocks).is_some_and(matches_usage_limit_prefix)
}

static OPUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)opus(?-u:\b)").unwrap());
static SONNET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)sonnet(?-u:\b)").unwrap());
static WEEK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&js_pattern(
        r"(?-u:\b)(weekly|week|7[{WS}\-]?day|seven[{WS}\-]?day)(?-u:\b)",
    ))
    .unwrap()
});
static SESSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&js_pattern(
        r"(?-u:\b)(session|5[{WS}\-]?hour|five[{WS}\-]?hour)(?-u:\b)",
    ))
    .unwrap()
});

/// `rateLimitTypeFromText`: the SDK `rateLimitType` the CLI's prose label
/// names, if any.
pub fn rate_limit_type_from_text(text: &str) -> Option<&'static str> {
    let t = js_string::to_lower(text);
    if OPUS.is_match(&t) {
        Some("seven_day_opus")
    } else if SONNET.is_match(&t) {
        Some("seven_day_sonnet")
    } else if WEEK.is_match(&t) {
        Some("seven_day")
    } else if SESSION.is_match(&t) {
        Some("five_hour")
    } else {
        None
    }
}

/// `rateLimitHitFromBlocks`: the `rateLimitHit` payload of a hit message,
/// from the last rate-limit warning (live) or the prose (replay).
pub fn rate_limit_hit_from_blocks(
    blocks: &[DisplayBlock],
    last: Option<&RateLimitInfo>,
    fallback_model: Option<&str>,
    subscription_type: Option<&str>,
) -> RateLimitHit {
    let text = blocks.iter().find_map(DisplayBlock::as_text).unwrap_or("");
    let rate_limit_type = match last.and_then(|l| l.rate_limit_type.as_deref()) {
        Some(t) => Some(t.to_owned()),
        None => rate_limit_type_from_text(text).map(str::to_owned),
    };
    let nonempty = |s: Option<&str>| s.filter(|s| !s.is_empty()).map(str::to_owned);
    let per_model = matches!(
        rate_limit_type.as_deref(),
        Some("seven_day_opus" | "seven_day_sonnet")
    );
    RateLimitHit {
        rate_limit_type: nonempty(rate_limit_type.as_deref()),
        resets_at: last.and_then(|l| l.resets_at),
        fallback_model: nonempty(fallback_model).filter(|_| per_model),
        error_code: nonempty(last.and_then(|l| l.error_code.as_deref())),
        can_user_purchase_credits: last.and_then(|l| l.can_user_purchase_credits),
        has_chargeable_saved_payment_method: last
            .and_then(|l| l.has_chargeable_saved_payment_method),
        limit_scope: nonempty(last.and_then(|l| l.limit_scope.as_deref())),
        subscription_type: nonempty(subscription_type),
    }
}

/// `RESUME_REASON_LABELS`: the `resume_reason` values the SDK sends, in
/// the TS object's key order.
pub const RESUME_REASON_LABELS: &[(&str, &str)] = &[
    ("interrupted_turn", "the session process restarted mid-turn"),
    ("host_draining", "the host was draining for maintenance"),
    (
        "checkpoint_restore",
        "the session was restored from a checkpoint",
    ),
    ("container_recreated", "the session container was recreated"),
];

/// `STARTUP_FAILURE_REASON_LABELS`: the `startup_failure_reason` values, in
/// the TS object's key order.
pub const STARTUP_FAILURE_REASON_LABELS: &[(&str, &str)] = &[
    (
        "org_pin_api_key_conflict",
        "your organization requires signing in, but an API key or auth token is configured instead",
    ),
    (
        "provider_not_allowed",
        "your organization's managed settings don't allow the API provider this session is set up for",
    ),
    (
        "org_verify_failed",
        "your sign-in's organization could not be verified \u{2014} check network connectivity or sign in again",
    ),
    (
        "org_pin_mismatch",
        "your sign-in belongs to an organization this workspace doesn't allow",
    ),
    (
        "managed_settings_invalid",
        "managed policy settings could not be read, or the pin names no organization",
    ),
    (
        "remote_settings_required_unavailable",
        "settings your organization requires could not be loaded",
    ),
    (
        "gateway_signin_required",
        "the Cloud gateway ended this sign-in \u{2014} sign in again",
    ),
    (
        "gateway_access_denied",
        "the Cloud gateway refused managed settings for this account",
    ),
    (
        "proxy_invalid",
        "a configured proxy setting is not a complete URL",
    ),
    (
        "temp_dir_unusable",
        "the per-user temp directory is unsafe or could not be created",
    ),
    (
        "cwd_unavailable",
        "the working directory was deleted, moved, or cannot be read",
    ),
    (
        "shell_tool_missing",
        "no usable shell tool was found (Git Bash or PowerShell)",
    ),
    (
        "session_held_by_background",
        "this session is already running as a background task",
    ),
    (
        "worktree_resume_refused",
        "the resume was refused because the session's worktree failed its safety checks",
    ),
    (
        "worktree_unverified",
        "the session's worktree could not be verified right now \u{2014} retrying may succeed",
    ),
    (
        "cli_version_too_old",
        "this Claude Code version is below the minimum Anthropic requires",
    ),
    (
        "bypass_root",
        "bypass-permissions mode was requested while running as root",
    ),
    (
        "org_config_required_unavailable",
        "your organization requires its policy limits and managed settings, and they could not be loaded \u{2014} retrying may succeed",
    ),
    (
        "org_config_refused",
        "your organization requires its policy limits and managed settings, and Anthropic refused them for this sign-in \u{2014} sign in again",
    ),
];

/// `CONVERSATION_RESET_TRIGGER_LABEL` (SDK 0.3.281): the
/// `conversation_reset` divider's `detail` for each `trigger`, in the TS
/// object's key order. The reducer reads it as
/// `[r.trigger ?? ""] ?? "reason unspecified"`
/// ([`conversation_reset_detail`]).
pub const CONVERSATION_RESET_TRIGGER_LABEL: &[(&str, &str)] = &[
    ("clear", "via /clear"),
    ("plan_mode_exit", "left plan mode with context cleared"),
    (
        "fresh_session",
        "fresh session started to implement the approved plan",
    ),
    ("onboarding", "onboarding re-run"),
];

/// `CONVERSATION_RESET_TRIGGER_LABEL[trigger ?? ""] ?? "reason
/// unspecified"`. One difference: the TS reads the table with `[]`, so a
/// trigger named after an `Object.prototype` member (`constructor`,
/// `toString`, `__proto__`) gives that function or object; here it is
/// unspecified like any other unknown trigger.
pub fn conversation_reset_detail(trigger: Option<&str>) -> &'static str {
    label(
        CONVERSATION_RESET_TRIGGER_LABEL,
        trigger.unwrap_or_default(),
    )
    .unwrap_or("reason unspecified")
}

/// The table's label for `key` (an own key; the call sites that read
/// these with `[]` belong to the reducer slices).
pub fn label(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

static OPUS_HIGH_DEMAND: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(r"(?-u:\b)high demand for opus 4(?-u:\b)"));

/// `isOpusHighDemandText`: a text-only message whose first block carries
/// the "high demand for Opus 4" banner.
pub fn is_opus_high_demand_text(blocks: &[DisplayBlock]) -> bool {
    only_text_first(blocks).is_some_and(|t| OPUS_HIGH_DEMAND.is_match(t))
}

/// `MODEL_UNAVAILABLE_MESSAGE`: shown in place of the SDK's
/// `model_not_found` prose for the Fable model.
pub const MODEL_UNAVAILABLE_MESSAGE: &str = "Claude Fable 5.1 is currently unavailable. Please use Opus 5.5 or another available model. Learn more: https://www.anthropic.com/news/fable-mythos-access";

static MODEL_NOT_FOUND: LazyLock<AsciiCi> = LazyLock::new(|| {
    AsciiCi::new(&js_pattern(
        "there['\u{2019}]s an issue with the selected model|may not exist or you may not have access|is not available on your {DOT}*deployment",
    ))
});

/// `isModelNotFoundText`: a text-only message with the CLI's "selected
/// model can't be used" prose.
pub fn is_model_not_found_text(blocks: &[DisplayBlock]) -> bool {
    only_text_first(blocks).is_some_and(|t| MODEL_NOT_FOUND.is_match(t))
}

static FABLE: LazyLock<AsciiCi> = LazyLock::new(|| AsciiCi::new(r"(?-u:\b)fable(?-u:\b)"));

/// `rewriteModelUnavailableBlocks`: the model-unavailable notice for the
/// Fable model becomes [`MODEL_UNAVAILABLE_MESSAGE`]; anything else comes
/// back as it was (`None`).
pub fn rewrite_model_unavailable_blocks(
    blocks: &[DisplayBlock],
    assistant_error: Option<&str>,
) -> Option<Vec<DisplayBlock>> {
    if assistant_error != Some("model_not_found") && !is_model_not_found_text(blocks) {
        return None;
    }
    let first = blocks.iter().find_map(DisplayBlock::as_text)?;
    FABLE
        .is_match(first)
        .then(|| vec![DisplayBlock::text(MODEL_UNAVAILABLE_MESSAGE)])
}
