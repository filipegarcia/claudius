//! `lib/server/updater/settings.ts`: `~/.claude/.claudius/updater.json`,
//! the install-wide self-update configuration and state.
//!
//! Every read normalizes (an unreadable or unparsable file, and any value
//! of the wrong type, falls back to the default), and every write writes
//! what the last read normalized, as `JSON.stringify(file, null, 2) + "\n"`.
//! `status` never comes back in flight: a crash mid-apply reads as `idle`.

use std::sync::Mutex;

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::docker::Js;
use crate::updater::{member, to_value};
use crate::{js_num, js_string, log, node_fs, node_path, paths};

/// The default mode: auto-apply, with a Claude Code session for a merge.
pub const DEFAULT_MODE: &str = "cc-merge";
/// `ALLOWED_MODES`, in the order the route's error message lists them.
pub const MODES: [&str; 4] = ["cc-merge", "ff-only", "notify-only", "disabled"];
/// The default remote.
pub const DEFAULT_REMOTE: &str = "origin";
/// The default branch.
pub const DEFAULT_BRANCH: &str = "main";
/// The default background interval, in hours.
pub const DEFAULT_INTERVAL_HOURS: f64 = 24.0;

/// `isMode(v)`.
pub fn is_mode(v: &str) -> bool {
    MODES.contains(&v)
}

/// `updaterSettingsPath`.
pub fn settings_path() -> String {
    node_path::join(&[&paths::claudius_root().to_string_lossy(), "updater.json"])
}

/// The four settings (`UpdaterSettings`).
#[derive(Clone, Debug, PartialEq)]
pub struct UpdaterSettings {
    pub mode: String,
    pub remote: String,
    pub branch: String,
    pub interval_hours: f64,
}

/// `UpdaterState`, with the members the TS only type-checks carried as the
/// JSON values they are.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdaterState {
    pub last_check_at: Option<f64>,
    pub last_update_at: Option<f64>,
    pub last_update_sha: Option<String>,
    pub last_error: Option<String>,
    pub pending: Option<Value>,
    pub conflicts: Option<Value>,
    pub recovery: Option<Value>,
    pub status: Value,
}

/// `UpdaterFile`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpdaterFile {
    pub settings: UpdaterSettings,
    pub state: UpdaterState,
}

/// `{ kind: "idle" }`.
pub fn idle() -> Value {
    let mut m = Map::new();
    m.insert("kind".into(), Value::String("idle".into()));
    Value::Object(m)
}

impl Default for UpdaterSettings {
    fn default() -> Self {
        UpdaterSettings {
            mode: DEFAULT_MODE.into(),
            remote: DEFAULT_REMOTE.into(),
            branch: DEFAULT_BRANCH.into(),
            interval_hours: DEFAULT_INTERVAL_HOURS,
        }
    }
}

impl Default for UpdaterState {
    fn default() -> Self {
        UpdaterState {
            last_check_at: None,
            last_update_at: None,
            last_update_sha: None,
            last_error: None,
            pending: None,
            conflicts: None,
            recovery: None,
            status: idle(),
        }
    }
}

impl UpdaterSettings {
    /// The four settings as the routes answer them.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("mode".into(), Value::String(self.mode.clone()));
        m.insert("remote".into(), Value::String(self.remote.clone()));
        m.insert("branch".into(), Value::String(self.branch.clone()));
        m.insert("intervalHours".into(), js_num(self.interval_hours));
        Value::Object(m)
    }
}

impl UpdaterState {
    /// The state as `JSON.stringify` writes it: `undefined` members are
    /// left out, the rest keep `normalize`'s order.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(n) = self.last_check_at {
            m.insert("lastCheckAt".into(), js_num(n));
        }
        if let Some(n) = self.last_update_at {
            m.insert("lastUpdateAt".into(), js_num(n));
        }
        if let Some(s) = &self.last_update_sha {
            m.insert("lastUpdateSha".into(), Value::String(s.clone()));
        }
        if let Some(s) = &self.last_error {
            m.insert("lastError".into(), Value::String(s.clone()));
        }
        if let Some(v) = &self.pending {
            m.insert("pending".into(), v.clone());
        }
        if let Some(v) = &self.conflicts {
            m.insert("conflicts".into(), v.clone());
        }
        if let Some(v) = &self.recovery {
            m.insert("recovery".into(), v.clone());
        }
        m.insert("status".into(), self.status.clone());
        Value::Object(m)
    }
}

