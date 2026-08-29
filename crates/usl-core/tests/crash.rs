//! Crash injection: a torn frame at every byte offset must recover to the
//! last complete frame. This enumerates every write boundary (len field,
//! crc field, payload bytes) rather than asserting by hand.

mod common;

use common::{frame_for, sid, write_raw, TempDir};
use usl_core::format::DATA_START;
use usl_core::{Store, StoreOpts};

#[test]
fn torn_tail_at_every_cut_point_recovers_to_last_complete_frame() {
    let session = sid("pi", "crash");
    let complete = 3;
    let frames: Vec<Vec<u8>> = (0..complete).map(|s| frame_for(s, session)).collect();
    let next_frame = frame_for(complete as u64, session);
    let prefix_len: u64 = frames.iter().map(|f| f.len() as u64).sum();

    // cut in 0..next_frame.len(): the tail is always a *partial* next frame.
    for cut in 0..next_frame.len() {
        let dir = TempDir::new("crash");
        write_raw(&dir.db(), &frames, &next_frame[..cut]);

        let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
        assert_eq!(s.next_seq(), complete as u64, "cut={cut} must recover seq up to {complete}");
        assert_eq!(s.data_end(), DATA_START + prefix_len, "cut={cut} must truncate at last complete frame");
        assert_eq!(s.session_count(), 1, "cut={cut}");
        assert_eq!(s.scan(&session, 0).unwrap().len(), complete as usize, "cut={cut}");
    }
}

#[test]
fn clean_append_of_all_frames_recovers_all() {
    let session = sid("pi", "crash-full");
    let frames: Vec<Vec<u8>> = (0..4).map(|s| frame_for(s, session)).collect();
    let dir = TempDir::new("crash-full");
    write_raw(&dir.db(), &frames, &[]);
    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.next_seq(), 4);
    assert_eq!(s.scan(&session, 0).unwrap().len(), 4);
}

#[test]
fn empty_file_recovers_to_empty_store() {
    let dir = TempDir::new("crash-empty");
    write_raw(&dir.db(), &[], &[]);
    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.next_seq(), 0);
    assert_eq!(s.session_count(), 0);
    assert_eq!(s.data_end(), DATA_START);
}
