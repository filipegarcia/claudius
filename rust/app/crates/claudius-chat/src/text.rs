//! The string helpers the row components call: `lib/shared/bash-io.ts`,
//! `lib/shared/peer-message-preview.ts`, `SystemPill.tsx`'s
//! `systemReminderTitle` / `formatCompactStats`, the user-prompt markdown
//! options (`<Markdown breaks>` with math off), and the native fold.

use serde_json::Value;

/// JS `String.prototype.trim`'s whitespace (WhiteSpace + LineTerminator).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JS truthiness of a JSON value (`!!v`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// One `parseUserTextWithBashIO` segment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Bash {
        command: String,
        stdout: String,
        stderr: String,
    },
}

/// `parseUserTextWithBashIO`: `BASH_IO_RE`'s blocks
/// (`<bash-input>…</bash-input>\n?<bash-stdout>…</bash-stdout>\n?<bash-stderr>…</bash-stderr>`,
/// lazy bodies) and the text between them. No text gives no segment.
pub fn bash_segments(raw: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut cursor = 0;
    let mut from = 0;
    while let Some(found) = next_bash_block(raw, from) {
        let (start, end, command, stdout, stderr) = found;
        if start > cursor {
            out.push(Segment::Text(raw[cursor..start].to_owned()));
        }
        out.push(Segment::Bash {
            command: command.to_owned(),
            stdout: stdout.to_owned(),
            stderr: stderr.to_owned(),
        });
        cursor = end;
        from = end;
    }
    if cursor < raw.len() {
        out.push(Segment::Text(raw[cursor..].to_owned()));
    }
    out
}

type Block<'a> = (usize, usize, &'a str, &'a str, &'a str);

/// The leftmost match of `BASH_IO_RE` at or after `from`: the regex tries
/// each `<bash-input>` in turn, and the lazy groups take the first closing
/// tag that lets the rest match.
fn next_bash_block(raw: &str, mut from: usize) -> Option<Block<'_>> {
    const IN: &str = "<bash-input>";
    while let Some(rel) = raw[from..].find(IN) {
        let start = from + rel;
        if let Some(found) = bash_block_at(raw, start) {
            return Some(found);
        }
        from = start + 1;
    }
    None
}

fn bash_block_at(raw: &str, start: usize) -> Option<Block<'_>> {
    let body = start + "<bash-input>".len();
    // Lazy `([\s\S]*?)</bash-input>`: try each closing tag in order.
    let mut search = body;
    while let Some(rel) = raw[search..].find("</bash-input>") {
        let cmd_end = search + rel;
        let after = cmd_end + "</bash-input>".len();
        if let Some((out_body, out_end, err_body, end)) = bash_tail(raw, after) {
            return Some((
                start,
                end,
                &raw[body..cmd_end],
                &raw[out_body..out_end],
                &raw[err_body..end - "</bash-stderr>".len()],
            ));
        }
        search = cmd_end + 1;
    }
    None
}

/// `\n?<bash-stdout>([\s\S]*?)</bash-stdout>\n?<bash-stderr>([\s\S]*?)</bash-stderr>`
/// at `at`: (stdout start, stdout end, stderr start, match end).
fn bash_tail(raw: &str, at: usize) -> Option<(usize, usize, usize, usize)> {
    for skip in [1, 0] {
        if skip == 1 && !raw[at..].starts_with('\n') {
            continue;
        }
        let open = at + skip;
        if !raw[open..].starts_with("<bash-stdout>") {
            continue;
        }
        let out_body = open + "<bash-stdout>".len();
        let mut search = out_body;
        while let Some(rel) = raw[search..].find("</bash-stdout>") {
            let out_end = search + rel;
            let after = out_end + "</bash-stdout>".len();
            if let Some((err_body, end)) = bash_stderr(raw, after) {
                return Some((out_body, out_end, err_body, end));
            }
            search = out_end + 1;
        }
    }
    None
}

