//! The `lib/client/types.ts` shapes the ported helpers read and build.
//!
//! They (de)serialize in the client's *snapshot JSON*, which the golden
//! recorder writes for the TS values too: the TS field names, a `None`
//! field omitted (`undefined`), a `Set` as an array in insertion order, a
//! `Record` as an object in JS own-key order, and a number as JS prints it,
//! except that `NaN`, `±Infinity` and `-0` (which JSON can't hold) are
//! `{"$num": "NaN"}` and so on.

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A TS `Record<string, V>` the UI iterates: own-key order (array-index
/// keys ascending, then the rest in insertion order). Insert with
/// [`record_set`].
pub type JsRecord<V> = IndexMap<String, V>;

/// `{ ...map, [key]: value }`: an existing key keeps its place, a new one
/// goes last, or among the leading array-index keys in ascending order.
pub fn record_set<V>(map: &mut JsRecord<V>, key: &str, value: V) {
    if let Some(slot) = map.get_mut(key) {
        *slot = value;
        return;
    }
    let Some(n) = claudius_agent::js::array_index(key) else {
        map.insert(key.to_owned(), value);
        return;
    };
    let at = map
        .keys()
        .position(|k| claudius_agent::js::array_index(k).is_none_or(|m| m > n))
        .unwrap_or(map.len());
    map.shift_insert(at, key.to_owned(), value);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// `DisplayBlock`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DisplayBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    ToolUse {
        id: String,
        name: String,
        /// The SDK's `input` as sent (`?? {}`); not checked to be an object.
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
        #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
        started_at: Option<f64>,
    },
}

impl DisplayBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// The text of a `text` block.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            _ => None,
        }
    }

    /// The id of a `tool_use` block.
    pub fn tool_use_id(&self) -> Option<&str> {
        match self {
            Self::ToolUse { id, .. } => Some(id),
            _ => None,
        }
    }
}

/// A `tool_use` block's `result`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_run: Option<bool>,
}

/// `DisplayMessage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMessage {
    pub uuid: String,
    pub role: Role,
    pub blocks: Vec<DisplayBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "string_set")]
    pub folded_sdk_uuids: Option<IndexSet<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<AttachedImage>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub created_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_hit: Option<RateLimitHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opus_high_demand: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<PeerInfo>,
}

impl DisplayMessage {
    /// A message with only the required fields.
    pub fn new(uuid: impl Into<String>, role: Role, blocks: Vec<DisplayBlock>) -> Self {
        Self {
            uuid: uuid.into(),
            role,
            blocks,
            streaming: None,
            pending: None,
            parent_tool_use_id: None,
            folded_sdk_uuids: None,
            images: None,
            created_at: None,
            rate_limit_hit: None,
            opus_high_demand: None,
            aborted: None,
            error_tag: None,
            peer: None,
        }
    }
}

/// `DisplayMessage["rateLimitHit"]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitHit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub resets_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_user_purchase_credits: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_chargeable_saved_payment_method: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_type: Option<String>,
}

/// `DisplayMessage["peer"]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub pid: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
}

/// `AttachedImage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedImage {
    pub id: String,
    #[serde(with = "num")]
    pub ordinal: f64,
    pub data: String,
    pub media_type: String,
}

/// `AgentTodo`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTodo {
    pub id: String,
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

/// `BackgroundBash`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundBash {
    pub tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bash_id: Option<String>,
    pub command: String,
    #[serde(with = "num")]
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub killed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub timed_out_after_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_with_agent_final_response: Option<bool>,
}

/// `ToolProgressInfo`. `parentToolUseId` and `errorStatus` are always
/// there on the wire (`null` for none), so `None` writes `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgressInfo {
    pub tool_use_id: String,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub elapsed_seconds: Option<f64>,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_retry: Option<SubagentRetry>,
}

/// `ToolProgressInfo["subagentRetry"]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRetry {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub attempt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub max_retries: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub retry_delay_ms: Option<f64>,
    #[serde(default, with = "num::opt")]
    pub error_status: Option<f64>,
    pub error_category: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemEntryKind {
    Init,
    HookStarted,
    HookResponse,
    Status,
    CompactBoundary,
    RateLimit,
    ApiRetry,
    PermissionDenied,
    ModelFallback,
    SystemReminder,
    ConversationReset,
    Notification,
    ModelRefusal,
    Info,
}

/// `SystemEntry`: a pill or divider between messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEntry {
    pub uuid: String,
    pub after_message_uuid: String,
    pub kind: SystemEntryKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_user_message_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<RateLimitInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_stats: Option<CompactStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_failed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_trigger: Option<String>,
}

