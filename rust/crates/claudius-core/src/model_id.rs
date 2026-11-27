//! `lib/shared/model-id.ts`: model-id spellings the pricing tables must
//! treat alike.
//!
//! Only [`normalize_dotted_model_version`] lives here so far (CC 2.1.314, the
//! cost side of "dotted model ids behind a gateway priced as an older
//! model"). The file's `[1m]`-tag helpers are picker lookups on the client
//! (R14).

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

/// `DOTTED_VERSION`, `/\b((?:claude-)?(?:opus|sonnet|haiku|fable|mythos)-\d+)\.(\d+)/gi`.
///
/// A JS regex without the `u` flag matches case-insensitively, at word
/// boundaries and on `\d` in ASCII only, so every part here is ASCII-only:
/// `ſonnet` (U+017F) and the Kelvin sign don't fold, and other scripts'
/// digits aren't `\d`. A fixed pattern, never built from input.
static DOTTED_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)((?i-u:(?:claude-)?(?:opus|sonnet|haiku|fable|mythos))-[0-9]+)\.([0-9]+)")
        .expect("DOTTED_VERSION compiles")
});

/// `normalizeDottedModelVersion(model)`: rewrites a
/// `[claude-]<family>-<major>.<minor>` version dot to a dash, everywhere it
/// occurs (`claude-opus-5.5` → `claude-opus-5-5`, `us.anthropic.claude-opus-4.8-v1:0`
/// → `us.anthropic.claude-opus-4-8-v1:0`), keeping the case of what it
/// copies. Every other dot stays: provider prefixes, `-v1:0` suffixes and
/// legacy ids such as `claude-2.1` or `claude-instant-1.2`.
pub fn normalize_dotted_model_version(model: &str) -> Cow<'_, str> {
    DOTTED_VERSION.replace_all(model, "${1}-${2}")
}

#[cfg(test)]
mod tests {
    use super::normalize_dotted_model_version as n;

    #[test]
    fn rewrites_only_a_family_version_dot() {
        assert_eq!(n("claude-opus-5.5"), "claude-opus-5-5");
        assert_eq!(n("sonnet-5.5"), "sonnet-5-5");
        assert_eq!(n("CLAUDE-Opus-4.8"), "CLAUDE-Opus-4-8");
        assert_eq!(
            n("us.anthropic.claude-opus-4.8-v1:0"),
            "us.anthropic.claude-opus-4-8-v1:0"
        );
        assert_eq!(
            n("claude-opus-5.5 and haiku-4.5"),
            "claude-opus-5-5 and haiku-4-5"
        );
        assert_eq!(n("claude-opus-5.5.1"), "claude-opus-5-5.1");
        for kept in [
            "claude-2.1",
            "claude-instant-1.2",
            "xopus-5.5",
            "opus-.5",
            "opus-5.",
            "claude-\u{17f}onnet-5.5",
            "opus-\u{665}.5",
        ] {
            assert_eq!(n(kept), kept);
        }
    }
}
