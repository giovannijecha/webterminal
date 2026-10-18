use super::disk::{MARKER, MARKER_FILE, NAME_LIMIT};
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct Base(PathBuf);
impl Base {
    fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "webterminal-uploads-test-{label}-{}-{stamp}",
            std::process::id()
        ));
        Self(path)
    }
}
impl Drop for Base {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Sends its byte budget, then fails like a dropped connection.
struct Broken(usize);
impl Read for Broken {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.0 == 0 {
            return Err(io::ErrorKind::ConnectionReset.into());
        }
        let count = self.0.min(buffer.len());
        buffer[..count].fill(7);
        self.0 -= count;
        Ok(count)
    }
}

/// A body that must stay unread.
struct Untouched;
impl Read for Untouched {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        panic!("a refused upload must not read its body")
    }
}

fn stage(uploads: &Uploads, session: &str, name: &str, bytes: &[u8]) -> StagedCopy {
    let mut body = bytes;
    uploads
        .receive(session, name, bytes.len() as u64, b"", &mut body)
        .unwrap()
        .commit()
        .unwrap()
}

#[cfg(windows)]
#[test]
fn an_intermediate_junction_cannot_redirect_copy_removal() {
    let base = Base::new("junction");
    let outside = Base::new("junction-outside");
    let uploads = Uploads::new(base.0.clone(), "owner".into());
    uploads.open_session("s1");
    let copy = stage(&uploads, "s1", "file.txt", b"staged");
    let session = base.0.join("owner").join("s1");
    let parked = base.0.join("owner").join("parked");
    fs::rename(&session, &parked).unwrap();
    let external_copy = outside.0.join("1");
    fs::create_dir_all(&external_copy).unwrap();
    let external_file = external_copy.join("important.txt");
    fs::write(&external_file, b"keep").unwrap();
    let result = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&session)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    assert!(uploads.remove_copy(&copy.id).is_err());
    assert_eq!(fs::read(&external_file).unwrap(), b"keep");

    fs::remove_dir(&session).unwrap();
    fs::rename(parked, session).unwrap();
    drop(uploads);
}

#[cfg(windows)]
#[test]
fn an_intermediate_junction_cannot_redirect_new_uploads() {
    let base = Base::new("junction-write");
    let outside = Base::new("junction-write-outside");
    let uploads = Uploads::new(base.0.clone(), "owner".into());
    uploads.open_session("s1");
    stage(&uploads, "s1", "first.txt", b"first");
    let session = base.0.join("owner").join("s1");
    let parked = base.0.join("owner").join("parked");
    fs::rename(&session, &parked).unwrap();
    fs::create_dir_all(&outside.0).unwrap();
    let result = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&session)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let mut body: &[u8] = b"second";
    assert!(
        uploads
            .receive("s1", "second.txt", 6, b"", &mut body)
            .is_err()
    );
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);

    fs::remove_dir(&session).unwrap();
    fs::rename(parked, session).unwrap();
}

#[test]
fn shutdown_waits_for_an_inflight_copy_before_removing_staging() {
    let base = Base::new("shutdown-inflight");
    let uploads = Uploads::new(base.0.clone(), "owner".into());
    uploads.open_session("s1");
    let mut body: &[u8] = b"copy";
    let pending = uploads
        .receive("s1", "copy.txt", 4, b"", &mut body)
        .unwrap();
    let root = base.0.join("owner");
    uploads.remove_all();
    drop(pending);
    assert!(!root.exists());
    assert!(!base.0.join("owner.lock").exists());
}

#[test]
fn names_stay_single_valid_components() {
    assert_eq!(file_name("report.pdf"), "report.pdf");
    assert_eq!(file_name("a/b\\c:d?.txt"), "a_b_c_d_.txt");
    assert_eq!(file_name("con.txt"), "_con.txt");
    assert_eq!(file_name("COM1"), "_COM1");
    assert_eq!(file_name("COMPANY.txt"), "COMPANY.txt");
    assert_eq!(file_name(" .. "), "file");
    assert_eq!(file_name("tail. "), "tail");
    assert_eq!(file_name("日本\u{7}.png"), "日本_.png");
    assert!(file_name(&"é".repeat(200)).len() <= NAME_LIMIT);
    assert_eq!(
        bounded(&"é".repeat(600), ORIGINAL_LIMIT).len(),
        ORIGINAL_LIMIT
    );
}

