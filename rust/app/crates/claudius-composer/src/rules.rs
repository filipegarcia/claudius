//! The pure TS helpers the composer calls, ported one for one (no regex is
//! compiled: each pattern is matched by hand, with JS `\s`, `\d`, `\b` and
//! `.` semantics). Replayed against the real TS by
//! `tests/composer_rules_golden.rs` (`rust/scripts/composer-rules-golden.mjs`).
//!
//! - `lib/shared/prompt-history.ts`: [`normalize_history_text`],
//!   [`build_prompt_history`], [`history_entry_index`].
//! - `lib/client/sendBash.ts`: [`command_needs_sudo`].
//! - `lib/client/cleared-draft.ts`: [`should_stash_cleared_draft`],
//!   [`can_restore_cleared_draft`], [`ordinal_floor_after_restore`].
//! - `lib/client/pending-draft.ts`: [`build_draft_flush_request`].
//! - `lib/client/send-outcome.ts`: [`send_delivery`], [`send_failed_notice`],
//!   [`place_failed_send`], [`merge_into_draft`].
//! - `lib/shared/markdown-list.ts`: [`compute_list_continuation`],
//!   [`is_list_line`], [`bullets_to_markdown`].
//! - `lib/shared/invisible-unicode.ts`: [`strip_invisible_unicode`],
//!   [`invisible_strip_needs_review`].
//! - `lib/client/key-match.ts`: [`is_letter_key`].
//! - `components/chat/PromptInput.tsx`: [`KEYWORD_HINTS`] /
//!   [`detected_hint`], [`queue_hint`], [`placeholder`].
//!
//! Strings are Rust strings; the one JS length the composer shows (the
//! footer's `N chars`) is [`utf16_len`].

use claudius_agent::js::{number_to_string, trim};
use claudius_client::AttachedImage;
use serde_json::{Map, Value, json};

/// `String.prototype.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// JS `\s` (`WhiteSpace` + `LineTerminator`).
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// A `LineTerminator`: what `.` doesn't match and `^` (with `m`) follows.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// A `\w` character (no `u` flag): `[A-Za-z0-9_]`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

// ------------------------------------------------------------------------
// prompt-history.ts

/// `normalizeHistoryText` (prompt-history.ts:34): drop every `[Image #N]`
/// token, collapse runs of two or more spaces, trim.
pub fn normalize_history_text(text: &str) -> String {
    let stripped = strip_image_tokens(text);
    let mut out = String::with_capacity(stripped.len());
    let mut run = 0usize;
    for c in stripped.chars() {
        if c == ' ' {
            run += 1;
            continue;
        }
        if run > 0 {
            out.push(' ');
            run = 0;
        }
        out.push(c);
    }
    if run > 0 {
        out.push(' ');
    }
    trim(&out).to_owned()
}

