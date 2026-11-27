//! MCP elicitation: `lib/shared/elicitation.ts` (the schema → fields
//! mapping, the form's initial values, its validation and coercion, the
//! link check) and `components/chat/McpElicitationPrompt.tsx` (the card's
//! content, state and the decision each control sends).
//!
//! Everything an elicitation carries is server-authored: the form schema is
//! reduced to the flat primitive subset the MCP spec allows (anything else
//! is skipped), and a link is only opened when it is http(s) and not the
//! app's own origin.

use claudius_agent::js;
use claudius_core::js_string;
use serde_json::{Map, Value, json};

/// `MAX_FIELDS` / `MAX_OPTIONS` / `MAX_VALUE_CHARS` (elicitation.ts:14-16).
pub const MAX_FIELDS: usize = 50;
pub const MAX_OPTIONS: usize = 200;
pub const MAX_VALUE_CHARS: usize = 10_000;
/// `UNSAFE_KEYS` (elicitation.ts:18).
const UNSAFE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// A link the card may open (`safeElicitationUrl`'s `URL`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafeUrl {
    /// `url.href`.
    pub href: String,
    /// `url.host` (with a non-default port).
    pub host: String,
    /// `url.origin`.
    pub origin: String,
}

/// `safeElicitationUrl(raw)` (elicitation.ts:24): the parsed URL when it is
/// http(s), else `None` (never a `javascript:` / `data:` / `file:` link).
pub fn safe_elicitation_url(raw: Option<&str>) -> Option<SafeUrl> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let u = url::Url::parse(raw).ok()?;
    if !matches!(u.scheme(), "https" | "http") {
        return None;
    }
    let host = match (u.host_str(), u.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_owned(),
        (None, _) => String::new(),
    };
    Some(SafeUrl {
        href: u.as_str().to_owned(),
        host,
        origin: u.origin().ascii_serialization(),
    })
}

/// `ElicitationOption`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

/// The kind-specific half of `ElicitationField` (elicitation.ts:36).
#[derive(Clone, Debug, PartialEq)]
pub enum FieldKind {
    String {
        format: Option<String>,
        min_length: Option<f64>,
        max_length: Option<f64>,
        default: Option<String>,
    },
    Number {
        integer: bool,
        minimum: Option<f64>,
        maximum: Option<f64>,
        default: Option<f64>,
    },
    Boolean {
        default: Option<bool>,
    },
    Enum {
        options: Vec<FieldOption>,
        default: Option<String>,
    },
    MultiEnum {
        options: Vec<FieldOption>,
        min_items: Option<f64>,
        max_items: Option<f64>,
        default: Option<Vec<String>>,
    },
}

/// `ElicitationField`.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: FieldKind,
}

fn options_json(options: &[FieldOption]) -> Value {
    Value::Array(
        options
            .iter()
            .map(|o| json!({ "value": o.value, "label": o.label }))
            .collect(),
    )
}

impl Field {
    /// The field as the TS builds it: `{ key, label, description?,
    /// required, kind, ... }` in that key order (for the golden).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("key".into(), json!(self.key));
        m.insert("label".into(), json!(self.label));
        if let Some(d) = &self.description {
            m.insert("description".into(), json!(d));
        }
        m.insert("required".into(), json!(self.required));
        let opt = |m: &mut Map<String, Value>, k: &str, v: Option<Value>| {
            if let Some(v) = v {
                m.insert(k.into(), v);
            }
        };
        let num = |n: &Option<f64>| n.map(claudius_core::js_num);
        match &self.kind {
            FieldKind::MultiEnum {
                options,
                min_items,
                max_items,
                default,
            } => {
                m.insert("kind".into(), json!("multi-enum"));
                m.insert("options".into(), options_json(options));
                opt(&mut m, "minItems", num(min_items));
                opt(&mut m, "maxItems", num(max_items));
                opt(&mut m, "default", default.as_ref().map(|d| json!(d)));
            }
            FieldKind::Enum { options, default } => {
                m.insert("kind".into(), json!("enum"));
                m.insert("options".into(), options_json(options));
                opt(&mut m, "default", default.as_ref().map(|d| json!(d)));
            }
            FieldKind::String {
                format,
                min_length,
                max_length,
                default,
            } => {
                m.insert("kind".into(), json!("string"));
                opt(&mut m, "format", format.as_ref().map(|f| json!(f)));
                opt(&mut m, "minLength", num(min_length));
                opt(&mut m, "maxLength", num(max_length));
                opt(&mut m, "default", default.as_ref().map(|d| json!(d)));
            }
            FieldKind::Number {
                integer,
                minimum,
                maximum,
                default,
            } => {
                m.insert("kind".into(), json!("number"));
                m.insert("integer".into(), json!(integer));
                opt(&mut m, "minimum", num(minimum));
                opt(&mut m, "maximum", num(maximum));
                opt(&mut m, "default", num(default));
            }
            FieldKind::Boolean { default } => {
                m.insert("kind".into(), json!("boolean"));
                opt(&mut m, "default", default.map(Value::Bool));
            }
        }
        Value::Object(m)
    }

    /// The `<input type>` the TS picks for a text field
    /// (McpElicitationPrompt.tsx:315): `number`, `email`, `url`, `date`,
    /// else `text` (`date-time` stays free text). The native field is a
    /// text input either way; this is its hint.
    pub fn input_type(&self) -> &'static str {
        match &self.kind {
            FieldKind::Number { .. } => "number",
            FieldKind::String { format, .. } => match format.as_deref() {
                Some("email") => "email",
                Some("uri") => "url",
                Some("date") => "date",
                _ => "text",
            },
            _ => "text",
        }
    }

    /// The options of an enum / multi-enum field.
    pub fn options(&self) -> &[FieldOption] {
        match &self.kind {
            FieldKind::Enum { options, .. } | FieldKind::MultiEnum { options, .. } => options,
            _ => &[],
        }
    }
}