#[test]
fn staged_files_hold_exact_bytes_and_failures_leave_nothing() {
    let base = Base::new("receive");
    let uploads = Uploads::new(base.0.clone(), "owner".into());
    uploads.open_session("s1");
    let mut body: &[u8] = b"lo world";
    let copy = uploads
        .receive("s1", "hello.txt", 11, b"hel", &mut body)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(fs::read(&copy.path).unwrap(), b"hello world");
    assert!(copy.path.starts_with(base.0.join("owner").join("s1")));
    assert_eq!(copy.path.file_name().unwrap(), "hello.txt");
    assert_eq!(
        (copy.id.as_str(), copy.original.as_str(), copy.size),
        ("f1", "hello.txt", 11)
    );

    let mut short: &[u8] = b"12";
    let Err(UploadError::Failed(error)) = uploads.receive("s1", "short.bin", 10, b"", &mut short)
    else {
        panic!("a short upload was accepted");
    };
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    let mut empty: &[u8] = b"";
    assert!(
        uploads
            .receive("s1", "big", FILE_LIMIT + 1, b"", &mut empty)
            .is_err()
    );
    assert!(uploads.receive("s1", "x", 1, b"ab", &mut empty).is_err());
    // A connection dropped mid-transfer leaves no partial file.
    let dropped = uploads.receive("s1", "cut.bin", 1 << 20, b"", &mut Broken(100_000));
    assert!(matches!(dropped, Err(UploadError::Failed(_))));
    let staged = fs::read_dir(base.0.join("owner").join("s1"))
        .unwrap()
        .count();
    assert_eq!(staged, 1, "failed uploads must remove their folders");
    assert_eq!(uploads.copies(), std::slice::from_ref(&copy));

    // A received copy that is never committed is discarded with its folder.
    let mut again: &[u8] = b"";
    let pending = uploads
        .receive("s1", "hello.txt", 0, b"", &mut again)
        .unwrap();
    let same = pending.path().to_path_buf();
    assert!(same.exists());
    assert_ne!(same, copy.path, "equal names stage side by side");
    drop(pending);
    assert!(!same.parent().unwrap().exists());
    assert_eq!(uploads.copies(), [copy]);

    uploads.remove_session("s1");
    assert!(!base.0.join("owner").join("s1").exists());
    assert!(uploads.copies().is_empty());
    uploads.remove_all();
    assert!(!base.0.join("owner").exists());
    assert!(!base.0.join("owner.lock").exists());
}

#[test]
fn copies_are_distinct_listed_newest_first_and_removed_only_by_id() {
    let base = Base::new("registry");
    let uploads = Uploads::new(base.0.clone(), "owner".into());
    uploads.open_session("s1");
    uploads.open_session("s2");
    let first = stage(&uploads, "s1", "same \"name\".txt", b"one");
    let twin = stage(&uploads, "s1", "same \"name\".txt", b"one");
    let other = stage(&uploads, "s2", "same \"name\".txt", b"one");
    assert_eq!(
        [&first, &twin, &other].map(|copy| copy.id.as_str()),
        ["f1", "f2", "f3"]
    );
    for copy in [&first, &twin, &other] {
        assert_eq!(copy.original, "same \"name\".txt");
        assert_eq!(copy.name, "same _name_.txt");
        assert_eq!(fs::read(&copy.path).unwrap(), b"one");
    }
    assert_ne!(first.path, twin.path);
    assert!(other.path.starts_with(base.0.join("owner").join("s2")));
    assert_eq!(
        uploads.copies(),
        [other.clone(), twin.clone(), first.clone()]
    );

    let listing = json::parse(&uploads.copies_json()).unwrap();
    assert_eq!(listing.field("type"), Ok("files"));
    assert_eq!(listing.integer("limit"), Ok(COPY_LIMIT as i64));
    let files = listing.get("files").and_then(json::Value::array).unwrap();
    assert_eq!(files.len(), 3);
    assert_eq!(files[0].field("id"), Ok("f3"));
    assert_eq!(files[0].field("session"), Ok("s2"));
    assert_eq!(files[0].field("original"), Ok("same \"name\".txt"));
    assert_eq!(files[0].field("name"), Ok("same _name_.txt"));
    assert_eq!(files[0].integer("size"), Ok(3));
    assert_eq!(files[0].field("path"), Ok(&*other.path.to_string_lossy()));
    assert_eq!(files[0].integer("created"), Ok(other.created_ms as i64));
    assert!(other.created_ms > 0);

    for unknown in ["f9", "f01", "f", "1", "../s1", ""] {
        assert!(uploads.remove_copy(unknown).is_err(), "{unknown}");
    }
    assert_eq!(uploads.copy("f2"), Some(twin.clone()));
    assert_eq!(uploads.remove_copy("f2").unwrap(), twin);
    assert!(!twin.path.parent().unwrap().exists());
    assert!(first.path.exists() && other.path.exists());
    assert_eq!(uploads.copy("f2"), None);
    assert!(uploads.remove_copy("f2").is_err());
    assert_eq!(stage(&uploads, "s1", "next", b"").id, "f4");
}

