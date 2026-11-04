//! Hooks in Claude Code settings files: `lib/server/hooks.ts`. The `hooks`
//! key of each settings scope ([`settings`]: user, project, local) maps an
//! event name to a list of matcher groups; `disableAllHooks` turns them all
//! off for that scope.
//!
//! Values are read the way the TS reads them off whatever `JSON.parse`
//! gave: a settings file holding `null` throws on the property read, any
//! other non-object has no `hooks`, and a `hooks` value that isn't an object
//! (or array) is `{}`. An event's entry is copied with `.slice()`, so a
//! string entry copies and then throws on `push` / `splice`, and any other
//! non-array entry throws on the `slice`, with V8's messages. Writes are
//! `writeSettings` of the spread settings, keys in place.

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::settings::{self, Scope};
use crate::skills::Thrown;

/// `HOOK_EVENT_NAMES` (`lib/shared/hook-events.ts`).
pub const HOOK_EVENT_NAMES: [&str; 33] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PreModelSwitch",
    "PostModelSwitch",
    "PermissionRequest",
    "PermissionDenied",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
    "DirectoryAdded",
    "MessageDisplay",
];

/// The three settings scopes, in `listAll`'s order.
pub const SCOPES: [(Scope, &str); 3] = [
    (Scope::User, "user"),
    (Scope::Project, "project"),
    (Scope::Local, "local"),
];

fn scope_name(scope: Scope) -> &'static str {
    SCOPES
        .iter()
        .find(|(s, _)| *s == scope)
        .map_or("user", |(_, n)| n)
}

/// `readSettings(scope, cwd)` for a property read: `null` throws.
fn read_object(scope: Scope, cwd: &str, key: &str) -> Result<Map<String, Value>, Thrown> {
    settings::read_settings_js(scope, cwd)?
        .ok_or_else(|| Thrown::type_error(settings::null_property_error(key)))
}

/// `readHooks(settings)`: `settings.hooks` when it's an object or array.
fn read_hooks(settings: &Map<String, Value>) -> Value {
    match settings.get("hooks") {
        Some(v @ (Value::Object(_) | Value::Array(_))) => v.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `{ ...hooks }`.
fn spread(hooks: &Value) -> Map<String, Value> {
    settings::spread(hooks)
}

/// The event's groups: `(hooks[event] ?? []).slice()`. `Ok(Err(text))` is
/// a string entry, which copies but has no `push` / `splice`.
fn groups(hooks: &Value, event: &str) -> Result<Result<Vec<Value>, Vec<u16>>, Thrown> {
    let entry = match hooks {
        Value::Object(m) => m.get(event),
        _ => None,
    };
    match entry {
        None | Some(Value::Null) => Ok(Ok(Vec::new())),
        Some(Value::Array(items)) => Ok(Ok(items.clone())),
        Some(Value::String(s)) => Ok(Err(s.encode_utf16().collect())),
        Some(_) => Err(Thrown::type_error(
            "(hooks[event] ?? []).slice is not a function",
        )),
    }
}

/// A `ScopedHooks`.
#[derive(Clone, Debug, PartialEq)]
pub struct ScopedHooks {
    pub scope: Scope,
    pub path: String,
    pub disable_all_hooks: bool,
    /// The scope's `hooks` (an object, or an array kept as is).
    pub hooks: Value,
}

impl ScopedHooks {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("scope".into(), Value::from(scope_name(self.scope)));
        m.insert("path".into(), Value::from(self.path.clone()));
        m.insert(
            "disableAllHooks".into(),
            Value::Bool(self.disable_all_hooks),
        );
        m.insert("hooks".into(), self.hooks.clone());
        Value::Object(m)
    }
}

/// `listAll(cwd)`: user, project, local, each read in turn (the first that
/// throws is the error).
pub fn list_all(cwd: &str) -> Result<Vec<ScopedHooks>, Thrown> {
    let mut out = Vec::new();
    for (scope, _) in SCOPES {
        let settings = read_object(scope, cwd, "disableAllHooks")?;
        out.push(ScopedHooks {
            scope,
            path: settings::path_for(scope, cwd)
                .to_string_lossy()
                .into_owned(),
            disable_all_hooks: settings.get("disableAllHooks").is_some_and(js::truthy),
            hooks: read_hooks(&settings),
        });
    }
    Ok(out)
}

/// `addGroup(scope, cwd, event, group)`: `group` appended to the event's
/// list.
pub fn add_group(scope: Scope, cwd: &str, event: &str, group: &Value) -> Result<(), Thrown> {
    let mut settings = read_object(scope, cwd, "hooks")?;
    let hooks = read_hooks(&settings);
    let Ok(mut arr) = groups(&hooks, event)? else {
        return Err(Thrown::type_error("arr.push is not a function"));
    };
    arr.push(group.clone());
    let mut next_hooks = spread(&hooks);
    next_hooks.insert(event.to_owned(), Value::Array(arr));
    settings.insert("hooks".into(), Value::Object(next_hooks));
    settings::write_settings(scope, cwd, &settings)?;
    Ok(())
}

/// `removeGroup(scope, cwd, event, index)`: whether there was a group at
/// `index` (`splice` truncates a fractional one); an emptied event goes.
pub fn remove_group(scope: Scope, cwd: &str, event: &str, index: f64) -> Result<bool, Thrown> {
    let mut settings = read_object(scope, cwd, "hooks")?;
    let hooks = read_hooks(&settings);
    let arr = groups(&hooks, event)?;
    let len = match &arr {
        Ok(items) => items.len(),
        Err(units) => units.len(),
    };
    // NaN passes both, and `splice` reads it as 0, as `as usize` does.
    if index < 0.0 || index >= len as f64 {
        return Ok(false);
    }
    let Ok(mut arr) = arr else {
        return Err(Thrown::type_error("arr.splice is not a function"));
    };
    arr.remove(index.trunc() as usize);
    let mut next_hooks = spread(&hooks);
    if arr.is_empty() {
        next_hooks.shift_remove(event);
    } else {
        next_hooks.insert(event.to_owned(), Value::Array(arr));
    }
    settings.insert("hooks".into(), Value::Object(next_hooks));
    settings::write_settings(scope, cwd, &settings)?;
    Ok(true)
}

/// `setDisableAllHooks(scope, cwd, disabled)`: `true` sets the key, `false`
/// removes it.
pub fn set_disable_all_hooks(scope: Scope, cwd: &str, disabled: bool) -> Result<(), Thrown> {
    let mut next = settings::read_settings(scope, cwd)?;
    if disabled {
        next.insert("disableAllHooks".into(), Value::Bool(true));
    } else {
        next.shift_remove("disableAllHooks");
    }
    settings::write_settings(scope, cwd, &next)?;
    Ok(())
}
