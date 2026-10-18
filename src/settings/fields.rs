//! Validation and JSON rendering of the `settings` object.
use super::{Settings, TerminalTheme};
use crate::json::{self, Value};
use std::collections::BTreeMap;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

/// Accepted terminal font sizes.
pub const FONT_SIZES: RangeInclusive<u8> = 10..=20;
/// Longest accepted start folder, in characters.
pub const PATH_LIMIT: usize = 1024;

/// Validates `value` as a `settings` object and applies it over `base`;
/// absent fields keep their base value. With `verify`, a start folder that
/// differs from the base must name an existing directory and is stored
/// canonicalized; otherwise it only has to be a well-formed absolute path.
pub(super) fn merge(base: &Settings, value: &Value, verify: bool) -> Result<Settings, String> {
    let mut next = base.clone();
    for (key, field) in object(value, "settings")? {
        match key.as_str() {
            "startFolder" => next.start_folder = start_folder(field, base, verify)?,
            "fontSize" => {
                next.font_size = field
                    .number()
                    .and_then(|size| u8::try_from(size).ok())
                    .filter(|size| FONT_SIZES.contains(size))
                    .ok_or_else(|| {
                        format!(
                            "settings.fontSize must be an integer from {} to {}",
                            FONT_SIZES.start(),
                            FONT_SIZES.end()
                        )
                    })?;
            }
            "terminalTheme" => {
                next.terminal_theme = match field.string() {
                    Some("dark") => TerminalTheme::Dark,
                    Some("light") => TerminalTheme::Light,
                    _ => return Err("settings.terminalTheme must be \"dark\" or \"light\"".into()),
                };
            }
            "notifications" => {
                for (key, field) in object(field, "settings.notifications")? {
                    let slot = match key.as_str() {
                        "input" => &mut next.notify_input,
                        "reply" => &mut next.notify_reply,
                        "failure" => &mut next.notify_failure,
                        _ => return Err(unknown("settings.notifications", key)),
                    };
                    let Value::Bool(enabled) = field else {
                        return Err(format!(
                            "settings.notifications.{key} must be true or false"
                        ));
                    };
                    *slot = *enabled;
                }
            }
            _ => return Err(unknown("settings", key)),
        }
    }
    Ok(next)
}

pub(super) fn render(settings: &Settings) -> String {
    let folder = settings.start_folder.as_ref().map_or_else(
        || "null".into(),
        |path| json::quote(&path.to_string_lossy()),
    );
    format!(
        "{{\"startFolder\":{folder},\"fontSize\":{},\"terminalTheme\":\"{}\",\"notifications\":{{\"input\":{},\"reply\":{},\"failure\":{}}}}}",
        settings.font_size,
        settings.terminal_theme.name(),
        settings.notify_input,
        settings.notify_reply,
        settings.notify_failure
    )
}

fn object<'a>(value: &'a Value, name: &str) -> Result<&'a BTreeMap<String, Value>, String> {
    match value {
        Value::Object(fields) => Ok(fields),
        _ => Err(format!("{name} must be an object")),
    }
}

fn unknown(parent: &str, key: &str) -> String {
    let key: String = key.chars().take(64).collect();
    format!("Unknown field {parent}.{key}")
}

fn start_folder(value: &Value, base: &Settings, verify: bool) -> Result<Option<PathBuf>, String> {
    const NAME: &str = "settings.startFolder";
    let text = match value {
        Value::Null => return Ok(None),
        Value::String(text) if text.is_empty() => return Ok(None),
        Value::String(text) => text,
        _ => return Err(format!("{NAME} must be a folder path or null")),
    };
    if text.chars().count() > PATH_LIMIT {
        return Err(format!("{NAME} must be at most {PATH_LIMIT} characters"));
    }
    if text.contains('\0') {
        return Err(format!("{NAME} must not contain NUL characters"));
    }
    let path = Path::new(text);
    if !path.is_absolute() {
        return Err(format!("{NAME} must be an absolute path"));
    }
    if !verify || base.start_folder.as_deref() == Some(path) {
        return Ok(Some(path.to_path_buf()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{NAME} must be an existing folder: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{NAME} must be a folder, not a file"));
    }
    let shown = ordinary(&canonical).ok_or_else(|| format!("{NAME} must be a Unicode path"))?;
    if shown.chars().count() > PATH_LIMIT {
        return Err(format!("{NAME} must be at most {PATH_LIMIT} characters"));
    }
    Ok(Some(PathBuf::from(shown)))
}

/// `canonicalize` returns verbatim `\\?\` paths on Windows. Keep the ordinary
/// DOS or UNC spelling that users and child shells understand, as
/// `native::windows::process_directory` does when spawning.
fn ordinary(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{share}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\")
        && let [drive, b':', b'\\', ..] = rest.as_bytes()
        && drive.is_ascii_alphabetic()
    {
        return Some(rest.to_owned());
    }
    Some(text.to_owned())
}
