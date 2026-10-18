//! Bounded reads and atomic writes of the settings file.
use super::{Settings, State, fields};
use crate::json::{self, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Larger files are treated as malformed.
const FILE_LIMIT: u64 = 64 * 1024;

/// The sidecar persists so waiters always lock the same filesystem object.
/// Removing it on drop would let a third server lock a new object while an
/// earlier server still holds the old one.
pub(super) fn lock(path: &Path) -> Result<File, String> {
    let folder = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(folder).map_err(|e| {
        format!(
            "Cannot create the settings folder {}: {e}",
            folder.display()
        )
    })?;
    let name = path
        .file_name()
        .ok_or("The settings path has no file name")?;
    let lock_path = folder.join(format!("{}.lock", name.to_string_lossy()));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("Cannot open settings lock {}: {e}", lock_path.display()))?;
    file.lock()
        .map_err(|e| format!("Cannot lock settings file {}: {e}", path.display()))?;
    Ok(file)
}

pub(super) fn load(path: &Path) -> State {
    let problem = match fs::metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => return State::default(),
        Err(e) => format!("Cannot read the settings file: {e}"),
        Ok(meta) if meta.is_dir() => {
            return State {
                problem: Some(
                    "The settings path is a folder, not a file. Defaults are in use; \
                     saving fails until that folder is moved."
                        .into(),
                ),
                ..State::default()
            };
        }
        Ok(meta) if meta.len() > FILE_LIMIT => too_large(),
        Ok(_) => match read(path).and_then(|text| decode(&text)) {
            Ok((revision, settings)) => {
                return State {
                    revision,
                    settings,
                    ..State::default()
                };
            }
            Err(problem) => problem,
        },
    };
    State {
        problem: Some(format!(
            "{problem}. Defaults are in use; saving keeps the old file as {} and writes a new one.",
            invalid_path(path).display()
        )),
        preserve: true,
        ..State::default()
    }
}

/// Writes `settings` as `revision` atomically. With `preserve`, the unusable
/// file at `path` is first backed up as `<stem>.invalid.json`; the returned
/// notice says so.
pub(super) fn write(
    path: &Path,
    revision: u64,
    settings: &Settings,
    preserve: bool,
) -> Result<Option<String>, String> {
    let name = path
        .file_name()
        .ok_or("The settings path has no file name")?;
    let folder = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(folder).map_err(|e| {
        format!(
            "Cannot create the settings folder {}: {e}",
            folder.display()
        )
    })?;
    let temp = folder.join(format!(
        "{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    let content = format!(
        "{{\"version\":1,\"revision\":{revision},\"settings\":{}}}\n",
        settings.json()
    );
    let result = replace(path, &temp, content.as_bytes(), preserve);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn replace(
    path: &Path,
    temp: &Path,
    content: &[u8],
    preserve: bool,
) -> Result<Option<String>, String> {
    File::create(temp)
        .and_then(|mut file| {
            file.write_all(content)?;
            file.sync_all()
        })
        .map_err(|e| format!("Cannot write {}: {e}", temp.display()))?;
    let mut notice = None;
    if preserve {
        let invalid = invalid_path(path);
        // Keep the canonical path present until the final atomic replacement.
        // The lock makes this backup exclusive with other Webterminal saves.
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let backup = temp.with_extension(format!("{nonce}.invalid.tmp"));
        // A hard link preserves even an oversized or unreadable file without
        // copying it. On filesystems without hard links, copy only small files.
        let backup_result = fs::hard_link(path, &backup)
            .or_else(|link_error| {
                if fs::metadata(path).is_ok_and(|meta| meta.len() <= FILE_LIMIT) {
                    fs::copy(path, &backup).map(|_| ())
                } else {
                    Err(link_error)
                }
            })
            .and_then(|_| fs::rename(&backup, &invalid));
        if let Err(error) = backup_result {
            let _ = fs::remove_file(&backup);
            if error.kind() != ErrorKind::NotFound {
                return Err(format!(
                    "Cannot keep the unusable settings file as {}: {error}",
                    invalid.display()
                ));
            }
        } else {
            notice = Some(format!(
                "The unusable settings file was kept as {}.",
                invalid.display()
            ));
        }
    }
    fs::rename(temp, path).map_err(|e| format!("Cannot replace {}: {e}", path.display()))?;
    Ok(notice)
}

fn read(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(FILE_LIMIT + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("Cannot read the settings file: {e}"))?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| "The settings file is not UTF-8 text".into())
}

fn decode(text: &str) -> Result<(u64, Settings), String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value =
        json::parse(text).map_err(|e| format!("The settings file is not valid JSON ({e})"))?;
    let Value::Object(entries) = &value else {
        return Err("The settings file must hold a JSON object".into());
    };
    if let Some(key) = entries
        .keys()
        .find(|key| !matches!(key.as_str(), "version" | "revision" | "settings"))
    {
        let key: String = key.chars().take(64).collect();
        return Err(format!("The settings file has an unknown field {key}"));
    }
    if entries.get("version") != Some(&Value::Number(1)) {
        return Err("The settings file must declare \"version\":1".into());
    }
    let revision = entries
        .get("revision")
        .and_then(Value::number)
        .and_then(|revision| u64::try_from(revision).ok())
        .ok_or("The settings file needs a non-negative integer revision")?;
    let settings = fields::merge(
        &Settings::default(),
        entries.get("settings").unwrap_or(&Value::Null),
        false,
    )
    .map_err(|e| format!("The settings file is invalid: {e}"))?;
    Ok((revision, settings))
}

fn too_large() -> String {
    format!("The settings file is larger than {} KiB", FILE_LIMIT / 1024)
}

fn invalid_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .map_or_else(|| "settings".into(), |stem| stem.to_string_lossy());
    path.with_file_name(format!("{stem}.invalid.json"))
}
