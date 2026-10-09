#![cfg(windows)]
mod support;

use support::{Harness, Socket, shell};
use webterminal::json::{self, Value};

fn create_in(socket: &mut Socket, cwd: &std::path::Path, workspace: Option<&str>) -> String {
    let workspace = workspace.map_or_else(String::new, |id| {
        format!(",\"workspace\":{}", json::quote(id))
    });
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24{workspace}}}",
        json::quote(&cwd.to_string_lossy())
    ));
    json::parse(&socket.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_owned()
}

fn create(socket: &mut Socket, cwd: &std::path::Path) -> String {
    create_in(socket, cwd, None)
}

fn listing(app: &Harness) -> Value {
    let response = app.request("/api/sessions", "");
    json::parse(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

fn array<'a>(message: &'a Value, key: &str) -> &'a [Value] {
    let Some(Value::Array(entries)) = message.get(key) else {
        panic!("missing {key} array")
    };
    entries
}

fn list(app: &Harness) -> Vec<Value> {
    array(&listing(app), "sessions").to_vec()
}

fn ids(entries: &[Value]) -> Vec<&str> {
    entries
        .iter()
        .map(|entry| entry.field("id").unwrap())
        .collect()
}

/// Workspaces as (id, name, session IDs), in display order.
fn workspaces(app: &Harness) -> Vec<(String, Option<String>, Vec<String>)> {
    array(&listing(app), "workspaces")
        .iter()
        .map(|workspace| {
            (
                workspace.field("id").unwrap().to_owned(),
                workspace
                    .get("name")
                    .and_then(Value::string)
                    .map(str::to_owned),
                array(workspace, "sessions")
                    .iter()
                    .map(|id| id.string().unwrap().to_owned())
                    .collect(),
            )
        })
        .collect()
}