/// `text.replace(/\[Image #\d+\]/g, "")`.
fn strip_image_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("[Image #") {
        let after = &rest[at + "[Image #".len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after.as_bytes().get(digits) == Some(&b']') {
            out.push_str(&rest[..at]);
            rest = &after[digits + 1..];
        } else {
            out.push_str(&rest[..at + 1]);
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    out
}

/// A prompt the user sent (`SentPromptEntry`).
#[derive(Clone, Debug, PartialEq)]
pub struct SentPrompt {
    pub text: String,
    pub at: Option<f64>,
}

/// A queued message pulled back into the composer (`LiftedPromptEntry`).
#[derive(Clone, Debug, PartialEq)]
pub struct LiftedPrompt {
    pub text: String,
    pub at: f64,
}

/// `buildPromptHistory` (prompt-history.ts:49): oldest → newest; each lift
/// slotted in before the first dated sent prompt observed after it;
/// empties dropped, consecutive duplicates collapsed.
pub fn build_prompt_history(sent: &[SentPrompt], lifted: &[LiftedPrompt]) -> Vec<String> {
    let mut pending: Vec<&LiftedPrompt> = lifted.iter().collect();
    // `[...lifted].sort((a, b) => a.at - b.at)`: a stable sort, a NaN
    // difference reading as equal.
    pending.sort_by(|a, b| {
        let d = a.at - b.at;
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let mut li = 0;
    let mut out: Vec<String> = Vec::new();
    let push = |raw: &str, out: &mut Vec<String>| {
        let text = normalize_history_text(raw);
        if text.is_empty() || out.last() == Some(&text) {
            return;
        }
        out.push(text);
    };
    for s in sent {
        if let Some(at) = s.at {
            while li < pending.len() && pending[li].at < at {
                push(&pending[li].text, &mut out);
                li += 1;
            }
        }
        push(&s.text, &mut out);
    }
    while li < pending.len() {
        push(&pending[li].text, &mut out);
        li += 1;
    }
    out
}

/// `historyEntryIndex` (prompt-history.ts:79): the newest entry, or the
/// one before it when the draft already holds the newest.
pub fn history_entry_index(history: &[String], draft: &str) -> Option<usize> {
    let last = history.len().checked_sub(1)?;
    if history[last] == normalize_history_text(draft) && last > 0 {
        return Some(last - 1);
    }
    Some(last)
}

// ------------------------------------------------------------------------
// sendBash.ts

/// `commandNeedsSudo` (sendBash.ts:37): the trimmed command matches
/// `/^sudo\b/`.
pub fn command_needs_sudo(command: &str) -> bool {
    let trimmed = trim(command);
    match trimmed.strip_prefix("sudo") {
        Some(rest) => !rest.chars().next().is_some_and(is_word),
        None => false,
    }
}

// ------------------------------------------------------------------------
// cleared-draft.ts

/// `shouldStashClearedDraft` (cleared-draft.ts:12).
pub fn should_stash_cleared_draft(text: &str, image_count: usize) -> bool {
    !text.is_empty() || image_count > 0
}

/// `canRestoreClearedDraft`'s argument.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RestoreGate<'a> {
    pub value: &'a str,
    pub image_count: usize,
    pub picker_open: bool,
    pub at_active: bool,
    pub emoji_active: bool,
    pub browsing_history: bool,
    pub has_stash: bool,
}

/// `canRestoreClearedDraft` (cleared-draft.ts:21).
pub fn can_restore_cleared_draft(s: &RestoreGate<'_>) -> bool {
    s.value.is_empty()
        && s.image_count == 0
        && !s.picker_open
        && !s.at_active
        && !s.emoji_active
        && !s.browsing_history
        && s.has_stash
}

/// `ordinalFloorAfterRestore` (cleared-draft.ts:68).
pub fn ordinal_floor_after_restore(counter: f64, images: &[AttachedImage]) -> f64 {
    images.iter().fold(counter, |m, im| js_max(m, im.ordinal))
}

/// `Math.max(a, b)`: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

// ------------------------------------------------------------------------
// pending-draft.ts

/// `KEEPALIVE_BODY_LIMIT` (pending-draft.ts:38).
pub const KEEPALIVE_BODY_LIMIT: usize = 60 * 1024;

/// The newest composer state not yet PUT (`PendingDraft`).
#[derive(Clone, Debug, PartialEq)]
pub struct PendingDraft {
    pub session_id: String,
    pub text: String,
    pub images: Vec<AttachedImage>,
}

/// The `{ url, init }` `buildDraftFlushRequest` builds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftFlush {
    pub url: String,
    pub method: &'static str,
    pub body: String,
    pub keepalive: bool,
}

/// `JSON.stringify({ text, images })` of a draft.
pub fn draft_body(text: &str, images: &[AttachedImage]) -> String {
    let mut m = Map::new();
    m.insert("text".into(), json!(text));
    m.insert(
        "images".into(),
        serde_json::to_value(images).expect("images serialize"),
    );
    Value::Object(m).to_string()
}

/// `buildDraftFlushRequest` (pending-draft.ts:53).
pub fn build_draft_flush_request(
    pending: Option<&PendingDraft>,
    unloading: bool,
) -> Option<DraftFlush> {
    let pending = pending.filter(|p| !p.session_id.is_empty())?;
    let body = draft_body(&pending.text, &pending.images);
    let keepalive = unloading && body.len() <= KEEPALIVE_BODY_LIMIT;
    Some(DraftFlush {
        url: format!("/api/sessions/{}/prompt-draft", pending.session_id),
        method: "PUT",
        body,
        keepalive,
    })
}

// ------------------------------------------------------------------------
// send-outcome.ts

/// `SendDelivery`: `Ok(())` delivered, `Err(error)` not.
pub type Delivery = Result<(), String>;

/// `sendOutcome` / `toDelivery` (send-outcome.ts:31, :44) of a settled
/// value: `false` is `"unknown"`; an object with `ok` is delivered unless
/// `ok === false`, then its non-empty string `error` (else `"unknown"`);
/// anything else (`undefined`, `true`, ...) is delivered. A rejected promise
/// is `"unknown"` too ([`undelivered`]).
pub fn send_delivery(v: &Value) -> Delivery {
    match v {
        Value::Bool(false) => undelivered(),
        Value::Object(o) if o.contains_key("ok") => {
            if o["ok"] != Value::Bool(false) {
                return Ok(());
            }
            match o.get("error") {
                Some(Value::String(e)) if !e.is_empty() => Err(e.clone()),
                _ => undelivered(),
            }
        }
        _ => Ok(()),
    }
}

/// `UNDELIVERED`.
pub fn undelivered() -> Delivery {
    Err("unknown".into())
}

/// Where a failed send's notice goes (`"restore"` / `"stash"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticePlacement {
    Restore,
    Stash,
}

/// `sendFailedNotice` (send-outcome.ts:58).
pub fn send_failed_notice(error: &str, placement: NoticePlacement) -> &'static str {
    match (error == "network", placement) {
        (true, NoticePlacement::Restore) => {
            "Couldn't reach Claudius \u{2014} your message is back in the box."
        }
        (true, NoticePlacement::Stash) => {
            "Couldn't reach Claudius \u{2014} your message wasn't sent. Press \u{2191} in an empty box to get it back."
        }
        (false, NoticePlacement::Restore) => "Message not sent \u{2014} it's back in the box.",
        (false, NoticePlacement::Stash) => {
            "Message not sent \u{2014} press \u{2191} in an empty box to get it back."
        }
    }
}

