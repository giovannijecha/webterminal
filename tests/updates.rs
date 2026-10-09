#![cfg(windows)]
mod support;

use support::{Harness, Socket, shell};
use webterminal::json::{self, Value};

fn terminal_message(socket: &mut Socket) -> Value {
    json::parse(&socket.recv_matching(|text| {
        text.starts_with("{\"type\":\"snapshot\"") || text.starts_with("{\"type\":\"update\"")
    }))
    .unwrap()
}
fn array(value: &Value) -> &[Value] {
    let Value::Array(values) = value else {
        panic!("Expected an array")
    };
    values
}
fn screen_text(snapshot: &Value) -> String {
    array(snapshot.get("terminal").unwrap().get("screen").unwrap())
        .iter()
        .flat_map(|line| {
            array(line.get("cells").unwrap())
                .iter()
                .map(|cell| array(cell)[0].string().unwrap())
        })
        .collect()
}
fn apply(previous: &Value, next: Value) -> Value {
    if next.field("type").unwrap() == "snapshot" {
        return next;
    }
    assert_eq!(
        next.integer("base").unwrap(),
        previous.integer("seq").unwrap()
    );
    assert!(next.integer("seq").unwrap() > previous.integer("seq").unwrap());
    assert!(next.integer("epoch").unwrap() >= previous.integer("epoch").unwrap());
    let Value::Object(mut envelope) = next else {
        panic!("Expected envelope")
    };
    let Value::Object(mut terminal) = envelope.remove("terminal").unwrap() else {
        panic!("Expected terminal")
    };
    let old = previous.get("terminal").unwrap();
    if let Some(changes) = terminal.remove("screenChanges") {
        let mut screen = array(old.get("screen").unwrap()).to_vec();
        for change in array(&changes) {
            let pair = array(change);
            screen[pair[0].number().unwrap() as usize] = pair[1].clone();
        }
        terminal.insert("screen".into(), Value::Array(screen));
    }
    if let Some(changes) = terminal.remove("historyChanges") {
        let drop = changes.integer("drop").unwrap() as usize;
        let keep = changes.integer("keep").unwrap() as usize;
        let mut history = array(old.get("history").unwrap())[drop..drop + keep].to_vec();
        history.extend_from_slice(array(changes.get("append").unwrap()));
        terminal.insert("history".into(), Value::Array(history));
    }
    terminal
        .entry("history".into())
        .or_insert_with(|| old.get("history").unwrap().clone());
    terminal
        .entry("screen".into())
        .or_insert_with(|| old.get("screen").unwrap().clone());
    envelope.insert("terminal".into(), Value::Object(terminal));
    Value::Object(envelope)
}
fn create(socket: &mut Socket, app: &Harness) -> (String, Value) {
    socket.send(&format!(
        "{{\"op\":\"create\",\"updates\":true,\"cwd\":{},\"cols\":40,\"rows\":8}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    let created = json::parse(&socket.recv_type("created")).unwrap();
    (
        created.field("id").unwrap().into(),
        terminal_message(socket),
    )
}

#[test]
fn compact_view_tracks_output_exit_and_fresh_attachment() {
    let app = Harness::new(shell("--echo", None));
    let mut owner = app.socket();
    let (id, mut state) = create(&mut owner, &app);
    while !screen_text(&state).contains("READY") {
        state = apply(&state, terminal_message(&mut owner));
    }
    let epoch = state.integer("epoch").unwrap();
    owner.send(&format!(
        "{{\"op\":\"input\",\"id\":{},\"epoch\":{epoch},\"seq\":1,\"data\":\"ORDERED_ECHO\\r\"}}",
        json::quote(&id)
    ));
    let mut updates = 0;
    while state.get("alive") != Some(&Value::Bool(false)) {
        let next = terminal_message(&mut owner);
        assert_eq!(next.field("type").unwrap(), "update");
        assert!(next.get("terminal").unwrap().get("history").is_none());
        state = apply(&state, next);
        updates += 1;
    }
    assert!(updates > 0);
    assert!(screen_text(&state).contains("ECHO:ORDERED_ECHO"));
    assert_eq!(state.get("exitCode"), Some(&Value::Number(0)));
    let mut legacy = app.socket();
    legacy.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"cols\":40,\"rows\":8}}",
        json::quote(&id)
    ));
    let restored = terminal_message(&mut legacy);
    assert_eq!(restored.field("type").unwrap(), "snapshot");
    assert_eq!(restored.get("terminal"), state.get("terminal"));
    owner.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"request\":77,\"updates\":true,\"cols\":40,\"rows\":8}}",
        json::quote(&id)
    ));
    assert_eq!(
        json::parse(&owner.recv_type("attached"))
            .unwrap()
            .integer("request")
            .unwrap(),
        77
    );
    let fresh = terminal_message(&mut owner);
    assert_eq!(fresh.field("type").unwrap(), "snapshot");
    assert!(fresh.get("base").is_none());
    assert_eq!(fresh.get("terminal"), state.get("terminal"));
}

#[test]
fn compact_view_control_transfer_is_ordered_and_invalid_options_have_no_effect() {
    let app = Harness::new(shell("--hold", None));
    let mut owner = app.socket();
    owner.send(&format!(
        "{{\"op\":\"create\",\"updates\":\"yes\",\"cwd\":{},\"cols\":40,\"rows\":8}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    assert!(
        owner
            .recv_type("error")
            .contains("Updates must be a boolean")
    );
    assert!(app.request("/api/sessions", "").contains("\"sessions\":[]"));
    let (id, mut state) = create(&mut owner, &app);
    let mut observer = app.socket();
    observer.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"request\":1,\"updates\":true,\"cols\":40,\"rows\":8}}",
        json::quote(&id)
    ));
    observer.recv_type("attached");
    let observed = terminal_message(&mut observer);
    assert_eq!(observed.field("type").unwrap(), "snapshot");
    observer.send(&format!(
        "{{\"op\":\"claim\",\"id\":{},\"cols\":42,\"rows\":9}}",
        json::quote(&id)
    ));
    let claimed = apply(&observed, terminal_message(&mut observer));
    while state.integer("epoch").unwrap() < claimed.integer("epoch").unwrap() {
        state = apply(&state, terminal_message(&mut owner));
    }
    assert_eq!(state.get("terminal"), claimed.get("terminal"));
    assert_eq!(state.get("controller"), claimed.get("controller"));
    assert_eq!(state.get("terminal").unwrap().integer("cols").unwrap(), 42);
    owner.send(&format!(
        "{{\"op\":\"input\",\"id\":{},\"epoch\":{},\"seq\":1,\"data\":\"WRONG\"}}",
        json::quote(&id),
        state.integer("epoch").unwrap()
    ));
    assert!(owner.recv_type("error").contains("Control changed"));
}
