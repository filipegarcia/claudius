//! Dump list/info/messages as JSON for parity checks against the TS SDK.
//!   parity_dump list [limit]        → listSessions({limit})
//!   parity_dump messages <id>...    → getSessionMessages(id, {includeSystemMessages:true}) per id
use claudius_core::sessions_list::{ListOptions, list_sessions};
use claudius_core::sessions_store as ss;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("list") => {
            let opts = ListOptions {
                limit: args.get(1).and_then(|s| s.parse().ok()),
                ..Default::default()
            };
            println!("{}", serde_json::to_string(&list_sessions(&opts)).unwrap());
        }
        Some("messages") => {
            let out: serde_json::Map<String, serde_json::Value> = args[1..]
                .iter()
                .map(|id| {
                    (
                        id.clone(),
                        serde_json::Value::Array(ss::messages(id, None, true)),
                    )
                })
                .collect();
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        _ => eprintln!("usage: parity_dump list [limit] | messages <id>..."),
    }
}
