//! Staging on disk: the per-server root and its lock, streamed copies,
//! guarded removal, crash sweeping and safe file names.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

pub(super) const NAME_LIMIT: usize = 180;
pub(super) const MARKER: &[u8] = b"webterminal-upload-staging-v1\n";
pub(super) const MARKER_FILE: &str = ".webterminal-upload";

/// This server's marked staging folder and the lock that proves it is live.
pub(super) struct Root {
    pub(super) path: PathBuf,
    lock: PathBuf,
    _held: File,
    _base: File,
}

impl Root {
    /// Creates `base/owner` with its marker while holding `base/owner.lock`.
    pub(super) fn create(base: &Path, owner: &str) -> io::Result<Self> {
        fs::create_dir_all(base)?;
        if !plain_dir(base) {
            return Err(io::Error::other("Upload staging base is a reparse point"));
        }
        let base_guard = guard_dir(base)?;
        sweep(base);
        let lock = base.join(format!("{owner}.lock"));
        let mut held = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lock)?;
        let path = base.join(owner);
        let mut created = false;
        let result = (|| {
            held.try_lock().map_err(|error| match error {
                TryLockError::Error(error) => error,
                TryLockError::WouldBlock => io::Error::other("Upload staging is owned elsewhere"),
            })?;
            held.write_all(MARKER)?;
            held.sync_all()?;
            fs::create_dir(&path)?;
            created = true;
            let mut marker = File::create_new(path.join(MARKER_FILE))?;
            marker.write_all(MARKER)?;
            marker.sync_all()
        })();
        if let Err(error) = result {
            if created {
                let _ = fs::remove_dir_all(&path);
            }
            drop(held);
            let _ = fs::remove_file(&lock);
            return Err(error);
        }
        Ok(Self {
            path,
            lock,
            _held: held,
            _base: base_guard,
        })
    }

    /// Deletes the marked folder, then releases and removes the lock.
    pub(super) fn remove(self) {
        if owned(&self.path) {
            let _ = fs::remove_dir_all(&self.path);
        }
        let lock = self.lock.clone();
        drop(self);
        let _ = fs::remove_file(lock);
    }
}

/// Whether `path` lies strictly below `root` through plain names only.
pub(super) fn inside(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|rest| {
        rest.components().next().is_some()
            && rest
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
    })
}

/// Open a directory itself, including a reparse point if present, and keep it
/// from being renamed while a descendant is accessed by name.
fn guard_dir(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    let file = OpenOptions::new()
        .read(true)
        .share_mode(0x0000_0001 | 0x0000_0002) // READ | WRITE, without DELETE
        .custom_flags(0x0200_0000 | 0x0020_0000) // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
        .open(path)?;
    #[cfg(not(windows))]
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other("Staging path is not a plain folder"));
    }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 {
        return Err(io::Error::other("Staging path is a reparse point"));
    }
    Ok(file)
}

/// Creates one copy folder, holding its root, session and copy directories
/// against replacement until the file has been received or discarded.
pub(super) fn create_folder(root: &Path, folder: &Path) -> io::Result<Vec<File>> {
    let rest = folder
        .strip_prefix(root)
        .map_err(|_| io::Error::other("Invalid upload folder"))?;
    let parts = rest.components().collect::<Vec<_>>();
    if parts.len() != 2
        || !parts
            .iter()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(io::Error::other("Invalid upload folder"));
    }
    let root_guard = guard_dir(root)?;
    let session = root.join(parts[0].as_os_str());
    match fs::create_dir(&session) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let session_guard = guard_dir(&session)?;
    fs::create_dir(folder)?;
    let copy_guard = guard_dir(folder)?;
    Ok(vec![root_guard, session_guard, copy_guard])
}