#[test]
fn closed_sessions_and_the_copy_limit_refuse_before_reading() {
    let base = Base::new("live");
    let mut uploads = Uploads::new(base.0.clone(), "owner".into());
    uploads.limit = 2;
    let refused = uploads.receive("s1", "f", 1, b"", &mut Untouched);
    assert!(matches!(refused, Err(UploadError::Closed)));
    assert!(!base.0.join("owner").join("s1").exists());

    uploads.open_session("s1");
    let kept = stage(&uploads, "s1", "kept", b"k");
    let mut body: &[u8] = b"p";
    let pending = uploads.receive("s1", "p", 1, b"", &mut body).unwrap();
    let Err(error) = uploads.receive("s1", "f", 1, b"", &mut Untouched) else {
        panic!("the copy limit was not enforced");
    };
    assert_eq!(
        error.to_string(),
        "Staged copy limit reached; remove dropped files first"
    );

    // The session closes while a copy is in flight: it is never listed.
    let path = pending.path().to_path_buf();
    uploads.remove_session("s1");
    assert!(matches!(pending.commit(), Err(UploadError::Closed)));
    assert!(!path.exists() && !kept.path.exists());
    assert!(!base.0.join("owner").join("s1").exists());
    assert!(uploads.copies().is_empty());
    let late = uploads.receive("s1", "late", 1, b"", &mut Untouched);
    assert!(matches!(late, Err(UploadError::Closed)));

    // Removing a copy makes room again.
    uploads.open_session("s2");
    let first = stage(&uploads, "s2", "a", b"");
    stage(&uploads, "s2", "b", b"");
    let full = uploads.receive("s2", "c", 1, b"", &mut Untouched);
    assert!(matches!(full, Err(UploadError::Full)));
    uploads.remove_copy(&first.id).unwrap();
    stage(&uploads, "s2", "c", b"");
}

#[test]
fn a_new_server_sweeps_only_marked_unlocked_staging() {
    let base = Base::new("sweep");
    let live = Uploads::new(base.0.clone(), "100-4183".into());
    live.open_session("s1");
    stage(&live, "s1", "kept", b"");
    fs::create_dir_all(base.0.join("200-4184").join("s1")).unwrap();
    fs::write(base.0.join("200-4184.lock"), MARKER).unwrap();
    fs::write(base.0.join("200-4184").join(MARKER_FILE), MARKER).unwrap();
    fs::create_dir_all(base.0.join("300-4185")).unwrap();
    fs::write(base.0.join("300-4185").join(MARKER_FILE), MARKER).unwrap();
    fs::write(base.0.join("300-4185.lock"), b"another owner").unwrap();
    fs::create_dir_all(base.0.join("400-4186")).unwrap();
    fs::write(base.0.join("400-4186.lock"), MARKER).unwrap();
    fs::create_dir_all(base.0.join("orphan")).unwrap();
    fs::write(base.0.join("orphan").join(MARKER_FILE), MARKER).unwrap();
    fs::write(base.0.join("orphan.lock"), MARKER).unwrap();
    fs::create_dir_all(base.0.join("500-4187")).unwrap();

    let next = Uploads::new(base.0.clone(), "600-4188".into());
    assert!(
        base.0.join("100-4183").exists(),
        "live lock must protect its staging"
    );
    assert!(!base.0.join("200-4184").exists());
    assert!(!base.0.join("200-4184.lock").exists());
    for name in ["300-4185", "400-4186", "orphan", "500-4187"] {
        assert!(
            base.0.join(name).exists(),
            "unowned directory {name} must survive"
        );
    }
    assert!(base.0.join("300-4185.lock").exists());
    assert!(base.0.join("400-4186.lock").exists());
    assert!(base.0.join("orphan.lock").exists());
    next.open_session("s1");
    stage(&next, "s1", "new", b"");
    assert!(base.0.join("100-4183").exists());
    assert!(!base.0.join("200-4184").exists());
    drop(live);
    assert!(!base.0.join("100-4183").exists());
    drop(next);
    assert!(!base.0.join("600-4188").exists());
    assert!(base.0.join("orphan").exists());
}
