//! SDK hook callbacks (`Options.hooks`). The CLI is told about them in the
//! `initialize` request as `{ Event: [{ matcher, hookCallbackIds, timeout }] }`
//! and calls back with `hook_callback` control requests.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait HookCallback: Send + Sync {
    /// Returns the hook output object (e.g. `{ "continue": true }`).
    async fn call(
        &self,
        input: Value,
        tool_use_id: Option<String>,
        cancel: CancellationToken,
    ) -> Value;
}

#[derive(Clone)]
pub struct HookMatcher {
    pub matcher: Option<String>,
    pub hooks: Vec<Arc<dyn HookCallback>>,
    /// Seconds.
    pub timeout: Option<u64>,
}

impl HookMatcher {
    pub fn new(hook: Arc<dyn HookCallback>) -> Self {
        Self {
            matcher: None,
            hooks: vec![hook],
            timeout: None,
        }
    }
}

type BoxFut = Pin<Box<dyn Future<Output = Value> + Send>>;

/// Adapter so a closure can be used as a hook.
pub struct FnHook<F>(pub F);

#[async_trait]
impl<F> HookCallback for FnHook<F>
where
    F: Fn(Value, Option<String>) -> BoxFut + Send + Sync,
{
    async fn call(
        &self,
        input: Value,
        tool_use_id: Option<String>,
        _cancel: CancellationToken,
    ) -> Value {
        (self.0)(input, tool_use_id).await
    }
}

/// `hook_fn(|input, tool_use_id| async move { json!({"continue": true}) })`
pub fn hook_fn<F, Fut>(f: F) -> Arc<dyn HookCallback>
where
    F: Fn(Value, Option<String>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Value> + Send + 'static,
{
    Arc::new(FnHook(move |i, t| Box::pin(f(i, t)) as BoxFut))
}
