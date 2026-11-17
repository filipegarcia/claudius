//! `lib/shared/dangerous-rm-deny.ts` (CC 2.1.309): in Bypass permissions
//! mode, the engine's dangerous `rm` / `rmdir` safety-check ask is denied at
//! once with a rewrite hint instead of parking an Allow/Deny card, so an
//! unattended session keeps going (what Desktop and VS Code do).
//!
//! [`bypass_dangerous_rm_denial`] is the decision, called from
//! `Session::can_use_tool` right after the tool budgets. It fires only in
//! `bypassPermissions`, only for a string `decision_reason` whose text
//! matches the engine's dangerous-rm wording, only for
//! `decisionReasonType` `safetyCheck` / `subcommandResults`, and never when
//! a user `permissions.ask` rule forced the prompt. The reason is stripped
//! of ANSI escapes (hook-ask's `stripAnsi`, [`crate::hook_ask::strip_ansi`],
//! shared with `feedback_refusal`), JS-trimmed and capped at 600
//! code points (599 and `…`), then the hint follows after a blank line.
//!
//! Replayed against the TS in `tests/cc2309_golden.rs`.

use claudius_agent::js;

use crate::hook_ask::strip_ansi;

/// `DANGEROUS_RM_REWRITE_HINT`, appended to the engine's own reason.
pub const DANGEROUS_RM_REWRITE_HINT: &str = concat!(
    "Denied automatically because this session runs in Bypass permissions mode, ",
    "so it can keep going without a person to approve. ",
    "Rewrite the command so it removes only literal paths inside the project, ",
    "or leave the removal for the user to run."
);

/// `REASON_MAX`: the engine reason's cap, in code points.
const REASON_MAX: usize = 600;

/// The deny message to answer with, or `None` to show the normal prompt.
///
/// `matched_ask_rule` is whether the request carried a truthy
/// `matched_ask_rule` (the SDK's `ctx.matchedAskRule`); `decision_reason` and
/// `decision_reason_type` are the context's values when they are strings
/// (anything else can't match the TS checks).
pub fn bypass_dangerous_rm_denial(
    permission_mode: &str,
    decision_reason: Option<&str>,
    decision_reason_type: Option<&str>,
    matched_ask_rule: bool,
) -> Option<String> {
    if permission_mode != "bypassPermissions" {
        return None;
    }
    if matched_ask_rule {
        return None;
    }
    if !matches!(
        decision_reason_type,
        Some("safetyCheck" | "subcommandResults")
    ) {
        return None;
    }
    let reason = js::trim(&strip_ansi(decision_reason?)).to_owned();
    if !has_dangerous_rm(&reason) {
        return None;
    }
    // `Array.from(reason)`: code points.
    let shown = if reason.chars().count() > REASON_MAX {
        let mut cut: String = reason.chars().take(REASON_MAX - 1).collect();
        cut.push('\u{2026}');
        cut
    } else {
        reason
    };
    Some(format!("{shown}\n\n{DANGEROUS_RM_REWRITE_HINT}"))
}

/// `/\bdangerous rm(?:dir)? operations?\b/i.test(text)`, by hand. Without
/// the `u` flag, `/i` canonicalizes through `toUpperCase` but keeps a
/// non-ASCII unit whose upper case is ASCII (`ſ`, `ı`, `K`), so the match is
/// ASCII-case-insensitive. `\b` is an ASCII word boundary.
fn has_dangerous_rm(text: &str) -> bool {
    let c: Vec<char> = text.chars().collect();
    let word = |ch: char| ch.is_ascii_alphanumeric() || ch == '_';
    for i in 0..c.len() {
        // `\b` before `d`: a word char with a non-word char (or nothing)
        // before it.
        if !word(c[i]) || (i > 0 && word(c[i - 1])) {
            continue;
        }
        // The alternatives in the regex's own order, greedy first.
        for lit in ["dangerous rmdir operation", "dangerous rm operation"] {
            let Some(after) = match_ascii_ci(&c, i, lit) else {
                continue;
            };
            for plural in [true, false] {
                let end = if plural {
                    match match_ascii_ci(&c, after, "s") {
                        Some(e) => e,
                        None => continue,
                    }
                } else {
                    after
                };
                // `\b` after it: `n` / `s` is a word char, so the next one
                // must not be.
                if end >= c.len() || !word(c[end]) {
                    return true;
                }
            }
        }
    }
    false
}

/// Where `lit` (ASCII, lower case) ends when it matches at `at`, ASCII-case
/// insensitively.
fn match_ascii_ci(c: &[char], at: usize, lit: &str) -> Option<usize> {
    let mut i = at;
    for want in lit.chars() {
        let got = *c.get(i)?;
        if got.to_ascii_lowercase() != want {
            return None;
        }
        i += 1;
    }
    Some(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bypass_mode_with_a_safety_check_denies() {
        let reason = "Command contains dangerous rm operations";
        let d = |mode, ty, ask| bypass_dangerous_rm_denial(mode, Some(reason), Some(ty), ask);
        assert!(d("bypassPermissions", "safetyCheck", false).is_some());
        assert!(d("bypassPermissions", "subcommandResults", false).is_some());
        assert!(d("bypassPermissions", "hook", false).is_none());
        assert!(d("acceptEdits", "safetyCheck", false).is_none());
        assert!(d("bypassPermissions", "safetyCheck", true).is_none());
        assert!(
            bypass_dangerous_rm_denial("bypassPermissions", None, Some("safetyCheck"), false)
                .is_none()
        );
    }

    #[test]
    fn the_wording_is_matched_like_the_regex() {
        for yes in [
            "dangerous rm operation",
            "DANGEROUS RM OPERATIONS",
            "x (dangerous rmdir operations)",
            "a dangerous rm operations.",
        ] {
            assert!(has_dangerous_rm(yes), "{yes:?}");
        }
        for no in [
            "dangerous rm",
            "dangerous rmdirx operations",
            "dangerous rm operationsx",
            "xdangerous rm operations",
            "dangerous  rm operations",
            "dangerou\u{017f} rm operations",
        ] {
            assert!(!has_dangerous_rm(no), "{no:?}");
        }
    }

    #[test]
    fn the_reason_is_cut_at_600_code_points() {
        let long = "dangerous rm operations ".to_owned() + &"\u{1f600}".repeat(700);
        let msg = bypass_dangerous_rm_denial(
            "bypassPermissions",
            Some(&long),
            Some("safetyCheck"),
            false,
        )
        .unwrap();
        let head = msg.split("\n\n").next().unwrap();
        assert_eq!(head.chars().count(), REASON_MAX);
        assert!(head.ends_with('\u{2026}'));
    }
}