fn layout(app: &Harness) -> Vec<(String, Vec<String>)> {
    workspaces(app)
        .into_iter()
        .map(|(id, _, sessions)| (id, sessions))
        .collect()
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn wait_for_sessions(socket: &mut Socket, predicate: impl Fn(&[Value]) -> bool) {
    socket.recv_matching(|text| {
        if let Ok(message) = json::parse(text)
            && message.field("type") == Ok("sessions")
            && let Some(Value::Array(entries)) = message.get("sessions")
        {
            return predicate(entries);
        }
        false
    });
}

#[test]
fn session_names_are_shared_and_invalid_names_are_atomic() {
    let app = Harness::new(shell("--hold", None));
    let mut owner = app.socket();
    let first = create(&mut owner, &app.cwd);
    let second = create(&mut owner, &app.cwd);
    let initial = list(&app);
    assert_eq!(ids(&initial), [first.as_str(), second.as_str()]);
    assert_eq!(initial[0].get("name"), Some(&Value::Null));
    let original_title = initial[0].field("title").unwrap().to_owned();

    // A separate, unattached view can edit names without terminal control.
    let mut observer = app.socket();
    observer.send(&format!(
        "{{\"op\":\"rename\",\"id\":{},\"name\":\"  Work 😀  \"}}",
        json::quote(&first)
    ));
    wait_for_sessions(&mut observer, |entries| {
        entries[0].field("name") == Ok("Work 😀")
    });
    let mut reconnected = app.socket();
    reconnected.send("{\"op\":\"list\"}");
    wait_for_sessions(&mut reconnected, |entries| {
        entries[0].field("name") == Ok("Work 😀")
    });
    assert_eq!(list(&app)[0].field("title").unwrap(), original_title);

    for bad in ["a\nline".to_owned(), "\nedge".to_owned(), "é".repeat(81)] {
        observer.send(&format!(
            "{{\"op\":\"rename\",\"id\":{},\"name\":{}}}",
            json::quote(&first),
            json::quote(&bad)
        ));
        assert!(observer.recv_type("error").contains("name"));
        assert_eq!(list(&app)[0].field("name").unwrap(), "Work 😀");
    }
    observer.send(&format!(
        "{{\"op\":\"rename\",\"id\":{},\"name\":\"  \"}}",
        json::quote(&first)
    ));
    wait_for_sessions(&mut observer, |entries| {
        entries[0].get("name") == Some(&Value::Null)
    });
    assert_eq!(list(&app)[0].field("title").unwrap(), original_title);
    owner.send(&format!(
        "{{\"op\":\"close\",\"id\":{}}}",
        json::quote(&first)
    ));
    wait_for_sessions(&mut owner, |entries| ids(entries) == [second.as_str()]);
    assert_eq!(layout(&app), [("w1".to_owned(), owned(&[&second]))]);
}

#[test]
fn workspaces_group_sessions_and_invalid_changes_are_atomic() {
    let app = Harness::new(shell("--hold", None));
    let mut socket = app.socket();
    assert_eq!(layout(&app), [("w1".to_owned(), vec![])]);
    let first = create(&mut socket, &app.cwd);
    let second = create(&mut socket, &app.cwd);

    socket.send("{\"op\":\"create-workspace\",\"request\":7}");
    let created = json::parse(&socket.recv_type("workspace-created")).unwrap();
    assert_eq!(created.integer("request"), Ok(7));
    let other = created.field("id").unwrap().to_owned();
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24,\"workspace\":{}}}",
        json::quote(&app.cwd.to_string_lossy()),
        json::quote(&other)
    ));
    let reply = json::parse(&socket.recv_type("created")).unwrap();
    assert_eq!(reply.field("workspace"), Ok(other.as_str()));
    let third = reply.field("id").unwrap().to_owned();

    socket.send(&format!(
        "{{\"op\":\"move\",\"id\":{},\"workspace\":{},\"position\":0}}",
        json::quote(&second),
        json::quote(&other)
    ));
    socket.recv_matching(|text| {
        text.contains(&format!(
            "\"sessions\":[{},{}]",
            json::quote(&second),
            json::quote(&third)
        ))
    });
    socket.send(&format!(
        "{{\"op\":\"order-workspaces\",\"ids\":[{},\"w1\"]}}",
        json::quote(&other)
    ));
    wait_for_sessions(&mut socket, |entries| {
        ids(entries) == [second.as_str(), third.as_str(), first.as_str()]
    });
    let expected = [
        (other.clone(), owned(&[&second, &third])),
        ("w1".to_owned(), owned(&[&first])),
    ];
    assert_eq!(layout(&app), expected);

    for bad in [
        "[\"w1\"]",
        "[\"w1\",\"w1\"]",
        "[\"w1\",\"w9\"]",
        "[\"w1\",4]",
        "\"w1\"",
    ] {
        socket.send(&format!("{{\"op\":\"order-workspaces\",\"ids\":{bad}}}"));
        assert!(socket.recv_type("error").contains("Order"));
        assert_eq!(layout(&app), expected);
    }
    let quoted = json::quote(&first);
    for (bad, message) in [
        (
            format!("\"id\":{quoted},\"workspace\":\"w9\",\"position\":0"),
            "Workspace",
        ),
        (
            "\"id\":\"s99\",\"workspace\":\"w1\",\"position\":0".to_owned(),
            "no longer exists",
        ),
        (
            format!("\"id\":{quoted},\"workspace\":\"w1\",\"position\":-1"),
            "negative",
        ),
    ] {
        socket.send(&format!("{{\"op\":\"move\",{bad}}}"));
        assert!(socket.recv_type("error").contains(message));
        assert_eq!(layout(&app), expected);
    }

    socket.send(&format!(
        "{{\"op\":\"rename-workspace\",\"id\":{},\"name\":\"  Agents  \"}}",
        json::quote(&other)
    ));
    socket.recv_matching(|text| text.contains("\"name\":\"Agents\""));
    for bad in ["a\tb".to_owned(), "x".repeat(81)] {
        socket.send(&format!(
            "{{\"op\":\"rename-workspace\",\"id\":{},\"name\":{}}}",
            json::quote(&other),
            json::quote(&bad)
        ));
        assert!(socket.recv_type("error").contains("Workspace name"));
    }
    assert_eq!(workspaces(&app)[0].1.as_deref(), Some("Agents"));

    // A full workspace rejects new and moved sessions without side effects.
    for _ in 0..3 {
        create_in(&mut socket, &app.cwd, Some("w1"));
    }
    socket.send(&format!(
        "{{\"op\":\"create\",\"request\":9,\"cwd\":{},\"cols\":80,\"rows\":24,\"workspace\":\"w1\"}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    let error = json::parse(&socket.recv_type("error")).unwrap();
    assert_eq!(error.integer("request"), Ok(9));
    assert!(error.field("message").unwrap().contains("at most 4"));
    socket.send(&format!(
        "{{\"op\":\"move\",\"id\":{},\"workspace\":\"w1\",\"position\":0}}",
        json::quote(&second)
    ));
    assert!(socket.recv_type("error").contains("at most 4"));
    assert_eq!(list(&app).len(), 6);

    socket.send("{\"op\":\"close-workspace\",\"id\":\"w1\"}");
    wait_for_sessions(&mut socket, |entries| {
        ids(entries) == [second.as_str(), third.as_str()]
    });
    assert_eq!(layout(&app), [(other.clone(), owned(&[&second, &third]))]);
    socket.send("{\"op\":\"close-workspace\",\"id\":\"w1\"}");
    assert!(
        socket
            .recv_type("error")
            .contains("Workspace no longer exists")
    );

    // Closing the last workspace leaves a fresh, empty one.
    socket.send(&format!(
        "{{\"op\":\"close-workspace\",\"id\":{}}}",
        json::quote(&other)
    ));
    wait_for_sessions(&mut socket, <[Value]>::is_empty);
    let remaining = layout(&app);
    assert_eq!(remaining.len(), 1);
    assert!(remaining[0].1.is_empty());
    assert_ne!(remaining[0].0, other);
}

#[test]
fn create_requests_correlate_success_and_validation_errors() {
    let app = Harness::new(shell("--hold", None));
    let mut socket = app.socket();
    let missing = app.cwd.join("missing-directory");
    socket.send(&format!(
        "{{\"op\":\"create\",\"request\":41,\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&missing.to_string_lossy())
    ));
    let error = json::parse(&socket.recv_type("error")).unwrap();
    assert_eq!(error.field("op"), Ok("create"));
    assert_eq!(error.integer("request"), Ok(41));
    assert!(error.field("message").unwrap().contains("directory"));
    assert!(list(&app).is_empty());

    socket.send(&format!(
        "{{\"op\":\"create\",\"request\":42,\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    let created = json::parse(&socket.recv_type("created")).unwrap();
    assert_eq!(created.integer("request"), Ok(42));
    let id = created.field("id").unwrap();
    assert_eq!(ids(&list(&app)), [id]);

    for bad in ["0", "9007199254740992", "\"42\""] {
        socket.send(&format!(
            "{{\"op\":\"create\",\"request\":{bad},\"cwd\":{},\"cols\":80,\"rows\":24}}",
            json::quote(&app.cwd.to_string_lossy())
        ));
        let error = json::parse(&socket.recv_type("error")).unwrap();
        assert_eq!(error.field("op"), Ok("create"));
        assert!(error.get("request").is_none());
        assert!(error.field("message").unwrap().contains("request"));
        assert_eq!(ids(&list(&app)), [id]);
    }

    socket.send("{\"op\":\"create\",\"request\":43,");
    let malformed = json::parse(&socket.recv_type("error")).unwrap();
    assert!(malformed.get("op").is_none());
    assert!(malformed.get("request").is_none());
}

#[test]
fn closing_confirms_only_while_a_program_runs_beyond_the_shell() {
    // A terminal whose job holds only its shell closes at once.
    let idle = Harness::new(shell("--hold", None));
    let mut socket = idle.socket();
    let id = create(&mut socket, &idle.cwd);
    socket.send(&format!("{{\"op\":\"close\",\"id\":{}}}", json::quote(&id)));
    wait_for_sessions(&mut socket, <[Value]>::is_empty);

    // A child process keeps it busy until the view forces the close.
    let marker = std::env::temp_dir().join(format!("webterminal-busy-{}.lock", std::process::id()));
    let busy = Harness::new(shell("--tree", Some(&marker)));
    let mut socket = busy.socket();
    let id = create(&mut socket, &busy.cwd);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !marker.exists() {
        assert!(
            std::time::Instant::now() < until,
            "fixture child did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let workspace = workspaces(&busy)[0].0.clone();
    let mut targets = Vec::new();
    for (op, target) in [("close", &id), ("close-workspace", &workspace)] {
        socket.send(&format!(
            "{{\"op\":\"{op}\",\"id\":{}}}",
            json::quote(target)
        ));
        let reply = json::parse(&socket.recv_type("busy")).unwrap();
        assert_eq!(reply.field("op"), Ok(op));
        assert_eq!(array(&reply, "sessions")[0].string(), Some(id.as_str()));
        if op == "close-workspace" {
            targets = array(&reply, "targets")
                .iter()
                .map(|id| id.string().unwrap().to_owned())
                .collect();
        }
    }
    assert_eq!(list(&busy).len(), 1);
    assert_eq!(targets.as_slice(), std::slice::from_ref(&id));
    for invalid in [
        "\"force\":true".to_owned(),
        "\"force\":true,\"confirmed\":null".to_owned(),
        "\"force\":true,\"confirmed\":[42]".to_owned(),
        format!(
            "\"force\":true,\"confirmed\":[{},{}]",
            json::quote(&id),
            json::quote(&id)
        ),
        format!("\"force\":false,\"confirmed\":[{}]", json::quote(&id)),
        format!("\"force\":\"true\",\"confirmed\":[{}]", json::quote(&id)),
    ] {
        socket.send(&format!(
            "{{\"op\":\"close-workspace\",\"id\":{}, {invalid}}}",
            json::quote(&workspace)
        ));
        let reply = socket.recv_type("error");
        assert!(reply.contains("confirmation") || reply.contains("force"));
        assert_eq!(layout(&busy), [(workspace.clone(), owned(&[&id]))]);
    }
    socket.send(&format!(
        "{{\"op\":\"close-workspace\",\"id\":{},\"force\":true,\"confirmed\":[{}]}}",
        json::quote(&workspace),
        json::quote(&id)
    ));
    wait_for_sessions(&mut socket, <[Value]>::is_empty);
    let _ = std::fs::remove_file(marker);
}

#[test]
fn stale_workspace_confirmation_does_not_close_a_new_member() {
    let marker = std::env::temp_dir().join(format!(
        "webterminal-stale-close-{}.lock",
        std::process::id()
    ));
    let app = Harness::new(shell("--tree", Some(&marker)));
    let mut owner = app.socket();
    let mut other = app.socket();
    let original = create(&mut owner, &app.cwd);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !marker.exists() {
        assert!(
            std::time::Instant::now() < until,
            "fixture child did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    owner.send("{\"op\":\"close-workspace\",\"id\":\"w1\"}");
    let busy = json::parse(&owner.recv_type("busy")).unwrap();
    assert_eq!(
        array(&busy, "sessions")[0].string(),
        Some(original.as_str())
    );

    other.send("{\"op\":\"create-workspace\"}");
    let second = json::parse(&other.recv_type("workspace-created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_owned();
    other.send(&format!(
        "{{\"op\":\"move\",\"id\":{},\"workspace\":{},\"position\":0}}",
        json::quote(&original),
        json::quote(&second)
    ));
    other.recv_matching(|text| {
        text.contains(&format!("\"sessions\":[{}]", json::quote(&original)))
            && text.contains(&json::quote(&second))
    });
    let replacement = create_in(&mut other, &app.cwd, Some("w1"));

    owner.send(&format!(
        "{{\"op\":\"close-workspace\",\"id\":\"w1\",\"force\":true,\"confirmed\":[{}]}}",
        json::quote(&original)
    ));
    let reply = owner.recv_matching(|text| {
        text.starts_with("{\"type\":\"error\"") || text.starts_with("{\"type\":\"busy\"")
    });
    assert!(reply.contains("confirmation") || reply.contains("\"type\":\"busy\""));
    assert_eq!(
        layout(&app),
        [
            ("w1".to_owned(), owned(&[&replacement])),
            (second.clone(), owned(&[&original]))
        ]
    );
    assert_eq!(array(&busy, "targets")[0].string(), Some(original.as_str()));
    other.send(&format!(
        "{{\"op\":\"close-workspace\",\"id\":{}}}",
        json::quote(&second)
    ));
    let reply = json::parse(&other.recv_type("busy")).unwrap();
    assert_eq!(
        array(&reply, "targets")[0].string(),
        Some(original.as_str())
    );
    other.send(&format!(
        "{{\"op\":\"close-workspace\",\"id\":{},\"force\":true,\"confirmed\":[{}]}}",
        json::quote(&second),
        json::quote(&original)
    ));
    wait_for_sessions(&mut other, |entries| ids(entries) == [replacement.as_str()]);
    other.send(&format!(
        "{{\"op\":\"close-workspace\",\"id\":\"w1\",\"force\":true,\"confirmed\":[{}]}}",
        json::quote(&replacement)
    ));
    wait_for_sessions(&mut other, <[Value]>::is_empty);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        match std::fs::remove_file(&marker) {
            Ok(()) => break,
            Err(_) if std::time::Instant::now() < until => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => panic!("fixture marker cleanup failed: {error}"),
        }
    }
}
