//! Crash recovery: scan the data region, stop at the first torn/corrupt frame,
//! and rebuild the index from complete frames. This is the core correctness
//! proposition of the engine.

use std::io::{ErrorKind, Read};

use crate::error::Error;
use crate::format::{DATA_START, MAX_FRAME_PAYLOAD};
use crate::index::{FrameMeta, Index};
use crate::record::StoredRecord;

/// The result of scanning a data region.
#[derive(Debug, Clone, PartialEq)]
pub struct Recovered {
    /// Offset of the first byte past the last complete frame (= `DATA_START`
    /// when the store has no records).
    pub data_end: u64,
    /// `max(seq) + 1` over complete frames (0 when empty).
    pub next_seq: u64,
    pub session_count: u64,
    pub index: Index,
    /// Offset of the first torn/corrupt frame, if any.
    pub truncation_offset: Option<u64>,
}

/// Stream-scan frames starting at `DATA_START`. `reader` must be positioned at
/// `DATA_START`. Recovery is a pure function of the bytes on disk: for a given
/// prefix of valid frames it always returns the same state, regardless of what
/// (torn) bytes follow.
pub fn recover_from(reader: &mut impl Read) -> Result<Recovered, Error> {
    let mut index = Index::default();
    let mut offset = DATA_START;
    let mut next_seq = 0u64;
    let mut truncation_offset = None;

    loop {
        // 1. length prefix
        let mut len_buf = [0u8; 4];
        match reader.read(&mut len_buf[..1]) {
            Ok(0) => break, // clean end exists only before a new frame begins
            Ok(_) => match reader.read_exact(&mut len_buf[1..]) {
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                    truncation_offset = Some(offset);
                    break;
                }
                Err(e) => return Err(e.into()),
            },
            Err(e) => return Err(e.into()),
        }
        let len = u32::from_le_bytes(len_buf);
        // A zero or oversized length is either a torn write or corruption; in
        // both cases this frame cannot be trusted — truncate here.
        if len == 0 || len > MAX_FRAME_PAYLOAD {
            truncation_offset = Some(offset);
            break;
        }

        // 2. crc
        let mut crc_buf = [0u8; 4];
        match reader.read_exact(&mut crc_buf) {
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                truncation_offset = Some(offset);
                break;
            }
            Err(e) => return Err(e.into()),
        }
        let crc = u32::from_le_bytes(crc_buf);

        // 3. payload
        let mut payload = vec![0u8; len as usize];
        match reader.read_exact(&mut payload) {
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                truncation_offset = Some(offset);
                break;
            }
            Err(e) => return Err(e.into()),
        }

        // 4. integrity
        if crc32fast::hash(&payload) != crc {
            truncation_offset = Some(offset);
            break;
        }

        // 5. deserialize (CRC passed ⇒ bytes are as written; a failure here is
        //    a schema/version mismatch, which must be loud, not silent).
        let stored: StoredRecord = postcard::from_bytes(&payload)
            .map_err(|e| Error::Schema(format!("frame at offset {offset}: {e}")))?;

        index.push(
            stored.session_id,
            FrameMeta { seq: stored.seq, offset, payload_len: len },
        );
        if stored.seq >= next_seq {
            next_seq = stored.seq + 1;
        }
        offset += 8 + len as u64;
    }

    Ok(Recovered {
        data_end: offset,
        next_seq,
        session_count: index.session_count(),
        index,
        truncation_offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::encode_frame;
    use crate::identity::SessionId;
    use crate::record::StoredRecord;
    use std::io::Cursor;

    fn frame_for(seq: u64) -> Vec<u8> {
        let rec = StoredRecord {
            seq,
            session_id: SessionId([0xAB; 32]),
            kind: 1,
            ts_ms: seq,
            body: format!("body-{seq}").into_bytes(),
        };
        encode_frame(&postcard::to_allocvec(&rec).unwrap()).unwrap()
    }

    #[test]
    fn empty_region_recovers_clean() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        let r = recover_from(&mut cur).unwrap();
        assert_eq!(r.data_end, DATA_START);
        assert_eq!(r.next_seq, 0);
        assert_eq!(r.truncation_offset, None);
        assert!(r.index.is_empty());
    }

    #[test]
    fn torn_payload_truncates_to_last_complete_frame() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&frame_for(0));
        let full = frame_for(1);
        // write only part of the second frame's payload
        bytes.extend_from_slice(&full[..8 + 3]);
        let mut cur = Cursor::new(bytes);
        let r = recover_from(&mut cur).unwrap();
        assert_eq!(r.next_seq, 1);
        assert_eq!(r.index.total_frames(), 1);
        assert_eq!(r.truncation_offset, Some(DATA_START + frame_for(0).len() as u64));
    }

    #[test]
    fn zero_length_is_truncation_not_oom() {
        let mut bytes = frame_for(0);
        bytes.extend_from_slice(&[0u8; 4]); // a zero length field
        let mut cur = Cursor::new(bytes);
        let r = recover_from(&mut cur).unwrap();
        assert_eq!(r.index.total_frames(), 1);
        assert_eq!(r.truncation_offset, Some(DATA_START + frame_for(0).len() as u64));
    }

    #[test]
    fn partial_length_prefix_is_reported_as_truncation() {
        let mut bytes = frame_for(0);
        bytes.extend_from_slice(&[8, 0, 0]);
        let mut cur = Cursor::new(bytes);
        let r = recover_from(&mut cur).unwrap();
        assert_eq!(r.index.total_frames(), 1);
        assert_eq!(r.truncation_offset, Some(DATA_START + frame_for(0).len() as u64));
    }

    #[test]
    fn oversized_length_is_rejected_without_allocating() {
        let mut bytes = frame_for(0);
        bytes.extend_from_slice(&u32::MAX.to_le_bytes()); // absurd length
        let mut cur = Cursor::new(bytes);
        let r = recover_from(&mut cur).unwrap();
        assert_eq!(r.index.total_frames(), 1);
        assert_eq!(r.truncation_offset, Some(DATA_START + frame_for(0).len() as u64));
    }

    #[test]
    fn corrupt_payload_crc_truncates() {
        let mut bytes = frame_for(0);
        let mut bad = frame_for(1);
        let n = bad.len();
        bad[n - 1] ^= 0xff; // flip a payload byte
        bytes.extend_from_slice(&bad);
        let mut cur = Cursor::new(bytes);
        let r = recover_from(&mut cur).unwrap();
        assert_eq!(r.index.total_frames(), 1);
        assert_eq!(r.truncation_offset, Some(DATA_START + frame_for(0).len() as u64));
    }

    #[test]
    fn schema_mismatch_is_loud() {
        // A frame whose CRC matches its payload but whose payload is not a
        // valid `StoredRecord` must surface a schema error — NOT silently
        // truncate (which would hide a version/schema bug).
        let payload = b"not a postcard record";
        let frame = encode_frame(payload).unwrap();
        let mut cur = Cursor::new(frame);
        let r = recover_from(&mut cur);
        assert!(matches!(r, Err(Error::Schema(_))));
    }
}
