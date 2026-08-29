//! On-disk byte layout: the header (superblock) and framed records.
//!
//! ```text
//! [0..64)   Header (redundant hint; correctness never depends on it)
//!   [0..6)   magic "USLDB\0"
//!   [6..8)   format_version u16 LE
//!   [8..12)  page_size u32 LE
//!   [12..16) flags u32 LE
//!   [16..24) data_end u64 LE
//!   [24..32) next_seq u64 LE
//!   [32..40) session_count u64 LE
//!   [40..48) reserved (zero)
//!   [48..52) header_crc u32 LE (covers [0..48))
//!   [52..64) reserved (zero)
//! [64..data_end)  framed records:
//!   [len u32 LE][crc32 u32 LE][payload(len bytes)]
//! ```

use crate::error::Error;

pub const MAGIC: &[u8; 6] = b"USLDB\0";
pub const FORMAT_VERSION: u16 = 0;
pub const DATA_START: u64 = 64;
pub const HEADER_SIZE: usize = 64;
pub const DEFAULT_PAGE_SIZE: u32 = 4096;
/// Upper bound on a single frame payload. Guards against a torn length field
/// causing an absurd allocation during recovery.
pub const MAX_FRAME_PAYLOAD: u32 = 64 * 1024 * 1024; // 64 MiB

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Header {
    pub page_size: u32,
    pub flags: u32,
    pub data_end: u64,
    pub next_seq: u64,
    pub session_count: u64,
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER_SIZE] {
        let mut b = [0u8; HEADER_SIZE];
        b[0..6].copy_from_slice(MAGIC);
        b[6..8].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        b[8..12].copy_from_slice(&self.page_size.to_le_bytes());
        b[12..16].copy_from_slice(&self.flags.to_le_bytes());
        b[16..24].copy_from_slice(&self.data_end.to_le_bytes());
        b[24..32].copy_from_slice(&self.next_seq.to_le_bytes());
        b[32..40].copy_from_slice(&self.session_count.to_le_bytes());
        // [40..48] reserved zero
        let crc = crc32fast::hash(&b[0..48]);
        b[48..52].copy_from_slice(&crc.to_le_bytes());
        // [52..64] reserved zero
        b
    }

    /// Decode and verify a 64-byte header. Fails on bad magic, wrong version,
    /// or CRC mismatch — any of which the caller treats as "header is just a
    /// hint, rebuild from the data region".
    pub fn decode(bytes: &[u8]) -> Result<Header, Error> {
        if bytes.len() < HEADER_SIZE {
            return Err(Error::Corrupt("header too short".into()));
        }
        let b = &bytes[..HEADER_SIZE];
        if &b[0..6] != MAGIC {
            return Err(Error::Corrupt("bad magic".into()));
        }
        let version = u16::from_le_bytes([b[6], b[7]]);
        if version != FORMAT_VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        let stored_crc = u32::from_le_bytes([b[48], b[49], b[50], b[51]]);
        if crc32fast::hash(&b[0..48]) != stored_crc {
            return Err(Error::Corrupt("header crc mismatch".into()));
        }
        Ok(Header {
            page_size: u32::from_le_bytes([b[8], b[9], b[10], b[11]]),
            flags: u32::from_le_bytes([b[12], b[13], b[14], b[15]]),
            data_end: u64::from_le_bytes(b[16..24].try_into().unwrap()),
            next_seq: u64::from_le_bytes(b[24..32].try_into().unwrap()),
            session_count: u64::from_le_bytes(b[32..40].try_into().unwrap()),
        })
    }
}

/// Encode a payload into a framed record: `[len u32 LE][crc32 u32 LE][payload]`.
/// CRC32 covers the payload only. Returns an error (never panics) if the
/// payload exceeds [`MAX_FRAME_PAYLOAD`].
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, Error> {
    if payload.len() > MAX_FRAME_PAYLOAD as usize {
        return Err(Error::Corrupt(format!(
            "frame payload {} bytes exceeds MAX_FRAME_PAYLOAD ({MAX_FRAME_PAYLOAD})",
            payload.len()
        )));
    }
    let len = payload.len() as u32;
    let crc = crc32fast::hash(payload);
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrip() {
        let h = Header { page_size: 4096, flags: 0, data_end: 64, next_seq: 7, session_count: 2 };
        let bytes = h.encode();
        assert_eq!(bytes.len(), HEADER_SIZE);
        assert_eq!(Header::decode(&bytes).unwrap(), h);
    }

    #[test]
    fn header_rejects_corruption() {
        let h = Header { page_size: 4096, flags: 0, data_end: 64, next_seq: 0, session_count: 0 };
        let mut bytes = h.encode();
        bytes[10] ^= 0xff; // flip a page_size byte (inside the CRC-covered region)
        assert!(Header::decode(&bytes).is_err());
    }

    #[test]
    fn frame_roundtrip_and_crc_detection() {
        let payload = b"hello usl";
        let frame = encode_frame(payload).unwrap();
        assert_eq!(frame.len(), 8 + payload.len());
        let len = u32::from_le_bytes(frame[0..4].try_into().unwrap());
        assert_eq!(len as usize, payload.len());
        let crc = u32::from_le_bytes(frame[4..8].try_into().unwrap());
        assert_eq!(crc, crc32fast::hash(payload));
    }
}
