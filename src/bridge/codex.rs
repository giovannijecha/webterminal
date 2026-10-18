//! Codex adapter: the `notify` program reports completed turns. Codex passes
//! the event JSON as the helper's last argument.
use super::{Activity, Signal};
use crate::json::Value;
use std::path::Path;

/// `-c notify=[…]` override for one invocation, using TOML literal strings.
pub fn arguments(helper: &Path, (port, session, token): (u16, &str, &str)) -> Vec<String> {
    let helper = helper.to_string_lossy();
    if helper.contains('\'') {
        // A TOML literal string cannot hold a quote; launch without replies.
        return Vec::new();
    }
    let items = [
        helper.as_ref(),
        "bridge",
        "--port",
        &port.to_string(),
        "--session",
        session,
        "--token",
        token,
    ]
    .map(|item| format!("'{item}'"));
    vec!["-c".into(), format!("notify=[{}]", items.join(","))]
}

pub(super) fn interpret(payload: &Value) -> Signal {
    let field = |key: &str| payload.get(key).and_then(Value::string).unwrap_or_default();
    match field("type") {
        "agent-turn-complete" => match field("last-assistant-message") {
            "" => Signal::Turn(Activity::Idle, "Codex finished a turn".into()),
            reply => Signal::Reply(reply.into()),
        },
        _ => Signal::Ignore,
    }
}
