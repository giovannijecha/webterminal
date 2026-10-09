//! Per-child Unicode environment; no process-global environment mutations.
//!
//! Kernel32 owns the snapshot until FreeEnvironmentStringsW. CreateProcessW
//! receives an owned, sorted, double-NUL-terminated copy with terminal identity.
//! https://learn.microsoft.com/windows/win32/procthread/changing-environment-variables
use std::cmp::Ordering;
use std::io;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetEnvironmentStringsW() -> *mut u16;
    fn FreeEnvironmentStringsW(environment: *mut u16) -> i32;
    fn CompareStringOrdinal(
        first: *const u16,
        first_len: i32,
        second: *const u16,
        second_len: i32,
        ignore_case: i32,
    ) -> i32;
}

struct Snapshot(*mut u16);
impl Drop for Snapshot {
    fn drop(&mut self) {
        // This pointer is the successful GetEnvironmentStringsW allocation.
        unsafe { FreeEnvironmentStringsW(self.0) };
    }
}

pub(super) fn for_terminal() -> io::Result<Vec<u16>> {
    let pointer = unsafe { GetEnvironmentStringsW() };
    if pointer.is_null() {
        return Err(io::Error::last_os_error());
    }
    let snapshot = Snapshot(pointer);
    let mut entries = Vec::new();
    let mut cursor = snapshot.0;
    // The documented allocation is a sequence of NUL-terminated UTF-16
    // entries ending with another NUL. Copy without decoding, including the
    // hidden =C: drive-directory entries and any unpaired UTF-16 code units.
    unsafe {
        while *cursor != 0 {
            let start = cursor;
            let mut length = 0;
            while *cursor != 0 {
                cursor = cursor.add(1);
                length += 1;
            }
            entries.push(std::slice::from_raw_parts(start, length).to_vec());
            cursor = cursor.add(1);
        }
    }
    build(entries)
}

fn build(entries: Vec<Vec<u16>>) -> io::Result<Vec<u16>> {
    // Redirected/noninteractive launchers describe their own output sink.
    // Those color controls must not describe an independent interactive PTY.
    // Programs can still set NO_COLOR or other preferences inside the shell.
    let replacements = [
        ("TERM", Some("xterm-256color")),
        ("COLORTERM", Some("truecolor")),
        ("TERM_PROGRAM", Some("Webterminal")),
        ("TERM_PROGRAM_VERSION", Some(env!("CARGO_PKG_VERSION"))),
        ("NO_COLOR", None),
        ("CLICOLOR", None),
        ("CLICOLOR_FORCE", None),
        ("FORCE_COLOR", None),
    ];
    let names: Vec<Vec<u16>> = replacements
        .iter()
        .map(|(name, _)| name.encode_utf16().collect())
        .collect();
    let mut result = Vec::new();
    for entry in entries {
        let key = name(&entry)?;
        let mut replace = false;
        for reserved in &names {
            if compare(key, reserved)? == Ordering::Equal {
                replace = true;
                break;
            }
        }
        if !replace {
            result.push(entry);
        }
    }
    for (key, value) in replacements {
        if let Some(value) = value {
            result.push(format!("{key}={value}").encode_utf16().collect());
        }
    }
    let mut error = None;
    result.sort_by(|first, second| {
        // Entries were validated above; replacements are valid constants.
        match compare(name(first).unwrap(), name(second).unwrap()) {
            Ok(ordering) => ordering,
            Err(cause) => {
                error = Some(cause);
                Ordering::Equal
            }
        }
    });
    if let Some(error) = error {
        return Err(error);
    }
    let mut block = Vec::new();
    for entry in result {
        block.extend(entry);
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn name(entry: &[u16]) -> io::Result<&[u16]> {
    let end = entry
        .iter()
        .enumerate()
        .skip(1) // Hidden drive variables start with '=', e.g. =C:=C:\Work.
        .find_map(|(index, &value)| (value == u16::from(b'=')).then_some(index))
        .filter(|_| !entry.contains(&0))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid environment entry"))?;
    Ok(&entry[..end])
}

fn compare(first: &[u16], second: &[u16]) -> io::Result<Ordering> {
    let length = |value: &[u16]| {
        i32::try_from(value.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "environment name too long"))
    };
    // Valid slices remain alive for this call. Windows' own ordinal comparison
    // supplies locale-independent Unicode case-insensitive environment order.
    let result = unsafe {
        CompareStringOrdinal(
            first.as_ptr(),
            length(first)?,
            second.as_ptr(),
            length(second)?,
            1,
        )
    };
    match result {
        1 => Ok(Ordering::Less),
        2 => Ok(Ordering::Equal),
        3 => Ok(Ordering::Greater),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(block: &[u16]) -> Vec<String> {
        assert!(block.ends_with(&[0, 0]));
        block
            .split(|&value| value == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| String::from_utf16(entry).unwrap())
            .collect()
    }

    #[test]
    fn capabilities_replace_case_insensitive_launcher_preferences() {
        let input = [
            "term=dumb",
            "No_Color=1",
            "CLICOLOR=0",
            "force_color=0",
            "TERM_PROGRAM=host",
        ];
        let block = build(
            input
                .iter()
                .map(|entry| entry.encode_utf16().collect())
                .collect(),
        )
        .unwrap();
        assert_eq!(
            entries(&block),
            [
                "COLORTERM=truecolor",
                "TERM=xterm-256color",
                "TERM_PROGRAM=Webterminal",
                concat!("TERM_PROGRAM_VERSION=", env!("CARGO_PKG_VERSION")),
            ]
        );
    }

    #[test]
    fn unrelated_unicode_values_and_hidden_drive_directories_are_preserved() {
        let input = [
            "z=value=with=equals",
            "äname=café 界",
            "=C:=C:\\Owned",
            "Fixture=owned",
            "EMPTY=",
        ];
        let block = build(
            input
                .iter()
                .map(|entry| entry.encode_utf16().collect())
                .collect(),
        )
        .unwrap();
        let actual = entries(&block);
        for entry in input {
            assert!(actual.iter().any(|value| value == entry));
        }
        assert_eq!(actual.first().unwrap(), "=C:=C:\\Owned");
        assert_eq!(actual.last().unwrap(), "äname=café 界");
        assert!(actual.windows(2).all(|pair| {
            compare(
                name(&pair[0].encode_utf16().collect::<Vec<_>>()).unwrap(),
                name(&pair[1].encode_utf16().collect::<Vec<_>>()).unwrap(),
            )
            .unwrap()
                != Ordering::Greater
        }));
    }

    #[test]
    fn malformed_entries_fail_without_exposing_their_values() {
        for invalid in ["MISSING_SEPARATOR", "ZERO=\0value", "=value"] {
            let error = build(vec![invalid.encode_utf16().collect()]).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert_eq!(error.to_string(), "invalid environment entry");
        }
    }
}
