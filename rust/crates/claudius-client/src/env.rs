//! The two impure inputs the hook's helpers read: the wall clock
//! (`Date.now()`, stamped on a replayed tool_use) and `crypto.randomUUID()`
//! (an SDK message without a `uuid`). A replay injects fixed ones, so a
//! recorded event log derives the same state every run.

/// The clock and uuid source the state machine reads.
pub trait ClientEnv {
    /// `Date.now()`: epoch milliseconds.
    fn now_ms(&mut self) -> f64;
    /// `crypto.randomUUID()`: a fresh v4 uuid, lowercase.
    fn random_uuid(&mut self) -> String;
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

/// A fixed clock and counted uuids (`00000000-0000-4000-8000-000000000001`,
/// `…02`, …), as the golden recorder stubs `Date.now` and
/// `crypto.randomUUID`.
#[derive(Debug, Clone)]
pub struct FixedEnv {
    pub now: f64,
    pub uuids: u64,
}

impl FixedEnv {
    pub fn new(now: f64) -> Self {
        Self { now, uuids: 0 }
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
}
