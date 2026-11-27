//! `components/panels/widgets/format.ts` and the rail's own number and
//! path helpers (`BackgroundTasksPanel.tsx`'s `fmtElapsed`,
//! `compactArg`, `toLocaleString()`), as the TS prints them.

use claudius_core::js_string::{from_units, units};
pub use claudius_status::line::to_fixed;

/// `String(x)`: JS's number text, `NaN` and `Infinity` included.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        claudius_agent::js::number_to_string(x)
    }
}

/// `fmtUsd(n)` (format.ts:1): `$0.00` for none, zero or a non-finite
/// number; four places under a cent, three under a dollar, else two.
pub fn fmt_usd(n: Option<f64>) -> String {
    let Some(n) = n.filter(|n| *n != 0.0 && n.is_finite()) else {
        return "$0.00".into();
    };
    if n < 0.01 {
        format!("${}", to_fixed(n, 4))
    } else if n < 1.0 {
        format!("${}", to_fixed(n, 3))
    } else {
        format!("${}", to_fixed(n, 2))
    }
}

/// `fmtTokens(n)` (format.ts:8): `0` for none, zero or a non-finite
/// number; the number as is under 1000, `1.2k` / `12k` under a million,
/// else `1.23M`.
pub fn fmt_tokens(n: Option<f64>) -> String {
    let Some(n) = n.filter(|n| *n != 0.0 && n.is_finite()) else {
        return "0".into();
    };
    if n < 1000.0 {
        number_to_string(n)
    } else if n < 1_000_000.0 {
        let digits = if n < 10_000.0 { 1 } else { 0 };
        format!("{}k", to_fixed(n / 1000.0, digits))
    } else {
        format!("{}M", to_fixed(n / 1_000_000.0, 2))
    }
}

/// JS `%` on doubles (`fmod`: the sign of the dividend).
fn js_rem(a: f64, b: f64) -> f64 {
    a % b
}

/// `fmtElapsedSec(s)` (format.ts:15): `42s`, `3m`, `3m 5s`, `2h`,
/// `2h 5m` (whole units, floored).
pub fn fmt_elapsed_sec(s: f64) -> String {
    if s < 60.0 {
        return format!("{}s", number_to_string(s.floor()));
    }
    let m = (s / 60.0).floor();
    let r = js_rem(s, 60.0).floor();
    if m < 60.0 {
        return if r == 0.0 {
            format!("{}m", number_to_string(m))
        } else {
            format!("{}m {}s", number_to_string(m), number_to_string(r))
        };
    }
    let h = (m / 60.0).floor();
    let mr = js_rem(m, 60.0);
    if mr == 0.0 {
        format!("{}h", number_to_string(h))
    } else {
        format!("{}h {}m", number_to_string(h), number_to_string(mr))
    }
}

/// `fmtMs(ms)` (format.ts:25): an em dash for none, zero or a
/// non-finite number; `850ms` under a second, else [`fmt_elapsed_sec`].
pub fn fmt_ms(ms: Option<f64>) -> String {
    let Some(ms) = ms.filter(|n| *n != 0.0 && n.is_finite()) else {
        return "\u{2014}".into();
    };
    if ms < 1000.0 {
        return format!("{}ms", number_to_string(ms));
    }
    fmt_elapsed_sec(ms / 1000.0)
}

/// `s.slice(start)` with a negative `start` counting from the end, in
/// UTF-16 units (a pair cut in half keeps its lone half's stand-in).
fn slice_from(s: &str, start: i64) -> String {
    let u = units(s);
    let len = u.len() as i64;
    let at = if start < 0 {
        (len + start).max(0)
    } else {
        start.min(len)
    };
    from_units(&u[at as usize..])
}

/// `fmtPath(p, maxLen)` (format.ts:32): a path longer than `max_len`
/// UTF-16 units keeps its last two segments, `…/`-prefixed, cut to
/// `max_len - 2` units from the end.
pub fn fmt_path(p: &str, max_len: i64) -> String {
    if units(p).len() as i64 <= max_len {
        return p.to_owned();
    }
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    // `slice(-(maxLen - 2))`: `-0` is `0`, the whole string.
    let cut = -(max_len - 2);
    let tail = if parts.len() <= 2 {
        parts.join("/")
    } else {
        parts[parts.len() - 2..].join("/")
    };
    format!("\u{2026}/{}", slice_from(&tail, cut))
}

