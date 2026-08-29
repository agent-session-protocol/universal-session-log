//! Corruption handling: a bit flip in a frame payload is detected and that
//! frame (and everything after it) is excluded; a corrupted header is ignored
//! and the store self-heals from the data region.

mod common;

use common::{frame_for, sid, write_raw, TempDir};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use usl_core::format::DATA_START;
use usl_core::{Store, StoreOpts};

#[test]
fn corrupt_payload_detected_and_truncated() {
    let session = sid("pi", "corr");
    let mut frames: Vec<Vec<u8>> = (0..3).map(|s| frame_for(s, session)).collect();
    // flip the last byte of frame[1]'s payload
    let n = frames[1].len();
    frames[1][n - 1] ^= 0xff;

    let dir = TempDir::new("corr");
    write_raw(&dir.db(), &frames, &[]);

    // verify() reports the truncation offset at the start of frame[1]
    let v = Store::verify(dir.db()).unwrap();
    assert_eq!(v.frame_count, 1);
    assert_eq!(v.truncation_offset, Some(DATA_START + frame_for(0, session).len() as u64));

    // open() recovers only the first frame
    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.next_seq(), 1);
    assert_eq!(s.scan(&session, 0).unwrap().len(), 1);
}

#[test]
fn corrupt_header_self_heals_from_data_region() {
    let session = sid("pi", "corr-header");
    let frames: Vec<Vec<u8>> = (0..2).map(|s| frame_for(s, session)).collect();
    let dir = TempDir::new("corr-header");
    write_raw(&dir.db(), &frames, &[]);

    // scribble garbage over the header
    let mut f = OpenOptions::new().read(true).write(true).open(dir.db()).unwrap();
    f.seek(SeekFrom::Start(0)).unwrap();
    f.write_all(&[0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33]).unwrap();
    f.sync_all().unwrap();
    drop(f);

    // open must ignore the bad header and recover both frames from the data region
    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.next_seq(), 2);
    assert_eq!(s.scan(&session, 0).unwrap().len(), 2);

    // a read-back sanity check: file still begins with the corrupted magic
    let mut f = OpenOptions::new().read(true).open(dir.db()).unwrap();
    let mut head = [0u8; 8];
    f.read_exact(&mut head).unwrap();
    assert_eq!(&head[..4], &[0xDE, 0xAD, 0xBE, 0xEF]);
}

#[test]
fn torn_length_field_is_truncation_not_oom() {
    let session = sid("pi", "corr-len");
    let frames: Vec<Vec<u8>> = (0..2).map(|s| frame_for(s, session)).collect();
    let dir = TempDir::new("corr-len");
    // append a max-u32 length field as the "next frame"
    write_raw(&dir.db(), &frames, &u32::MAX.to_le_bytes());
    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.next_seq(), 2);
    assert_eq!(s.scan(&session, 0).unwrap().len(), 2);
}
