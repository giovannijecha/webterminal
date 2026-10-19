#![cfg(windows)]
//! Staged copies follow session lifetime through the registry's close paths.
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use webterminal::session::{Registry, WorkspaceClose};
use webterminal::uploads::{StagedCopy, UploadError, Uploads};

/// A private working directory and staging base, removed after the test.
struct Folders {
    cwd: PathBuf,
    base: PathBuf,
    owner: String,
}
impl Folders {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let prefix = std::env::temp_dir().join(format!(
            "webterminal-upload-registry-{}-{stamp}",
            std::process::id()
        ));
        let cwd = prefix.with_extension("cwd");
        fs::create_dir(&cwd).unwrap();
        Self {
            cwd,
            base: prefix.with_extension("staging"),
            owner: format!("{}-1", std::process::id()),
        }
    }
}
impl Drop for Folders {
    fn drop(&mut self) {
        // Windows can hold a terminated fixture's working directory briefly.
        let until = Instant::now() + Duration::from_secs(8);
        for path in [&self.cwd, &self.base] {
            while path.exists() && fs::remove_dir_all(path).is_err() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn stage(registry: &Registry, session: &str, name: &str) -> StagedCopy {
    let mut body: &[u8] = b"data";
    registry
        .uploads
        .receive(session, name, 4, b"", &mut body)
        .unwrap()
        .commit()
        .unwrap()
}

#[test]
fn closing_a_workspace_removes_the_staging_of_every_closed_session() {
    let folders = Folders::new();
    let shell = format!("\"{}\" --hold", env!("CARGO_BIN_EXE_native_fixture"));
    let uploads = Uploads::new(folders.base.clone(), folders.owner.clone());
    let registry = Registry::new(folders.cwd.clone(), shell, uploads);
    let (first, workspace) = registry.create(&folders.cwd, 80, 24, "v1", None).unwrap();
    let (second, same) = registry
        .create(&folders.cwd, 80, 24, "v1", Some(&workspace))
        .unwrap();
    assert_eq!(same, workspace);
    let elsewhere = registry.create_workspace().unwrap();
    let (third, _) = registry
        .create(&folders.cwd, 80, 24, "v1", Some(&elsewhere))
        .unwrap();

    // Equal names in one session and across sessions are distinct copies.
    let closed = [
        stage(&registry, &first.id, "same.txt"),
        stage(&registry, &first.id, "same.txt"),
        stage(&registry, &second.id, "same.txt"),
    ];
    let kept = stage(&registry, &third.id, "same.txt");
    // A transfer still in flight when the workspace closes is never listed.
    let mut body: &[u8] = b"late";
    let late = registry
        .uploads
        .receive(&second.id, "late.txt", 4, b"", &mut body)
        .unwrap();
    let late_path = late.path().to_path_buf();

    let confirmed = [first.id.clone(), second.id.clone()];
    assert!(matches!(
        registry.close_workspace(&workspace, &confirmed, true),
        Ok(WorkspaceClose::Closed)
    ));
    assert!(matches!(late.commit(), Err(UploadError::Closed)));
    let root = folders.base.join(&folders.owner);
    for path in closed.iter().map(|copy| &copy.path).chain([&late_path]) {
        assert!(!path.exists(), "{} survived its session", path.display());
    }
    for session in [&first.id, &second.id] {
        assert!(!root.join(session).exists(), "{session} staging survived");
    }
    assert_eq!(registry.uploads.copies(), std::slice::from_ref(&kept));
    assert!(kept.path.exists());
    let mut empty: &[u8] = b"";
    let refused = registry
        .uploads
        .receive(&first.id, "after.txt", 0, b"", &mut empty);
    assert!(matches!(refused, Err(UploadError::Closed)));

    registry.shutdown();
    assert!(registry.uploads.copies().is_empty());
    assert!(!root.exists());
}