/// `isRecord(v)`: a non-null, non-array object.
fn record(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

/// `num(v)`: a finite number.
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// `str(v)`: a non-empty string.
fn str_(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `readOptions(def)` (elicitation.ts:56): `enum` (+ legacy `enumNames`)
/// or `oneOf` / `anyOf` of `{ const, title }`; `None` when neither is an
/// array.
fn read_options(def: &Map<String, Value>) -> Option<Vec<FieldOption>> {
    if let Some(values) = def.get("enum").and_then(Value::as_array) {
        let names = def.get("enumNames").and_then(Value::as_array);
        let out = values
            .iter()
            .enumerate()
            .filter_map(|(i, v)| {
                let value = v.as_str()?;
                let label = names
                    .and_then(|n| n.get(i))
                    .and_then(Value::as_str)
                    .unwrap_or(value);
                Some(FieldOption {
                    value: value.to_owned(),
                    label: label.to_owned(),
                })
            })
            .take(MAX_OPTIONS)
            .collect();
        return Some(out);
    }
    let variants = def
        .get("oneOf")
        .and_then(Value::as_array)
        .or_else(|| def.get("anyOf").and_then(Value::as_array))?;
    Some(
        variants
            .iter()
            .filter_map(|v| {
                let o = v.as_object()?;
                let value = o.get("const")?.as_str()?;
                let label = o
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .unwrap_or(value);
                Some(FieldOption {
                    value: value.to_owned(),
                    label: label.to_owned(),
                })
            })
            .take(MAX_OPTIONS)
            .collect(),
    )
}

/// `parseElicitationSchema(schema)` (elicitation.ts:84): a form-mode
/// `requestedSchema` as renderable fields, in property order (own-key
/// order: integer-like keys first). Unsupported shapes are skipped.
pub fn parse_elicitation_schema(schema: Option<&Value>) -> Vec<Field> {
    let Some(schema) = record(schema) else {
        return Vec::new();
    };
    let Some(props) = record(schema.get("properties")) else {
        return Vec::new();
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut fields = Vec::new();
    for (key, def) in js::own_keys_order(props) {
        if fields.len() >= MAX_FIELDS {
            break;
        }
        let Some(def) = def.as_object() else { continue };
        if UNSAFE_KEYS.contains(&key.as_str()) {
            continue;
        }
        let base = |kind| Field {
            key: key.clone(),
            label: str_(def.get("title")).unwrap_or_else(|| key.clone()),
            description: str_(def.get("description")),
            required: required.contains(&key.as_str()),
            kind,
        };
        let ty = def.get("type").and_then(Value::as_str);
        if ty == Some("array") {
            let options = record(def.get("items")).and_then(read_options);
            let Some(options) = options.filter(|o| !o.is_empty()) else {
                continue;
            };
            let default = def.get("default").and_then(Value::as_array).map(|d| {
                d.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            });
            fields.push(base(FieldKind::MultiEnum {
                options,
                min_items: num(def.get("minItems")),
                max_items: num(def.get("maxItems")),
                default,
            }));
            continue;
        }
        if let Some(options) = read_options(def).filter(|o| !o.is_empty()) {
            fields.push(base(FieldKind::Enum {
                options,
                default: str_(def.get("default")),
            }));
            continue;
        }
        match ty {
            Some("string") => fields.push(base(FieldKind::String {
                format: str_(def.get("format")),
                min_length: num(def.get("minLength")),
                max_length: num(def.get("maxLength")),
                default: def
                    .get("default")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })),
            Some(t @ ("number" | "integer")) => fields.push(base(FieldKind::Number {
                integer: t == "integer",
                minimum: num(def.get("minimum")),
                maximum: num(def.get("maximum")),
                default: num(def.get("default")),
            })),
            Some("boolean") => fields.push(base(FieldKind::Boolean {
                default: def.get("default").and_then(Value::as_bool),
            })),
            _ => {}
        }
    }
    fields
}

/// One field's raw form state: text inputs hold strings, checkboxes
/// booleans, multi-selects lists (`ElicitationFormValues`' values).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldValue {
    Text(String),
    Bool(bool),
    Multi(Vec<String>),
}

impl FieldValue {
    pub fn to_json(&self) -> Value {
        match self {
            FieldValue::Text(s) => json!(s),
            FieldValue::Bool(b) => json!(b),
            FieldValue::Multi(v) => json!(v),
        }
    }

    /// A form value from JSON (the golden's): a string, a boolean or a
    /// list of strings; `None` for anything else (`undefined`).
    pub fn from_json(v: &Value) -> Option<FieldValue> {
        match v {
            Value::String(s) => Some(FieldValue::Text(s.clone())),
            Value::Bool(b) => Some(FieldValue::Bool(*b)),
            Value::Array(a) => Some(FieldValue::Multi(
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            )),
            _ => None,
        }
    }
}

/// The form's values by field key, in field order.
pub type FormValues = Vec<(String, FieldValue)>;

fn value_of<'a>(values: &'a FormValues, key: &str) -> Option<&'a FieldValue> {
    values.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `initialFormValues(fields)` (elicitation.ts:145).
pub fn initial_form_values(fields: &[Field]) -> FormValues {
    fields
        .iter()
        .map(|f| {
            let v = match &f.kind {
                FieldKind::Boolean { default } => FieldValue::Bool(default.unwrap_or(false)),
                FieldKind::MultiEnum { default, .. } => {
                    FieldValue::Multi(default.clone().unwrap_or_default())
                }
                FieldKind::Number { default, .. } => {
                    FieldValue::Text(default.map(js::number_to_string).unwrap_or_default())
                }
                FieldKind::String { default, .. } | FieldKind::Enum { default, .. } => {
                    FieldValue::Text(default.clone().unwrap_or_default())
                }
            };
            (f.key.clone(), v)
        })
        .collect()
}

/// `buildElicitationContent(fields, values)` (elicitation.ts:160): the
/// `content` to send (keys in field order), or per-field error messages.
pub fn build_elicitation_content(
    fields: &[Field],
    values: &FormValues,
) -> Result<Map<String, Value>, Map<String, Value>> {
    let mut content = Map::new();
    let mut errors = Map::new();
    let n = |x: f64| js::number_to_string(x);
    for f in fields {
        let v = value_of(values, &f.key);
        let key = f.key.clone();
        match &f.kind {
            FieldKind::Boolean { .. } => {
                content.insert(key, json!(v == Some(&FieldValue::Bool(true))));
                continue;
            }
            FieldKind::MultiEnum {
                options,
                min_items,
                max_items,
                ..
            } => {
                let picked: Vec<String> = match v {
                    Some(FieldValue::Multi(list)) => list
                        .iter()
                        .filter(|x| options.iter().any(|o| &o.value == *x))
                        .cloned()
                        .collect(),
                    _ => Vec::new(),
                };
                let len = picked.len() as f64;
                if f.required && picked.is_empty() {
                    errors.insert(key.clone(), json!("Pick at least one"));
                } else if let Some(min) = min_items.filter(|m| len > 0.0 && len < *m) {
                    errors.insert(key.clone(), json!(format!("Pick at least {}", n(min))));
                } else if let Some(max) = max_items.filter(|m| len > *m) {
                    errors.insert(key.clone(), json!(format!("Pick at most {}", n(max))));
                }
                if !picked.is_empty() {
                    content.insert(key, json!(picked));
                }
                continue;
            }
            _ => {}
        }
        let text = match v {
            Some(FieldValue::Text(s)) => js::trim(s),
            _ => "",
        };
        if text.is_empty() {
            if f.required {
                errors.insert(key, json!("Required"));
            }
            continue;
        }
        match &f.kind {
            FieldKind::Number {
                integer,
                minimum,
                maximum,
                ..
            } => {
                let x = js::to_number(text);
                if !x.is_finite() {
                    errors.insert(key, json!("Enter a number"));
                } else if *integer && x.fract() != 0.0 {
                    errors.insert(key, json!("Enter a whole number"));
                } else if let Some(min) = minimum.filter(|m| x < *m) {
                    errors.insert(key, json!(format!("Must be at least {}", n(min))));
                } else if let Some(max) = maximum.filter(|m| x > *m) {
                    errors.insert(key, json!(format!("Must be at most {}", n(max))));
                } else {
                    content.insert(key, claudius_core::js_num(x));
                }
            }
            FieldKind::Enum { options, .. } => {
                if options.iter().any(|o| o.value == text) {
                    content.insert(key, json!(text));
                } else {
                    errors.insert(key, json!("Pick an option"));
                }
            }
            FieldKind::String {
                min_length,
                max_length,
                ..
            } => {
                let len = js_string::len16(text) as f64;
                if let Some(min) = min_length.filter(|m| len < *m) {
                    errors.insert(key, json!(format!("At least {} characters", n(min))));
                } else if let Some(max) = max_length.filter(|m| len > *m) {
                    errors.insert(key, json!(format!("At most {} characters", n(max))));
                } else {
                    content.insert(key, json!(slice16(text, MAX_VALUE_CHARS)));
                }
            }
            FieldKind::Boolean { .. } | FieldKind::MultiEnum { .. } => unreachable!(),
        }
    }
    if errors.is_empty() {
        Ok(content)
    } else {
        Err(errors)
    }
}

/// `s.slice(0, n)` over UTF-16 units (a cut astral pair keeps its lone
/// first half, as JS does).
fn slice16(s: &str, n: usize) -> String {
    if js_string::len16(s) <= n {
        return s.to_owned();
    }
    js_string::from_units(&js_string::units(s)[..n])
}

/// `ElicitationDecision` (events.ts:577).
#[derive(Clone, Debug, PartialEq)]
pub enum ElicitationDecision {
    /// "Submit" / "Accept" (with the form's content), "Open link", "I'm
    /// done, continue" (without).
    Accept(Option<Map<String, Value>>),
    /// "Decline": an explicit no.
    Decline,
    /// Escape: dismissed (MCP servers may treat it apart from a decline).
    Cancel,
}

impl ElicitationDecision {
    pub fn to_json(&self) -> Value {
        match self {
            ElicitationDecision::Accept(None) => json!({ "action": "accept" }),
            ElicitationDecision::Accept(Some(c)) => {
                json!({ "action": "accept", "content": Value::Object(c.clone()) })
            }
            ElicitationDecision::Decline => json!({ "action": "decline" }),
            ElicitationDecision::Cancel => json!({ "action": "cancel" }),
        }
    }
}

/// The card's content (McpElicitationPrompt.tsx:38-78).
#[derive(Clone, Debug, PartialEq)]
pub struct ElicitationCard {
    pub request_id: String,
    pub server_name: String,
    /// `mode === "url"`.
    pub is_url: bool,
    /// The title, or `{displayName ?? serverName} wants you to open a link`
    /// / `… needs some information`.
    pub heading: String,
    pub description: Option<String>,
    pub message: Option<String>,
    /// The link, when it is safe to open (url mode).
    pub url: Option<SafeUrl>,
    /// `1 of {N}` when more than one waits.
    pub queue_label: Option<String>,
    /// The form (form mode; empty in url mode).
    pub fields: Vec<Field>,
    /// CC 2.1.288: a url elicitation without an `elicitationId` can't be
    /// closed by the server, so opening the link waits for "I'm done".
    pub user_confirms_completion: bool,
}

impl ElicitationCard {
    /// The card for the queue's head. `own_origin` is the app's (a link to
    /// it isn't opened: a remote server mustn't steer the user into the
    /// app's own routes); `None` when there's no such origin.
    pub fn new(request: &Value, queue_total: Option<usize>, own_origin: Option<&str>) -> Self {
        let s = |k: &str| request.get(k).and_then(Value::as_str);
        let is_url = s("mode") == Some("url");
        let url = safe_elicitation_url(s("url")).filter(|u| Some(u.origin.as_str()) != own_origin);
        let server = js::to_string(request.get("serverName"));
        let who = match request.get("displayName") {
            Some(v) if !v.is_null() => js::to_string(Some(v)),
            _ => server.clone(),
        };
        let heading = match s("title") {
            Some(t) => t.to_owned(),
            None if is_url => format!("{who} wants you to open a link"),
            None => format!("{who} needs some information"),
        };
        ElicitationCard {
            request_id: js::to_string(request.get("requestId")),
            is_url,
            heading,
            description: s("description")
                .filter(|d| !d.is_empty())
                .map(str::to_owned),
            message: s("message").filter(|m| !m.is_empty()).map(str::to_owned),
            url,
            queue_label: queue_total.filter(|n| *n > 1).map(|n| format!("1 of {n}")),
            fields: if is_url {
                Vec::new()
            } else {
                parse_elicitation_schema(request.get("requestedSchema"))
            },
            user_confirms_completion: is_url
                && !request.get("elicitationId").is_some_and(js::truthy),
            server_name: server,
        }
    }

    /// The form's primary button: "Submit" with fields, "Accept" without.
    pub fn submit_label(&self) -> &'static str {
        if self.fields.is_empty() {
            "Accept"
        } else {
            "Submit"
        }
    }
}