fn bash_stderr(raw: &str, at: usize) -> Option<(usize, usize)> {
    for skip in [1, 0] {
        if skip == 1 && !raw[at..].starts_with('\n') {
            continue;
        }
        let open = at + skip;
        if !raw[open..].starts_with("<bash-stderr>") {
            continue;
        }
        let body = open + "<bash-stderr>".len();
        if let Some(rel) = raw[body..].find("</bash-stderr>") {
            return Some((body, body + rel + "</bash-stderr>".len()));
        }
    }
    None
}

/// `firstLine`: the first line with something besides whitespace, trimmed.
pub fn first_line(text: &str) -> &str {
    text.split('\n')
        .find(|l| !js_trim(l).is_empty())
        .map(js_trim)
        .unwrap_or("")
}

/// `peerMessagePreview`: `Message from <name>: <first line>`.
pub fn peer_preview(name: &str, body: &str) -> String {
    match first_line(body) {
        "" => format!("Message from {name}"),
        line => format!("Message from {name}: {line}"),
    }
}

/// `systemReminderTitle`: a short title from the reminder's first words.
pub fn system_reminder_title(body: &str) -> &'static str {
    let lead = body.trim_start_matches(is_js_space).to_lowercase();
    const TITLES: [(&str, &str); 8] = [
        ("the current to-do list", "Todos snapshot"),
        ("the todowrite tool hasn't", "TodoWrite idle"),
        ("the task tools haven't", "Task tools idle"),
        ("## re-entering plan mode", "Re-entering plan mode"),
        ("## exited auto mode", "Exited auto mode"),
        ("you have completed implementing the plan", "Verify plan"),
        ("the date has changed", "Date change"),
        ("memory", "Memory update"),
    ];
    TITLES
        .iter()
        .find(|(prefix, _)| lead.starts_with(prefix))
        .map_or("System reminder", |(_, title)| title)
}

/// `n.toLocaleString()` in en-US for an integer-valued count (grouped by
/// thousands); other values print as JS would.
pub fn locale_number(n: f64) -> String {
    if !n.is_finite() || n.fract() != 0.0 || n.abs() >= 1e21 {
        return claudius_core::js_num(n).to_string();
    }
    let digits = format!("{}", n.abs() as u128);
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0.0 {
        out.insert(0, '-');
    }
    out
}

/// `formatCompactStats`: `pre→post tokens · Ns`, the duration only from a
/// second up.
pub fn compact_stats(s: &claudius_client::CompactStats) -> Option<String> {
    let mut parts = Vec::new();
    if let (Some(pre), Some(post)) = (s.pre_tokens, s.post_tokens) {
        parts.push(format!(
            "{}→{} tokens",
            locale_number(pre),
            locale_number(post)
        ));
    }
    if let Some(ms) = s.duration_ms
        && ms >= 1000.0
    {
        // `Math.round` (half up).
        parts.push(format!("{}s", (ms / 1000.0 + 0.5).floor()));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// The user prompt as markdown for the native renderer: `<Markdown breaks
/// math={false}>`. gpui's parser has math on, so `$` is escaped outside
/// code; `remark-breaks` turns every soft line break into a hard one, so a
/// line that continues a paragraph gets a trailing backslash. Code fences,
/// inline code and blank lines are left as typed.
pub fn user_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut fence: Option<(char, usize)> = None;
    let lines: Vec<&str> = text.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let last = i + 1 == lines.len();
        if let Some((ch, n)) = fence {
            out.push_str(line);
            if fence_marker(line).is_some_and(|(c, m, info)| c == ch && m >= n && info.is_empty()) {
                fence = None;
            }
        } else if let Some((ch, n, _)) = fence_marker(line) {
            fence = Some((ch, n));
            out.push_str(line);
        } else {
            out.push_str(&escape_dollars(line));
            let next_is_prose = lines
                .get(i + 1)
                .is_some_and(|n| !js_trim(n).is_empty() && fence_marker(n).is_none());
            if !last && !js_trim(line).is_empty() && next_is_prose && !line.ends_with('\\') {
                out.push('\\');
            }
        }
        if !last {
            out.push('\n');
        }
    }
    out
}

