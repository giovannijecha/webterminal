#![cfg(windows)]
//! Settings store behavior against isolated temporary folders only; the real
//! `~/.webterminal` is never touched.
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use webterminal::json::{self, Value};
use webterminal::settings::{self, SaveError, Settings, Store, TerminalTheme};

/// A unique scratch folder removed on drop.
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "webterminal-settings-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    /// Settings file inside a folder that does not exist yet.
    fn file(&self) -> PathBuf {
        self.0.join("config").join("settings.json")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn value(text: &str) -> Value {
    json::parse(text).unwrap()
}
fn parsed(store: &Store) -> Value {
    json::parse(&store.json()).unwrap()
}
fn assert_no_temp(folder: &Path) {
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(!name.ends_with(".tmp"), "temporary file left: {name}");
        }
    }
}
/// The ordinary spelling of a canonical path, without `\\?\`.
fn canonical(path: &Path) -> PathBuf {
    let text = path.canonicalize().unwrap().to_string_lossy().into_owned();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
}

#[test]
fn missing_file_gives_defaults() {
    let scratch = Scratch::new();
    let store = Store::open(scratch.file());
    assert_eq!(store.current(), Settings::default());
    assert_eq!(store.revision(), 0);
    assert_eq!(store.start_folder(), None);
    assert_eq!(
        store.json(),
        format!(
            "{{\"type\":\"settings\",\"revision\":0,\"settings\":{{\"startFolder\":null,\"fontSize\":13,\"terminalTheme\":\"dark\",\"notifications\":{{\"input\":true,\"reply\":true,\"failure\":true}}}},\"path\":{},\"problem\":null,\"notice\":null}}",
            json::quote(&scratch.file().to_string_lossy())
        )
    );
    assert!(!scratch.file().exists(), "open must not create the file");
}

#[test]
fn default_path_is_user_scoped() {
    let path = settings::default_path().expect("USERPROFILE or HOME is set");
    assert!(path.is_absolute());
    assert!(path.ends_with(Path::new(".webterminal").join("settings.json")));
}