/// The card's state (McpElicitationPrompt.tsx:47-55), keyed per request.
#[derive(Clone, Debug, PartialEq)]
pub struct ElicitationForm {
    pub request_id: String,
    pub values: FormValues,
    /// Per-field errors from the last submit, in field order.
    pub errors: Vec<(String, String)>,
    /// The link was opened and the card waits for "I'm done, continue".
    pub link_opened: bool,
}

/// What a control asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum ElicitationStep {
    /// Send this decision.
    Resolve(ElicitationDecision),
    /// Open the link, then keep waiting ("I'm done, continue" shows).
    OpenAndWait(String),
    /// Open the link and accept.
    OpenAndAccept(String),
    /// Nothing (invalid form: the errors show; no link to open).
    Stay,
}

impl ElicitationForm {
    pub fn new(card: &ElicitationCard) -> Self {
        ElicitationForm {
            request_id: card.request_id.clone(),
            values: initial_form_values(&card.fields),
            errors: Vec::new(),
            link_opened: false,
        }
    }

    pub fn value(&self, key: &str) -> Option<&FieldValue> {
        value_of(&self.values, key)
    }

    pub fn error(&self, key: &str) -> Option<&str> {
        self.errors
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, e)| e.as_str())
    }

    /// A field changed: store it and clear that field's error
    /// (McpElicitationPrompt.tsx:170).
    pub fn set(&mut self, key: &str, value: FieldValue) {
        match self.values.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.values.push((key.to_owned(), value)),
        }
        self.errors.retain(|(k, _)| k != key);
    }

    /// A multi-select's checkbox: add or remove the option.
    pub fn toggle_multi(&mut self, key: &str, option: &str, checked: bool) {
        let mut picked = match self.value(key) {
            Some(FieldValue::Multi(p)) => p.clone(),
            _ => Vec::new(),
        };
        if checked {
            picked.push(option.to_owned());
        } else {
            picked.retain(|p| p != option);
        }
        self.set(key, FieldValue::Multi(picked));
    }

    /// "Submit" / "Accept" (`submitForm`).
    pub fn submit(&mut self, card: &ElicitationCard) -> ElicitationStep {
        match build_elicitation_content(&card.fields, &self.values) {
            Ok(content) => ElicitationStep::Resolve(ElicitationDecision::Accept(Some(content))),
            Err(errors) => {
                self.errors = errors
                    .into_iter()
                    .map(|(k, v)| (k, v.as_str().unwrap_or_default().to_owned()))
                    .collect();
                ElicitationStep::Stay
            }
        }
    }

    /// "Open link" (`openLink`): disabled without a safe link.
    pub fn open_link(&mut self, card: &ElicitationCard) -> ElicitationStep {
        let Some(url) = &card.url else {
            return ElicitationStep::Stay;
        };
        if card.user_confirms_completion {
            self.link_opened = true;
            ElicitationStep::OpenAndWait(url.href.clone())
        } else {
            ElicitationStep::OpenAndAccept(url.href.clone())
        }
    }

    /// The url footer shows "I'm done, continue" instead of "Open link".
    pub fn shows_done(&self, card: &ElicitationCard) -> bool {
        card.user_confirms_completion && self.link_opened
    }
}

