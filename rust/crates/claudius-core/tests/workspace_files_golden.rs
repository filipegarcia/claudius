//! Replays the `pure` half of `fixtures/workspace_files_golden.json`,
//! recorded by `rust/scripts/workspace-files-golden.mjs` from the real
//! `lib/shared/text-encoding.ts` and V8's `String.prototype.toLowerCase`:
//! * `detect`: `detectTextEncoding` over byte strings (every single byte,
//!   every byte after a valid prefix, BOMs, the NUL probe's edge), then the
//!   content the files route's GET shows (`decodeText` / `decodePreview`);
//! * `forced`: `decodeText` with an encoding the sniff didn't pick (its
//!   throw), `previews`: `decodePreview` with each guess, `encode`:
//!   `encodeText`, `win1252`: the legacy preview of every byte;
//! * `lower`: every code point `toLowerCase` changes, and whole strings for
//!   Final_Sigma's context ([`js_string::to_lower`]);
//! * `exts` + `binary`: `lib/shared/file-types.ts`'s `BINARY_EXTS` in order
//!   and `isKnownBinaryPath` over each of them and the split's edges
//!   ([`claudius_core::file_types`], CC 2.1.301).
//!
//! The groups (the route on the real binary) replay in
//! `claudius-server/tests/workspace_files.rs`. Strings are compared as
//! `JSON.stringify` text ([`js_string::stringify`]).

use std::path::PathBuf;
use std::sync::OnceLock;

use claudius_agent::js;
use claudius_core::file_types;
use claudius_core::js_string;
use claudius_core::text_encoding::{
    Detected, Editable, Guess, decode_preview, decode_text, detect, encode_text,
};
use claudius_core::workspace_files::{
    ContentMatch, image_mime, inside, is_hidden, match_lines, matches_json, rel_path, under,
};
use serde_json::{Value, json};

fn pure() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/workspace_files_golden.json");
        let mut all = js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        all["pure"].take()
    })
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

/// A case's input: `hex`, or `gen` (`head` + `repeat` × `count` + `tail`).
fn input(case: &Value) -> Vec<u8> {
    if let Some(h) = case["hex"].as_str() {
        return unhex(h);
    }
    let g = &case["gen"];
    let mut h = g["head"].as_str().unwrap().to_owned();
    h.push_str(
        &g["repeat"]
            .as_str()
            .unwrap()
            .repeat(g["count"].as_u64().unwrap() as usize),
    );
    h.push_str(g["tail"].as_str().unwrap());
    unhex(&h)
}

fn editable(name: &str) -> Editable {
    match name {
        "utf-8" => Editable::Utf8,
        "utf-8-bom" => Editable::Utf8Bom,
        "utf-16le" => Editable::Utf16Le,
        other => panic!("not an editable encoding: {other}"),
    }
}

fn guess(name: &str) -> Guess {
    match name {
        "utf-16be" => Guess::Utf16Be,
        "utf-32" => Guess::Utf32,
        "binary" => Guess::Binary,
        "legacy" => Guess::Legacy,
        other => panic!("not a guess: {other}"),
    }
}

/// `DetectedTextEncoding` as the TS builds it (its key order).
fn detected_json(d: Detected) -> Value {
    match d {
        Detected::Editable(e) => {
            json!({"encoding": e.as_str(), "editable": true, "label": e.label()})
        }
        Detected::Unsupported(g) => json!({
            "encoding": "unsupported",
            "editable": false,
            "guess": g.as_str(),
            "label": g.label(),
            "reason": g.reason(),
        }),
    }
}

/// Decoded text is well formed, so a U+10F800-and-up character in it is
/// itself (not a lone-surrogate stand-in): plain `JSON.stringify`.
fn text(v: &Value) -> String {
    js::stringify(v)
}

fn content_json(r: Result<String, String>) -> Value {
    match r {
        Ok(s) => json!(s),
        Err(m) => json!({"threw": m}),
    }
}