impl UpdaterFile {
    /// The whole file as `JSON.stringify` writes it.
    pub fn to_json(&self) -> Value {
        let Value::Object(mut m) = self.settings.to_json() else {
            unreachable!("to_json makes an object")
        };
        m.insert("state".into(), self.state.to_json());
        Value::Object(m)
    }
}

/// `typeof v === "number" ? v : undefined`.
fn number(v: Option<&Js>) -> Option<f64> {
    match v {
        Some(Js::Num(n)) => Some(*n),
        _ => None,
    }
}

/// `typeof v === "string" ? v : undefined`.
fn string(v: Option<&Js>) -> Option<String> {
    match v {
        Some(Js::Str(s)) => Some(js_string::from_units(s)),
        _ => None,
    }
}

/// `v && typeof v === "object" ? v : undefined` — an object or an array.
fn object(v: Option<&Js>) -> Option<Value> {
    match v {
        Some(v @ (Js::Obj(_) | Js::Arr(_))) => Some(to_value(v)),
        _ => None,
    }
}

/// `normalize(parsed)`.
pub fn normalize(parsed: Option<&Js>) -> UpdaterFile {
    let base = UpdaterFile::default();
    // `!parsed || typeof parsed !== "object"`: an array gets this far and
    // then answers `undefined` for every member, so it reads as the base.
    let Some(parsed @ (Js::Obj(_) | Js::Arr(_))) = parsed else {
        return base;
    };
    let mode = match member(parsed, "mode") {
        Some(Js::Str(s)) => {
            let s = js_string::from_units(s);
            if is_mode(&s) { s } else { base.settings.mode }
        }
        _ => base.settings.mode,
    };
    let remote = string(member(parsed, "remote"))
        .filter(|r| !js::trim(r).is_empty())
        .unwrap_or(base.settings.remote);
    let branch = string(member(parsed, "branch"))
        .filter(|b| !js::trim(b).is_empty())
        .unwrap_or(base.settings.branch);
    let interval_hours = number(member(parsed, "intervalHours"))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(base.settings.interval_hours);
    // `parsed.state ?? {}`: `null` and `undefined` become `{}`; anything
    // else is read for members it hasn't got.
    let state_in = match member(parsed, "state") {
        Some(Js::Null) | None => None,
        v => v,
    };
    let field = |key: &str| state_in.and_then(|s| member(s, key));
    let status = match field("status") {
        // `s && typeof s === "object" && "kind" in s`: an array has no
        // `kind`, and a status that isn't `idle` doesn't come back.
        Some(s @ Js::Obj(_)) if member(s, "kind").is_some() => match member(s, "kind") {
            Some(Js::Str(k)) if js_string::from_units(k) == "idle" => to_value(s),
            _ => idle(),
        },
        _ => idle(),
    };
    UpdaterFile {
        settings: UpdaterSettings {
            mode,
            remote,
            branch,
            interval_hours,
        },
        state: UpdaterState {
            last_check_at: number(field("lastCheckAt")),
            last_update_at: number(field("lastUpdateAt")),
            last_update_sha: string(field("lastUpdateSha")),
            last_error: string(field("lastError")),
            pending: object(field("pending")),
            conflicts: object(field("conflicts")),
            recovery: object(field("recovery")),
            status,
        },
    }
}

/// The file reads and writes are serialized here: the TS has no lock, so
/// two concurrent writers can clobber each other there.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// `readUpdaterFile()`: a missing, unreadable or unparsable file reads as
/// the defaults.
pub fn read_updater_file() -> UpdaterFile {
    let _guard = FILE_LOCK.lock().expect("updater file lock");
    read_locked()
}

fn read_locked() -> UpdaterFile {
    let path = settings_path();
    let raw = match node_fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) => {
            if !e.is_not_found() {
                tracing::warn!(
                    target: log::API,
                    "[updater] settings file unreadable, using defaults: {}",
                    e.message
                );
            }
            return UpdaterFile::default();
        }
    };
    match Js::parse(&raw) {
        Some(parsed) => normalize(Some(&parsed)),
        None => {
            tracing::warn!(
                target: log::API,
                "[updater] settings file unreadable, using defaults: {}",
                js::json_parse_error(&raw).unwrap_or_default()
            );
            UpdaterFile::default()
        }
    }
}