/// `FailedSendPlacement`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailedSendPlacement {
    Restore,
    Stash,
    SaveToOrigin,
}

/// `placeFailedSend` (send-outcome.ts:85). `origin` / `current` are the
/// session ids (`None` and `""` are both falsy for the origin).
pub fn place_failed_send(
    origin: Option<&str>,
    current: Option<&str>,
    current_text: &str,
    current_image_count: usize,
) -> FailedSendPlacement {
    if let Some(o) = origin.filter(|o| !o.is_empty())
        && Some(o) != current
    {
        return FailedSendPlacement::SaveToOrigin;
    }
    if current_text.is_empty() && current_image_count == 0 {
        FailedSendPlacement::Restore
    } else {
        FailedSendPlacement::Stash
    }
}

/// `[Image #N]` tokens of `text`: each match's byte range and `N`'s digits.
fn image_tokens(text: &str) -> Vec<(std::ops::Range<usize>, &str)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find("[Image #") {
        let at = from + rel;
        let digits_at = at + "[Image #".len();
        let digits = text[digits_at..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if digits > 0 && text.as_bytes().get(digits_at + digits) == Some(&b']') {
            let end = digits_at + digits + 1;
            out.push((at..end, &text[digits_at..digits_at + digits]));
            from = end;
        } else {
            from = at + 1;
        }
    }
    out
}

/// A number as a template literal prints it (`${n}`).
pub fn num_text(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        number_to_string(x)
    }
}

/// `Number(digits)`.
fn digits_number(d: &str) -> f64 {
    d.parse::<f64>().unwrap_or(f64::NAN)
}

/// `mergeIntoDraft` (send-outcome.ts:106): the sent message appended to the
/// session's draft, its images renumbered past the draft's highest ordinal
/// (images and `[Image #N]` tokens) and its own tokens rewritten to match.
pub fn merge_into_draft(
    current_text: &str,
    current_images: &[AttachedImage],
    sent_text: &str,
    sent_images: &[AttachedImage],
) -> (String, Vec<AttachedImage>) {
    if current_text.is_empty() && current_images.is_empty() {
        return (sent_text.to_owned(), sent_images.to_vec());
    }
    let mut offset = current_images
        .iter()
        .fold(0.0, |m, im| js_max(m, im.ordinal));
    for (_, n) in image_tokens(current_text) {
        offset = js_max(offset, digits_number(n));
    }
    let sent_ordinals: Vec<f64> = sent_images.iter().map(|im| im.ordinal).collect();
    // `Set.has` is SameValueZero: NaN finds NaN.
    let has = |n: f64| {
        sent_ordinals
            .iter()
            .any(|&o| o == n || (o.is_nan() && n.is_nan()))
    };
    let text = if offset == 0.0 {
        sent_text.to_owned()
    } else {
        let mut out = String::with_capacity(sent_text.len());
        let mut last = 0;
        for (range, n) in image_tokens(sent_text) {
            out.push_str(&sent_text[last..range.start]);
            let num = digits_number(n);
            if has(num) {
                out.push_str(&format!("[Image #{}]", num_text(num + offset)));
            } else {
                out.push_str(&sent_text[range.clone()]);
            }
            last = range.end;
        }
        out.push_str(&sent_text[last..]);
        out
    };
    let text = if current_text.is_empty() {
        text
    } else {
        format!("{current_text}\n{text}")
    };
    let mut images = current_images.to_vec();
    images.extend(sent_images.iter().map(|im| AttachedImage {
        ordinal: im.ordinal + offset,
        ..im.clone()
    }));
    (text, images)
}