/// The card's Escape (McpElicitationPrompt.tsx:64): cancels, unless an
/// auto-repeat or within the arm window.
pub fn escape_cancels(repeat: bool, event_ms: f64, armed_at: Option<f64>) -> bool {
    !repeat && !crate::arm::is_before_prompt_armed(event_ms, armed_at)
}

/// The elicitation card shows only while no permission card is up, so two
/// modals never stack (ChatSurface.tsx:3128).
pub fn elicitation_shows(permission_pending: bool, elicitation_pending: bool) -> bool {
    !permission_pending && elicitation_pending
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudius_core::js_string::stringify;

    fn fields(schema: Value) -> Vec<Field> {
        parse_elicitation_schema(Some(&schema))
    }

    fn keys(f: &[Field]) -> Vec<&str> {
        f.iter().map(|f| f.key.as_str()).collect()
    }

    #[test]
    fn parse_elicitation_schema_keeps_the_primitive_subset_in_own_key_order() {
        let f = fields(json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "title": "Name", "minLength": 2 },
                "2": { "type": "boolean" },
                "1": { "type": "integer", "minimum": 0 },
                "obj": { "type": "object" },
                "__proto__": { "type": "string" },
                "constructor": { "type": "string" },
                "bad": "string",
                "tags": { "type": "array", "items": { "enum": ["a", "b"] } },
                "none": { "type": "array", "items": { "enum": [] } }
            },
            "required": ["name", 5, "tags"]
        }));
        assert_eq!(keys(&f), ["1", "2", "name", "tags"]);
        assert!(f[2].required && f[3].required && !f[0].required);
        assert_eq!(f[2].label, "Name");
        assert_eq!(f[0].label, "1");
        assert_eq!(
            stringify(&f[0].to_json()),
            r#"{"key":"1","label":"1","required":false,"kind":"number","integer":true,"minimum":0}"#
        );
    }

    #[test]
    fn read_options_takes_enum_names_or_one_of_titles() {
        let f = fields(json!({ "properties": {
            "a": { "type": "string", "enum": ["x", 3, "y"], "enumNames": ["Ex", "Three", ""] },
            "b": { "oneOf": [{ "const": "p", "title": "" }, { "const": 1 }, { "const": "q", "title": "Q" }] },
            "c": { "anyOf": [{ "const": "r" }], "default": "r" },
            "d": { "type": "string", "enum": [] }
        }}));
        assert_eq!(keys(&f), ["a", "b", "c", "d"]);
        let labels = |f: &Field| {
            f.options()
                .iter()
                .map(|o| (o.value.clone(), o.label.clone()))
                .collect::<Vec<_>>()
        };
        // `enumNames[i]` is the original index; an empty name is kept.
        assert_eq!(
            labels(&f[0]),
            [("x".into(), "Ex".into()), ("y".into(), "".into())]
        );
        assert_eq!(
            labels(&f[1]),
            [("p".into(), "p".into()), ("q".into(), "Q".into())]
        );
        assert_eq!(
            f[2].kind,
            FieldKind::Enum {
                options: vec![FieldOption {
                    value: "r".into(),
                    label: "r".into()
                }],
                default: Some("r".into())
            }
        );
        // An empty enum falls through to the type.
        assert!(matches!(f[3].kind, FieldKind::String { .. }));
    }

    #[test]
    fn parse_elicitation_schema_caps_fields_and_options() {
        let mut props = Map::new();
        for i in 0..60 {
            props.insert(format!("f{i}"), json!({ "type": "string" }));
        }
        assert_eq!(fields(json!({ "properties": props })).len(), MAX_FIELDS);
        let many: Vec<String> = (0..250).map(|i| format!("o{i}")).collect();
        let f = fields(json!({ "properties": { "e": { "enum": many } } }));
        assert_eq!(f[0].options().len(), MAX_OPTIONS);
        assert!(fields(json!({ "properties": [] })).is_empty());
        assert!(parse_elicitation_schema(None).is_empty());
    }

    #[test]
    fn initial_form_values_follow_the_defaults() {
        let f = fields(json!({ "properties": {
            "s": { "type": "string", "default": "" },
            "n": { "type": "number", "default": 1e21 },
            "z": { "type": "number", "default": -0.0 },
            "b": { "type": "boolean", "default": true },
            "m": { "type": "array", "items": { "enum": ["a"] }, "default": ["a", 1] },
            "e": { "enum": ["a"], "default": "" }
        }}));
        let v = initial_form_values(&f);
        assert_eq!(
            v,
            vec![
                ("s".into(), FieldValue::Text("".into())),
                ("n".into(), FieldValue::Text("1e+21".into())),
                ("z".into(), FieldValue::Text("0".into())),
                ("b".into(), FieldValue::Bool(true)),
                ("m".into(), FieldValue::Multi(vec!["a".into()])),
                ("e".into(), FieldValue::Text("".into())),
            ]
        );
    }

    fn build(schema: Value, values: Value) -> String {
        let f = fields(schema);
        let values: FormValues = values
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), FieldValue::from_json(v)?)))
            .collect();
        match build_elicitation_content(&f, &values) {
            Ok(c) => format!("ok {}", stringify(&Value::Object(c))),
            Err(e) => format!("err {}", stringify(&Value::Object(e))),
        }
    }

    #[test]
    fn build_elicitation_content_validates_and_coerces() {
        let schema = json!({ "properties": {
            "n": { "type": "integer", "minimum": 1, "maximum": 10 },
            "s": { "type": "string", "minLength": 2, "maxLength": 4 },
            "e": { "enum": ["a", "b"] },
            "b": { "type": "boolean" },
            "m": { "type": "array", "items": { "enum": ["x", "y", "z"] }, "minItems": 2, "maxItems": 2 }
        }, "required": ["s"] });
        assert_eq!(
            build(
                schema.clone(),
                json!({ "n": " 0x5 ", "s": " ab ", "e": "a", "b": true, "m": ["x", "q", "y"] })
            ),
            r#"ok {"n":5,"s":"ab","e":"a","b":true,"m":["x","y"]}"#
        );
        assert_eq!(
            build(
                schema.clone(),
                json!({ "n": "2.5", "s": "", "e": "c", "m": ["x"] })
            ),
            r#"err {"n":"Enter a whole number","s":"Required","e":"Pick an option","m":"Pick at least 2"}"#
        );
        assert_eq!(
            build(
                schema.clone(),
                json!({ "n": "11", "s": "abcde", "m": ["x", "y", "z"] })
            ),
            r#"err {"n":"Must be at most 10","s":"At most 4 characters","m":"Pick at most 2"}"#
        );
        assert_eq!(
            build(schema.clone(), json!({ "n": "abc", "s": "a" })),
            r#"err {"n":"Enter a number","s":"At least 2 characters"}"#
        );
        assert_eq!(
            build(schema, json!({ "n": "-1", "s": "ok" })),
            r#"err {"n":"Must be at least 1"}"#
        );
        // Optional and empty: left out; a boolean is always sent.
        assert_eq!(
            build(
                json!({ "properties": { "o": { "type": "string" }, "b": { "type": "boolean" } } }),
                json!({})
            ),
            r#"ok {"b":false}"#
        );
        // A required multi-select with nothing picked.
        assert_eq!(
            build(
                json!({ "properties": { "m": { "type": "array", "items": { "enum": ["x"] } } }, "required": ["m"] }),
                json!({ "m": ["nope"] })
            ),
            r#"err {"m":"Pick at least one"}"#
        );
    }

    #[test]
    fn string_values_are_capped_in_utf16_units() {
        let long = "\u{1F600}".repeat(5_001);
        let f = fields(json!({ "properties": { "s": { "type": "string" } } }));
        let c = build_elicitation_content(&f, &vec![("s".into(), FieldValue::Text(long))]).unwrap();
        let s = c["s"].as_str().unwrap();
        assert_eq!(js_string::len16(s), MAX_VALUE_CHARS);
    }

    #[test]
    fn safe_elicitation_url_is_http_only() {
        let u = safe_elicitation_url(Some(" https://Example.com:8443/a?b#c ")).unwrap();
        assert_eq!(u.href, "https://example.com:8443/a?b#c");
        assert_eq!(u.host, "example.com:8443");
        assert_eq!(u.origin, "https://example.com:8443");
        assert_eq!(
            safe_elicitation_url(Some("http://x.test:80/"))
                .unwrap()
                .host,
            "x.test"
        );
        for bad in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "nope",
            "",
        ] {
            assert_eq!(safe_elicitation_url(Some(bad)), None, "{bad}");
        }
        assert_eq!(safe_elicitation_url(None), None);
    }

    fn url_request(extra: Value) -> Value {
        let mut r = json!({ "requestId": "e1", "serverName": "linear", "message": "Sign in", "mode": "url", "url": "https://auth.example/x" });
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r
    }

    #[test]
    fn the_url_card_waits_for_done_without_an_elicitation_id() {
        let card = ElicitationCard::new(&url_request(json!({})), None, None);
        assert_eq!(card.heading, "linear wants you to open a link");
        assert!(card.user_confirms_completion);
        let mut form = ElicitationForm::new(&card);
        assert!(!form.shows_done(&card));
        assert_eq!(
            form.open_link(&card),
            ElicitationStep::OpenAndWait("https://auth.example/x".into())
        );
        assert!(form.shows_done(&card));
        let card =
            ElicitationCard::new(&url_request(json!({ "elicitationId": "el-1" })), None, None);
        assert_eq!(
            ElicitationForm::new(&card).open_link(&card),
            ElicitationStep::OpenAndAccept("https://auth.example/x".into())
        );
    }

    #[test]
    fn an_unsafe_or_own_origin_link_is_not_opened() {
        let card = ElicitationCard::new(&url_request(json!({ "url": "javascript:x" })), None, None);
        assert_eq!(card.url, None);
        assert_eq!(
            ElicitationForm::new(&card).open_link(&card),
            ElicitationStep::Stay
        );
        let card = ElicitationCard::new(
            &url_request(json!({ "url": "http://localhost:3000/x" })),
            None,
            Some("http://localhost:3000"),
        );
        assert_eq!(card.url, None);
    }

    #[test]
    fn the_form_card_heading_and_submit_label() {
        let r = json!({ "requestId": "e2", "serverName": "db", "displayName": "Postgres", "message": "", "mode": "form",
            "requestedSchema": { "properties": { "q": { "type": "string" } } } });
        let card = ElicitationCard::new(&r, Some(2), None);
        assert_eq!(card.heading, "Postgres needs some information");
        assert_eq!(card.queue_label.as_deref(), Some("1 of 2"));
        assert_eq!(card.message, None);
        assert_eq!(card.submit_label(), "Submit");
        let r =
            json!({ "requestId": "e3", "serverName": "db", "title": "Confirm", "mode": "form" });
        let card = ElicitationCard::new(&r, Some(1), None);
        assert_eq!(
            (
                card.heading.as_str(),
                card.submit_label(),
                card.queue_label.clone()
            ),
            ("Confirm", "Accept", None)
        );
    }

    #[test]
    fn a_field_change_clears_its_error() {
        let r = json!({ "requestId": "e", "serverName": "s", "mode": "form",
            "requestedSchema": { "properties": { "a": { "type": "string" }, "b": { "type": "string" } }, "required": ["a", "b"] } });
        let card = ElicitationCard::new(&r, None, None);
        let mut form = ElicitationForm::new(&card);
        assert_eq!(form.submit(&card), ElicitationStep::Stay);
        assert_eq!(form.errors.len(), 2);
        form.set("a", FieldValue::Text("x".into()));
        assert_eq!(form.error("a"), None);
        assert_eq!(form.error("b"), Some("Required"));
        form.set("b", FieldValue::Text("y".into()));
        let ElicitationStep::Resolve(d) = form.submit(&card) else {
            panic!()
        };
        assert_eq!(
            stringify(&d.to_json()),
            r#"{"action":"accept","content":{"a":"x","b":"y"}}"#
        );
    }

    #[test]
    fn toggle_multi_adds_and_removes() {
        let r = json!({ "requestId": "e", "serverName": "s", "mode": "form",
            "requestedSchema": { "properties": { "m": { "type": "array", "items": { "enum": ["x", "y"] } } } } });
        let card = ElicitationCard::new(&r, None, None);
        let mut form = ElicitationForm::new(&card);
        form.toggle_multi("m", "y", true);
        form.toggle_multi("m", "x", true);
        assert_eq!(
            form.value("m"),
            Some(&FieldValue::Multi(vec!["y".into(), "x".into()]))
        );
        form.toggle_multi("m", "y", false);
        assert_eq!(form.value("m"), Some(&FieldValue::Multi(vec!["x".into()])));
    }

    #[test]
    fn decisions_serialize_as_elicitation_decision() {
        assert_eq!(
            stringify(&ElicitationDecision::Accept(None).to_json()),
            r#"{"action":"accept"}"#
        );
        assert_eq!(
            stringify(&ElicitationDecision::Decline.to_json()),
            r#"{"action":"decline"}"#
        );
        assert_eq!(
            stringify(&ElicitationDecision::Cancel.to_json()),
            r#"{"action":"cancel"}"#
        );
    }

    #[test]
    fn elicitation_shows_only_without_a_permission() {
        assert!(elicitation_shows(false, true));
        assert!(!elicitation_shows(true, true));
        assert!(!elicitation_shows(false, false));
        assert!(escape_cancels(false, 500.0, Some(0.0)));
        assert!(!escape_cancels(true, 500.0, Some(0.0)));
        assert!(!escape_cancels(false, 399.0, Some(0.0)));
    }

    #[test]
    fn input_types_follow_the_format() {
        let f = fields(json!({ "properties": {
            "e": { "type": "string", "format": "email" }, "u": { "type": "string", "format": "uri" },
            "d": { "type": "string", "format": "date" }, "t": { "type": "string", "format": "date-time" },
            "n": { "type": "number" }, "b": { "type": "boolean" }
        }}));
        let types: Vec<_> = f.iter().map(Field::input_type).collect();
        assert_eq!(types, ["email", "url", "date", "text", "number", "text"]);
    }
}
