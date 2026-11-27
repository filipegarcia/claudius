//! The `:shortcode:` emoji picker's pure half: `lib/shared/emoji-shortcodes.ts`
//! (the table and its aliases, `parseEmojiTrigger`, `filterEmojiShortcodes`,
//! `lookupEmojiShortcode`), `PromptInput.tsx`'s `insertEmojiShortcode`
//! splice and its type-the-closing-`:` auto-complete, and
//! `useEmojiCompletionEnabled`'s settings read. Replayed against the TS by
//! `tests/composer_pickers_golden.rs`.

use claudius_core::collate::locale_compare;
use serde_json::Value;

use crate::slash::splice_token;

/// `EMOJI_SHORTCODES` (emoji-shortcodes.ts:20), in `Object.entries` order
/// (the integer-like `"100"` first). Every key is lowercase.
pub const EMOJI_SHORTCODES: &[(&str, &str)] = &[
    ("100", "\u{1f4af}"),
    ("smile", "\u{1f604}"),
    ("smiley", "\u{1f603}"),
    ("grin", "\u{1f601}"),
    ("laughing", "\u{1f606}"),
    ("joy", "\u{1f602}"),
    ("rofl", "\u{1f923}"),
    ("slightly_smiling_face", "\u{1f642}"),
    ("wink", "\u{1f609}"),
    ("blush", "\u{1f60a}"),
    ("innocent", "\u{1f607}"),
    ("relaxed", "\u{263a}\u{fe0f}"),
    ("heart_eyes", "\u{1f60d}"),
    ("kissing_heart", "\u{1f618}"),
    ("thinking", "\u{1f914}"),
    ("neutral_face", "\u{1f610}"),
    ("expressionless", "\u{1f611}"),
    ("no_mouth", "\u{1f636}"),
    ("smirk", "\u{1f60f}"),
    ("unamused", "\u{1f612}"),
    ("roll_eyes", "\u{1f644}"),
    ("grimacing", "\u{1f62c}"),
    ("lying_face", "\u{1f925}"),
    ("relieved", "\u{1f60c}"),
    ("pensive", "\u{1f614}"),
    ("sleepy", "\u{1f62a}"),
    ("sleeping", "\u{1f634}"),
    ("mask", "\u{1f637}"),
    ("sunglasses", "\u{1f60e}"),
    ("nerd_face", "\u{1f913}"),
    ("confused", "\u{1f615}"),
    ("worried", "\u{1f61f}"),
    ("slightly_frowning_face", "\u{1f641}"),
    ("frowning", "\u{2639}\u{fe0f}"),
    ("persevere", "\u{1f623}"),
    ("confounded", "\u{1f616}"),
    ("tired_face", "\u{1f62b}"),
    ("weary", "\u{1f629}"),
    ("cry", "\u{1f622}"),
    ("sob", "\u{1f62d}"),
    ("triumph", "\u{1f624}"),
    ("angry", "\u{1f620}"),
    ("rage", "\u{1f621}"),
    ("scream", "\u{1f631}"),
    ("fearful", "\u{1f628}"),
    ("cold_sweat", "\u{1f630}"),
    ("astonished", "\u{1f632}"),
    ("flushed", "\u{1f633}"),
    ("dizzy_face", "\u{1f635}"),
    ("exploding_head", "\u{1f92f}"),
    ("zany_face", "\u{1f92a}"),
    ("hugs", "\u{1f917}"),
    ("shushing_face", "\u{1f92b}"),
    ("eyes", "\u{1f440}"),
    ("eye", "\u{1f441}\u{fe0f}"),
    ("see_no_evil", "\u{1f648}"),
    ("hear_no_evil", "\u{1f649}"),
    ("speak_no_evil", "\u{1f64a}"),
    ("poop", "\u{1f4a9}"),
    ("clown_face", "\u{1f921}"),
    ("skull", "\u{1f480}"),
    ("ghost", "\u{1f47b}"),
    ("alien", "\u{1f47d}"),
    ("robot", "\u{1f916}"),
    ("heart", "\u{2764}\u{fe0f}"),
    ("orange_heart", "\u{1f9e1}"),
    ("yellow_heart", "\u{1f49b}"),
    ("green_heart", "\u{1f49a}"),
    ("blue_heart", "\u{1f499}"),
    ("purple_heart", "\u{1f49c}"),
    ("black_heart", "\u{1f5a4}"),
    ("broken_heart", "\u{1f494}"),
    ("two_hearts", "\u{1f495}"),
    ("sparkling_heart", "\u{1f496}"),
    ("heartbeat", "\u{1f493}"),
    ("heartpulse", "\u{1f497}"),
    ("cupid", "\u{1f498}"),
    ("sparkles", "\u{2728}"),
    ("star", "\u{2b50}"),
    ("star2", "\u{1f31f}"),
    ("boom", "\u{1f4a5}"),
    ("fire", "\u{1f525}"),
    ("zap", "\u{26a1}"),
    ("dizzy", "\u{1f4ab}"),
    ("thumbsup", "\u{1f44d}"),
    ("+1", "\u{1f44d}"),
    ("thumbsdown", "\u{1f44e}"),
    ("-1", "\u{1f44e}"),
    ("clap", "\u{1f44f}"),
    ("wave", "\u{1f44b}"),
    ("raised_hands", "\u{1f64c}"),
    ("pray", "\u{1f64f}"),
    ("muscle", "\u{1f4aa}"),
    ("ok_hand", "\u{1f44c}"),
    ("v", "\u{270c}\u{fe0f}"),
    ("crossed_fingers", "\u{1f91e}"),
    ("point_up", "\u{261d}\u{fe0f}"),
    ("point_down", "\u{1f447}"),
    ("point_left", "\u{1f448}"),
    ("point_right", "\u{1f449}"),
    ("handshake", "\u{1f91d}"),
    ("writing_hand", "\u{270d}\u{fe0f}"),
    ("raised_hand", "\u{270b}"),
    ("facepunch", "\u{1f44a}"),
    ("fist", "\u{270a}"),
    ("rocket", "\u{1f680}"),
    ("tada", "\u{1f389}"),
    ("confetti_ball", "\u{1f38a}"),
    ("balloon", "\u{1f388}"),
    ("gift", "\u{1f381}"),
    ("trophy", "\u{1f3c6}"),
    ("medal", "\u{1f3c5}"),
    ("checkered_flag", "\u{1f3c1}"),
    ("warning", "\u{26a0}\u{fe0f}"),
    ("no_entry", "\u{26d4}"),
    ("x", "\u{274c}"),
    ("white_check_mark", "\u{2705}"),
    ("heavy_check_mark", "\u{2714}\u{fe0f}"),
    ("question", "\u{2753}"),
    ("exclamation", "\u{2757}"),
    ("bulb", "\u{1f4a1}"),
    ("bug", "\u{1f41b}"),
    ("wrench", "\u{1f527}"),
    ("hammer", "\u{1f528}"),
    ("gear", "\u{2699}\u{fe0f}"),
    ("lock", "\u{1f512}"),
    ("unlock", "\u{1f513}"),
    ("key", "\u{1f511}"),
    ("mag", "\u{1f50d}"),
    ("bookmark", "\u{1f516}"),
    ("memo", "\u{1f4dd}"),
    ("pencil2", "\u{270f}\u{fe0f}"),
    ("computer", "\u{1f4bb}"),
    ("keyboard", "\u{2328}\u{fe0f}"),
    ("package", "\u{1f4e6}"),
    ("incoming_envelope", "\u{1f4e8}"),
    ("email", "\u{2709}\u{fe0f}"),
    ("calendar", "\u{1f4c5}"),
    ("hourglass", "\u{23f3}"),
    ("alarm_clock", "\u{23f0}"),
    ("stopwatch", "\u{23f1}\u{fe0f}"),
    ("coffee", "\u{2615}"),
    ("pizza", "\u{1f355}"),
    ("hamburger", "\u{1f354}"),
    ("beer", "\u{1f37a}"),
    ("tada2", "\u{1f38a}"),
    ("moon", "\u{1f319}"),
    ("sun", "\u{2600}\u{fe0f}"),
    ("cloud", "\u{2601}\u{fe0f}"),
    ("rainbow", "\u{1f308}"),
    ("snowflake", "\u{2744}\u{fe0f}"),
    ("dog", "\u{1f436}"),
    ("cat", "\u{1f431}"),
    ("monkey", "\u{1f412}"),
    ("unicorn", "\u{1f984}"),
    ("turtle", "\u{1f422}"),
    ("octopus", "\u{1f419}"),
    ("seedling", "\u{1f331}"),
    ("tree", "\u{1f333}"),
    ("palm_tree", "\u{1f334}"),
    ("four_leaf_clover", "\u{1f340}"),
    ("earth_americas", "\u{1f30e}"),
    ("globe_with_meridians", "\u{1f310}"),
    ("car", "\u{1f697}"),
    ("airplane", "\u{2708}\u{fe0f}"),
    ("house", "\u{1f3e0}"),
    ("office", "\u{1f3e2}"),
    ("camera", "\u{1f4f7}"),
    ("telephone", "\u{260e}\u{fe0f}"),
    ("loudspeaker", "\u{1f4e2}"),
    ("bell", "\u{1f514}"),
    ("no_bell", "\u{1f515}"),
    ("recycle", "\u{267b}\u{fe0f}"),
    ("infinity", "\u{267e}\u{fe0f}"),
    ("arrows_counterclockwise", "\u{1f504}"),
    ("arrow_right", "\u{27a1}\u{fe0f}"),
    ("arrow_left", "\u{2b05}\u{fe0f}"),
    ("arrow_up", "\u{2b06}\u{fe0f}"),
    ("arrow_down", "\u{2b07}\u{fe0f}"),
];
/// `EMOJI_ALIASES` (emoji-shortcodes.ts): alternate names, to a key of
/// [`EMOJI_SHORTCODES`].
pub const EMOJI_ALIASES: &[(&str, &str)] = &[
    ("love", "heart"),
    ("satisfied", "laughing"),
    ("collision", "boom"),
];

