//! Boundary bodies: empty, page-size, 1 MiB, > 64 MiB data region, and
//! oversized-frame rejection (must error, not panic).

mod common;

use common::{sid, TempDir};
use usl_core::format::MAX_FRAME_PAYLOAD;
use usl_core::record::Record;
use usl_core::{Store, StoreOpts};

#[test]
fn empty_body_roundtrips() {
    let dir = TempDir::new("empty");
    let session = sid("pi", "empty");
    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();
    let seq = s.append(&Record::new(session, 1, 0, Vec::new())).unwrap();
    assert_eq!(seq, 0);
    s.flush().unwrap();
    drop(s);

    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    let rows = s.scan(&session, 0).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].body.is_empty());
}

#[test]
fn page_size_boundary_bodies_roundtrip() {
    let dir = TempDir::new("page");
    let session = sid("pi", "page");
    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();
    // Just under, exactly on, and just over the 4096 page boundary.
    for (i, size) in [4095usize, 4096, 4097].iter().enumerate() {
        let body = vec![(i as u8).wrapping_add(0x40); *size];
        s.append(&Record::new(session, 1, i as u64, body)).unwrap();
    }
    s.flush().unwrap();
    drop(s);

    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    let rows = s.scan(&session, 0).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].body.len(), 4095);
    assert_eq!(rows[1].body.len(), 4096);
    assert_eq!(rows[2].body.len(), 4097);
    // byte-for-byte integrity at the boundary
    assert_eq!(rows[1].body, vec![0x41u8; 4096]);
    assert_eq!(rows[2].body[4096], 0x42);
}

#[test]
fn one_mebibyte_body_roundtrips() {
    let dir = TempDir::new("mib");
    let session = sid("pi", "mib");
    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();
    let body = vec![0x5Au8; 1024 * 1024];
    s.append(&Record::new(session, 1, 0, body.clone())).unwrap();
    s.flush().unwrap();
    drop(s);

    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    let rows = s.scan(&session, 0).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].body, body);
}

#[test]
fn data_region_crosses_64mib_without_crashing() {
    // v0 has no segment rollover; the data region is a single unbounded file.
    // Crossing the 64 MiB mark must just keep working.
    let dir = TempDir::new("big");
    let session = sid("pi", "big");
    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();

    let count = 70u64; // 70 × 1 MiB ≈ 70 MiB total
    let mut body = vec![0xABu8; 1024 * 1024];
    for seq in 0..count {
        body[0..8].copy_from_slice(&seq.to_le_bytes());
        let assigned = s.append(&Record::new(session, 1, seq, body.clone())).unwrap();
        assert_eq!(assigned, seq);
    }
    assert!(s.data_end() > 64 * 1024 * 1024, "data region must exceed 64 MiB");
    s.flush().unwrap();
    drop(s);

    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.next_seq(), count);
    let rows = s.scan(&session, 0).unwrap();
    assert_eq!(rows.len(), count as usize);
    assert_eq!(rows[0].seq, 0);
    assert_eq!(rows[count as usize - 1].seq, count - 1);
    // the final record's body encodes its own seq in the first 8 bytes
    assert_eq!(&rows[count as usize - 1].body[0..8], &(count - 1).to_le_bytes());
}

#[test]
fn oversized_frame_rejected_gracefully() {
    // A body equal to MAX_FRAME_PAYLOAD serializes to a payload *larger* than
    // the cap (seq/session/kind/ts + varint overhead), so it must be rejected
    // with an error — and the store must remain usable afterwards.
    let dir = TempDir::new("oversize");
    let session = sid("pi", "oversize");
    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();

    let huge = vec![0u8; MAX_FRAME_PAYLOAD as usize];
    assert!(s.append(&Record::new(session, 1, 0, huge)).is_err());

    // store still usable
    s.append(&Record::new(session, 1, 1, b"still works".to_vec())).unwrap();
    s.flush().unwrap();
    drop(s);

    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    let rows = s.scan(&session, 0).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].body, b"still works");
}