/// The rail's `fmtElapsed(s)` (BackgroundTasksPanel.tsx:239): `42s`
/// (`toFixed(0)`, so 59.5 reads `60s`) under a minute, else `3m 5s`.
pub fn fmt_elapsed(s: f64) -> String {
    if s < 60.0 {
        return format!("{}s", to_fixed(s, 0));
    }
    let m = (s / 60.0).floor();
    let r = js_rem(s, 60.0).floor();
    format!("{}m {}s", number_to_string(m), number_to_string(r))
}

/// `compactArg(name, arg)` (BackgroundTasksPanel.tsx:262): a file tool's
/// path shows its basename (the whole arg when that's empty).
pub fn compact_arg(name: &str, arg: &str) -> String {
    if matches!(name, "Edit" | "MultiEdit" | "Write" | "Read") {
        let base = arg.rsplit('/').next().unwrap_or(arg);
        return if base.is_empty() { arg } else { base }.to_owned();
    }
    arg.to_owned()
}

/// `n.toLocaleString()` in en-US (grouped by thousands).
pub fn locale_number(n: f64) -> String {
    claudius_chat::text::locale_number(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_usd_uses_four_three_or_two_places() {
        assert_eq!(fmt_usd(None), "$0.00");
        assert_eq!(fmt_usd(Some(0.0)), "$0.00");
        assert_eq!(fmt_usd(Some(f64::INFINITY)), "$0.00");
        assert_eq!(fmt_usd(Some(0.0042)), "$0.0042");
        assert_eq!(fmt_usd(Some(0.01)), "$0.010");
        assert_eq!(fmt_usd(Some(0.4821)), "$0.482");
        assert_eq!(fmt_usd(Some(1.0)), "$1.00");
        assert_eq!(fmt_usd(Some(-3.0)), "$-3.0000");
    }

    #[test]
    fn fmt_tokens_steps_at_a_thousand_ten_thousand_and_a_million() {
        assert_eq!(fmt_tokens(None), "0");
        assert_eq!(fmt_tokens(Some(999.0)), "999");
        assert_eq!(fmt_tokens(Some(1000.0)), "1.0k");
        assert_eq!(fmt_tokens(Some(9_999.0)), "10.0k");
        assert_eq!(fmt_tokens(Some(10_000.0)), "10k");
        assert_eq!(fmt_tokens(Some(999_999.0)), "1000k");
        assert_eq!(fmt_tokens(Some(1_000_000.0)), "1.00M");
    }

    #[test]
    fn fmt_elapsed_sec_drops_zero_parts() {
        assert_eq!(fmt_elapsed_sec(0.0), "0s");
        assert_eq!(fmt_elapsed_sec(59.9), "59s");
        assert_eq!(fmt_elapsed_sec(60.0), "1m");
        assert_eq!(fmt_elapsed_sec(65.0), "1m 5s");
        assert_eq!(fmt_elapsed_sec(3600.0), "1h");
        assert_eq!(fmt_elapsed_sec(3720.0), "1h 2m");
        assert_eq!(fmt_elapsed_sec(f64::NAN), "NaNh NaNm");
    }

    #[test]
    fn fmt_ms_reads_milliseconds_under_a_second() {
        assert_eq!(fmt_ms(None), "\u{2014}");
        assert_eq!(fmt_ms(Some(850.0)), "850ms");
        assert_eq!(fmt_ms(Some(1500.0)), "1s");
    }

    #[test]
    fn fmt_path_keeps_the_last_two_segments() {
        assert_eq!(fmt_path("/a/b", 36), "/a/b");
        assert_eq!(
            fmt_path("/Users/demo/projects/claudius/rust/app", 32),
            "\u{2026}/rust/app"
        );
        assert_eq!(
            fmt_path("/x/averyveryveryveryverylongdirectoryname", 12),
            "\u{2026}/ectoryname"
        );
    }

    #[test]
    fn fmt_elapsed_rounds_under_a_minute() {
        assert_eq!(fmt_elapsed(59.5), "60s");
        assert_eq!(fmt_elapsed(3.2), "3s");
        assert_eq!(fmt_elapsed(125.7), "2m 5s");
    }

    #[test]
    fn compact_arg_shows_a_file_tools_basename() {
        assert_eq!(compact_arg("Edit", "/a/b/c.rs"), "c.rs");
        assert_eq!(compact_arg("Read", "/a/b/"), "/a/b/");
        assert_eq!(compact_arg("Bash", "/a/b/c.rs"), "/a/b/c.rs");
    }
}