/// `EMOJI_PICKER_LIMIT` (emoji-shortcodes.ts).
pub const EMOJI_PICKER_LIMIT: usize = 30;
/// The header (EmojiShortcodePicker.tsx:85).
pub const HEADER: &str = "Emoji \u{b7} Tab to insert";

/// A shortcode name's character (`[a-zA-Z0-9_+-]`).
fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-')
}

/// The `:name` token ending `before`: `(^|\s):([a-zA-Z0-9_+-]*)$`, its
/// name and the byte offset of its `:`.
fn trigger(before: &str) -> Option<(usize, &str)> {
    let start = before
        .char_indices()
        .rev()
        .find(|(_, c)| crate::rules::is_js_space(*c))
        .map_or(0, |(i, c)| i + c.len_utf8());
    let name = before[start..].strip_prefix(':')?;
    name.chars().all(is_name_char).then_some((start, name))
}

/// `parseEmojiTrigger(before)` (emoji-shortcodes.ts): the still-open
/// `:name` before the caret, without its `:`.
pub fn parse_emoji_trigger(before: &str) -> Option<&str> {
    trigger(before).map(|(_, name)| name)
}

fn shortcode(name: &str) -> Option<&'static str> {
    EMOJI_SHORTCODES
        .iter()
        .find(|(k, _)| *k == name)
        .map(|(_, e)| *e)
}