/// Deletes `path`, a plain folder below the marked staging `root`. A folder
/// that is already gone counts as removed; nothing outside `root` is touched.
pub(super) fn remove_inside(root: &Path, path: &Path) -> io::Result<()> {
    if !inside(root, path) {
        return Err(io::Error::other(
            "Path is outside the upload staging folder",
        ));
    }
    let mut guards = vec![guard_dir(root)?];
    if !owned(root) {
        return Err(io::Error::other("Upload staging marker is missing"));
    }
    let rest = path.strip_prefix(root).expect("inside checked above");
    let components = rest.components().collect::<Vec<_>>();
    let mut ancestor = root.to_path_buf();
    for part in &components[..components.len() - 1] {
        ancestor.push(part.as_os_str());
        guards.push(guard_dir(&ancestor)?);
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) if !plain_dir(path) => Err(io::Error::other("Staged copy is not a plain folder")),
        Ok(_) => fs::remove_dir_all(path),
    }
}

/// Writes exactly `length` bytes, starting with `prefix`, into a new file.
pub(super) fn copy(
    path: &Path,
    length: u64,
    prefix: &[u8],
    body: &mut impl Read,
) -> io::Result<()> {
    let mut file = File::create_new(path)?;
    file.write_all(prefix)?;
    let mut remaining = length - prefix.len() as u64;
    let mut buffer = vec![0; 65_536];
    while remaining > 0 {
        let want = buffer.len().min(remaining as usize);
        let read = body.read(&mut buffer[..want])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Upload ended before its Content-Length",
            ));
        }
        file.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    // Staged payloads need immediate readability, not crash durability. Keep
    // the ownership marker durable, without syncing up to 1 GiB per payload.
    Ok(())
}

fn owned(root: &Path) -> bool {
    plain_dir(root) && marker_matches(&root.join(MARKER_FILE))
}

fn plain_entry(path: &Path) -> Option<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    // Windows junctions and other reparse points are not always symlinks.
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 {
        return None;
    }
    Some(metadata)
}

fn plain_dir(path: &Path) -> bool {
    plain_entry(path).is_some_and(|metadata| metadata.is_dir())
}

fn marker_matches(path: &Path) -> bool {
    if !plain_entry(path).is_some_and(|metadata| metadata.is_file()) {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut marker = [0; MARKER.len()];
    let mut extra = [0];
    file.read_exact(&mut marker).is_ok()
        && marker == MARKER
        && matches!(file.read(&mut extra), Ok(0))
}

fn owner_name(name: &str) -> bool {
    let Some((pid, port)) = name.split_once('-') else {
        return false;
    };
    pid.parse::<u32>().is_ok_and(|pid| pid > 0) && port.parse::<u16>().is_ok_and(|port| port > 0)
}

/// Removes only marked staging folders whose server no longer holds its lock.
pub(super) fn sweep(base: &Path) {
    let Ok(_base_guard) = guard_dir(base) else {
        return;
    };
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let lock_path = entry.path();
        if lock_path
            .extension()
            .is_none_or(|extension| extension != "lock")
            || !plain_entry(&lock_path).is_some_and(|metadata| metadata.is_file())
        {
            continue;
        }
        let owner = lock_path.with_extension("");
        if !owner
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(owner_name)
        {
            continue;
        }
        let Ok(mut lock) = OpenOptions::new().read(true).write(true).open(&lock_path) else {
            continue;
        };
        if lock.try_lock().is_err() {
            continue;
        }
        let mut marker = [0; MARKER.len()];
        let mut extra = [0];
        if lock.read_exact(&mut marker).is_err()
            || marker != MARKER
            || !matches!(lock.read(&mut extra), Ok(0))
        {
            continue;
        }
        if owner.exists() {
            if !owned(&owner) {
                continue;
            }
            if fs::remove_dir_all(&owner).is_err() {
                continue;
            }
        }
        drop(lock);
        let _ = fs::remove_file(&lock_path);
    }
}

/// Keeps the browser's file name readable while making it a single valid
/// Windows path component.
pub fn file_name(name: &str) -> String {
    let mut clean = String::new();
    for c in name.chars() {
        if clean.len() + c.len_utf8() > NAME_LIMIT {
            break;
        }
        let invalid = c.is_control() || r#"<>:"/\|?*"#.contains(c);
        clean.push(if invalid { '_' } else { c });
    }
    let clean = clean.trim().trim_end_matches('.');
    if clean.is_empty() {
        return "file".into();
    }
    let stem = clean
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let numbered = stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit();
    if numbered || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) {
        format!("_{clean}")
    } else {
        clean.into()
    }
}