#[test]
fn detect_and_decode_match_ts() {
    let cases = pure()["detect"].as_array().unwrap();
    assert!(cases.len() > 400);
    let mut bad = vec![];
    for case in cases {
        let bytes = input(case);
        let d = detect(&bytes);
        let content = match d {
            Detected::Editable(e) => content_json(decode_text(&bytes, e)),
            Detected::Unsupported(g) => json!(decode_preview(&bytes, g)),
        };
        // The route's pick.
        assert_eq!(
            content,
            json!(claudius_core::text_encoding::content(&bytes, d)),
            "{case}"
        );
        let got = json!({"detected": detected_json(d), "content": content});
        let want = json!({"detected": case["detected"], "content": case["content"]});
        if text(&got) != text(&want) {
            bad.push(format!(
                "{}\n  want {}\n  got  {}",
                case.get("hex").unwrap_or(&case["gen"]),
                text(&want),
                text(&got)
            ));
        }
    }
    assert!(bad.is_empty(), "{} differ:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn forced_decodes_and_previews_match_ts() {
    for case in pure()["forced"].as_array().unwrap() {
        let got = content_json(decode_text(
            &unhex(case["hex"].as_str().unwrap()),
            editable(case["encoding"].as_str().unwrap()),
        ));
        assert_eq!(text(&got), text(&case["content"]), "{case}");
    }
    for case in pure()["previews"].as_array().unwrap() {
        let got = decode_preview(
            &unhex(case["hex"].as_str().unwrap()),
            guess(case["guess"].as_str().unwrap()),
        );
        assert_eq!(text(&json!(got)), text(&case["content"]), "{case}");
    }
}

#[test]
fn encode_matches_ts() {
    let cases = pure()["encode"].as_array().unwrap();
    assert_eq!(cases.len(), 30);
    for case in cases {
        let units: Vec<u16> = unhex(case["units"].as_str().unwrap())
            .chunks(2)
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        let got = encode_text(&units, editable(case["encoding"].as_str().unwrap()));
        assert_eq!(hex(&got), case["hex"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn windows_1252_preview_matches_ts() {
    let all: Vec<u8> = (0..=255).collect();
    let got = decode_preview(&all, Guess::Legacy);
    assert_eq!(got, pure()["win1252"].as_str().unwrap());
    for b in all {
        let one = decode_preview(&[b], Guess::Legacy);
        assert_eq!(one.chars().count(), 1, "{b:#x}");
    }
}

#[test]
fn to_lower_matches_v8() {
    let changed = pure()["lower"].as_array().unwrap();
    let mut want = std::collections::BTreeMap::new();
    for pair in changed {
        want.insert(
            pair[0].as_u64().unwrap() as u32,
            pair[1].as_str().unwrap().to_owned(),
        );
    }
    let mut bad = vec![];
    for c in (0..=0x10ffffu32).filter_map(char::from_u32) {
        let s = c.to_string();
        let got = js_string::to_lower(&s);
        let w = want.get(&(c as u32)).cloned().unwrap_or_else(|| s.clone());
        // The lone-surrogate stand-ins (private use) can't be told from a
        // surrogate; V8 never lowercases either.
        if got != w {
            bad.push(format!("U+{:04X}: want {w:?} got {got:?}", c as u32));
        }
    }
    assert!(bad.is_empty(), "{} differ:\n{}", bad.len(), bad.join("\n"));
    for pair in pure()["lowerStrings"].as_array().unwrap() {
        let (s, w) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        assert_eq!(js_string::to_lower(s), w, "{s:?}");
    }
}

#[test]
fn path_rules() {
    // `inside`: a first segment starting with `..` counts as outside.
    for (root, target, want) in [
        ("/r", "/r", true),
        ("/r", "/r/a", true),
        ("/r", "/r/..foo", false),
        ("/r", "/r/a/..foo", true),
        ("/r", "/rx", false),
        ("/r", "/", false),
        ("/", "/anything", true),
        ("/r", "/r/...", false),
    ] {
        assert_eq!(inside(root, target), want, "{root} {target}");
    }
    for (raw, want) in [
        ("", "."),
        ("/", ""),
        ("//a//b/", "a/b/"),
        ("/../x", "x"),
        ("../x", "../x"),
        ("a/./b/../c", "a/c"),
    ] {
        assert_eq!(rel_path(raw), want, "{raw}");
    }
    assert_eq!(under("/"), "/");
    assert_eq!(under("/r"), "/r/");
    for name in [
        ".git",
        "node_modules",
        "dist",
        ".DS_Store",
        ".env",
        ".",
        "..x",
    ] {
        assert!(is_hidden(name), "{name}");
    }
    for name in ["Dist", "dist ", "coverage.txt", "Node_Modules", "x.git"] {
        assert!(!is_hidden(name), "{name}");
    }
}

#[test]
fn image_types() {
    for (path, want) in [
        ("/a/b.PNG", Some("image/png")),
        ("/a/b.jpeg", Some("image/jpeg")),
        ("/a/b.tar.gz", None),
        ("/a.png/b", None),
        ("/a/noext", None),
        ("/a/.png", Some("image/png")),
        ("/a/b.toString", None),
        (
            "/a/b.CONSTRUCTOR",
            Some("function Object() { [native code] }"),
        ),
        ("/a/b.__proto__", Some("[object Object]")),
    ] {
        assert_eq!(image_mime(path), want, "{path}");
    }
}

#[test]
fn line_matching() {
    let mut m: Vec<ContentMatch> = vec![];
    // `split(/\r?\n/)`: a lone `\r` stays in its line.
    assert!(!match_lines(
        "f",
        "a hello\r\nb\rhello\n\rhello\r",
        "hello",
        "hello",
        false,
        &mut m
    ));
    let cols: Vec<_> = m
        .iter()
        .map(|m| {
            (
                m.line,
                m.col,
                m.col_end,
                String::from_utf16(&m.text).unwrap(),
            )
        })
        .collect();
    assert_eq!(
        cols,
        [
            (1, 3, 8, "a hello".to_owned()),
            (2, 3, 8, "b\rhello".to_owned()),
            (3, 2, 7, "\rhello\r".to_owned())
        ]
    );
    // A long line: 400 units around the hit; a cut through a pair keeps
    // the half (`\ude00` here), written as its escape.
    m.clear();
    let line = format!("{}x{}", "\u{1f600}".repeat(300), "\u{1f600}".repeat(300));
    match_lines("f", &line, "x", "x", true, &mut m);
    let units = &m[0].text;
    assert_eq!((m[0].col, m[0].col_end, units.len()), (200, 201, 400));
    assert_eq!(units[0], 0xde00, "starts on a low surrogate");
    let json = matches_json(&m);
    assert!(
        json.starts_with(
            "[{\"relPath\":\"f\",\"line\":1,\"col\":200,\"colEnd\":201,\"text\":\"\\ude00\u{1f600}"
        ),
        "{json}"
    );
    assert!(json.ends_with("\",\"truncated\":true}]"), "{json}");
    // U+10FFFD is itself, two units.
    m.clear();
    match_lines("f", "\u{10fffd}x", "x", "x", true, &mut m);
    assert_eq!((m[0].col, m[0].text.len()), (3, 3));
    assert_eq!(
        matches_json(&m),
        "[{\"relPath\":\"f\",\"line\":1,\"col\":3,\"colEnd\":4,\"text\":\"\u{10fffd}x\",\"truncated\":false}]"
    );
    // `İ` lowercases to two units: the hit's index is the lowered line's.
    m.clear();
    let line = format!("{}needle{}", "\u{130}".repeat(300), "z".repeat(300));
    match_lines("f", &line, "needle", "needle", false, &mut m);
    assert_eq!((m[0].col, m[0].col_end), (198, 204));
    assert!(m[0].truncated);
    // The cap: the 1000th match stops the file.
    m.clear();
    assert!(match_lines(
        "f",
        &"hit\n".repeat(1005),
        "hit",
        "hit",
        true,
        &mut m
    ));
    assert_eq!(m.len(), 1000);
}

#[test]
fn known_binary_paths_match_the_ts() {
    let fx = pure();
    // The set itself, in the TS insertion order.
    let exts: Vec<&str> = fx["exts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap())
        .collect();
    assert_eq!(exts, file_types::BINARY_EXTS, "BINARY_EXTS drifted");
    let cases = fx["binary"].as_array().unwrap();
    let mut failures = Vec::new();
    for c in cases {
        // The fixture was parsed with `js_string::parse`, so a lone
        // surrogate is already the stand-in char the route would see.
        let path = c[0].as_str().unwrap();
        let want = c[1].as_bool().unwrap();
        if file_types::is_known_binary_path(path) != want {
            failures.push(format!("{}: want {want}", js_string::stringify(&c[0])));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} paths differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    assert!(cases.len() >= 170);
}
