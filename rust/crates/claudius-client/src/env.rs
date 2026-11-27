//! The impure inputs the hook reads synchronously: the wall clock
//! (`Date.now()`, stamped on a replayed tool_use), `crypto.randomUUID()`
//! (an SDK message without a `uuid`) and the tab's `sessionStorage` (the
//! boot guard's marker, U01k). A replay injects fixed ones, so a recorded
//! event log derives the same state every run.

use indexmap::IndexMap;

use crate::JsThrow;
use crate::boot_guard::TabStorage;

/// The clock, uuid source and tab storage the state machine reads.
pub trait ClientEnv {
    /// `Date.now()`: epoch milliseconds.
    fn now_ms(&mut self) -> f64;
    /// `crypto.randomUUID()`: a fresh v4 uuid, lowercase.
    fn random_uuid(&mut self) -> String;
    /// `window.sessionStorage`. `None` (the default) is a storage whose
    /// every call throws, which the hook's callers all swallow: the boot
    /// guard then never skips a session.
    fn session_storage(&mut self) -> Option<&mut dyn TabStorage> {
        None
    }
}

/// Run `f` over the env's storage, or over one that throws on every call.
pub(crate) fn with_storage<R>(
    env: &mut dyn ClientEnv,
    f: impl FnOnce(&mut dyn TabStorage) -> R,
) -> R {
    match env.session_storage() {
        Some(s) => f(s),
        None => f(&mut NoStorage),
    }
}

/// A storage the page can't use (`SecurityError` on every call).
struct NoStorage;

impl TabStorage for NoStorage {
    fn get_item(&mut self, _: &str) -> Result<Option<String>, JsThrow> {
        Err(denied())
    }
    fn set_item(&mut self, _: &str, _: &str) -> Result<(), JsThrow> {
        Err(denied())
    }
    fn remove_item(&mut self, _: &str) -> Result<(), JsThrow> {
        Err(denied())
    }
}

fn denied() -> JsThrow {
    JsThrow {
        name: "SecurityError",
        message: "The operation is insecure.".into(),
    }
}

/// An in-memory `Storage` (insertion order, as the browser lists keys).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemStorage(pub IndexMap<String, String>);

impl TabStorage for MemStorage {
    fn get_item(&mut self, key: &str) -> Result<Option<String>, JsThrow> {
        Ok(self.0.get(key).cloned())
    }
    fn set_item(&mut self, key: &str, value: &str) -> Result<(), JsThrow> {
        self.0.insert(key.to_owned(), value.to_owned());
        Ok(())
    }
    fn remove_item(&mut self, key: &str) -> Result<(), JsThrow> {
        self.0.shift_remove(key);
        Ok(())
    }
}

/// The real clock and OS randomness.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemEnv;

impl ClientEnv for SystemEnv {
    fn now_ms(&mut self) -> f64 {
        claudius_core::now_ms() as f64
    }

    fn random_uuid(&mut self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// A fixed clock, counted uuids (`00000000-0000-4000-8000-000000000001`,
/// `…02`, …) and an in-memory tab storage, as the golden recorder stubs
/// `Date.now`, `crypto.randomUUID` and `sessionStorage`.
#[derive(Debug, Clone)]
pub struct FixedEnv {
    pub now: f64,
    pub uuids: u64,
    pub storage: MemStorage,
}

impl FixedEnv {
    pub fn new(now: f64) -> Self {
        Self {
            now,
            uuids: 0,
            storage: MemStorage::default(),
        }
    }
}

impl ClientEnv for FixedEnv {
    fn now_ms(&mut self) -> f64 {
        self.now
    }

    fn random_uuid(&mut self) -> String {
        self.uuids += 1;
        format!("00000000-0000-4000-8000-{:012}", self.uuids)
    }

    fn session_storage(&mut self) -> Option<&mut dyn TabStorage> {
        Some(&mut self.storage)
    }
}