fn write_locked(file: &UpdaterFile) -> Result<(), node_fs::FsError> {
    let path = settings_path();
    node_fs::mkdir_recursive(&node_path::dirname(&path), 0o777)?;
    let text = format!("{}\n", js_string::stringify_pretty(&file.to_json()));
    node_fs::write_file(&path, &text, 0o666)
}

/// `getUpdaterSettings()`.
pub fn get_updater_settings() -> UpdaterSettings {
    read_updater_file().settings
}

/// `getUpdaterState()`.
pub fn get_updater_state() -> UpdaterState {
    read_updater_file().state
}

/// The `Partial<UpdaterSettings>` a `PUT` hands to
/// [`patch_updater_settings`] — each member only when the body had one of
/// the right type.
#[derive(Clone, Debug, Default)]
pub struct SettingsPatch {
    pub mode: Option<String>,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub interval_hours: Option<f64>,
}

impl SettingsPatch {
    /// `{ mode: u.mode, remote: u.remote, branch: u.branch, intervalHours:
    /// u.intervalHours }` over a JSON value, as the settings import builds
    /// it from a bundle's `system.updaterSettings`: a string member (a
    /// number for `intervalHours`) is kept, and [`patch_updater_settings`]
    /// checks the rest. A value that isn't an object has none of the four
    /// (no string or array has them either).
    pub fn from_json(u: &Value) -> SettingsPatch {
        let member = |key: &str| u.as_object().and_then(|m| m.get(key));
        let string = |key: &str| member(key).and_then(Value::as_str).map(str::to_owned);
        SettingsPatch {
            mode: string("mode"),
            remote: string("remote"),
            branch: string("branch"),
            interval_hours: member("intervalHours").and_then(Value::as_f64),
        }
    }
}

/// `patchUpdaterSettings(patch)`: the members that pass the same checks
/// `normalize` makes are written; the answer is the four settings after it.
pub fn patch_updater_settings(patch: &SettingsPatch) -> Result<UpdaterSettings, node_fs::FsError> {
    let _guard = FILE_LOCK.lock().expect("updater file lock");
    let mut file = read_locked();
    if let Some(mode) = patch.mode.as_ref().filter(|m| is_mode(m)) {
        file.settings.mode = mode.clone();
    }
    if let Some(remote) = patch.remote.as_ref().filter(|r| !js::trim(r).is_empty()) {
        file.settings.remote = remote.clone();
    }
    if let Some(branch) = patch.branch.as_ref().filter(|b| !js::trim(b).is_empty()) {
        file.settings.branch = branch.clone();
    }
    if let Some(n) = patch.interval_hours.filter(|n| n.is_finite() && *n > 0.0) {
        file.settings.interval_hours = n;
    }
    write_locked(&file)?;
    Ok(file.settings)
}

/// A `Partial<UpdaterState>` spread over the state: `None` leaves the
/// member alone, `Some(None)` is the TS's `undefined` (the member goes).
#[derive(Clone, Debug, Default)]
pub struct StatePatch {
    pub last_check_at: Option<Option<f64>>,
    pub last_error: Option<Option<String>>,
    pub pending: Option<Option<Value>>,
    pub conflicts: Option<Option<Value>>,
    pub status: Option<Value>,
}

/// `patchUpdaterState(patch)`.
pub fn patch_updater_state(patch: &StatePatch) -> Result<UpdaterState, node_fs::FsError> {
    let _guard = FILE_LOCK.lock().expect("updater file lock");
    let mut file = read_locked();
    if let Some(v) = &patch.last_check_at {
        file.state.last_check_at = *v;
    }
    if let Some(v) = &patch.last_error {
        file.state.last_error = v.clone();
    }
    if let Some(v) = &patch.pending {
        file.state.pending = v.clone();
    }
    if let Some(v) = &patch.conflicts {
        file.state.conflicts = v.clone();
    }
    if let Some(v) = &patch.status {
        file.state.status = v.clone();
    }
    write_locked(&file)?;
    Ok(file.state)
}

/// `setUpdaterStatus(status)`.
pub fn set_updater_status(status: Value) -> Result<(), node_fs::FsError> {
    patch_updater_state(&StatePatch {
        status: Some(status),
        ..Default::default()
    })
    .map(|_| ())
}

/// `{ kind: "checking", startedAt }`.
pub fn checking(started_at: i64) -> Value {
    let mut m = Map::new();
    m.insert("kind".into(), Value::String("checking".into()));
    m.insert("startedAt".into(), js_num(started_at as f64));
    Value::Object(m)
}
