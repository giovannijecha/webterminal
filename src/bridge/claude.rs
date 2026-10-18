//! Claude Code adapter: hooks supplied with `--settings` for one invocation,
//! leaving the user's own Claude Code settings untouched. Hooks run the
//! Webterminal helper in exec form, so no shell parses their arguments.
use super::{
    Activity, Answer, Draft, Kind, REQUEST_WAIT, Signal, TEXT_LIMIT, bounded, fingerprint, text,
};
use crate::json::{self, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;

const EVENT_TIMEOUT: u64 = 10;
const QUESTION_LIMIT: usize = 4;
const OPTION_LIMIT: usize = 8;

pub(super) fn arguments(
    helper: &Path,
    directory: &Path,
    (port, session, token): (u16, &str, &str),
) -> io::Result<Vec<String>> {
    fs::create_dir_all(directory)?;
    let path = directory.join(format!("{session}-claude-settings.json"));
    fs::write(&path, settings(helper, port, session, token))?;
    Ok(vec![
        "--settings".into(),
        path.to_string_lossy().into_owned(),
    ])
}

/// Settings JSON that reports lifecycle events and routes permission
/// requests and questions to Webterminal.
pub fn settings(helper: &Path, port: u16, session: &str, token: &str) -> String {
    let hook = |timeout: u64| {
        format!(
            "{{\"type\":\"command\",\"command\":{},\"args\":[\"bridge\",\"--port\",\"{port}\",\"--session\",{},\"--token\",{}],\"timeout\":{timeout}}}",
            json::quote(&helper.to_string_lossy()),
            json::quote(session),
            json::quote(token)
        )
    };
    let wait = REQUEST_WAIT.as_secs() + 60;
    let group = |matcher: Option<&str>, timeout: u64| match matcher {
        Some(matcher) => format!(
            "[{{\"matcher\":{},\"hooks\":[{}]}}]",
            json::quote(matcher),
            hook(timeout)
        ),
        None => format!("[{{\"hooks\":[{}]}}]", hook(timeout)),
    };
    let events = [
        ("PermissionRequest", group(None, wait)),
        ("PreToolUse", group(Some("AskUserQuestion"), wait)),
        // Claude Code keeps a permission hook running after a local answer;
        // the tool run tells Webterminal that its request is settled.
        ("PostToolUse", group(None, EVENT_TIMEOUT)),
        ("UserPromptSubmit", group(None, EVENT_TIMEOUT)),
        ("Stop", group(None, EVENT_TIMEOUT)),
        ("StopFailure", group(None, EVENT_TIMEOUT)),
        ("Notification", group(None, EVENT_TIMEOUT)),
        ("SessionStart", group(None, EVENT_TIMEOUT)),
        ("SessionEnd", group(None, EVENT_TIMEOUT)),
    ];
    let hooks: Vec<String> = events
        .iter()
        .map(|(name, groups)| format!("\"{name}\":{groups}"))
        .collect();
    format!("{{\"hooks\":{{{}}}}}\n", hooks.join(","))
}

pub(super) fn interpret(payload: &Value) -> Signal {
    let field = |key: &str| payload.get(key).and_then(Value::string).unwrap_or_default();
    match field("hook_event_name") {
        // Questions are routed through PreToolUse only. A question left to
        // the terminal raises a second, generic permission request there.
        "PermissionRequest" if field("tool_name") != "AskUserQuestion" => permission(payload),
        "PreToolUse" if field("tool_name") == "AskUserQuestion" => question(payload),
        "PostToolUse" => Signal::Ran {
            tool: field("tool_name").to_owned(),
            input: fingerprint(payload.get("tool_input")),
        },
        "UserPromptSubmit" => Signal::Turn(Activity::Working, "Claude Code is working".into()),
        "Stop" => match field("last_assistant_message") {
            "" => Signal::Turn(Activity::Idle, "Claude Code finished".into()),
            reply => Signal::Reply(reply.into()),
        },
        "StopFailure" => {
            let reason = [field("error"), field("last_assistant_message")]
                .into_iter()
                .find(|value| !value.is_empty())
                .unwrap_or("the request failed");
            Signal::Failure(format!("Claude Code stopped: {}", bounded(reason, 400)))
        }
        "Notification" => match field("notification_type") {
            "permission_prompt" => Signal::Activity(
                Activity::Waiting,
                "Claude Code is waiting for permission in the terminal".into(),
            ),
            "elicitation_dialog" => Signal::Activity(
                Activity::Waiting,
                "Claude Code is waiting for input in the terminal".into(),
            ),
            "idle_prompt" => Signal::Activity(
                Activity::Idle,
                "Claude Code is waiting for your next message".into(),
            ),
            _ => Signal::Ignore,
        },
        "SessionStart" => Signal::Started(Some(field("session_id").to_owned())),
        "SessionEnd" => Signal::Ended,
        _ => Signal::Ignore,
    }
}

fn permission(payload: &Value) -> Signal {
    let tool = payload
        .get("tool_name")
        .and_then(Value::string)
        .unwrap_or_default();
    let input = payload.get("tool_input");
    let get = |key: &str| text(input.and_then(|i| i.get(key)));
    let (kind, evidence) = match tool {
        "Bash" => (
            Kind::Command,
            object([
                ("command", get("command")),
                ("description", get("description")),
            ]),
        ),
        "Edit" => (
            Kind::Edit,
            object([
                ("path", get("file_path")),
                ("old", get("old_string")),
                ("new", get("new_string")),
            ]),
        ),
        "Write" => (
            Kind::Edit,
            object([
                ("path", get("file_path")),
                ("old", Value::String(String::new())),
                ("new", get("content")),
            ]),
        ),
        "MultiEdit" | "NotebookEdit" => {
            let path = [get("file_path"), get("notebook_path")]
                .into_iter()
                .find(|v| v.string().is_some_and(|s| !s.is_empty()))
                .unwrap_or(Value::String(String::new()));
            let input = input.map(Value::to_json).unwrap_or_default();
            (
                Kind::Edit,
                object([
                    ("path", path),
                    ("input", Value::String(bounded(&input, TEXT_LIMIT))),
                ]),
            )
        }
        _ => {
            let input = input.map(Value::to_json).unwrap_or_default();
            (
                Kind::Tool,
                object([("input", Value::String(bounded(&input, TEXT_LIMIT)))]),
            )
        }
    };
    let (suggestions, scope) = session_rules(payload.get("permission_suggestions"));
    Signal::Request(Draft {
        kind,
        tool: tool.to_owned(),
        input: fingerprint(input),
        evidence,
        suggestions,
        scope,
        questions: None,
    })
}

/// Keeps only "allow" rule additions and narrows them to the current Claude
/// Code session, so an ongoing grant never reaches a settings file.
fn session_rules(suggestions: Option<&Value>) -> (Option<Value>, Option<String>) {
    let mut kept = Vec::new();
    let mut labels = Vec::new();
    for suggestion in suggestions.and_then(Value::array).unwrap_or_default() {
        let Value::Object(entry) = suggestion else {
            continue;
        };
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "type" | "rules" | "behavior" | "destination"))
        {
            continue;
        }
        let is = |key: &str, value: &str| entry.get(key).and_then(Value::string) == Some(value);
        let Some(rules) = entry.get("rules").and_then(Value::array) else {
            continue;
        };
        if !is("type", "addRules") || !is("behavior", "allow") || rules.is_empty() {
            continue;
        }
        let mut clean_rules = Vec::with_capacity(rules.len());
        let mut clean_labels = Vec::with_capacity(rules.len());
        for rule in rules {
            let Value::Object(fields) = rule else { break };
            if fields
                .keys()
                .any(|key| !matches!(key.as_str(), "toolName" | "ruleContent"))
            {
                break;
            }
            let Some(tool) = rule.get("toolName").and_then(Value::string) else {
                break;
            };
            if tool.is_empty()
                || !tool
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
            {
                break;
            }
            let content = match rule.get("ruleContent") {
                None => None,
                Some(value) => match value.string() {
                    Some(content) if !content.chars().any(char::is_control) => Some(content),
                    _ => break,
                },
            };
            let mut clean = BTreeMap::from([("toolName".into(), Value::String(tool.into()))]);
            if let Some(content) = content {
                clean.insert("ruleContent".into(), Value::String(content.into()));
            }
            clean_rules.push(Value::Object(clean));
            clean_labels.push(match content {
                Some(content) => format!("{tool}({content})"),
                None => tool.to_owned(),
            });
        }
        if clean_rules.len() != rules.len() {
            continue;
        }
        labels.extend(clean_labels);
        kept.push(object([
            ("type", Value::String("addRules".into())),
            ("behavior", Value::String("allow".into())),
            ("destination", Value::String("session".into())),
            ("rules", Value::Array(clean_rules)),
        ]));
    }
    if kept.is_empty() {
        return (None, None);
    }
    let scope = labels.join(", ");
    if scope.len() > 400 {
        return (None, None);
    }
    (Some(Value::Array(kept)), Some(scope))
}

