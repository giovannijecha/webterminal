//! Opt-in `--tool-probe` replies: a marker in the newest user turn selects a
//! scripted tool call, and the following tool result turn gets a final text.
//! Only tool names, turn shapes and the selected reply are logged, never
//! request content. Scenarios (`WEBTERMINAL_TOOL_PROBE <word>`):
//!
//! - `bash`: run `echo` (read-only, so CLIs may allow it without asking);
//! - `write`: redirect `echo` into a file in the CLI's working directory, which
//!   needs permission in Claude's manual mode;
//! - `exec`: a loopback `ping`, which writes nothing but is not read-only;
//! - `escalate` (Codex): `echo` with an escalated-sandbox approval request;
//! - `ask` (Claude): an AskUserQuestion with one question and two options.
use super::{TEXT, message_events, push_event, response_envelope, responses_text_stream};
use webterminal::json::quote;

/// A user turn containing this marker and a scenario word requests a tool call.
const PROBE_MARKER: &str = "WEBTERMINAL_TOOL_PROBE";
const PROBE_RESULT: &str = "Webterminal bridge probe result:";

/// The harmless shell command each shell scenario runs.
fn probe_command(word: &str) -> Option<&'static str> {
    match word {
        "bash" | "escalate" => Some("echo webterminal-bridge-probe"),
        "write" => Some("echo webterminal-bridge-probe > bridge-probe.txt"),
        "exec" => Some("ping -n 1 127.0.0.1"),
        _ => None,
    }
}