/// `lookupEmojiShortcode(name)` (emoji-shortcodes.ts): the table, then the
/// aliases, case-insensitively. Own keys only: the TS's plain-object
/// lookup also "finds" `constructor` and `__proto__` (a function, an
/// object), which this doesn't.
pub fn lookup_emoji_shortcode(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if let Some(e) = shortcode(&lower) {
        return Some(e);
    }
    let canonical = EMOJI_ALIASES
        .iter()
        .find(|(k, _)| *k == lower)
        .map(|(_, c)| *c)?;
    shortcode(canonical)
}

/// `filterEmojiShortcodes(query)` (emoji-shortcodes.ts): the names (and
/// aliases) starting with the lowercased query, then those containing it,
/// each by `localeCompare`, at most [`EMOJI_PICKER_LIMIT`]; every row for
/// no query.
pub fn filter_emoji_shortcodes(query: &str) -> Vec<(&'static str, &'static str)> {
    let needle = query.to_lowercase();
    let aliases = EMOJI_ALIASES
        .iter()
        .filter_map(|(alias, canonical)| shortcode(canonical).map(|e| (*alias, e)));
    let mut starts = Vec::new();
    let mut contains = Vec::new();
    for (name, emoji) in EMOJI_SHORTCODES.iter().copied().chain(aliases) {
        if needle.is_empty() || name.starts_with(&needle) {
            starts.push((name, emoji));
        } else if name.contains(&needle) {
            contains.push((name, emoji));
        }
    }
    starts.sort_by(|a, b| locale_compare(a.0, b.0));
    contains.sort_by(|a, b| locale_compare(a.0, b.0));
    starts.extend(contains);
    starts.truncate(EMOJI_PICKER_LIMIT);
    starts
}

