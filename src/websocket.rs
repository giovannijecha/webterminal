//! Original RFC 6455 framing and handshake primitives, with bounded receive state.
use std::io::{self, Write};
use std::net::TcpStream;

const MAX_MESSAGE: usize = 131_072;
pub enum Message {
    Text(String),
    Ping(Vec<u8>),
    Close,
}

#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
    fragment: Option<Vec<u8>>,
}
impl Decoder {
    pub fn push(&mut self, data: &[u8]) -> io::Result<()> {
        if self.buffer.len() + data.len() > MAX_MESSAGE + 16_384 {
            return Err(invalid("WebSocket receive buffer exceeded"));
        }
        self.buffer.extend_from_slice(data);
        Ok(())
    }
    pub fn next(&mut self) -> io::Result<Option<Message>> {
        loop {
            let before = self.buffer.len();
            let result = self.next_frame()?;
            if result.is_some() || self.buffer.len() == before {
                return Ok(result);
            }
        }
    }
    fn next_frame(&mut self) -> io::Result<Option<Message>> {
        if self.buffer.len() < 2 {
            return Ok(None);
        }
        let b = &self.buffer;
        if b[0] & 0x70 != 0 || b[1] & 0x80 == 0 {
            return Err(invalid("Invalid or unmasked WebSocket frame"));
        }
        let fin = b[0] & 0x80 != 0;
        let opcode = b[0] & 15;
        let mut offset = 2;
        let size = match b[1] & 127 {
            126 => {
                if b.len() < 4 {
                    return Ok(None);
                }
                offset = 4;
                let n = u16::from_be_bytes([b[2], b[3]]) as usize;
                if n < 126 {
                    return Err(invalid("Noncanonical WebSocket length"));
                }
                n
            }
            127 => {
                if b.len() < 10 {
                    return Ok(None);
                }
                offset = 10;
                let n = u64::from_be_bytes(b[2..10].try_into().unwrap());
                if n < 65536 || n > MAX_MESSAGE as u64 {
                    return Err(invalid("WebSocket frame too large"));
                }
                n as usize
            }
            n => n as usize,
        };
        if size > MAX_MESSAGE {
            return Err(invalid("WebSocket frame too large"));
        }
        if opcode >= 8 && (!fin || size > 125) {
            return Err(invalid("Invalid WebSocket control frame"));
        }
        if b.len() < offset + 4 + size {
            return Ok(None);
        }
        let mask: [u8; 4] = b[offset..offset + 4].try_into().unwrap();
        offset += 4;
        let data: Vec<u8> = b[offset..offset + size]
            .iter()
            .enumerate()
            .map(|(i, v)| v ^ mask[i % 4])
            .collect();
        self.buffer.drain(..offset + size);
        match opcode {
            1 => {
                if self.fragment.is_some() {
                    return Err(invalid("Nested WebSocket fragment"));
                }
                if fin {
                    Ok(Some(Message::Text(
                        String::from_utf8(data).map_err(|_| invalid("Invalid WebSocket UTF-8"))?,
                    )))
                } else {
                    self.fragment = Some(data);
                    Ok(None)
                }
            }
            0 => {
                let fragment = self
                    .fragment
                    .as_mut()
                    .ok_or_else(|| invalid("Unexpected WebSocket continuation"))?;
                if fragment.len() + data.len() > MAX_MESSAGE {
                    return Err(invalid("WebSocket message too large"));
                }
                fragment.extend_from_slice(&data);
                if fin {
                    let text = String::from_utf8(self.fragment.take().unwrap())
                        .map_err(|_| invalid("Invalid WebSocket UTF-8"))?;
                    Ok(Some(Message::Text(text)))
                } else {
                    Ok(None)
                }
            }
            8 => {
                if size == 1 {
                    return Err(invalid("Invalid WebSocket close"));
                }
                if size >= 2 {
                    let code = u16::from_be_bytes([data[0], data[1]]);
                    if !((1000..=1014).contains(&code) && ![1004, 1005, 1006].contains(&code)
                        || (3000..=4999).contains(&code))
                    {
                        return Err(invalid("Invalid WebSocket close code"));
                    }
                    std::str::from_utf8(&data[2..]).map_err(|_| invalid("Invalid close reason"))?;
                }
                Ok(Some(Message::Close))
            }
            9 => Ok(Some(Message::Ping(data))),
            10 => Ok(None),
            _ => Err(invalid("Unsupported WebSocket opcode")),
        }
    }
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn write_frame(stream: &mut TcpStream, opcode: u8, data: &[u8]) -> io::Result<()> {
    let mut header = vec![0x80 | opcode];
    if data.len() < 126 {
        header.push(data.len() as u8);
    } else if data.len() <= u16::MAX as usize {
        header.push(126);
        header.extend_from_slice(&(data.len() as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(data.len() as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(data)
}
pub fn send_text(stream: &mut TcpStream, text: &str) -> io::Result<()> {
    write_frame(stream, 1, text.as_bytes())
}

pub fn accept_key(key: &str) -> Option<String> {
    let bytes = unbase64(key)?;
    if bytes.len() != 16 || base64(&bytes) != key {
        return None;
    }
    let source = format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    Some(base64(&sha1(source.as_bytes())))
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for part in bytes.chunks(3) {
        let a = part[0] as u32;
        let b = part.get(1).copied().unwrap_or(0) as u32;
        let c = part.get(2).copied().unwrap_or(0) as u32;
        let bits = (a << 16) | (b << 8) | c;
        out.push(ALPHABET[(bits >> 18) as usize] as char);
        out.push(ALPHABET[((bits >> 12) & 63) as usize] as char);
        out.push(if part.len() > 1 {
            ALPHABET[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if part.len() > 2 {
            ALPHABET[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
fn unbase64(source: &str) -> Option<Vec<u8>> {
    if !source.len().is_multiple_of(4) || source.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (index, chunk) in source.as_bytes().chunks(4).enumerate() {
        let mut n = 0u32;
        let mut padding = 0;
        for &b in chunk {
            let v = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    padding += 1;
                    0
                }
                _ => return None,
            };
            if padding > 0 && b != b'=' {
                return None;
            }
            n = (n << 6) | v as u32;
        }
        if padding > 2 || padding > 0 && index + 1 != source.len() / 4 {
            return None;
        }
        out.push((n >> 16) as u8);
        if padding < 2 {
            out.push((n >> 8) as u8);
        }
        if padding < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}
fn sha1(bytes: &[u8]) -> [u8; 20] {
    let mut source = bytes.to_vec();
    source.push(0x80);
    while source.len() % 64 != 56 {
        source.push(0);
    }
    source.extend_from_slice(&((bytes.len() as u64) * 8).to_be_bytes());
    let mut h = [
        0x67452301u32,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0,
    ];
    for block in source.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999u32),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        for (v, n) in h.iter_mut().zip([a, b, c, d, e]) {
            *v = v.wrapping_add(n);
        }
    }
    let mut result = [0; 20];
    for (i, v) in h.iter().enumerate() {
        result[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(op: u8, fin: bool, text: &[u8]) -> Vec<u8> {
        let mut out = vec![
            op | if fin { 128 } else { 0 },
            128 | text.len() as u8,
            1,
            2,
            3,
            4,
        ];
        out.extend(
            text.iter()
                .enumerate()
                .map(|(i, b)| b ^ [1, 2, 3, 4][i % 4]),
        );
        out
    }
    #[test]
    fn rfc_handshake_and_incremental_fragmented_utf8() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ==").unwrap(),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        assert!(accept_key("bad").is_none());
        let mut d = Decoder::default();
        let bytes = frame(1, false, &[0xf0, 0x9f]);
        for b in bytes {
            d.push(&[b]).unwrap();
            assert!(d.next().unwrap().is_none());
        }
        d.push(&frame(9, true, b"ok")).unwrap();
        assert!(matches!(d.next().unwrap(), Some(Message::Ping(_))));
        d.push(&frame(0, true, &[0x98, 0x80])).unwrap();
        assert!(matches!(d.next().unwrap(),Some(Message::Text(s)) if s == "😀"));
    }
    #[test]
    fn malformed_frames_are_rejected() {
        for bytes in [
            vec![0x81, 0],
            vec![0x89, 0xfe, 0, 126],
            vec![0x80, 0x80, 0, 0, 0, 0],
        ] {
            let mut d = Decoder::default();
            d.push(&bytes).unwrap();
            assert!(d.next().is_err());
        }
    }
    #[test]
    fn many_control_frames_do_not_recurse_or_grow_state() {
        let mut decoder = Decoder::default();
        let mut data = frame(10, true, b"").repeat(10_000);
        data.extend(frame(1, true, b"list"));
        decoder.push(&data).unwrap();
        assert!(matches!(decoder.next().unwrap(), Some(Message::Text(s)) if s == "list"));
        assert!(decoder.buffer.is_empty());
        assert!(decoder.fragment.is_none());
    }
}
