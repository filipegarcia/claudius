//! `~/.claude/keybindings.json`: `lib/server/keybindings.ts`. Read as
//! `JSON.parse` of the file (any JSON value; a missing file is `{}`, a
//! malformed one throws V8's `SyntaxError`), written as
//! `JSON.stringify(data, null, 2)` and a newline. Values go through
//! [`js_string`], so a lone surrogate escape reads and writes back as the
//! same escape.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::js_string;
use crate::node_err;
use crate::node_path;
use crate::skills::Thrown;

/// `keybindingsPath()`.
pub fn keybindings_path(home: &str) -> String {
    node_path::join(&[home, ".claude", "keybindings.json"])
}

/// The folder every fs call here is checked against.
fn base(home: &str) -> String {
    node_path::resolve(&[home, ".claude"])
}

/// `readKeybindings()`: `{ path, exists, data }`. `Err` is the `readFile`
/// error (not ENOENT) or the `SyntaxError`.
pub fn read_keybindings(home: &str) -> Result<Value, Thrown> {
    let path = keybindings_path(home);
    let base = base(home);
    let target = node_path::resolve(&[&path]);
    if !target.starts_with(&format!("{base}/")) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    let bytes = match node_err::fs::read_file(Path::new(&target)) {
        Ok(b) => b,
        Err(e) if e.code == "ENOENT" => {
            return Ok(json!({ "path": path, "exists": false, "data": Map::new() }));
        }
        Err(e) => return Err(e.into()),
    };
    let data = js_string::parse(&String::from_utf8_lossy(&bytes)).map_err(|message| Thrown {
        name: "SyntaxError",
        message,
    })?;
    Ok(json!({ "path": path, "exists": true, "data": data }))
}

/// `writeKeybindings(data)`.
pub fn write_keybindings(home: &str, data: &Value) -> Result<(), Thrown> {
    let path = keybindings_path(home);
    let base = base(home);
    let target = node_path::resolve(&[&path]);
    let dir = node_path::dirname(&target);
    if dir != base {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    node_err::fs::mkdir_recursive(Path::new(&dir))?;
    let mut body = js_string::stringify_pretty(data);
    body.push('\n');
    if !target.starts_with(&format!("{base}/")) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    node_err::fs::write_file(Path::new(&target), body.as_bytes())?;
    Ok(())
}