/// `insertEmojiShortcode(name)` (PromptInput.tsx:1637): the `:token`
/// before `caret` becomes `<emoji> `; the new text and the caret. `None`
/// for a name with no emoji (the TS returns early).
pub fn insert_emoji_shortcode(value: &str, caret: usize, name: &str) -> Option<(String, usize)> {
    let emoji = lookup_emoji_shortcode(name)?;
    Some(splice_token(
        value,
        caret,
        parse_emoji_trigger,
        &format!("{emoji} "),
    ))
}

/// The auto-complete on the closing `:` (PromptInput.tsx:2197): `next` is
/// `prev` plus one character, a `:` just before `caret`, closing a known
/// `:name` (`(^|\s):([a-zA-Z0-9_+-]+)$` before it). The whole `:name:`
/// becomes the emoji; the new text and the caret after the emoji.
pub fn complete_on_close(prev: &str, next: &str, caret: usize) -> Option<(String, usize)> {
    if crate::rules::utf16_len(next) != crate::rules::utf16_len(prev) + 1
        || caret == 0
        || caret > next.len()
        || next.as_bytes()[caret - 1] != b':'
    {
        return None;
    }
    let (start, name) = trigger(&next[..caret - 1])?;
    if name.is_empty() {
        return None;
    }
    let emoji = lookup_emoji_shortcode(name)?;
    let replaced = format!("{}{emoji}{}", &next[..start], &next[caret..]);
    Some((replaced, start + emoji.len()))
}

/// `useEmojiCompletionEnabled`'s request (`/api/settings?scope=user&cwd=…`).
pub fn settings_url(cwd: &str) -> String {
    format!(
        "/api/settings?scope=user&cwd={}",
        crate::rules::encode_uri_component(cwd)
    )
}

/// What an OK settings answer sets (`data.settings.emojiCompletionEnabled
/// !== false`), or `None` when the TS's read throws (no `settings`, a
/// `null` one, a body that isn't an object) and the setting stays.
pub fn emoji_enabled_of(data: &Value) -> Option<bool> {
    let settings = data.as_object()?.get("settings")?;
    match settings {
        Value::Null => None,
        Value::Object(o) => Some(o.get("emojiCompletionEnabled") != Some(&Value::Bool(false))),
        // A primitive's property is `undefined`.
        _ => Some(true),
    }
}

/// The header's count (EmojiShortcodePicker.tsx:87).
pub fn count_label(n: usize) -> String {
    format!("{n} match{}", if n == 1 { "" } else { "es" })
}

#[cfg(test)]
mod tests;