fn question(payload: &Value) -> Signal {
    let original = payload.get("tool_input").and_then(|i| i.get("questions"));
    let Some(questions) = original.and_then(Value::array) else {
        return Signal::Ignore;
    };
    if questions.is_empty() || questions.len() > QUESTION_LIMIT {
        return Signal::Ignore;
    }
    let mut shown = Vec::new();
    let mut question_texts = BTreeSet::new();
    for item in questions {
        let options = item
            .get("options")
            .and_then(Value::array)
            .unwrap_or_default();
        let Some(question_text) = item.get("question").and_then(Value::string) else {
            return Signal::Ignore;
        };
        if !question_texts.insert(question_text)
            || options.is_empty()
            || options.len() > OPTION_LIMIT
        {
            return Signal::Ignore;
        }
        if item.get("multiSelect").and_then(Value::boolean) == Some(true) {
            let labels: Vec<&str> = options
                .iter()
                .filter_map(|option| option.get("label").and_then(Value::string))
                .collect();
            if labels.len() != options.len() || !unique_multiselect_answers(&labels) {
                return Signal::Ignore;
            }
        }
        let options = options
            .iter()
            .map(|o| {
                object([
                    ("label", text(o.get("label"))),
                    ("description", text(o.get("description"))),
                ])
            })
            .collect();
        shown.push(object([
            ("question", text(item.get("question"))),
            ("header", text(item.get("header"))),
            (
                "multiSelect",
                Value::Bool(
                    item.get("multiSelect")
                        .and_then(Value::boolean)
                        .unwrap_or(false),
                ),
            ),
            ("options", Value::Array(options)),
        ]));
    }
    Signal::Request(Draft {
        kind: Kind::Question,
        tool: "AskUserQuestion".into(),
        input: fingerprint(payload.get("tool_input")),
        evidence: object([("questions", Value::Array(shown))]),
        suggestions: None,
        scope: None,
        questions: original.cloned(),
    })
}

