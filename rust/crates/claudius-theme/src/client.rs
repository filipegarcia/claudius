//! How the client picks, stores and applies the theme: `lib/client/theme.ts`
//! (`useTheme`), the `beforeInteractive` bootstrap in `app/layout.tsx`, and
//! the `/theme` slash command in `components/chat/ChatSurface.tsx`.
//!
//! The browser side effects go through [`Host`], one method per call the
//! TS makes (`localStorage`, `documentElement.dataset` / `.style`,
//! `window.dispatchEvent`), in the TS's order. A storage call the browser
//! refuses (private mode, quota) is an `Err`.

use crate::js;
use crate::palette::ThemeName;

/// The browser surface the client logic touches.
pub trait Host {
    fn get_item(&mut self, key: &str) -> Result<Option<String>, StorageError>;
    fn set_item(&mut self, key: &str, value: &str) -> Result<(), StorageError>;
    fn remove_item(&mut self, key: &str) -> Result<(), StorageError>;
    /// `document.documentElement.dataset[key] = value` (`theme`, `electron`).
    fn set_dataset(&mut self, key: &str, value: &str);
    /// `document.documentElement.style.setProperty`.
    fn set_style_property(&mut self, name: &str, value: &str);
    /// `document.documentElement.style.removeProperty`.
    fn remove_style_property(&mut self, name: &str);
    /// `window.dispatchEvent(new Event(name))`.
    fn dispatch_event(&mut self, name: &str);
}

/// A storage call the browser threw on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageError;

/// `STORAGE_KEY`.
pub const THEME_STORAGE_KEY: &str = "claudius.theme";
/// `SAME_TAB_EVENT`: the native `storage` event only reaches other tabs.
pub const THEME_CHANGED_EVENT: &str = "claudius.theme.changed";
/// The window events `useTheme` re-reads the store on.
pub const THEME_SUBSCRIBE_EVENTS: [&str; 2] = ["storage", THEME_CHANGED_EVENT];

/// `readSnapshot`: the saved id when it is exactly one of the seven, else
/// the default (also when storage throws).
pub fn read_theme(host: &mut dyn Host) -> ThemeName {
    match host.get_item(THEME_STORAGE_KEY) {
        Ok(Some(saved)) => ThemeName::from_id(&saved).unwrap_or(ThemeName::DEFAULT),
        _ => ThemeName::DEFAULT,
    }
}

/// `applyTheme`: what `useTheme`'s effect writes after each render.
pub fn apply_theme(host: &mut dyn Host, id: &str) {
    host.set_dataset("theme", id);
}

/// `setTheme`: saves the id (ignoring a refusal) and tells the same tab.
/// The TS types `id` as a `ThemeId` but stores whatever it gets.
pub fn set_theme(host: &mut dyn Host, id: &str) {
    let _ = host.set_item(THEME_STORAGE_KEY, id);
    host.dispatch_event(THEME_CHANGED_EVENT);
}

/// The names `allowed[t]` finds on a plain object literal besides its own
/// keys: `Object.prototype`'s members (all truthy).
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// The bootstrap's `data-theme` for a saved value: `(t && allowed[t]) ? t :
/// 'dark'`. Unlike [`read_theme`], an `Object.prototype` name gets through
/// (`"toString"`), and the stylesheet then shows `:root`'s dark values.
pub fn bootstrap_theme_attr(saved: Option<&str>) -> String {
    match saved {
        Some(t) if ThemeName::from_id(t).is_some() || OBJECT_PROTOTYPE_KEYS.contains(&t) => {
            t.to_string()
        }
        _ => "dark".to_string(),
    }
}

fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    lo.max(hi.min(n))
}

/// `app/layout.tsx`'s inline bootstrap, run before hydration: the theme,
/// the chat-size overrides (`parseFloat`, unlike the hook's `Number()`) and
/// the Electron marker.
pub fn bootstrap(host: &mut dyn Host, user_agent: &str) {
    let theme = match host.get_item(THEME_STORAGE_KEY) {
        Ok(saved) => bootstrap_theme_attr(saved.as_deref()),
        Err(StorageError) => "dark".to_string(),
    };
    host.set_dataset("theme", &theme);
    let _ = (|| -> Result<(), StorageError> {
        let c = js::parse_float(
            host.get_item(crate::chat::COL_KEY)?
                .as_deref()
                .unwrap_or("null"),
        );
        if c.is_finite() {
            let v = clamp(c, 36.0, 400.0);
            host.set_style_property("--chat-col", &format!("{}rem", js::number_to_string(v)));
        }
        let f = js::parse_float(
            host.get_item(crate::chat::TEXT_KEY)?
                .as_deref()
                .unwrap_or("null"),
        );
        if f.is_finite() {
            let v = clamp(f, 13.0, 48.0);
            host.set_style_property("--chat-text", &format!("{}px", js::number_to_string(v)));
        }
        Ok(())
    })();
    if user_agent.contains("Electron") {
        host.set_dataset("electron", "1");
    }
}

/// `/theme`'s ids: the first four only (no tui, tui-light or synthwave).
pub const THEME_COMMAND_IDS: [ThemeName; 4] = [
    ThemeName::Dark,
    ThemeName::Light,
    ThemeName::Midnight,
    ThemeName::Paper,
];

/// What `/theme <args>` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThemeCommand {
    /// Saved and applied (no same-tab event: an open settings page keeps
    /// showing the old pick until it re-reads), with this toast.
    Applied { theme: ThemeName, toast: String },
    /// Anything else opens `/settings`.
    OpenSettings,
}

/// `/theme <args>`: `args.trim().toLowerCase()` must be one of
/// [`THEME_COMMAND_IDS`]. The TS doesn't catch a refused `setItem`: the
/// handler throws before applying or toasting, which is the `Err`.
pub fn theme_command(host: &mut dyn Host, args: &str) -> Result<ThemeCommand, StorageError> {
    let candidate = js::trim(args).to_lowercase();
    let Some(theme) = THEME_COMMAND_IDS.into_iter().find(|t| t.id() == candidate) else {
        return Ok(ThemeCommand::OpenSettings);
    };
    host.set_item(THEME_STORAGE_KEY, theme.id())?;
    host.set_dataset("theme", theme.id());
    Ok(ThemeCommand::Applied {
        theme,
        toast: format!("Theme \u{2192} {}", theme.id()),
    })
}
