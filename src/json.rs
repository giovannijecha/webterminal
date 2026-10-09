//! Small bounded JSON protocol codec. It deliberately accepts integer numbers only.
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(i64),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Self::Object(o) => o.get(key),
            _ => None,
        }
    }
    pub fn string(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
    pub fn number(&self) -> Option<i64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }
    pub fn field(&self, key: &str) -> Result<&str, String> {
        self.get(key)
            .and_then(Self::string)
            .ok_or_else(|| format!("Missing string field: {key}"))
    }
    pub fn integer(&self, key: &str) -> Result<i64, String> {
        self.get(key)
            .and_then(Self::number)
            .ok_or_else(|| format!("Missing integer field: {key}"))
    }
}

pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn parse(s: &str) -> Result<Value, String> {
    if s.len() > 131_072 {
        return Err("JSON message too large".into());
    }
    let mut parser = Parser {
        source: s.as_bytes(),
        offset: 0,
    };
    let value = parser.value(0)?;
    parser.space();
    if parser.offset != parser.source.len() {
        return Err("Trailing JSON data".into());
    }
    Ok(value)
}

struct Parser<'a> {
    source: &'a [u8],
    offset: usize,
}
impl Parser<'_> {
    fn space(&mut self) {
        while self
            .source
            .get(self.offset)
            .is_some_and(|b| b.is_ascii_whitespace())
        {
            self.offset += 1;
        }
    }
    fn consume(&mut self, b: u8) -> bool {
        self.space();
        if self.source.get(self.offset) == Some(&b) {
            self.offset += 1;
            true
        } else {
            false
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > 16 {
            return Err("JSON nesting too deep".into());
        }
        self.space();
        match self.source.get(self.offset).copied() {
            Some(b'"') => self.text().map(Value::String),
            Some(b'{') => {
                self.offset += 1;
                let mut object = BTreeMap::new();
                if self.consume(b'}') {
                    return Ok(Value::Object(object));
                }
                loop {
                    self.space();
                    let key = self.text()?;
                    if !self.consume(b':') {
                        return Err("Expected JSON colon".into());
                    }
                    if object.insert(key, self.value(depth + 1)?).is_some() {
                        return Err("Duplicate JSON field".into());
                    }
                    if self.consume(b'}') {
                        break;
                    }
                    if !self.consume(b',') {
                        return Err("Expected JSON comma".into());
                    }
                }
                Ok(Value::Object(object))
            }
            Some(b'[') => {
                self.offset += 1;
                let mut values = Vec::new();
                if self.consume(b']') {
                    return Ok(Value::Array(values));
                }
                loop {
                    if values.len() >= 1024 {
                        return Err("JSON array too long".into());
                    }
                    values.push(self.value(depth + 1)?);
                    if self.consume(b']') {
                        break;
                    }
                    if !self.consume(b',') {
                        return Err("Expected JSON comma".into());
                    }
                }
                Ok(Value::Array(values))
            }
            Some(b'-' | b'0'..=b'9') => {
                let start = self.offset;
                if self.source[self.offset] == b'-' {
                    self.offset += 1;
                }
                let digits = self.offset;
                while self.source.get(self.offset).is_some_and(u8::is_ascii_digit) {
                    self.offset += 1;
                }
                if digits == self.offset
                    || (self.offset - digits > 1 && self.source[digits] == b'0')
                {
                    return Err("Invalid JSON integer".into());
                }
                let s = std::str::from_utf8(&self.source[start..self.offset])
                    .map_err(|_| "Invalid JSON integer")?;
                s.parse()
                    .map(Value::Number)
                    .map_err(|_| "JSON integer overflow".into())
            }
            Some(b't') => {
                self.literal(b"true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.literal(b"false")?;
                Ok(Value::Bool(false))
            }
            Some(b'n') => {
                self.literal(b"null")?;
                Ok(Value::Null)
            }
            _ => Err("Invalid JSON value".into()),
        }
    }
    fn literal(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.source.get(self.offset..self.offset + bytes.len()) != Some(bytes) {
            return Err("Invalid JSON literal".into());
        }
        self.offset += bytes.len();
        Ok(())
    }
    fn text(&mut self) -> Result<String, String> {
        if self.source.get(self.offset) != Some(&b'"') {
            return Err("Expected JSON string".into());
        }
        self.offset += 1;
        let mut out = Vec::new();
        loop {
            let b = *self
                .source
                .get(self.offset)
                .ok_or("Unterminated JSON string")?;
            self.offset += 1;
            match b {
                b'"' => return String::from_utf8(out).map_err(|_| "Invalid JSON UTF-8".into()),
                0..=31 => return Err("Control character in JSON string".into()),
                b'\\' => {
                    let escape = *self
                        .source
                        .get(self.offset)
                        .ok_or("Unterminated JSON escape")?;
                    self.offset += 1;
                    match escape {
                        b'"' | b'\\' | b'/' => out.push(escape),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(10),
                        b'r' => out.push(13),
                        b't' => out.push(9),
                        b'u' => {
                            let mut code = self.hex()?;
                            if (0xd800..=0xdbff).contains(&code) {
                                self.literal(b"\\u")?;
                                let low = self.hex()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err("Invalid JSON surrogate pair".into());
                                }
                                code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                            }
                            let c = char::from_u32(code).ok_or("Invalid JSON Unicode escape")?;
                            out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
                        }
                        _ => return Err("Invalid JSON escape".into()),
                    }
                }
                b => out.push(b),
            }
        }
    }
    fn hex(&mut self) -> Result<u32, String> {
        let mut n = 0;
        for _ in 0..4 {
            let b = *self
                .source
                .get(self.offset)
                .ok_or("Short JSON Unicode escape")?;
            self.offset += 1;
            let d = (b as char)
                .to_digit(16)
                .ok_or("Invalid JSON Unicode escape")?;
            n = n * 16 + d;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_protocol_fields() {
        let v = parse(r#"{"op":"input","data":"a\uD83D\uDE00\n","seq":12}"#).unwrap();
        assert_eq!(v.field("data").unwrap(), "a😀\n");
        assert_eq!(v.integer("seq").unwrap(), 12);
        assert_eq!(
            parse(&quote("\0\"\\😀")).unwrap().string(),
            Some("\0\"\\😀")
        );
    }
    #[test]
    fn rejects_ambiguous_and_unbounded_messages() {
        for input in [
            r#"{"op":"list","op":"close"}"#,
            "01",
            "1.5",
            r#""\uD800""#,
            "true null",
            "[1,]",
            "\"\n\"",
        ] {
            assert!(parse(input).is_err(), "{input}");
        }
        assert!(parse(&format!("{}0{}", "[".repeat(18), "]".repeat(18))).is_err());
    }
}