#[test]
fn save_round_trips_and_revision_survives_reopen() {
    let scratch = Scratch::new();
    let store = Store::open(scratch.file());
    let full = r#"{"startFolder":null,"fontSize":18,"terminalTheme":"light","notifications":{"input":false,"reply":true,"failure":false}}"#;
    let saved = json::parse(&store.save(0, &value(full)).unwrap()).unwrap();
    assert_eq!(saved.integer("revision").unwrap(), 1);
    assert_eq!(saved.get("settings"), Some(&value(full)));
    assert_eq!(saved.get("notice"), Some(&Value::Null));
    let file = fs::read_to_string(scratch.file()).unwrap();
    assert_eq!(
        file,
        format!("{{\"version\":1,\"revision\":1,\"settings\":{full}}}\n")
    );

    // Absent fields keep their saved value.
    store
        .save(1, &value(r#"{"notifications":{"input":true}}"#))
        .unwrap();
    let expected = Settings {
        start_folder: None,
        font_size: 18,
        terminal_theme: TerminalTheme::Light,
        notify_input: true,
        notify_reply: true,
        notify_failure: false,
    };
    assert_eq!(store.current(), expected);
    assert_eq!(store.revision(), 2);

    let reopened = Store::open(scratch.file());
    assert_eq!(reopened.current(), expected);
    assert_eq!(reopened.revision(), 2);
    assert_eq!(reopened.json(), store.json());
    assert_no_temp(&scratch.0.join("config"));
}

#[test]
fn stale_revision_conflicts_without_writing() {
    let scratch = Scratch::new();
    let first = Store::open(scratch.file());
    let second = Store::open(scratch.file());
    first.save(0, &value(r#"{"fontSize":20}"#)).unwrap();
    let before = fs::read(scratch.file()).unwrap();

    let Err(SaveError::Conflict(current)) = first.save(0, &value(r#"{"fontSize":12}"#)) else {
        panic!("stale base revision must conflict");
    };
    assert_eq!(current, first.json());
    // Another store sharing the file sees the change on its next save.
    let Err(SaveError::Conflict(current)) = second.save(0, &value(r#"{"fontSize":12}"#)) else {
        panic!("a change from another store must conflict");
    };
    let current = json::parse(&current).unwrap();
    assert_eq!(current.integer("revision").unwrap(), 1);
    assert_eq!(
        current
            .get("settings")
            .unwrap()
            .integer("fontSize")
            .unwrap(),
        20
    );
    assert_eq!(fs::read(scratch.file()).unwrap(), before);
    assert_eq!(second.current().font_size, 20);
    second.save(1, &value(r#"{"fontSize":12}"#)).unwrap();
    assert_eq!(Store::open(scratch.file()).current().font_size, 12);
}

#[test]
fn a_save_waits_for_another_stores_file_lock() {
    let scratch = Scratch::new();
    let path = scratch.file();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lock_path = path.with_file_name("settings.json.lock");
    let held = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .unwrap();
    held.lock().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let store = Store::open(path);
        started_tx.send(()).unwrap();
        result_tx
            .send(store.save(0, &value(r#"{"fontSize":18}"#)))
            .unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(result_rx.recv_timeout(Duration::from_millis(300)).is_err());
    drop(held);
    assert!(
        result_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_ok()
    );
    writer.join().unwrap();
}

#[test]
fn simultaneous_stores_cannot_both_save_the_same_revision() {
    for _ in 0..8 {
        let scratch = Scratch::new();
        let first = Store::open(scratch.file());
        let second = Store::open(scratch.file());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let other = barrier.clone();
        let writer = thread::spawn(move || {
            other.wait();
            first.save(0, &value(r#"{"fontSize":18}"#))
        });
        barrier.wait();
        let second_result = second.save(0, &value(r#"{"fontSize":12}"#));
        let results = [writer.join().unwrap(), second_result];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(SaveError::Conflict(_))))
                .count(),
            1
        );
        assert_eq!(Store::open(scratch.file()).revision(), 1);
        assert_no_temp(scratch.file().parent().unwrap());
    }
}

#[test]
fn invalid_fields_are_rejected_by_name() {
    let scratch = Scratch::new();
    let a_file = scratch.0.join("plain.txt");
    fs::write(&a_file, "not a folder").unwrap();
    let store = Store::open(scratch.file());
    let long = format!("C:\\{}", "a".repeat(1100));
    let cases = [
        ("[]".to_string(), "settings must be an object"),
        (r#"{"colour":1}"#.into(), "Unknown field settings.colour"),
        (
            r#"{"notifications":{"sound":true}}"#.into(),
            "Unknown field settings.notifications.sound",
        ),
        (
            r#"{"notifications":true}"#.into(),
            "settings.notifications must",
        ),
        (r#"{"fontSize":9}"#.into(), "settings.fontSize"),
        (r#"{"fontSize":21}"#.into(), "settings.fontSize"),
        (r#"{"fontSize":"14"}"#.into(), "settings.fontSize"),
        (
            r#"{"terminalTheme":"blue"}"#.into(),
            "settings.terminalTheme",
        ),
        (r#"{"terminalTheme":null}"#.into(), "settings.terminalTheme"),
        (
            r#"{"notifications":{"reply":"yes"}}"#.into(),
            "settings.notifications.reply",
        ),
        (r#"{"startFolder":5}"#.into(), "settings.startFolder"),
        (
            r#"{"startFolder":"relative\\folder"}"#.into(),
            "settings.startFolder must be an absolute path",
        ),
        (
            r#"{"startFolder":"\\no-drive"}"#.into(),
            "settings.startFolder must be an absolute path",
        ),
        (
            format!("{{\"startFolder\":{}}}", json::quote(&long)),
            "settings.startFolder must be at most 1024",
        ),
        (
            format!(
                "{{\"startFolder\":{}}}",
                json::quote(&scratch.0.join("missing").to_string_lossy())
            ),
            "settings.startFolder must be an existing folder",
        ),
        (
            format!(
                "{{\"startFolder\":{}}}",
                json::quote(&a_file.to_string_lossy())
            ),
            "settings.startFolder must be a folder",
        ),
    ];
    for (input, expected) in cases {
        match store.save(0, &value(&input)) {
            Err(SaveError::Invalid(message)) => {
                assert!(message.contains(expected), "{input}: {message}")
            }
            other => panic!("{input}: {other:?}"),
        }
    }
    assert_eq!(store.revision(), 0);
    assert_eq!(store.current(), Settings::default());
    assert!(!scratch.file().exists());
}

#[test]
fn start_folder_is_canonical_and_revalidated() {
    let scratch = Scratch::new();
    let folder = scratch.0.join("Projects");
    fs::create_dir(&folder).unwrap();
    let store = Store::open(scratch.file());
    let spelled = format!("{}/Projects/../Projects/.", scratch.0.to_string_lossy());
    let input = format!("{{\"startFolder\":{}}}", json::quote(&spelled));
    let saved = json::parse(&store.save(0, &value(&input)).unwrap()).unwrap();
    let expected = canonical(&folder);
    assert!(!expected.to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(
        saved.get("settings").unwrap().field("startFolder").unwrap(),
        expected.to_string_lossy()
    );
    assert_eq!(store.current().start_folder.as_ref(), Some(&expected));
    assert_eq!(store.start_folder(), Some(expected.clone()));

    // A folder removed later is ignored, and the unchanged value still saves.
    fs::remove_dir(&folder).unwrap();
    assert_eq!(store.start_folder(), None);
    let mut unchanged = parsed(&store).get("settings").unwrap().clone();
    if let Value::Object(fields) = &mut unchanged {
        fields.insert("fontSize".into(), Value::Number(16));
    }
    store.save(1, &unchanged).unwrap();
    assert_eq!(store.current().start_folder, Some(expected));

    // Empty or null clears it.
    store.save(2, &value(r#"{"startFolder":""}"#)).unwrap();
    assert_eq!(store.current().start_folder, None);
    assert_eq!(
        parsed(&store).get("settings").unwrap().get("startFolder"),
        Some(&Value::Null)
    );
}

#[test]
fn malformed_file_falls_back_and_is_preserved_on_save() {
    let bad_contents = [
        "{not json",
        "[]",
        r#"{"version":2,"revision":1,"settings":{}}"#,
        r#"{"version":1,"revision":-1,"settings":{}}"#,
        r#"{"version":1,"revision":1,"settings":{},"extra":true}"#,
        r#"{"version":1,"revision":1,"settings":{"fontSize":99}}"#,
        r#"{"version":1,"revision":1}"#,
    ];
    for bad in bad_contents {
        let scratch = Scratch::new();
        let folder = scratch.0.join("config");
        fs::create_dir_all(&folder).unwrap();
        fs::write(scratch.file(), bad).unwrap();
        fs::write(folder.join("settings.invalid.json"), "older copy").unwrap();

        let store = Store::open(scratch.file());
        assert_eq!(store.current(), Settings::default(), "{bad}");
        assert_eq!(store.revision(), 0);
        let problem = parsed(&store).field("problem").unwrap().to_string();
        assert!(
            problem.contains("settings.invalid.json"),
            "{bad}: {problem}"
        );

        let saved = json::parse(&store.save(0, &value(r#"{"fontSize":15}"#)).unwrap()).unwrap();
        assert_eq!(saved.get("problem"), Some(&Value::Null));
        assert!(
            saved
                .field("notice")
                .unwrap()
                .contains("settings.invalid.json")
        );
        assert_eq!(
            fs::read_to_string(folder.join("settings.invalid.json")).unwrap(),
            bad
        );
        assert_eq!(Store::open(scratch.file()).current().font_size, 15);
        assert_eq!(parsed(&store).get("notice"), Some(&Value::Null));
        assert_no_temp(&folder);
    }
}

#[test]
fn oversized_file_is_treated_as_malformed() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.0.join("config")).unwrap();
    let padded = format!(
        "{}{{\"version\":1,\"revision\":4,\"settings\":{{}}}}",
        " ".repeat(64 * 1024)
    );
    fs::write(scratch.file(), &padded).unwrap();
    let store = Store::open(scratch.file());
    assert_eq!(store.revision(), 0);
    let problem = parsed(&store).field("problem").unwrap().to_string();
    assert!(problem.contains("64 KiB"), "{problem}");
    store.save(0, &value("{}")).unwrap();
    let kept = scratch.0.join("config").join("settings.invalid.json");
    assert_eq!(fs::read_to_string(kept).unwrap(), padded);
}

#[test]
fn unwritable_targets_fail_cleanly() {
    // The settings path is a folder.
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.file()).unwrap();
    let store = Store::open(scratch.file());
    let before = store.json();
    assert!(parsed(&store).field("problem").unwrap().contains("folder"));
    assert!(matches!(
        store.save(0, &value(r#"{"fontSize":20}"#)),
        Err(SaveError::Io(_))
    ));
    assert_eq!(store.json(), before);
    assert!(scratch.file().is_dir());
    assert_no_temp(&scratch.0.join("config"));

    // The settings folder is a file.
    let scratch = Scratch::new();
    fs::write(scratch.0.join("config"), "file").unwrap();
    let store = Store::open(scratch.file());
    let Err(SaveError::Io(message)) = store.save(0, &value("{}")) else {
        panic!("a file in place of the folder must fail");
    };
    assert!(message.contains("settings folder"), "{message}");

    // A read-only file keeps its saved state.
    let scratch = Scratch::new();
    let store = Store::open(scratch.file());
    store.save(0, &value(r#"{"fontSize":20}"#)).unwrap();
    let before = (store.json(), fs::read(scratch.file()).unwrap());
    let mut permissions = fs::metadata(scratch.file()).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(scratch.file(), permissions.clone()).unwrap();
    let result = store.save(1, &value(r#"{"fontSize":18}"#));
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(scratch.file(), permissions).unwrap();
    assert!(matches!(result, Err(SaveError::Io(_))), "{result:?}");
    assert_eq!((store.json(), fs::read(scratch.file()).unwrap()), before);
    assert_eq!(store.current().font_size, 20);
    assert_no_temp(&scratch.0.join("config"));
}