// ------------------------------------------------------------------------
// markdown-list.ts

/// `BULLET_GLYPH` (markdown-list.ts:25).
pub const BULLET_GLYPH: char = '\u{2022}';

/// `ListContinuation` (markdown-list.ts:33).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListContinuation {
    /// An empty item: clear its marker.
    Empty,
    /// Insert `\n` + this.
    Next(String),
}

/// The leading `\s*` run of `s`, in bytes.
fn ws_prefix(s: &str) -> usize {
    s.char_indices()
        .find(|(_, c)| !is_js_space(*c))
        .map_or(s.len(), |(i, _)| i)
}

/// `(\s+)(.*)$` on `rest`: `Some(content)` when at least one whitespace
/// leads and what follows the (greedy) whitespace run holds no line
/// terminator.
fn ws_then_line(rest: &str) -> Option<&str> {
    let ws = ws_prefix(rest);
    if ws == 0 {
        return None;
    }
    let content = &rest[ws..];
    (!content.chars().any(is_line_terminator)).then_some(content)
}

/// `/^(\s*)(- \[[ xX]\])(\s+)(.*)$/`'s marker: the rest after `- [?]`.
fn checkbox_marker(s: &str) -> Option<&str> {
    let rest = s.strip_prefix("- [")?;
    let mut it = rest.chars();
    matches!(it.next(), Some(' ' | 'x' | 'X')).then_some(())?;
    it.as_str().strip_prefix(']')
}

/// `/^(\s*)(\d+)\.(\s+)/`'s marker: the digits and the rest after the `.`.
fn number_marker(s: &str) -> Option<(&str, &str)> {
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = s[digits..].strip_prefix('.')?;
    Some((&s[..digits], rest))
}

/// `[•*\-]`: the marker char and the rest.
fn bullet_marker(s: &str) -> Option<(char, &str)> {
    let c = s.chars().next()?;
    matches!(c, '\u{2022}' | '*' | '-').then(|| (c, &s[c.len_utf8()..]))
}

/// `computeListContinuation` (markdown-list.ts:44): checkbox first, then
/// numbered, then bullet; `None` when the line is no list item.
pub fn compute_list_continuation(line: &str) -> Option<ListContinuation> {
    let ws = ws_prefix(line);
    let (indent, body) = line.split_at(ws);
    let item = |content: &str, next: String| {
        Some(if trim(content).is_empty() {
            ListContinuation::Empty
        } else {
            ListContinuation::Next(next)
        })
    };
    if let Some(content) = checkbox_marker(body).and_then(ws_then_line) {
        return item(content, format!("{indent}- [ ] "));
    }
    if let Some((n, rest)) = number_marker(body)
        && let Some(content) = ws_then_line(rest)
    {
        let next = num_text(digits_number(n) + 1.0);
        return item(content, format!("{indent}{next}. "));
    }
    if let Some((marker, rest)) = bullet_marker(body)
        && let Some(content) = ws_then_line(rest)
    {
        return item(content, format!("{indent}{marker} "));
    }
    None
}

/// `isListLine` (markdown-list.ts:71): a list marker followed by
/// whitespace (the checkbox alternative is covered by the `-` one).
pub fn is_list_line(line: &str) -> bool {
    let body = &line[ws_prefix(line)..];
    let ws_follows = |rest: &str| rest.chars().next().is_some_and(is_js_space);
    if let Some(rest) = checkbox_marker(body)
        && ws_follows(rest)
    {
        return true;
    }
    if let Some((_, rest)) = number_marker(body)
        && ws_follows(rest)
    {
        return true;
    }
    bullet_marker(body).is_some_and(|(_, rest)| ws_follows(rest))
}