impl SystemEntry {
    /// An entry with only the required fields.
    pub fn new(
        uuid: impl Into<String>,
        after_message_uuid: impl Into<String>,
        kind: SystemEntryKind,
        label: impl Into<String>,
    ) -> Self {
        Self {
            uuid: uuid.into(),
            after_message_uuid: after_message_uuid.into(),
            kind,
            label: label.into(),
            detail: None,
            ts: None,
            priority: None,
            info_level: None,
            refused_user_message_uuid: None,
            count: None,
            rate_limit: None,
            compact_stats: None,
            compact_summary: None,
            reminder_body: None,
            hook_failed: None,
            hook_stderr: None,
            reset_trigger: None,
        }
    }
}

/// `SystemEntry["rateLimit"]`: the last `rate_limit_event`'s info.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub resets_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub utilization: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overage_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub overage_resets_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overage_disabled_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_using_overage: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overage_in_use: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overage_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub surpassed_threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_user_purchase_credits: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_chargeable_saved_payment_method: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_scope: Option<String>,
}

/// `SystemEntry["compactStats"]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactStats {
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub pre_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub post_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

/// A `Set<string>` in snapshot JSON: an array in insertion order.
mod string_set {
    use indexmap::IndexSet;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        set: &Option<IndexSet<String>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match set {
            Some(set) => s.collect_seq(set),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<IndexSet<String>>, D::Error> {
        Ok(Option::<Vec<String>>::deserialize(d)?.map(|v| v.into_iter().collect()))
    }
}

/// JS numbers in snapshot JSON: integral values as integers (`3`, not
/// `3.0`), and the values JSON can't hold as `{"$num": "NaN"}`,
/// `"Infinity"`, `"-Infinity"` or `"-0"`.
pub mod num {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::Value;

    /// The snapshot JSON of the JS number `x`.
    pub fn to_value(x: f64) -> Value {
        let text = if x.is_nan() {
            "NaN"
        } else if x == f64::INFINITY {
            "Infinity"
        } else if x == f64::NEG_INFINITY {
            "-Infinity"
        } else if x == 0.0 && x.is_sign_negative() {
            "-0"
        } else {
            return claudius_core::js_num(x);
        };
        serde_json::json!({ "$num": text })
    }

    /// The JS number a snapshot JSON value holds.
    pub fn from_value(v: &Value) -> Option<f64> {
        if let Some(x) = v.as_f64() {
            return Some(x);
        }
        Some(match v.get("$num")?.as_str()? {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            _ => return None,
        })
    }

    pub fn serialize<S: Serializer>(x: &f64, s: S) -> Result<S::Ok, S::Error> {
        to_value(*x).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        let v = Value::deserialize(d)?;
        from_value(&v).ok_or_else(|| serde::de::Error::custom(format!("not a JS number: {v}")))
    }

    pub mod opt {
        use super::*;

        pub fn serialize<S: Serializer>(x: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
            match x {
                Some(x) => super::serialize(x, s),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
            let v = Value::deserialize(d)?;
            if v.is_null() {
                return Ok(None);
            }
            from_value(&v)
                .map(Some)
                .ok_or_else(|| serde::de::Error::custom(format!("not a JS number: {v}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_set_keeps_js_own_key_order() {
        let mut m: JsRecord<u8> = JsRecord::new();
        for (k, v) in [
            ("b", 1),
            ("10", 2),
            ("a", 3),
            ("2", 4),
            ("b", 5),
            ("01", 6),
            ("0", 7),
        ] {
            record_set(&mut m, k, v);
        }
        let got: Vec<(&str, u8)> = m.iter().map(|(k, v)| (k.as_str(), *v)).collect();
        assert_eq!(
            got,
            [("0", 7), ("2", 4), ("10", 2), ("b", 5), ("a", 3), ("01", 6)]
        );
    }

    #[test]
    fn numbers_round_trip_through_snapshot_json() {
        for x in [
            0.0,
            -0.0,
            1.5,
            3.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            1e21,
        ] {
            let v = num::to_value(x);
            let back = num::from_value(&v).unwrap();
            assert!(
                back == x || (back.is_nan() && x.is_nan()),
                "{x} -> {v} -> {back}"
            );
            assert_eq!(back.is_sign_negative(), x.is_sign_negative(), "{x}");
        }
        assert_eq!(num::to_value(3.0).to_string(), "3");
        assert_eq!(num::to_value(-0.0).to_string(), r#"{"$num":"-0"}"#);
    }
}
