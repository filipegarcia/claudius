//! session.ts `sendInput()`'s reads of the input itself (S29), over the
//! values as the `input` route's body holds them:
//!
//! * the slash command's name and args (`text.trim().split(/\s+/, 1)[0]`,
//!   JS whitespace, so a BOM separates and a NEL doesn't; whitespace-only
//!   text names the command `""`);
//! * the image branch: which `images` take it (`!images || images.length
//!   === 0` is the text branch, so `[]`, `""`, `0` and `{length: 0}` send
//!   text), the `[Image #n]` tokens (ASCII digits read with `Number`, so
//!   `#03` is image 3 and a fraction never matches) each inlining its image
//!   once, the images with no numeric `ordinal` appended (one per code point
//!   of a string `images`), and the TypeErrors V8 throws for a `null`
//!   element or an `images` that isn't iterable, which TS throws after the
//!   turn was marked running;
//! * a `text` that isn't a string (posted beside images), which throws at
//!   the first string method called on it, also after the turn was marked
//!   running (S29a). The posted `uuid` is carried as it is, of any type
//!   ([`uuid_or_new`]).

use std::collections::HashMap;
use std::sync::LazyLock;

use claudius_agent::js;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::Session;
use crate::queue_db::ImageInput;

/// `/\[Image #(\d+)\]/g` (`\d` is ASCII without the `u` flag).
static IMAGE_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[Image #([0-9]+)\]").unwrap());

/// `text` where `sendInput` first calls a string method on it (`trim` for
/// a slash send, else `toLowerCase` in the ultrathink scan). The route
/// passes any posted `text` beside images; a non-string throws there, after
/// the turn was marked running (S29a).
pub(super) fn text_str<'a>(text: &'a Value, method: &str) -> Result<&'a str, String> {
    text.as_str()
        .ok_or_else(|| format!("TypeError: text.{method} is not a function"))
}

/// `opts.uuid ?? randomUUID()` (`sendInput`, `enqueueMessage`): the uuid
/// the caller passed, of any JS type (the `input` route forwards the posted
/// one, and a queued row whose uuid is NULL reads back `null`; S29a), else
/// a fresh v4.
pub(super) fn uuid_or_new(uuid: Option<Value>) -> Value {
    match uuid {
        None | Some(Value::Null) => json!(uuid::Uuid::new_v4().to_string()),
        Some(u) => u,
    }
}

/// `[command, args]` of a slash send.
pub(super) fn slash_parts(text: &str) -> (String, String) {
    let t = js::trim(text);
    let command = t.split(js::is_whitespace).next().unwrap_or("");
    (command.to_owned(), js::trim(&t[command.len()..]).to_owned())
}

/// `images` as `sendInput` receives them from a typed caller.
pub(super) fn image_values(images: &[ImageInput]) -> Option<Value> {
    (!images.is_empty()).then(|| {
        Value::Array(
            images
                .iter()
                .map(|i| serde_json::to_value(i).unwrap_or(Value::Null))
                .collect(),
        )
    })
}

/// `!images || images.length === 0`.
fn text_only(images: Option<&Value>) -> bool {
    match images {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Array(a)) => a.is_empty(),
        Some(Value::Object(o)) => o.get("length").and_then(Value::as_f64) == Some(0.0),
        Some(Value::Bool(true)) => false,
    }
}

/// `img.<key>` on a parsed JSON value (`undefined` off a non-object).
fn prop<'a>(img: &'a Value, key: &str) -> Option<&'a Value> {
    img.as_object().and_then(|o| o.get(key))
}

/// `typeof img.ordinal === "number"`.
fn ordinal(img: &Value) -> Option<f64> {
    prop(img, "ordinal").and_then(Value::as_f64)
}

/// `{type: "image", source: {type: "base64", media_type, data}}`, an
/// `undefined` field left out as `JSON.stringify` does.
fn image_block(media_type: Option<&Value>, data: Option<&Value>) -> Value {
    let mut source = Map::new();
    source.insert("type".into(), json!("base64"));
    if let Some(m) = media_type {
        source.insert("media_type".into(), m.clone());
    }
    if let Some(d) = data {
        source.insert("data".into(), d.clone());
    }
    json!({"type": "image", "source": source})
}

