//! A port of the parse half of the npm `yaml` package (2.9.0): what
//! `YAML.parse(src)` does with its default options, down to the JS value it
//! returns and what `JSON.stringify` makes of that value.
//!
//! The pipeline is the package's own: lexer → CST parser → composer (with
//! the `core` schema and its known tags, or `yaml-1.1` under `%YAML 1.1`) →
//! `doc.toJS()`. Strings are handled as UTF-16 code units throughout, so
//! offsets, lengths and escapes match the JS. Known differences:
//!
//! - nesting past [`compose::MAX_DEPTH`] levels fails the parse, where V8
//!   runs out of stack (and yaml reports it) somewhere past ~700–1700 levels;
//! - a lone surrogate (from a `"\ud800"` escape) becomes U+FFFD on output;
//! - a map key whose JS value is a `Date` names it in UTC (`Date#toString`
//!   prints local time; the golden recorder runs in `TZ=UTC`);
//! - a value nested past `MAX_JSON_DEPTH` levels (only chains of aliases to
//!   empty collections get there) fails `JSON.stringify`, where V8 goes on.
//!
//! Map keys whose JS value is an object (collections, timestamps, binaries)
//! are named the way yaml does it, by its flow stringifier
//! ([`stringify`]: comments, `spaceBefore`, tags, anchors, folding at 80
//! columns). `tests/agents_golden.rs` replays a recording of the package on
//! a hand corpus and two seeded fuzz corpora.

mod compose;
mod lexer;
mod parser;
mod schema;
mod stringify;
mod tojs;

use serde_json::{Value, json};

use compose::{Composer, Report};
use parser::Tok;
use schema::{Directives, Schema};
use tojs::{JsObj, JsVal, ToJs};

pub(super) type U16s = Vec<u16>;

/// A scalar node's value (`Date` and `Buffer` are objects in JS; their
/// identity is the node's).
#[derive(Debug, Clone)]
pub(super) enum SVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(U16s),
    /// The merge key's `Symbol('<<')`.
    Sym,
    /// A `Date`'s time value (`NaN` when invalid).
    Date(f64),
    Buffer(Vec<u8>),
}

pub(super) fn eq_ascii(a: &[u16], s: &str) -> bool {
    a.len() == s.len() && a.iter().zip(s.bytes()).all(|(x, y)| *x == u16::from(y))
}

pub(super) fn units_to_string(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

/// Deeper JS values than this make `JSON.stringify` fail here (only chains
/// of aliases to empty collections get there; V8 goes deeper).
const MAX_JSON_DEPTH: usize = 2000;

/// The parse of one source: errors and warnings by code, and the value.
struct Parsed {
    report: Report,
    /// `None`: `YAML.parse` throws (an error was reported, there are
    /// several documents, or `toJS` threw).
    value: Option<(Vec<JsObj>, JsVal)>,
    multiple_docs: bool,
}

fn parse_units(src: &[u16]) -> Parsed {
    let mut report = Report::default();
    let Some(tokens) = parser::parse(src) else {
        report.on_error("RESOURCE_EXHAUSTION", false);
        return Parsed {
            report,
            value: None,
            multiple_docs: false,
        };
    };
    let mut directives = Directives::new();
    let mut next_id = 0usize;
    let mut at_directives = false;
    let mut first: Option<(compose::Node, Schema, Directives, Vec<schema::Tag>)> = None;
    let mut docs = 0usize;
    for token in &tokens {
        match token {
            Tok::Directive { source, .. } => {
                directives.add(source, &mut report);
                at_directives = true;
            }
            Tok::Document {
                offset,
                start,
                value,
                end,
            } => {
                if docs == 1 {
                    // parseDocument stops at the second document
                    docs += 1;
                    break;
                }
                let doc_directives = directives.at_document();
                let version = if doc_directives.explicit {
                    doc_directives.version
                } else {
                    "1.2"
                };
                let schema = Schema {
                    yaml11: version == "1.1",
                };
                let (contents, doc_start, pushed) = {
                    let mut c = Composer::new(&mut report, &mut next_id, &doc_directives, &schema);
                    let (contents, doc_start) =
                        c.compose_doc(*offset, start, value.as_deref(), end.as_deref());
                    (contents, doc_start, std::mem::take(&mut c.pushed))
                };
                if at_directives && !doc_start {
                    report.on_error("MISSING_CHAR", false);
                }
                first = Some((contents, schema, doc_directives, pushed));
                docs += 1;
                at_directives = false;
            }
            Tok::Src(s) => match s.ty {
                parser::Ty::ByteOrderMark
                | parser::Ty::Space
                | parser::Ty::Comment
                | parser::Ty::Newline => {}
                _ => report.on_error("UNEXPECTED_TOKEN", false),
            },
            Tok::Error { .. } => report.on_error("UNEXPECTED_TOKEN", false),
            Tok::DocEnd {
                offset,
                source,
                end,
            } => {
                if docs == 0 {
                    report.on_error("UNEXPECTED_TOKEN", false);
                } else {
                    let _ = compose::resolve_end(
                        &mut report,
                        end.as_deref(),
                        offset + source.len() as i64,
                        true,
                    );
                }
            }
            _ => report.on_error("UNEXPECTED_TOKEN", false),
        }
    }
    let multiple_docs = docs > 1;
    if multiple_docs {
        report.on_error("MULTIPLE_DOCS", false);
    }
    if docs == 0 && at_directives {
        report.on_error("MISSING_CHAR", false);
    }
    if !report.errors.is_empty() {
        return Parsed {
            report,
            value: None,
            multiple_docs,
        };
    }
    let value = match &first {
        None => Some((Vec::new(), JsVal::Null)),
        Some((root, schema, directives, pushed)) => {
            let mut cx = ToJs::new(root, *schema, directives.tags().to_vec(), pushed.clone());
            match cx.js_of(root) {
                Ok(v) => Some((std::mem::take(&mut cx.heap), v)),
                Err(_) => None,
            }
        }
    };
    Parsed {
        report,
        value,
        multiple_docs,
    }
}

/// Runs `f` on a thread with room for the composer's recursion.
fn with_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .name("yaml".into())
        .stack_size(64 << 20)
        .spawn(f)
        .expect("spawn yaml thread")
        .join()
        .expect("yaml thread")
}

