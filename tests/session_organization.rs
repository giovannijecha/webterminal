#![cfg(windows)]
mod support;

use support::{Harness, Socket, shell};
use webterminal::json::{self, Value};

fn create(socket: &mut Socket, cwd: &std::path::Path) -> String {
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&cwd.to_string_lossy())
    ));
    json::parse(&socket.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_owned()
}

fn list(app: &Harness) -> Vec<Value> {
    let response = app.request("/api/sessions", "");
    let body = response.split("\r\n\r\n").nth(1).unwrap();
    let message = json::parse(body).unwrap();
    let Some(Value::Array(entries)) = message.get("sessions") else {
        panic!("missing sessions array")
    };
    entries.clone()
}

fn ids(entries: &[Value]) -> Vec<&str> {
    entries
        .iter()
        .map(|entry| entry.field("id").unwrap())
        .collect()
}

#[test]
fn names_and_order_are_shared_and_invalid_changes_are_atomic() {
    let app = Harness::new(shell("--hold", None));
    let mut owner = app.socket();
    let first = create(&mut owner, &app.cwd);
    let second = create(&mut owner, &app.cwd);
    let initial = list(&app);
    assert_eq!(ids(&initial), [first.as_str(), second.as_str()]);
    assert_eq!(initial[0].get("name"), Some(&Value::Null));
    let original_title = initial[0].field("title").unwrap().to_owned();

    // A separate, unattached view can edit tab metadata without terminal control.
    let mut observer = app.socket();
    observer.send(&format!(
        "{{\"op\":\"rename\",\"id\":{},\"name\":\"  Work 😀  \"}}",
        json::quote(&first)
    ));
    observer.recv_matching(|text| {
        text.starts_with("{\"type\":\"sessions\"") && text.contains("\"name\":\"Work 😀\"")
    });
    let named = list(&app);
    assert_eq!(named[0].field("name").unwrap(), "Work 😀");
    assert_eq!(named[0].field("title").unwrap(), original_title);

    observer.send(&format!(
        "{{\"op\":\"reorder\",\"ids\":[{},{}]}}",
        json::quote(&second),
        json::quote(&first)
    ));
    observer.recv_matching(|text| {
        if let Ok(message) = json::parse(text)
            && message.field("type") == Ok("sessions")
            && let Some(Value::Array(entries)) = message.get("sessions")
        {
            return ids(entries) == [second.as_str(), first.as_str()];
        }
        false
    });
    let mut reconnected = app.socket();
    reconnected.send("{\"op\":\"list\"}");
    let fresh = json::parse(&reconnected.recv_matching(|text| {
        if let Ok(message) = json::parse(text)
            && message.field("type") == Ok("sessions")
            && let Some(Value::Array(entries)) = message.get("sessions")
        {
            return ids(entries) == [second.as_str(), first.as_str()];
        }
        false
    }))
    .unwrap();
    let Some(Value::Array(entries)) = fresh.get("sessions") else {
        unreachable!()
    };
    assert_eq!(entries[1].field("name").unwrap(), "Work 😀");

    for bad in [
        format!("[{}]", json::quote(&first)),
        format!("[{},{}]", json::quote(&first), json::quote(&first)),
        format!("[{},\"unknown\"]", json::quote(&first)),
        format!("[{},4]", json::quote(&first)),
    ] {
        observer.send(&format!("{{\"op\":\"reorder\",\"ids\":{bad}}}"));
        assert!(observer.recv_type("error").contains("Order"));
        assert_eq!(ids(&list(&app)), [second.as_str(), first.as_str()]);
    }
    for bad in ["a\nline".to_owned(), "\nedge".to_owned(), "é".repeat(81)] {
        observer.send(&format!(
            "{{\"op\":\"rename\",\"id\":{},\"name\":{}}}",
            json::quote(&first),
            json::quote(&bad)
        ));
        assert!(observer.recv_type("error").contains("name"));
        assert_eq!(list(&app)[1].field("name").unwrap(), "Work 😀");
    }

    let third = create(&mut owner, &app.cwd);
    assert_eq!(
        ids(&list(&app)),
        [second.as_str(), first.as_str(), third.as_str()]
    );
    observer.send(&format!(
        "{{\"op\":\"reorder\",\"ids\":[{},{}]}}",
        json::quote(&first),
        json::quote(&second)
    ));
    assert!(
        observer
            .recv_type("error")
            .contains("every current session")
    );
    assert_eq!(
        ids(&list(&app)),
        [second.as_str(), first.as_str(), third.as_str()]
    );
    observer.send(&format!(
        "{{\"op\":\"rename\",\"id\":{},\"name\":\"  \"}}",
        json::quote(&first)
    ));
    observer.recv_matching(|text| {
        if let Ok(message) = json::parse(text)
            && message.field("type") == Ok("sessions")
            && let Some(Value::Array(entries)) = message.get("sessions")
        {
            return entries.len() == 3 && entries[1].get("name") == Some(&Value::Null);
        }
        false
    });
    assert_eq!(list(&app)[1].field("title").unwrap(), original_title);
    owner.send(&format!(
        "{{\"op\":\"close\",\"id\":{}}}",
        json::quote(&second)
    ));
    owner.recv_matching(|text| {
        if let Ok(message) = json::parse(text)
            && message.field("type") == Ok("sessions")
            && let Some(Value::Array(entries)) = message.get("sessions")
        {
            return ids(entries) == [first.as_str(), third.as_str()];
        }
        false
    });
    assert_eq!(ids(&list(&app)), [first.as_str(), third.as_str()]);
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
