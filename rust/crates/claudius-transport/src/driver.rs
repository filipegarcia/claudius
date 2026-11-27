//! [`Driver`]: runs a `ChatState`'s effects over a [`Transport`], the way
//! the browser runs the React hook's.
//!
//! - [`Effect::Fetch`] goes out on a task; its outcome comes back through
//!   [`Driver::step`] as `fetch_settled`.
//! - [`Effect::SetTimer`] / [`Effect::ClearTimer`] arm and cancel tokio
//!   timers; an expiry comes back through [`Driver::step`] as
//!   `timer_fired`. The delay is `setTimeout`'s: the `f64` through WebIDL's
//!   `long` (`ToInt32`: NaN and ±∞ are 0, larger values wrap), then a
//!   negative one is 0. An interval's period is at least 1 ms (tokio has no
//!   zero period; a browser clamps a nested timer to 4 ms anyway). A timer
//!   cleared after it fired but before `step` took the expiry is dropped,
//!   as `clearTimeout` drops a queued callback.
//! - Every other effect is the UI's (`WindowEvent`, `ReplaceUrl`,
//!   `ActionResolved`, `BadPayload`, ...): it goes to the callback, in
//!   order.
//!
//! - [`Effect::OpenEventSource`] / [`Effect::CloseEventSource`] (U01k) run
//!   an [`EventSource`] per [`StreamId`] ([`Driver::open_stream`] /
//!   [`Driver::close_stream`]). Its events come back through
//!   [`Driver::step`] as `ChatState::event_source_open` /
//!   `event_source_message` / `event_source_error` (U02d). A message whose
//!   `event:` isn't `message` reaches no `onmessage`, so it is dropped, as
//!   the browser drops it. The machine ignores a stream it didn't open, or
//!   one whose session is no longer bound; [`Driver::on_stream_event`]
//!   observes every event either way.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use claudius_client::ClientEnv;
use claudius_client::effect::{self, Effect, FetchId, FetchOutcome, StreamId, TimerId};
use claudius_client::state::ChatState;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::{EventSource, EventSourceEvent, EventSourceOptions, Transport};

/// What came back from the outside world.
#[derive(Debug)]
enum Completion {
    Fetch(FetchId, FetchOutcome),
    Timer(TimerId),
    /// An event of the stream with this id (`StreamId.0`), from its
    /// `open_stream` numbered here.
    Stream(u64, u64, EventSourceEvent),
}

/// The UI's effects: everything the driver doesn't run itself.
pub type UiCallback = Box<dyn FnMut(Effect) + Send>;

/// Observes each stream event before the state machine gets it (tests,
/// diagnostics). Gets the stream id and the event.
pub type StreamTap = Box<dyn FnMut(u64, &EventSourceEvent) + Send>;

/// A `ChatState` with its host: fetches, timers and streams over a
/// transport, the UI's effects to a callback.
pub struct Driver<E: ClientEnv> {
    pub state: ChatState,
    pub env: E,
    transport: Arc<dyn Transport>,
    on_ui: UiCallback,
    on_stream: Option<StreamTap>,
    tx: mpsc::UnboundedSender<Completion>,
    rx: mpsc::UnboundedReceiver<Completion>,
    fetches: usize,
    /// Armed timers: the task, and whether it repeats.
    timers: HashMap<TimerId, (AbortHandle, bool)>,
    /// Open streams: the pump task and which `open_stream` it is (a
    /// reopened id's old events are dropped).
    streams: HashMap<u64, (AbortHandle, u64)>,
    opened: u64,
    stream_opts: EventSourceOptions,
}

