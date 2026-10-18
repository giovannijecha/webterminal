use super::*;
use std::thread;

const BASH: &str = r#"{"hook_event_name":"PermissionRequest","session_id":"c1","tool_name":"Bash","tool_input":{"command":"npm test","description":"Run tests"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test:*"}],"behavior":"allow","destination":"localSettings"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}"#;
const QUESTION: &str = r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which runner?","header":"Runner","multiSelect":false,"options":[{"label":"Node","description":"node --test"},{"label":"Cargo","description":"cargo test"}]}]}}"#;

fn waiting(bridge: &Bridge, payload: &str) -> String {
    match bridge.report("s1", payload).unwrap() {
        Outcome::Wait(id) => id,
        Outcome::Respond(_) => panic!("expected a request"),
    }
}
fn revision_of(bridge: &Bridge, id: &str) -> u64 {
    let inner = bridge.inner.lock().unwrap();
    inner.requests.iter().find(|r| r.id == id).unwrap().revision
}
fn state_of(bridge: &Bridge, id: &str) -> State {
    let inner = bridge.inner.lock().unwrap();
    inner.requests.iter().find(|r| r.id == id).unwrap().state
}

#[test]
fn tokens_authenticate_only_their_session() {
    let bridge = Bridge::new();
    let token = bridge.register("s1", Program::Claude);
    assert_eq!(token.len(), 32);
    assert!(bridge.authenticate("s1", &token));
    assert!(!bridge.authenticate("s2", &token));
    assert!(!bridge.authenticate("s1", &token[..31]));
    assert_ne!(token, bridge.register("s2", Program::Claude));
    assert!(bridge.report("s3", "{}").is_err());
}

