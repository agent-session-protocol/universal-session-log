//! Incremental line framing.
//!
//! The central correctness property: **framing is independent of how the byte
//! stream is chunked**. Feeding `"a\nb\nc"` in one call, byte-by-byte, or
//! split mid-line must yield the same complete lines in the same order. A
//! harness's `write()` boundaries are arbitrary and must not leak into the
//! captured records.

use std::fmt;

#[derive(Debug, PartialEq)]
pub enum FrameError {
    /// The trailing partial line (everything after the last newline) exceeded
    /// the safety cap — a runaway write with no terminator would otherwise
    /// grow the buffer without bound.
    LineTooLong(usize),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::LineTooLong(n) => write!(f, "partial line exceeds cap ({n} bytes)"),
        }
    }
}

impl std::error::Error for FrameError {}

pub struct Framer {
    buf: Vec<u8>,
    max_line: usize,
}

impl Framer {
    pub fn new(max_line: usize) -> Self {
        Framer { buf: Vec::new(), max_line }
    }

    /// Feed a chunk of appended bytes. Returns every complete line (without
    /// its trailing `\n` / `\r\n`) and buffers any trailing partial line.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop(); // drop '\r' of CRLF
            }
            out.push(line);
        }
        if self.buf.len() > self.max_line {
            return Err(FrameError::LineTooLong(self.buf.len()));
        }
        Ok(out)
    }

    /// Take the trailing partial line (if any). Call once at end of stream.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(chunks: &[&[u8]]) -> (Vec<Vec<u8>>, Option<Vec<u8>>) {
        let mut f = Framer::new(1024 * 1024);
        let mut all = Vec::new();
        for c in chunks {
            all.extend(f.feed(c).unwrap());
        }
        let tail = f.finish();
        (all, tail)
    }

    #[test]
    fn chunking_does_not_change_framing() {
        let whole = lines(&[b"a\nb\nc\n"]);
        let bytewise: Vec<Vec<u8>> = b"a\nb\nc\n".iter().map(|b| vec![*b]).collect();
        let bytewise_refs: Vec<&[u8]> = bytewise.iter().map(|v| v.as_slice()).collect();
        let by_byte = lines(&bytewise_refs);
        assert_eq!(whole, by_byte);
        assert_eq!(whole.0, vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]);
        assert_eq!(whole.1, None);
    }

    #[test]
    fn trailing_partial_line_is_buffered_until_finish() {
        let (got, tail) = lines(&[b"a\nb\nc"]);
        assert_eq!(got, vec![b"a".to_vec(), b"b".to_vec()]);
        assert_eq!(tail, Some(b"c".to_vec()));
    }

    #[test]
    fn mid_line_split_is_joined() {
        let (got, _) = lines(&[b"ab", b"c\nd"]);
        assert_eq!(got, vec![b"abc".to_vec()]);
    }

    #[test]
    fn crlf_is_stripped() {
        let (got, _) = lines(&[b"a\r\nb\r\n"]);
        assert_eq!(got, vec![b"a".to_vec(), b"b".to_vec()]);
    }

    #[test]
    fn empty_lines_are_framed_not_filtered() {
        let (got, _) = lines(&[b"a\n\nb\n"]);
        assert_eq!(got, vec![b"a".to_vec(), b"".to_vec(), b"b".to_vec()]);
    }

    #[test]
    fn partial_line_over_cap_errors() {
        let mut f = Framer::new(4);
        assert!(f.feed(b"abc").is_ok()); // 3 bytes, no newline, under cap
        assert!(matches!(f.feed(b"de"), Err(FrameError::LineTooLong(5))));
    }
}
