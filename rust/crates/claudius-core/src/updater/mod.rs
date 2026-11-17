//! The updater (`lib/server/updater/*`), first half (D27a): the settings
//! file, the install root, the `git` wrapper these need, the background
//! check and the release changelog. `apply`, `restart` and the scheduler
//! stay on Next until D27b.
//!
//! The settings file is read and written as `JSON.parse` / `JSON.stringify`
//! see it, so a hand-written `~/.claude/.claudius/updater.json` round trips:
//! strings are UTF-16 ([`crate::docker::Js`], so a lone surrogate survives),
//! a number past the f64 range is `Infinity` and prints `null`, array-index
//! keys come first, and the state members the TS only type-checks
//! (`pending`, `conflicts`, `recovery`, `status`) are carried through
//! whatever shape they have.

pub mod detect;
pub mod git;
pub mod release_changelog;
pub mod root;
pub mod settings;
pub mod spawn_env;

use serde_json::{Map, Value};

use crate::docker::Js;
use crate::{js_num, js_string};

/// `o.key`: an object's own property (`None` for `undefined`, and for any
/// value that isn't an object — none of the keys read here is one a string
/// or array has).
pub(crate) fn member<'a>(v: &'a Js, key: &str) -> Option<&'a Js> {
    match v {
        Js::Obj(m) => m.get(&key.encode_utf16().collect::<Vec<u16>>()),
        _ => None,
    }
}

/// `v` as a JSON value: strings keep their lone surrogates (as
/// [`js_string`]'s stand-ins), `±Infinity` becomes `null` — which is what
/// `JSON.stringify` writes for it — and objects keep their insertion order
/// (the array-index-first reorder happens in `JSON.stringify`, see
/// [`claudius_agent::js::own_keys_order`]).
pub(crate) fn to_value(v: &Js) -> Value {
    match v {
        Js::Null => Value::Null,
        Js::Bool(b) => Value::Bool(*b),
        Js::Num(n) => js_num(*n),
        Js::Str(s) => Value::String(js_string::from_units(s)),
        Js::Arr(items) => Value::Array(items.iter().map(to_value).collect()),
        Js::Obj(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (js_string::from_units(k), to_value(v)))
                .collect::<Map<String, Value>>(),
        ),
    }
}