/// `bulletsToMarkdown` (markdown-list.ts:80): `/^(\s*)• /gm` → `$1* `. A
/// `• ` converts when the whitespace run before it reaches back to the
/// start of the text or holds a line terminator (`^` after it, `\s*`
/// spanning it).
pub fn bullets_to_markdown(text: &str) -> String {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = String::with_capacity(text.len());
    for (k, &(_, c)) in chars.iter().enumerate() {
        let is_bullet = c == BULLET_GLYPH && chars.get(k + 1).map(|p| p.1) == Some(' ') && {
            let mut j = k;
            let mut ok = false;
            loop {
                if j == 0 {
                    ok = true;
                    break;
                }
                let prev = chars[j - 1].1;
                if !is_js_space(prev) {
                    break;
                }
                if is_line_terminator(prev) {
                    ok = true;
                    break;
                }
                j -= 1;
            }
            ok
        };
        out.push(if is_bullet { '*' } else { c });
    }
    out
}

// ------------------------------------------------------------------------
// invisible-unicode.ts

/// `INVISIBLE_UNICODE_RE` (invisible-unicode.ts:57).
pub fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'
            | '\u{2060}'
            | '\u{FEFF}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

/// `BIDI_CONTROL_RE`.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// `stripInvisibleUnicode`'s result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stripped {
    pub cleaned: String,
    pub removed_count: usize,
    pub bidi_count: usize,
}

/// `stripInvisibleUnicode` (invisible-unicode.ts:67).
pub fn strip_invisible_unicode(text: &str) -> Stripped {
    let mut removed_count = 0;
    let mut bidi_count = 0;
    let cleaned = text
        .chars()
        .filter(|&c| {
            if !is_invisible(c) {
                return true;
            }
            removed_count += 1;
            if is_bidi_control(c) {
                bidi_count += 1;
            }
            false
        })
        .collect();
    Stripped {
        cleaned,
        removed_count,
        bidi_count,
    }
}

/// `invisibleStripNeedsReview` (invisible-unicode.ts:100).
pub fn invisible_strip_needs_review(
    cleaned: &str,
    bidi_count: usize,
    has_attachments: bool,
) -> bool {
    let trimmed = trim(cleaned);
    if bidi_count > 0 {
        return true;
    }
    if trimmed.is_empty() {
        return !has_attachments;
    }
    trimmed.starts_with('/') || trimmed.starts_with('!')
}

/// The "removed N hidden character(s)" copy (PromptInput.tsx:1056, :1314);
/// `from_prompt` adds `from your prompt`, `review` the hold's tail.
pub fn hidden_chars_notice(removed: usize, from_prompt: bool, review: bool) -> String {
    let s = if removed == 1 { "" } else { "s" };
    let mut out = format!("Removed {removed} hidden character{s}");
    if from_prompt {
        out.push_str(" from your prompt");
    }
    if review {
        out.push_str(" \u{2014} review and press Send again.");
    }
    out
}

// ------------------------------------------------------------------------
// key-match.ts

/// `isLetterKey` (key-match.ts:18): a Latin letter the layout typed is
/// trusted; otherwise the physical key (`code`), unless Alt is down or an
/// IME is composing (`"Process"`).
pub fn is_letter_key(key: &str, code: &str, alt: bool, letter: char) -> bool {
    let want = letter.to_ascii_lowercase();
    let mut chars = key.chars();
    // `e.key.length === 1`: one UTF-16 unit.
    let typed = match (chars.next(), chars.next()) {
        (Some(c), None) if c.len_utf16() == 1 => js_lower_single(c),
        _ => None,
    };
    if let Some(t) = typed
        && t.is_ascii_lowercase()
    {
        return t == want;
    }
    if alt || key == "Process" {
        return false;
    }
    code == format!("Key{}", want.to_ascii_uppercase())
}

/// `c.toLowerCase()` when it stays one char (else no Latin letter anyway).
fn js_lower_single(c: char) -> Option<char> {
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(x), None) => Some(x),
        (Some(_), Some(_)) => Some('\u{0}'),
        _ => None,
    }
}

// ------------------------------------------------------------------------
// PromptInput.tsx

