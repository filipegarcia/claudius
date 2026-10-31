//! `String.prototype.localeCompare(that)` with no locale or options.
//!
//! V8 compares with an ICU4C collator for the process's default locale, at
//! the default (tertiary) strength, punctuation not ignored, normalization
//! on. This uses ICU4X's collator on the root data with the same defaults,
//! which is what `en` / `en-US` (and node's fallback when `LANG` is unset or
//! `C`) collate with. Under a locale with its own tailoring (`sv`, `da`,
//! `de-u-co-phonebk`, …) the TS order follows that locale; this one doesn't.
//!
//! Strings that compare equal (they differ only by completely ignorable
//! characters such as U+0001 or U+200B) return `Equal`, so a stable sort
//! keeps their input order, as `Array.prototype.sort` does. Replayed against
//! node 22 (ICU 78, CLDR 48) in `tests/fs_list_golden.rs`.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

static ROOT: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("the root collation data is compiled in")
});

/// `a.localeCompare(b)` (see the module docs for the locale).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    ROOT.compare(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_order() {
        let mut v = vec!["b", "Zed", "_x", "a", "A", "10", "9", "é", "~x", "a b"];
        v.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(v, ["_x", "~x", "10", "9", "a", "A", "a b", "b", "é", "Zed"]);
        assert_eq!(locale_compare("a\u{1}", "a"), Ordering::Equal);
    }
}
