#![cfg(windows)]
#![allow(dead_code)]
//! Exact-selection close, the read-only view routes and settings saved over
//! the socket.
mod support;

use support::{Harness, Socket, shell};
use webterminal::json::{self, Value};

fn body(app: &Harness, path: &str) -> Value {
    let response = app.request(path, "");
    assert!(response.starts_with("HTTP/1.1 200"), "{path}: {response}");
    json::parse(response.split_once("\r\n\r\n").unwrap().1).unwrap()
}
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::array).unwrap_or_default()
}
fn create(socket: &mut Socket, app: &Harness) -> String {
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    json::parse(&socket.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_owned()
}
fn session_ids(app: &Harness) -> Vec<String> {
    array(&body(app, "/api/sessions"), "sessions")
        .iter()
        .map(|session| session.field("id").unwrap().to_owned())
        .collect()
}
fn close(socket: &mut Socket, ids: &[&str]) {
    let ids: Vec<String> = ids.iter().map(|id| json::quote(id)).collect();
    socket.send(&format!(
        "{{\"op\":\"close-sessions\",\"ids\":[{}]}}",
        ids.join(",")
    ));
}

#[test]
fn exact_selection_close_affects_only_listed_terminals() {
    let app = Harness::new(shell("--hold", None));
    let mut socket = app.socket();
    let ids: Vec<String> = (0..3).map(|_| create(&mut socket, &app)).collect();
    let (a, b, c) = (ids[0].as_str(), ids[1].as_str(), ids[2].as_str());
    for (selection, message) in [
        (vec![], "Select 1..32"),
        (vec![a, a], "duplicate"),
        (vec![a, "s999"], "Selection changed"),
    ] {
        close(&mut socket, &selection);
        assert!(socket.recv_type("error").contains(message), "{message}");
        assert_eq!(session_ids(&app), ids);
    }
    close(&mut socket, &[c, a]);
    let closed = json::parse(&socket.recv_type("closed")).unwrap();
    let closed: Vec<&str> = array(&closed, "ids")
        .iter()
        .filter_map(Value::string)
        .collect();
    assert_eq!(closed, [c, a]);
    assert_eq!(session_ids(&app), [b]);
}

#[test]
fn read_routes_describe_only_owned_state() {
    let app = Harness::new(shell("--hold", None));
    let mut socket = app.socket();
    let id = create(&mut socket, &app);

    let info = body(&app, "/api/info");
    assert_eq!(info.integer("port"), Ok(i64::from(app.port)));
    assert_eq!(info.integer("pid"), Ok(i64::from(std::process::id())));
    // Programs need a PowerShell base shell; this fixture shell hosts none.
    let programs = body(&app, "/api/programs");
    assert!(matches!(programs.get("hosted"), Some(Value::Bool(false))));
    assert!(
        array(&programs, "programs")
            .iter()
            .all(|program| matches!(program.get("available"), Some(Value::Bool(false))))
    );
    let processes = body(&app, "/api/processes");
    let sessions = array(&processes, "sessions");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].field("id"), Ok(id.as_str()));
    let owned = array(&sessions[0], "processes");
    assert!(owned.iter().any(|process| {
        matches!(process.get("root"), Some(Value::Bool(true)))
            && process
                .field("name")
                .is_ok_and(|name| name.eq_ignore_ascii_case("native_fixture.exe"))
    }));
    let files = body(&app, "/api/files");
    assert!(array(&files, "files").is_empty());
    let agents = body(&app, "/api/agents");
    assert!(array(&agents, "sources").is_empty() && array(&agents, "requests").is_empty());

    for path in [
        "/api/processes",
        "/api/files",
        "/api/agents",
        "/api/settings",
    ] {
        let foreign = app.raw_http(&format!(
            "GET {path} HTTP/1.1\r\nHost: evil.example\r\n\r\n"
        ));
        assert!(foreign.starts_with("HTTP/1.1 403"), "{path}");
        let cross_site = app.request(path, "Sec-Fetch-Site: cross-site\r\n");
        assert!(cross_site.starts_with("HTTP/1.1 403"), "{path}");
    }
}

#[test]
fn settings_saved_over_the_socket_reject_stale_revisions() {
    let app = Harness::new(shell("--hold", None));
    let mut writer = app.socket();
    // The connection publishes initial settings independently of any save.
    // Consume that snapshot before waiting for the save's settings response.
    writer.recv_type("settings");
    let revision = body(&app, "/api/settings").integer("revision").unwrap();
    let save = |revision: i64, size: u32| {
        format!(
            "{{\"op\":\"save-settings\",\"revision\":{revision},\"settings\":{{\"fontSize\":{size},\"notifications\":{{\"reply\":false}}}}}}"
        )
    };
    writer.send(&save(revision, 15));
    let saved = json::parse(&writer.recv_type("settings")).unwrap();
    let next = saved.integer("revision").unwrap();
    assert!(next > revision);
    let settings = saved.get("settings").unwrap();
    assert_eq!(settings.integer("fontSize"), Ok(15));
    let notifications = settings.get("notifications").unwrap();
    assert!(matches!(
        notifications.get("reply"),
        Some(Value::Bool(false))
    ));
    assert!(matches!(
        notifications.get("input"),
        Some(Value::Bool(true))
    ));

    // A draft based on the earlier revision is refused and nothing changes.
    writer.send(&save(revision, 18));
    assert!(writer.recv_type("error").contains("changed elsewhere"));
    let current = body(&app, "/api/settings");
    assert_eq!(current.integer("revision"), Ok(next));
    assert_eq!(current.get("settings").unwrap().integer("fontSize"), Ok(15));
    writer.send(&save(next, 99));
    assert!(writer.recv_type("error").contains("fontSize"));
}
