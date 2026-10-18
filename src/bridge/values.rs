//! Small value helpers for the bridge: bounded text, timestamps, tokens and
//! tool-call fingerprints.
use super::TEXT_LIMIT;
use crate::json::Value;
use std::hash::{BuildHasher, DefaultHasher, Hash, Hasher, RandomState};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &text[..end])
}

pub(super) fn text(value: Option<&Value>) -> Value {
    Value::String(bounded(
        value.and_then(Value::string).unwrap_or_default(),
        TEXT_LIMIT,
    ))
}

/// Identifies one tool call by its exact input within this server process.
pub(super) fn fingerprint(input: Option<&Value>) -> u64 {
    let mut hasher = DefaultHasher::new();
    input
        .map(Value::to_json)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 128 bits from SipHash keyed by the standard library's OS-seeded keys.
pub(super) fn token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    (0..2u8)
        .map(|part| {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u8(part);
            hasher.write_u128(nanos);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

pub(super) fn same(expected: &str, actual: &str) -> bool {
    expected.len() == actual.len()
        && expected
            .bytes()
            .zip(actual.bytes())
            .fold(0, |difference, (a, b)| difference | (a ^ b))
            == 0
}