impl<E: ClientEnv> Driver<E> {
    pub fn new(
        state: ChatState,
        env: E,
        transport: Arc<dyn Transport>,
        on_ui: impl FnMut(Effect) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            state,
            env,
            transport,
            on_ui: Box::new(on_ui),
            on_stream: None,
            tx,
            rx,
            fetches: 0,
            timers: HashMap::new(),
            streams: HashMap::new(),
            opened: 0,
            stream_opts: EventSourceOptions::default(),
        }
    }

    /// The options the driver's event sources get.
    pub fn with_stream_options(mut self, opts: EventSourceOptions) -> Self {
        self.stream_opts = opts;
        self
    }

    /// Observe every stream event, before the state machine gets it.
    pub fn on_stream_event(&mut self, tap: impl FnMut(u64, &EventSourceEvent) + Send + 'static) {
        self.on_stream = Some(Box::new(tap));
    }

    /// Call into the state machine (an action, a server event, ...) and run
    /// what it asks for.
    pub fn act(&mut self, f: impl FnOnce(&mut ChatState, &mut E) -> Vec<Effect>) {
        let effects = f(&mut self.state, &mut self.env);
        self.run(effects);
    }

    /// Run `effects`, in order.
    pub fn run(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Fetch(req) => {
                    self.fetches += 1;
                    let (transport, tx) = (self.transport.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let outcome = transport.fetch_outcome(&req).await;
                        let _ = tx.send(Completion::Fetch(req.id, outcome));
                    });
                }
                Effect::SetTimer { id, ms, repeat } => {
                    let delay = timer_delay(ms, repeat);
                    let tx = self.tx.clone();
                    let task = tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(delay).await;
                            if tx.send(Completion::Timer(id)).is_err() || !repeat {
                                return;
                            }
                        }
                    });
                    if let Some((old, _)) = self.timers.insert(id, (task.abort_handle(), repeat)) {
                        old.abort();
                    }
                }
                Effect::ClearTimer { id } => {
                    if let Some((t, _)) = self.timers.remove(&id) {
                        t.abort();
                    }
                }
                Effect::OpenEventSource { id, url } => self.open_stream(id.0, &url),
                Effect::CloseEventSource { id } => self.close_stream(id.0),
                ui => (self.on_ui)(ui),
            }
        }
    }

    /// Open stream `id`: `new EventSource(url)`, its events fed back
    /// through [`Self::step`]. An open stream of the same id is closed
    /// first.
    pub fn open_stream(&mut self, id: u64, url: &str) {
        self.close_stream(id);
        self.opened += 1;
        let generation = self.opened;
        let mut es = EventSource::open(self.transport.clone(), url, self.stream_opts);
        let tx = self.tx.clone();
        let task = tokio::spawn(async move {
            while let Some(ev) = es.recv().await {
                if tx.send(Completion::Stream(id, generation, ev)).is_err() {
                    return;
                }
            }
        });
        self.streams.insert(id, (task.abort_handle(), generation));
    }

    /// `es.close()` of stream `id`: no event of it after this.
    pub fn close_stream(&mut self, id: u64) {
        if let Some((t, _)) = self.streams.remove(&id) {
            t.abort();
        }
    }

    /// Whether anything is still out (a fetch, an armed timer, an open
    /// stream): [`Self::step`] would wait for it.
    pub fn busy(&self) -> bool {
        self.fetches > 0 || !self.timers.is_empty() || !self.streams.is_empty()
    }

    /// Wait for the next fetch, timer expiry or stream event, feed it to
    /// the state machine and run what that asks for. `false` (at once)
    /// when nothing is out.
    pub async fn step(&mut self) -> bool {
        loop {
            if !self.busy() {
                return false;
            }
            let Some(done) = self.rx.recv().await else {
                return false;
            };
            let effects = match done {
                Completion::Fetch(id, outcome) => {
                    self.fetches -= 1;
                    self.state.fetch_settled(id, outcome, &mut self.env)
                }
                Completion::Timer(id) => {
                    let Some(&(_, repeat)) = self.timers.get(&id) else {
                        continue; // cleared after it fired
                    };
                    if !repeat {
                        self.timers.remove(&id);
                    }
                    self.state.timer_fired(id, &mut self.env)
                }
                Completion::Stream(id, generation, ev) => {
                    if self.streams.get(&id).map(|s| s.1) != Some(generation) {
                        continue; // closed (or reopened) after it was queued
                    }
                    if matches!(
                        ev,
                        EventSourceEvent::Error {
                            ready_state: crate::ReadyState::Closed
                        }
                    ) {
                        self.streams.remove(&id);
                    }
                    self.stream_input(id, &ev)
                }
            };
            self.run(effects);
            return true;
        }
    }

    /// Step until nothing is out, or `limit` steps.
    pub async fn run_until_idle(&mut self, limit: usize) -> usize {
        let mut n = 0;
        while n < limit && self.step().await {
            n += 1;
        }
        n
    }

    /// A stream event into the state machine: `onopen`, `onmessage` (only
    /// for `event: message`, as `onmessage` hears only those) and `onerror`
    /// with the source's `readyState` then.
    fn stream_input(&mut self, id: u64, ev: &EventSourceEvent) -> Vec<Effect> {
        if let Some(tap) = self.on_stream.as_mut() {
            tap(id, ev);
        }
        let id = StreamId(id);
        match ev {
            EventSourceEvent::Open => self.state.event_source_open(id, &mut self.env),
            EventSourceEvent::Message {
                data, event_type, ..
            } if event_type == "message" => {
                self.state.event_source_message(id, data, &mut self.env)
            }
            EventSourceEvent::Message { .. } => Vec::new(),
            EventSourceEvent::Error { ready_state } => {
                let rs = match ready_state {
                    crate::ReadyState::Connecting => effect::ReadyState::Connecting,
                    crate::ReadyState::Open => effect::ReadyState::Open,
                    crate::ReadyState::Closed => effect::ReadyState::Closed,
                };
                self.state.event_source_error(id, rs, &mut self.env)
            }
        }
    }
}

impl<E: ClientEnv> Drop for Driver<E> {
    fn drop(&mut self) {
        for (t, _) in self.timers.values() {
            t.abort();
        }
        for (t, _) in self.streams.values() {
            t.abort();
        }
    }
}

/// `setTimeout` / `setInterval`'s delay (see the module docs).
pub(crate) fn timer_delay(ms: f64, repeat: bool) -> Duration {
    let ms = to_int32(ms).max(0) as u64;
    Duration::from_millis(if repeat { ms.max(1) } else { ms })
}

/// ECMAScript `ToInt32`.
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc().rem_euclid(4_294_967_296.0);
    if m >= 2_147_483_648.0 {
        (m - 4_294_967_296.0) as i32
    } else {
        m as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timer_delays_are_set_timeouts() {
        let ms = |x: f64, r: bool| timer_delay(x, r).as_millis();
        assert_eq!(ms(30_000.0, true), 30_000);
        assert_eq!(ms(1.9, false), 1);
        assert_eq!(ms(-5.0, false), 0);
        assert_eq!(ms(f64::NAN, false), 0);
        assert_eq!(ms(f64::INFINITY, false), 0);
        assert_eq!(ms(0.0, false), 0);
        assert_eq!(ms(0.0, true), 1);
        // `long` wraps: 2^31 is negative, so 0; 2^32 + 5 is 5.
        assert_eq!(ms(2_147_483_648.0, false), 0);
        assert_eq!(ms(4_294_967_301.0, false), 5);
        assert_eq!(ms(2_147_483_647.0, false), 2_147_483_647);
        assert_eq!(ms(-4_294_967_291.0, false), 5);
    }
}