/// A CommonMark fence opener / closer: up to 3 spaces, then 3+ backticks or
/// tildes; the marker, its length and the info string.
fn fence_marker(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = rest.chars().take_while(|c| *c == ch).count();
    if n < 3 {
        return None;
    }
    let info = rest[n..].trim();
    if ch == '`' && info.contains('`') {
        return None;
    }
    Some((ch, n, info))
}

/// `$` → `\$` outside inline code spans (a run of backticks up to the same
/// run), so no `$…$` / `$$` reads as math.
fn escape_dollars(line: &str) -> String {
    if !line.contains('$') {
        return line.to_owned();
    }
    let mut out = String::with_capacity(line.len() + 4);
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'`' => {
                let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
                let ticks = &line[i..i + run];
                let body = i + run;
                match find_closing_ticks(line, body, run) {
                    Some(close) => {
                        out.push_str(&line[i..close + run]);
                        i = close + run;
                    }
                    None => {
                        out.push_str(ticks);
                        i = body;
                    }
                }
            }
            b'\\' if i + 1 < bytes.len() => {
                let c = line[i + 1..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&line[i..i + 1 + c]);
                i += 1 + c;
            }
            b'$' => {
                out.push_str("\\$");
                i += 1;
            }
            _ => {
                let c = line[i..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&line[i..i + c]);
                i += c;
            }
        }
    }
    out
}

fn find_closing_ticks(line: &str, from: usize, run: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let n = bytes[i..].iter().take_while(|b| **b == b'`').count();
            if n == run {
                return Some(i);
            }
            i += n;
        } else {
            i += 1;
        }
    }
    None
}

/// Where a long text folds (U00a: a row's document is laid out in one
/// frame, so text past `cap` bytes waits behind "Show more"): the last line
/// break at or before `cap`, or `cap` itself (on a char boundary) when the
/// first line is longer. `None` when the text fits.
pub fn fold_cut(text: &str, cap: usize) -> Option<usize> {
    if text.len() <= cap {
        return None;
    }
    let mut cut = cap;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    Some(match text[..cut].rfind('\n') {
        Some(nl) if nl > 0 => nl,
        _ => cut,
    })
}

/// The folded prefix as markdown: `text[..cut]`, with a code fence the cut
/// left open closed again so the rest doesn't render as code.
pub fn folded_markdown(text: &str, cut: usize) -> String {
    let head = &text[..cut];
    let mut open: Option<(char, usize)> = None;
    for line in head.split('\n') {
        match (open, fence_marker(line)) {
            (None, Some((c, n, _))) => open = Some((c, n)),
            (Some((c, n)), Some((c2, m, info))) if c == c2 && m >= n && info.is_empty() => {
                open = None
            }
            _ => {}
        }
    }
    match open {
        Some((c, n)) => {
            let mut s = head.to_owned();
            s.push('\n');
            s.extend(std::iter::repeat_n(c, n));
            s
        }
        None => head.to_owned(),
    }
}