fn json_of(heap: &[JsObj], v: &JsVal) -> Result<Option<Value>, tojs::Thrown> {
    tojs::json_value(heap, v, MAX_JSON_DEPTH)
}

/// What agents' `parseFrontmatter` takes from `YAML.parse(m[1])`.
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    /// `JSON.stringify(frontmatter)`'s value: the parse when it is a
    /// non-array object, else `{}`. `None` when stringifying throws (a
    /// cyclic value, from an anchor aliased inside itself).
    pub json: Option<Value>,
    /// `frontmatter.name`, when it is a string (as UTF-16 code units).
    pub name: Option<Vec<u16>>,
}

/// `parseFrontmatter`'s YAML step: `YAML.parse(src)`, kept when it is an
/// object and not an array, `{}` otherwise or when parsing throws.
pub fn frontmatter(src: &str) -> Frontmatter {
    let units: U16s = src.encode_utf16().collect();
    with_stack(move || {
        let parsed = parse_units(&units);
        let empty = Frontmatter {
            json: Some(Value::Object(serde_json::Map::new())),
            name: None,
        };
        let Some((heap, root)) = parsed.value else {
            return empty;
        };
        let JsVal::Obj(id) = root else { return empty };
        if matches!(heap[id], JsObj::Array(_)) {
            return empty;
        }
        let name = match &heap[id] {
            JsObj::Object(o) => match o.get(&tojs::PropKey::Str(
                "name".encode_utf16().collect::<Vec<_>>().into(),
            )) {
                Some(JsVal::Str(s)) => Some(s.to_vec()),
                _ => None,
            },
            _ => None,
        };
        Frontmatter {
            json: json_of(&heap, &root).ok().flatten(),
            name,
        }
    })
}

/// The parse as the golden recorder sees it: `parseDocument(src)`'s error
/// and warning codes, and `JSON.stringify(YAML.parse(src))` (or `"throws"`,
/// `"undefined"`, `"circular"`).
pub fn debug_report(src: &str) -> Value {
    let units: U16s = src.encode_utf16().collect();
    with_stack(move || {
        let parsed = parse_units(&units);
        let result = match &parsed.value {
            None => json!("throws"),
            Some((heap, v)) => match json_of(heap, v) {
                Ok(Some(j)) => json!({ "json": j }),
                Ok(None) => json!("undefined"),
                Err(_) => json!("circular"),
            },
        };
        json!({
            "errors": parsed.report.errors,
            "warnings": parsed.report.warnings,
            "multipleDocs": parsed.multiple_docs,
            "result": result,
        })
    })
}