/// The helper's output for an answer, and the outcome shown to views.
pub(super) fn decision(draft: &Draft, answer: &Answer) -> Result<(String, String), String> {
    if *answer == Answer::Terminal {
        return Ok((String::new(), "Answer in the terminal".into()));
    }
    if draft.kind == Kind::Question {
        let Answer::Answers(answers) = answer else {
            return Err("Answer the question or continue in the terminal".into());
        };
        let questions = draft.questions.as_ref().ok_or("Question is unavailable")?;
        let answers = checked_answers(questions, answers)?;
        let body = format!(
            "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"updatedInput\":{{\"questions\":{},\"answers\":{}}}}}}}",
            questions.to_json(),
            answers.to_json()
        );
        return Ok((body, "Answered".into()));
    }
    let (decision, outcome) = match answer {
        Answer::Allow => (
            "{\"behavior\":\"allow\"}".to_owned(),
            "Allowed once".to_owned(),
        ),
        Answer::AllowSession => {
            let rules = draft
                .suggestions
                .as_ref()
                .ok_or("No session rule is available for this request")?;
            (
                format!(
                    "{{\"behavior\":\"allow\",\"updatedPermissions\":{}}}",
                    rules.to_json()
                ),
                format!(
                    "Allowed for this Claude Code session: {}",
                    draft.scope.as_deref().unwrap_or_default()
                ),
            )
        }
        Answer::Deny => (
            "{\"behavior\":\"deny\",\"message\":\"Denied from Webterminal.\"}".to_owned(),
            "Denied".to_owned(),
        ),
        Answer::Answers(_) => return Err("This request needs Allow or Deny".into()),
        Answer::Terminal => unreachable!(),
    };
    let body = format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PermissionRequest\",\"decision\":{decision}}}}}"
    );
    Ok((body, outcome))
}

fn checked_answers(questions: &Value, answers: &BTreeMap<String, String>) -> Result<Value, String> {
    let mut checked = BTreeMap::new();
    for item in questions.array().unwrap_or_default() {
        let question = item
            .get("question")
            .and_then(Value::string)
            .unwrap_or_default();
        let answer = answers
            .get(question)
            .ok_or_else(|| format!("Answer every question: {question}"))?;
        let labels: Vec<&str> = item
            .get("options")
            .and_then(Value::array)
            .unwrap_or_default()
            .iter()
            .filter_map(|o| o.get("label").and_then(Value::string))
            .collect();
        let multiple = item
            .get("multiSelect")
            .and_then(Value::boolean)
            .unwrap_or(false);
        let valid = if multiple {
            subset_answers(&labels).any(|candidate| candidate == *answer)
        } else {
            labels.contains(&answer.as_str())
        };
        if !valid {
            return Err(format!("Choose one of the offered answers for: {question}"));
        }
        checked.insert(question.to_owned(), Value::String(answer.clone()));
    }
    if checked.len() != answers.len() {
        return Err("Answers do not match the questions".into());
    }
    Ok(Value::Object(checked))
}

/// AskUserQuestion encodes a multi-selection as labels joined by `, `.
/// Refuse ambiguous option sets before offering a browser answer.
fn unique_multiselect_answers(labels: &[&str]) -> bool {
    let mut seen = BTreeSet::new();
    subset_answers(labels).all(|answer| seen.insert(answer))
}

fn subset_answers<'a>(labels: &'a [&'a str]) -> impl Iterator<Item = String> + 'a {
    (1..(1usize << labels.len())).map(|mask| {
        labels
            .iter()
            .enumerate()
            .filter_map(|(index, label)| (mask & (1 << index) != 0).then_some(*label))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}