/// The `[Image #N]` ordinals in `text` (`TOKEN_RE`).
pub fn image_tokens(text: &str) -> Vec<u64> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("[Image #") {
        let after = &rest[at + "[Image #".len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after[digits..].starts_with(']') {
            if let Ok(n) = after[..digits].parse() {
                out.push(n);
            }
            rest = &after[digits + 1..];
        } else {
            rest = after;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_text_is_one_text_segment_and_empty_text_none() {
        assert_eq!(bash_segments("hi"), [Segment::Text("hi".into())]);
        assert!(bash_segments("").is_empty());
    }

    #[test]
    fn bash_blocks_split_out_of_the_text() {
        let raw = "before<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>after";
        assert_eq!(
            bash_segments(raw),
            [
                Segment::Text("before".into()),
                Segment::Bash {
                    command: "ls".into(),
                    stdout: "a\nb".into(),
                    stderr: String::new()
                },
                Segment::Text("after".into()),
            ]
        );
    }

    #[test]
    fn a_bash_input_without_its_outputs_stays_text() {
        let raw = "<bash-input>ls</bash-input> and nothing";
        assert_eq!(bash_segments(raw), [Segment::Text(raw.into())]);
    }

    #[test]
    fn the_lazy_groups_take_the_first_closing_tags_that_complete_a_block() {
        let raw = "<bash-input>a</bash-input>x<bash-input>b</bash-input><bash-stdout>o</bash-stdout><bash-stderr>e</bash-stderr>";
        // The first `<bash-input>` has no stdout after its close, so the
        // regex's lazy group runs on to the next `</bash-input>`.
        assert_eq!(
            bash_segments(raw),
            [Segment::Bash {
                command: "a</bash-input>x<bash-input>b".into(),
                stdout: "o".into(),
                stderr: "e".into()
            }]
        );
    }

    #[test]
    fn peer_preview_uses_the_first_non_blank_line() {
        assert_eq!(
            peer_preview("@ana", "\n  \n  hello there \nmore"),
            "Message from @ana: hello there"
        );
        assert_eq!(peer_preview("@ana", " \n"), "Message from @ana");
    }

    #[test]
    fn reminder_titles_match_the_opening_words_case_insensitively() {
        assert_eq!(
            system_reminder_title("  The current to-do list is"),
            "Todos snapshot"
        );
        assert_eq!(
            system_reminder_title("## Re-entering Plan Mode"),
            "Re-entering plan mode"
        );
        assert_eq!(system_reminder_title("Memory: x"), "Memory update");
        assert_eq!(system_reminder_title("something else"), "System reminder");
    }

    #[test]
    fn compact_stats_group_thousands_and_drop_sub_second_durations() {
        let s = claudius_client::CompactStats {
            pre_tokens: Some(123456.0),
            post_tokens: Some(7890.0),
            duration_ms: Some(2500.0),
            trigger: None,
        };
        assert_eq!(
            compact_stats(&s).as_deref(),
            Some("123,456→7,890 tokens · 3s")
        );
        let quick = claudius_client::CompactStats {
            duration_ms: Some(999.0),
            ..Default::default()
        };
        assert_eq!(compact_stats(&quick), None);
        assert_eq!(locale_number(-1234567.0), "-1,234,567");
        assert_eq!(locale_number(1.5), "1.5");
    }

    #[test]
    fn user_markdown_keeps_line_breaks_and_dollars_but_not_inside_code() {
        assert_eq!(user_markdown("a\nb\n\nc"), "a\\\nb\n\nc");
        assert_eq!(
            user_markdown("costs $5 and $$x$$"),
            "costs \\$5 and \\$\\$x\\$\\$"
        );
        assert_eq!(user_markdown("`$HOME` ok"), "`$HOME` ok");
        assert_eq!(
            user_markdown("run\n```sh\necho $A\nls\n```\ndone"),
            "run\n```sh\necho $A\nls\n```\ndone"
        );
        assert_eq!(user_markdown("ends with \\\nnext"), "ends with \\\nnext");
    }

    #[test]
    fn fold_cut_prefers_a_line_break_and_respects_char_boundaries() {
        assert_eq!(fold_cut("short", 10), None);
        // Exactly the cap still fits: nothing hides behind "Show more".
        assert_eq!(fold_cut("0123456789", 10), None);
        assert_eq!(fold_cut("0123456789a", 10), Some(10));
        assert_eq!(fold_cut("aaaa\nbbbbbbbb", 8), Some(4));
        assert_eq!(fold_cut("ééééé", 3), Some(2));
    }

    #[test]
    fn a_fold_inside_a_code_fence_closes_it() {
        let text = "intro\n```rust\nfn a() {}\nfn b() {}\n```\n";
        let cut = text.find("fn b").unwrap() - 1;
        assert_eq!(folded_markdown(text, cut), "intro\n```rust\nfn a() {}\n```");
        assert_eq!(folded_markdown("a\nb", 1), "a");
    }

    #[test]
    fn image_tokens_read_the_ordinals() {
        assert_eq!(
            image_tokens("see [Image #1] and [Image #12] not [Image #x]"),
            [1, 12]
        );
    }

    #[test]
    fn truthiness_is_js() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("x"))));
        assert!(truthy(Some(&json!([]))));
    }
}