#[test]
fn an_answer_is_delivered_exactly_once_at_the_shown_revision() {
    let bridge = Arc::new(Bridge::new());
    bridge.register("s1", Program::Claude);
    let id = waiting(&bridge, BASH);
    assert!(bridge.json().contains(r#""state":"waiting""#));
    assert!(bridge.json().contains(r#""activity":"waiting""#));
    let revision = revision_of(&bridge, &id);
    assert!(bridge.respond(&id, revision + 1, Answer::Allow).is_err());
    let waiter = {
        let (bridge, id) = (bridge.clone(), id.clone());
        thread::spawn(move || bridge.wait(&id, Instant::now() + Duration::from_secs(5), || true))
    };
    bridge.respond(&id, revision, Answer::Allow).unwrap();
    let body = waiter.join().unwrap();
    assert_eq!(
        body,
        r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
    );
    assert_eq!(state_of(&bridge, &id), State::Resolved);
    let revision = revision_of(&bridge, &id);
    assert!(bridge.respond(&id, revision, Answer::Deny).is_err());
    assert_eq!(bridge.wait(&id, Instant::now(), || true), "");
}

#[test]
fn session_grants_are_narrowed_to_the_program_session() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let id = waiting(&bridge, BASH);
    assert!(bridge.json().contains(r#""scope":"Bash(npm test:*)""#));
    bridge
        .respond(&id, revision_of(&bridge, &id), Answer::AllowSession)
        .unwrap();
    let body = bridge.wait(&id, Instant::now(), || true);
    assert!(body.contains(r#""updatedPermissions":[{"behavior":"allow","destination":"session","rules":[{"ruleContent":"npm test:*","toolName":"Bash"}],"type":"addRules"}]"#), "{body}");
    assert!(!body.contains("localSettings") && !body.contains("setMode"));
}

#[test]
fn session_grant_is_unavailable_when_its_complete_scope_cannot_be_shown() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let broad = "x".repeat(400);
    let payload = format!(
        r#"{{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{{"command":"echo hi"}},"permission_suggestions":[{{"type":"addRules","behavior":"allow","rules":[{{"toolName":"Bash","ruleContent":{}}},{{"toolName":"Write"}}]}}]}}"#,
        json::quote(&broad)
    );
    let id = waiting(&bridge, &payload);
    assert!(bridge.json().contains(r#""scope":null"#));
    assert!(
        bridge
            .respond(&id, revision_of(&bridge, &id), Answer::AllowSession)
            .is_err()
    );
    bridge
        .respond(&id, revision_of(&bridge, &id), Answer::Allow)
        .unwrap();
}

#[test]
fn session_grant_rejects_malformed_rule_fields() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let payload = r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo hi"},"permission_suggestions":[{"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"echo hi","extra":"unshown"}]}]}"#;
    let id = waiting(&bridge, payload);
    assert!(bridge.json().contains(r#""scope":null"#));
    assert!(
        bridge
            .respond(&id, revision_of(&bridge, &id), Answer::AllowSession)
            .is_err()
    );
}

#[test]
fn departed_helpers_closed_terminals_and_new_program_sessions_expire_requests() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let first = waiting(&bridge, BASH);
    assert_eq!(
        bridge.wait(&first, Instant::now() + Duration::from_secs(5), || false),
        ""
    );
    assert_eq!(state_of(&bridge, &first), State::Expired);
    assert!(
        bridge
            .respond(&first, revision_of(&bridge, &first), Answer::Allow)
            .is_err()
    );

    let second = waiting(&bridge, BASH);
    bridge
        .report(
            "s1",
            r#"{"hook_event_name":"SessionStart","session_id":"c2","source":"clear"}"#,
        )
        .unwrap();
    assert_eq!(state_of(&bridge, &second), State::Expired);

    let third = waiting(&bridge, BASH);
    bridge.remove_session("s1");
    assert_eq!(state_of(&bridge, &third), State::Expired);
    assert!(bridge.json().contains("Terminal closed"));
    assert!(!bridge.authenticate("s1", ""));
}

#[test]
fn questions_accept_only_offered_answers() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let id = waiting(&bridge, QUESTION);
    let revision = revision_of(&bridge, &id);
    let answers = |answer: &str| {
        Answer::Answers(BTreeMap::from([(
            "Which runner?".to_owned(),
            answer.to_owned(),
        )]))
    };
    assert!(bridge.respond(&id, revision, answers("Deno")).is_err());
    assert!(bridge.respond(&id, revision, Answer::Allow).is_err());
    bridge.respond(&id, revision, answers("Cargo")).unwrap();
    let body = bridge.wait(&id, Instant::now(), || true);
    assert!(body.starts_with(r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":[{"header":"Runner""#));
    assert!(
        body.ends_with(r#""answers":{"Which runner?":"Cargo"}}}}"#),
        "{body}"
    );
}

#[test]
fn multiselect_accepts_an_offered_label_with_a_comma() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let payload = r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which?","header":"Choice","multiSelect":true,"options":[{"label":"Alpha, beta"},{"label":"Gamma"}]}]}}"#;
    let id = waiting(&bridge, payload);
    let answer = Answer::Answers(BTreeMap::from([("Which?".into(), "Alpha, beta".into())]));
    bridge
        .respond(&id, revision_of(&bridge, &id), answer)
        .unwrap();
    assert!(
        bridge
            .wait(&id, Instant::now(), || true)
            .contains(r#""Which?":"Alpha, beta""#)
    );
}

#[test]
fn ambiguous_multiselect_labels_fall_back_to_the_terminal() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let payload = r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which?","header":"Choice","multiSelect":true,"options":[{"label":"Alpha, beta"},{"label":"Alpha"},{"label":"beta"}]}]}}"#;
    assert!(matches!(
        bridge.report("s1", payload).unwrap(),
        Outcome::Respond(body) if body.is_empty()
    ));
}

#[test]
fn terminal_answers_release_the_program_prompt() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let id = waiting(&bridge, BASH);
    bridge
        .respond(&id, revision_of(&bridge, &id), Answer::Terminal)
        .unwrap();
    assert_eq!(bridge.wait(&id, Instant::now(), || true), "");
    assert!(bridge.json().contains("Answer in the terminal"));
}

#[test]
fn replies_and_activity_are_source_attributed() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    bridge.register("s2", Program::Codex);
    bridge
        .report(
            "s1",
            r#"{"hook_event_name":"UserPromptSubmit","prompt":"hi"}"#,
        )
        .unwrap();
    assert!(bridge.json().contains(r#""activity":"working""#));
    bridge
        .report(
            "s1",
            r#"{"hook_event_name":"Stop","last_assistant_message":"Done."}"#,
        )
        .unwrap();
    bridge
        .report(
            "s2",
            r#"{"type":"agent-turn-complete","last-assistant-message":"Ok"}"#,
        )
        .unwrap();
    let replies = bridge.replies_after(0);
    assert_eq!(replies.len(), 2);
    assert_eq!(
        (replies[0].session.as_str(), replies[0].text.as_str()),
        ("s1", "Done.")
    );
    assert_eq!(replies[1].program, Program::Codex);
    assert!(bridge.replies_after(bridge.reply_seq()).is_empty());
    // Codex reports turns only; it never receives answers from views.
    assert!(matches!(
        bridge.report("s2", r#"{"type":"approval-requested"}"#).unwrap(),
        Outcome::Respond(body) if body.is_empty()
    ));
}

#[test]
fn malformed_payloads_and_request_floods_fall_back_to_the_terminal() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    assert!(bridge.report("s1", "{").is_err());
    for _ in 0..LIVE_LIMIT {
        waiting(&bridge, BASH);
    }
    assert!(matches!(
        bridge.report("s1", BASH).unwrap(),
        Outcome::Respond(body) if body.is_empty()
    ));
}

#[test]
fn local_terminal_answers_retire_the_matching_request() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let ran = |command: &str| {
        format!(
            r#"{{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{{"command":"{command}","description":"Run tests"}},"tool_use_id":"toolu_1"}}"#
        )
    };
    let id = waiting(&bridge, BASH);
    // An unrelated call of the same tool leaves the request open.
    bridge.report("s1", &ran("ls")).unwrap();
    assert_eq!(state_of(&bridge, &id), State::Waiting);
    let shown = revision_of(&bridge, &id);
    bridge.report("s1", &ran("npm test")).unwrap();
    assert_eq!(state_of(&bridge, &id), State::Expired);
    assert!(bridge.json().contains("Answered in the terminal"));
    assert!(bridge.json().contains(r#""activity":"working""#));
    assert!(bridge.respond(&id, shown, Answer::Allow).is_err());
    assert_eq!(
        bridge.wait(&id, Instant::now() + Duration::from_secs(5), || true),
        ""
    );
}

#[test]
fn a_tool_run_cannot_reassign_one_of_two_identical_requests() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let first = waiting(&bridge, BASH);
    let second = waiting(&bridge, BASH);
    bridge.report("s1", r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm test","description":"Run tests"},"tool_use_id":"toolu_1"}"#).unwrap();
    assert_eq!(state_of(&bridge, &first), State::Waiting);
    assert_eq!(state_of(&bridge, &second), State::Waiting);
    bridge
        .respond(&second, revision_of(&bridge, &second), Answer::Allow)
        .unwrap();
    assert!(!bridge.wait(&second, Instant::now(), || true).is_empty());
}

#[test]
fn a_tool_run_for_an_approved_twin_keeps_the_other_request_open() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let first = waiting(&bridge, BASH);
    let second = waiting(&bridge, BASH);
    bridge
        .respond(&first, revision_of(&bridge, &first), Answer::Allow)
        .unwrap();
    assert!(!bridge.wait(&first, Instant::now(), || true).is_empty());
    bridge.report("s1", r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm test","description":"Run tests"},"tool_use_id":"toolu_1"}"#).unwrap();
    assert_eq!(state_of(&bridge, &first), State::Resolved);
    assert_eq!(state_of(&bridge, &second), State::Waiting);
}

#[test]
fn a_new_turn_can_retire_a_new_unique_request() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let first = waiting(&bridge, BASH);
    let second = waiting(&bridge, BASH);
    bridge
        .report("s1", r#"{"hook_event_name":"UserPromptSubmit"}"#)
        .unwrap();
    assert_eq!(state_of(&bridge, &first), State::Expired);
    assert_eq!(state_of(&bridge, &second), State::Expired);
    let next = waiting(&bridge, BASH);
    bridge.report("s1", r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm test","description":"Run tests"},"tool_use_id":"toolu_2"}"#).unwrap();
    assert_eq!(state_of(&bridge, &next), State::Expired);
}

#[test]
fn turn_boundaries_settle_open_requests_but_notifications_do_not() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    bridge.register("s2", Program::Claude);
    let id = waiting(&bridge, BASH);
    let other = match bridge.report("s2", BASH).unwrap() {
        Outcome::Wait(id) => id,
        Outcome::Respond(_) => panic!("expected a request"),
    };
    bridge
        .report(
            "s1",
            r#"{"hook_event_name":"Notification","notification_type":"permission_prompt"}"#,
        )
        .unwrap();
    assert_eq!(state_of(&bridge, &id), State::Waiting);
    bridge
        .report(
            "s1",
            r#"{"hook_event_name":"Stop","last_assistant_message":""}"#,
        )
        .unwrap();
    assert_eq!(state_of(&bridge, &id), State::Expired);
    assert_eq!(state_of(&bridge, &other), State::Waiting);
    assert!(bridge.json().contains(IN_TERMINAL));
}

#[test]
fn questions_are_asked_once_through_pre_tool_use() {
    let bridge = Bridge::new();
    bridge.register("s1", Program::Claude);
    let id = waiting(&bridge, QUESTION);
    bridge
        .respond(&id, revision_of(&bridge, &id), Answer::Terminal)
        .unwrap();
    assert_eq!(bridge.wait(&id, Instant::now(), || true), "");
    // Claude Code then asks for the same tool through its permission hook.
    let follow_up = QUESTION.replace(r#""PreToolUse""#, r#""PermissionRequest""#);
    assert!(matches!(
        bridge.report("s1", &follow_up).unwrap(),
        Outcome::Respond(body) if body.is_empty()
    ));
    assert_eq!(bridge.json().matches(r#""kind":"question""#).count(), 1);
}

#[test]
fn claude_settings_use_exec_form_hooks() {
    let settings = claude::settings(Path::new(r"C:\x\webterminal.exe"), 4183, "s1", "t0k");
    let parsed = json::parse(&settings).unwrap();
    let hooks = parsed.get("hooks").unwrap();
    let permission = &hooks.get("PermissionRequest").unwrap().array().unwrap()[0];
    let hook = &permission.get("hooks").unwrap().array().unwrap()[0];
    assert_eq!(hook.field("command").unwrap(), r"C:\x\webterminal.exe");
    assert_eq!(
        hook.get("args").unwrap().to_json(),
        r#"["bridge","--port","4183","--session","s1","--token","t0k"]"#
    );
    assert!(hook.integer("timeout").unwrap() as u64 > REQUEST_WAIT.as_secs());
    let ask = &hooks.get("PreToolUse").unwrap().array().unwrap()[0];
    assert_eq!(ask.field("matcher").unwrap(), "AskUserQuestion");
    let ran = &hooks.get("PostToolUse").unwrap().array().unwrap()[0];
    assert!(ran.get("matcher").is_none());
}

use std::sync::Arc;