/// Streams one function call; `arguments` is the call's JSON object text.
fn responses_call_stream(name: &str, arguments: &str, serial: usize) -> String {
    let (id, name, arguments) = (
        format!("fc_webterminal_{serial}"),
        quote(name),
        quote(arguments),
    );
    let item = |status: &str, arguments: &str| {
        format!(
            r#"{{"id":"{id}","type":"function_call","status":"{status}","call_id":"call_webterminal_{serial}","name":{name},"arguments":{arguments}}}"#
        )
    };
    let done = item("completed", &arguments);
    let mut body = String::new();
    push_event(
        &mut body,
        "response.created",
        &format!(
            r#"{{"type":"response.created","sequence_number":1,"response":{}}}"#,
            response_envelope("in_progress", "")
        ),
    );
    push_event(
        &mut body,
        "response.output_item.added",
        &format!(
            r#"{{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{}}}"#,
            item("in_progress", "\"\"")
        ),
    );
    push_event(
        &mut body,
        "response.function_call_arguments.delta",
        &format!(
            r#"{{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"{id}","output_index":0,"delta":{arguments}}}"#
        ),
    );
    push_event(
        &mut body,
        "response.function_call_arguments.done",
        &format!(
            r#"{{"type":"response.function_call_arguments.done","sequence_number":4,"item_id":"{id}","output_index":0,"arguments":{arguments}}}"#
        ),
    );
    push_event(
        &mut body,
        "response.output_item.done",
        &format!(
            r#"{{"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":{done}}}"#
        ),
    );
    push_event(
        &mut body,
        "response.completed",
        &format!(
            r#"{{"type":"response.completed","sequence_number":6,"response":{}}}"#,
            response_envelope("completed", &done)
        ),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

/// What the newest turn of a probe-mode request asks the fixture to return.
enum Turn {
    /// Plain final text (not yet JSON-quoted).
    Text(String),
    /// The scenario word that followed the probe marker in the user's text.
    Scenario(String),
}

/// Claude Messages: `bash` returns a Bash tool_use, `ask` an AskUserQuestion
/// tool_use, and a tool_result turn returns a bounded excerpt of that result.
pub(super) fn probe_messages(body: &[u8], serial: usize) -> (&'static str, String) {
    let request = parse_json(body).unwrap_or(Json::Null);
    let tools = tool_names(&request);
    let messages = request.get("messages").map(Json::list).unwrap_or_default();
    // Claude Code may append `system` role messages after the user turn.
    let user = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Json::text) == Some("user"));
    // A user message can hold an earlier tool_result followed by a new
    // prompt; the newest tool_result or marker text decides the reply.
    let turn = match user.and_then(|message| message.get("content")) {
        Some(Json::List(blocks)) => blocks
            .iter()
            .rev()
            .find_map(|block| match block.kind() {
                "tool_result" => Some(tool_result_text(block, block.get("content"))),
                _ => match user_turn(block.get("text").into_iter()) {
                    scenario @ Turn::Scenario(_) => Some(scenario),
                    Turn::Text(_) => None,
                },
            })
            .unwrap_or(Turn::Text(TEXT.into())),
        Some(text) => user_turn([text].into_iter()),
        None => Turn::Text(TEXT.into()),
    };
    let offered = |name: &str| tools.iter().any(|tool| tool == name);
    let (tool, text) = match turn {
        Turn::Scenario(word)
            if word != "escalate" && offered("Bash") && probe_command(&word).is_some() =>
        {
            let input = format!(
                r#"{{"command":{},"description":"Print the Webterminal bridge probe marker"}}"#,
                quote(probe_command(&word).unwrap_or_default())
            );
            (Some(("Bash", input)), String::new())
        }
        Turn::Scenario(word) if word == "ask" && offered("AskUserQuestion") => {
            let input = r#"{"questions":[{"question":"Which probe color should Webterminal use?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"First fixture option"},{"label":"Blue","description":"Second fixture option"}]}]}"#;
            (Some(("AskUserQuestion", input.to_owned())), String::new())
        }
        Turn::Scenario(word) => (None, format!("Unsupported probe scenario {word}.")),
        Turn::Text(text) => (None, text),
    };
    let id = format!("msg_webterminal_probe_{serial}");
    let streaming = request.get("stream").and_then(Json::boolean) == Some(true);
    let label = match (&tool, streaming) {
        (Some((name, _)), true) => name,
        _ => "text",
    };
    let shape = messages
        .iter()
        .rev()
        .take(4)
        .map(|message| shape(Some(message), "content"))
        .collect::<Vec<_>>()
        .join(" < ");
    eprintln!(
        "probe /v1/messages #{serial}: tools={tools:?} last={shape} stream={streaming} reply={label}"
    );
    match (tool, streaming) {
        (Some((name, input)), true) => {
            let block = format!(
                r#"{{"type":"tool_use","id":"toolu_webterminal_{serial}","name":"{name}","input":{{}}}}"#
            );
            let delta = format!(
                r#"{{"type":"input_json_delta","partial_json":{}}}"#,
                quote(&input)
            );
            (
                "text/event-stream",
                message_events(&id, &block, &delta, "tool_use"),
            )
        }
        (None, true) => {
            let delta = format!(r#"{{"type":"text_delta","text":{}}}"#, quote(&text));
            let block = r#"{"type":"text","text":""}"#;
            (
                "text/event-stream",
                message_events(&id, block, &delta, "end_turn"),
            )
        }
        // Non-streaming side requests receive one complete text message.
        (tool, false) => {
            let text = quote(if tool.is_some() { TEXT } else { &text });
            let body = format!(
                r#"{{"id":"msg_webterminal_fixture","type":"message","role":"assistant","content":[{{"type":"text","text":{text}}}],"model":"fixture-model","stop_reason":"end_turn","stop_sequence":null,"usage":{{"input_tokens":32,"output_tokens":6}}}}"#
            );
            ("application/json", body)
        }
    }
}

/// Codex Responses: `bash` returns a shell function call and `escalate` the
/// same call with an escalated-sandbox request; call output returns an excerpt.
pub(super) fn probe_responses(body: &[u8], serial: usize) -> String {
    let request = parse_json(body).unwrap_or(Json::Null);
    let tools = tool_names(&request);
    let last = request.get("input").map(Json::list).and_then(<[_]>::last);
    let turn = match last {
        Some(item) if item.kind().ends_with("_call_output") => {
            tool_result_text(item, item.get("output"))
        }
        Some(item) if item.kind() == "message" => user_turn(
            item.get("content")
                .map(Json::list)
                .unwrap_or_default()
                .iter()
                .filter_map(|part| part.get("text")),
        ),
        _ => Turn::Text(TEXT.into()),
    };
    let shell = ["shell_command", "exec_command", "shell"]
        .into_iter()
        .find(|name| tools.iter().any(|tool| tool == name));
    let (reply, label) = match (turn, shell) {
        (Turn::Scenario(word), Some(name)) if probe_command(&word).is_some() => {
            let command = quote(probe_command(&word).unwrap_or_default());
            let mut arguments = match name {
                "exec_command" => format!(r#"{{"cmd":{command}"#),
                "shell" => {
                    format!(r#"{{"command":["powershell.exe","-NoProfile","-Command",{command}]"#)
                }
                _ => format!(r#"{{"command":{command}"#),
            };
            if word == "escalate" {
                arguments.push_str(r#","sandbox_permissions":"require_escalated","justification":"Webterminal bridge probe approval check""#);
            }
            arguments.push('}');
            (responses_call_stream(name, &arguments, serial), name)
        }
        (Turn::Scenario(word), _) => (
            responses_text_stream(&quote(&format!("Unsupported probe scenario {word}."))),
            "text",
        ),
        (Turn::Text(text), _) => (responses_text_stream(&quote(&text)), "text"),
    };
    let shape = shape(last, "content");
    eprintln!("probe /v1/responses #{serial}: tools={tools:?} last={shape} reply={label}");
    reply
}

/// Role (or type) and part types of the newest item, e.g. `user[text,text]`.
fn shape(item: Option<&Json>, parts: &str) -> String {
    let Some(item) = item else {
        return "none".into();
    };
    let role = item.get("role").and_then(Json::text).unwrap_or(item.kind());
    let kinds = match item.get(parts) {
        Some(Json::List(list)) => list.iter().map(Json::kind).collect::<Vec<_>>().join(","),
        Some(Json::Text(_)) => "string".into(),
        _ => String::new(),
    };
    format!("{role}[{kinds}]")
}

/// Names of the tools offered by a request, or their type for unnamed tools.
fn tool_names(request: &Json) -> Vec<String> {
    let tools = request.get("tools").map(Json::list).unwrap_or_default();
    tools
        .iter()
        .filter_map(|tool| tool.get("name").or_else(|| tool.get("type")))
        .filter_map(Json::text)
        .map(str::to_owned)
        .collect()
}

/// Selects a scenario when the user's text carries the probe marker.
fn user_turn<'a>(texts: impl Iterator<Item = &'a Json>) -> Turn {
    let text = texts.filter_map(Json::text).collect::<Vec<_>>().join("\n");
    match text.split_once(PROBE_MARKER) {
        Some((_, rest)) => Turn::Scenario(
            rest.split_whitespace()
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase(),
        ),
        None => Turn::Text(TEXT.into()),
    }
}

/// A bounded, single-line excerpt of a tool result for on-screen evidence.
fn tool_result_text(item: &Json, content: Option<&Json>) -> Turn {
    let mut text = String::new();
    match content {
        Some(Json::Text(value)) => text.push_str(value),
        Some(Json::List(parts)) => {
            for part in parts.iter().filter_map(|part| part.get("text")) {
                text.push_str(part.text().unwrap_or_default());
                text.push(' ');
            }
        }
        _ => {}
    }
    let error = item.get("is_error").and_then(Json::boolean) == Some(true);
    let excerpt: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect();
    let error = if error { " [error]" } else { "" };
    Turn::Text(format!("{PROBE_RESULT}{error} {excerpt}"))
}

/// Lenient JSON tree for probe requests, which carry deep schemas and floats.
enum Json {
    Null,
    Bool(bool),
    Number,
    Text(String),
    List(Vec<Json>),
    Map(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Map(fields) => fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn text(&self) -> Option<&str> {
        match self {
            Json::Text(text) => Some(text),
            _ => None,
        }
    }
    fn boolean(&self) -> Option<bool> {
        match self {
            Json::Bool(value) => Some(*value),
            _ => None,
        }
    }
    fn list(&self) -> &[Json] {
        match self {
            Json::List(items) => items,
            _ => &[],
        }
    }
    fn kind(&self) -> &str {
        self.get("type").and_then(Json::text).unwrap_or_default()
    }
}

fn parse_json(bytes: &[u8]) -> Option<Json> {
    let mut at = 0;
    let value = json_value(bytes, &mut at, 0)?;
    skip_space(bytes, &mut at);
    (at == bytes.len()).then_some(value)
}

fn skip_space(b: &[u8], at: &mut usize) {
    while matches!(b.get(*at), Some(b' ' | b'\t' | b'\r' | b'\n')) {
        *at += 1;
    }
}

fn json_value(b: &[u8], at: &mut usize, depth: usize) -> Option<Json> {
    if depth > 256 {
        return None;
    }
    skip_space(b, at);
    let literal = |at: &mut usize, word: &[u8], value: Json| {
        b[*at..].starts_with(word).then(|| {
            *at += word.len();
            value
        })
    };
    match *b.get(*at)? {
        open @ (b'{' | b'[') => {
            let close = if open == b'{' { b'}' } else { b']' };
            *at += 1;
            let (mut fields, mut items) = (Vec::new(), Vec::new());
            skip_space(b, at);
            if b.get(*at) == Some(&close) {
                *at += 1;
            } else {
                loop {
                    skip_space(b, at);
                    if open == b'{' {
                        let key = json_string(b, at)?;
                        skip_space(b, at);
                        (b.get(*at) == Some(&b':')).then_some(())?;
                        *at += 1;
                        fields.push((key, json_value(b, at, depth + 1)?));
                    } else {
                        items.push(json_value(b, at, depth + 1)?);
                    }
                    skip_space(b, at);
                    let next = *b.get(*at)?;
                    *at += 1;
                    if next == close {
                        break;
                    }
                    (next == b',').then_some(())?;
                }
            }
            Some(if open == b'{' {
                Json::Map(fields)
            } else {
                Json::List(items)
            })
        }
        b'"' => json_string(b, at).map(Json::Text),
        b't' => literal(at, b"true", Json::Bool(true)),
        b'f' => literal(at, b"false", Json::Bool(false)),
        b'n' => literal(at, b"null", Json::Null),
        b'-' | b'0'..=b'9' => {
            while matches!(
                b.get(*at),
                Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
            ) {
                *at += 1;
            }
            Some(Json::Number)
        }
        _ => None,
    }
}

fn json_string(b: &[u8], at: &mut usize) -> Option<String> {
    (b.get(*at) == Some(&b'"')).then_some(())?;
    *at += 1;
    let mut out = Vec::new();
    loop {
        match *b.get(*at)? {
            b'"' => {
                *at += 1;
                return String::from_utf8(out).ok();
            }
            b'\\' => {
                let escape = *b.get(*at + 1)?;
                *at += 2;
                let ch = match escape {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let first = hex4(b, at)?;
                        let paired = (0xD800..0xDC00).contains(&first)
                            && b.get(*at..*at + 2) == Some(b"\\u".as_slice());
                        let code = if paired {
                            *at += 2;
                            let low = hex4(b, at)?;
                            0x10000 + ((first - 0xD800) << 10) + (low.wrapping_sub(0xDC00) & 0x3FF)
                        } else {
                            first
                        };
                        char::from_u32(code).unwrap_or('\u{fffd}')
                    }
                    _ => return None,
                };
                out.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
            }
            byte => {
                out.push(byte);
                *at += 1;
            }
        }
    }
}

fn hex4(b: &[u8], at: &mut usize) -> Option<u32> {
    let digits = std::str::from_utf8(b.get(*at..*at + 4)?).ok()?;
    *at += 4;
    u32::from_str_radix(digits, 16).ok()
}