/// The image branch's content blocks, or `None` for the text branch. `Err`
/// is the TypeError V8 throws.
pub(super) fn image_content(
    text: &str,
    images: Option<&Value>,
) -> Result<Option<Vec<Value>>, String> {
    if text_only(images) {
        return Ok(None);
    }
    // `for (const img of images)`: an array's elements, a string's code points.
    let elements: Vec<Value> = match images {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s.chars().map(|c| json!(c.to_string())).collect(),
        _ => return Err("TypeError: images is not iterable".into()),
    };
    // `byOrdinal` (a Map: SameValueZero keys, so -0 is 0).
    let mut by_ordinal: HashMap<u64, (Option<&Value>, Option<&Value>)> = HashMap::new();
    for img in &elements {
        if img.is_null() {
            return Err("TypeError: Cannot read properties of null (reading 'ordinal')".into());
        }
        if let Some(o) = ordinal(img) {
            by_ordinal.insert(
                (o + 0.0).to_bits(),
                (prop(img, "mediaType"), prop(img, "data")),
            );
        }
    }
    let mut content = Vec::new();
    let mut cursor = 0;
    for m in IMAGE_TOKEN.captures_iter(text) {
        let ord = js::to_number(&m[1]) + 0.0;
        // An unknown token stays literal text; a used one doesn't repeat.
        let Some((media_type, data)) = by_ordinal.remove(&ord.to_bits()) else {
            continue;
        };
        let whole = m.get(0).unwrap();
        if whole.start() > cursor {
            content.push(json!({"type": "text", "text": &text[cursor..whole.start()]}));
        }
        content.push(image_block(media_type, data));
        cursor = whole.end();
    }
    if cursor < text.len() {
        content.push(json!({"type": "text", "text": &text[cursor..]}));
    }
    for img in elements.iter().filter(|i| ordinal(i).is_none()) {
        content.push(image_block(prop(img, "mediaType"), prop(img, "data")));
    }
    Ok(Some(content))
}

impl Session {
    /// The local date the next send compares today against
    /// (`lastSeenLocalDate`), as if the session had last sent on `key`
    /// (tests: a send after midnight).
    pub fn set_last_seen_local_date(&self, key: &str) {
        self.with(|st| st.last_seen_local_date = Some(key.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_parts_read_js_whitespace() {
        assert_eq!(
            slash_parts("  /compact keep it "),
            ("/compact".into(), "keep it".into())
        );
        assert_eq!(
            slash_parts("\u{feff}/a\u{85}b\u{a0} c "),
            ("/a\u{85}b".into(), "c".into())
        );
        assert_eq!(slash_parts("  "), (String::new(), String::new()));
        assert_eq!(slash_parts(""), (String::new(), String::new()));
        assert_eq!(slash_parts("/x\u{3000}y\tz"), ("/x".into(), "y\tz".into()));
    }

    #[test]
    fn text_only_follows_js_falsiness_and_length() {
        for v in [
            json!(null),
            json!(false),
            json!(0),
            json!(-0.0),
            json!(""),
            json!([]),
            json!({"length": 0}),
        ] {
            assert!(text_only(Some(&v)), "{v}");
        }
        assert!(text_only(None));
        for v in [
            json!(true),
            json!(5),
            json!("a"),
            json!([1]),
            json!({}),
            json!({"length": "0"}),
        ] {
            assert!(!text_only(Some(&v)), "{v}");
        }
    }

    #[test]
    fn image_content_inlines_each_ordinal_once() {
        let imgs = json!([
            {"data": "A", "mediaType": "image/png", "ordinal": 1},
            {"data": "B", "mediaType": "image/gif", "ordinal": -0.0},
            {"data": "C", "mediaType": "image/gif", "ordinal": 1.5},
            {"data": "D", "mediaType": "image/gif"},
        ]);
        let c = image_content(
            "[Image #01] [Image #1] [Image #0] [Image #1.5]",
            Some(&imgs),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            Value::Array(c),
            json!([
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "A"}},
                {"type": "text", "text": " [Image #1] "},
                {"type": "image", "source": {"type": "base64", "media_type": "image/gif", "data": "B"}},
                {"type": "text", "text": " [Image #1.5]"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/gif", "data": "D"}},
            ])
        );
    }

    #[test]
    fn image_content_throws_where_v8_does() {
        assert_eq!(
            image_content("x", Some(&json!(5))),
            Err("TypeError: images is not iterable".into())
        );
        assert_eq!(
            image_content("x", Some(&json!([{"ordinal": 1}, null]))),
            Err("TypeError: Cannot read properties of null (reading 'ordinal')".into())
        );
        let c = image_content("", Some(&json!("a\u{1f600}")))
            .unwrap()
            .unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[1], json!({"type": "image", "source": {"type": "base64"}}));
    }

    #[test]
    fn a_text_that_isnt_a_string_throws_at_its_method() {
        assert_eq!(text_str(&json!("a"), "trim"), Ok("a"));
        assert_eq!(text_str(&json!(""), "trim"), Ok(""));
        for v in [json!(5), json!(["a"]), json!({}), json!(true), json!(null)] {
            assert_eq!(
                text_str(&v, "toLowerCase"),
                Err("TypeError: text.toLowerCase is not a function".into()),
                "{v}"
            );
        }
        assert_eq!(
            text_str(&json!(0), "trim"),
            Err("TypeError: text.trim is not a function".into())
        );
    }

    #[test]
    fn uuid_or_new_keeps_any_value_but_nullish() {
        for v in [
            json!(7),
            json!(""),
            json!(false),
            json!({"a": 1}),
            json!([null]),
            json!("u"),
        ] {
            assert_eq!(uuid_or_new(Some(v.clone())), v);
        }
        for u in [uuid_or_new(None), uuid_or_new(Some(Value::Null))] {
            let u = uuid::Uuid::parse_str(u.as_str().unwrap()).unwrap();
            assert_eq!(u.get_version_num(), 4);
        }
        assert_ne!(uuid_or_new(None), uuid_or_new(None));
    }
}