/// One `KEYWORD_HINTS` row (PromptInput.tsx:236).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeywordHint {
    pub id: &'static str,
    /// The pattern's word, matched as `\b<word>s?\b` case-insensitively.
    word: &'static str,
    pub label: &'static str,
    pub ignored_label: Option<&'static str>,
}

/// `KEYWORD_HINTS`, in order.
pub const KEYWORD_HINTS: [KeywordHint; 2] = [
    KeywordHint {
        id: "workflow",
        word: "workflow",
        label: "Dynamic workflow requested for this turn",
        ignored_label: Some("Workflow keyword ignored for this prompt"),
    },
    KeywordHint {
        id: "goal",
        word: "goal",
        label: "Goal mentioned \u{2014} set it as the session objective with /goal",
        ignored_label: None,
    },
];

impl KeywordHint {
    /// The TS pattern's source (its flags are `i`).
    pub fn source(&self) -> String {
        format!("\\b{}s?\\b", self.word)
    }

    /// `pattern.test(value)`: `/\b<word>s?\b/i`.
    pub fn matches(&self, value: &str) -> bool {
        let lower: Vec<char> = value.chars().map(ascii_fold).collect();
        let word: Vec<char> = self.word.chars().collect();
        let boundary = |i: usize| {
            let before = i.checked_sub(1).map(|j| lower[j]);
            let at = lower.get(i).copied();
            before.is_some_and(is_word) != at.is_some_and(is_word)
        };
        for start in 0..lower.len() {
            if !boundary(start) || lower[start..].len() < word.len() {
                continue;
            }
            if lower[start..start + word.len()] != word[..] {
                continue;
            }
            let end = start + word.len();
            // `s?` is greedy: try with the `s`, then without.
            if lower.get(end) == Some(&'s') && boundary(end + 1) {
                return true;
            }
            if boundary(end) {
                return true;
            }
        }
        false
    }
}

/// The case folding `/i` (no `u` flag) applies to these ASCII patterns:
/// `Canonicalize` never maps a non-ASCII char onto an ASCII one (the Kelvin
/// sign is not a `k` here), so only ASCII letters fold.
fn ascii_fold(c: char) -> char {
    c.to_ascii_lowercase()
}

/// The footer hint's state (PromptInput.tsx:1916).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintState {
    Active,
    Ignored,
}

/// `detectedHint` / `hintState` (PromptInput.tsx:1913): the first hint whose
/// word the draft has (none in `!` mode), and whether it was dismissed.
pub fn detected_hint(value: &str, dismissed: &[&str]) -> Option<(&'static KeywordHint, HintState)> {
    if value.starts_with('!') {
        return None;
    }
    let hint = KEYWORD_HINTS.iter().find(|h| h.matches(value))?;
    if dismissed.contains(&hint.id) {
        hint.ignored_label.map(|_| (hint, HintState::Ignored))
    } else {
        Some((hint, HintState::Active))
    }
}

/// `queueHint` (PromptInput.tsx:1929).
pub fn queue_hint(pending: bool, queued_count: usize) -> String {
    if !pending {
        String::new()
    } else if queued_count > 0 {
        format!("{queued_count} queued \u{b7} edit above")
    } else {
        "Send queues until current response finishes".into()
    }
}

/// The textarea's placeholder (PromptInput.tsx:2223), for a mounted
/// composer.
pub fn placeholder(ready: bool, pending: bool) -> &'static str {
    if !ready {
        "Starting session\u{2026}"
    } else if pending {
        "Queue a follow-up \u{2014} Shift+Enter for newline"
    } else {
        "Message Claudius \u{2014} / for commands, @ for files/agents, drop or paste images, ! for shell"
    }
}

/// The footer's Send-now link (PromptInput.tsx:2464).
pub const SEND_NOW_HINT: &str = "\u{b7} Ctrl+Enter to send now";

/// The queue strip's header (QueueIndicator.tsx:72), shown uppercase.
pub const QUEUE_HEADER: &str = "Queued \u{b7} sends after current response";

/// The queue strip's "Send all now" (QueueIndicator.tsx:81).
pub const SEND_ALL_NOW: &str = "Send all now";

/// `sdkQueuedTurns`' row (QueueIndicator.tsx:158).
pub fn sdk_queued_turns_label(n: f64) -> String {
    let unit = if n == 1.0 { "turn" } else { "turns" };
    format!("{} more {unit} sent \u{b7} runs automatically", num_text(n))
}

#[cfg(test)]
mod tests;
