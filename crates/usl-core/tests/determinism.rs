//! Determinism: a torn write and a clean write of the same prefix must
//! recover to byte-identical store state. Recovery is a pure function of the
//! valid prefix, independent of whatever (torn) bytes follow it.

mod common;

use common::{frame_for, sid, write_raw, TempDir};
use usl_core::{Store, StoreOpts};

#[test]
fn torn_tail_recovers_identically_to_clean_prefix() {
    let session = sid("pi", "det");
    let all: Vec<Vec<u8>> = (0..5).map(|s| frame_for(s, session)).collect();

    for k in 0..=all.len() {
        let prefix: Vec<Vec<u8>> = all[..k].to_vec();

        let dir_clean = TempDir::new("det-clean");
        write_raw(&dir_clean.db(), &prefix, &[]);

        let dir_torn = TempDir::new("det-torn");
        let torn: &[u8] = if k < all.len() { &all[k][..all[k].len() / 2] } else { &[] };
        write_raw(&dir_torn.db(), &prefix, torn);

        let clean = Store::open(dir_clean.db(), StoreOpts::default()).unwrap();
        let torn = Store::open(dir_torn.db(), StoreOpts::default()).unwrap();

        assert_eq!(clean.next_seq(), torn.next_seq(), "k={k}");
        assert_eq!(clean.data_end(), torn.data_end(), "k={k}");
        assert_eq!(clean.session_count(), torn.session_count(), "k={k}");
        assert_eq!(clean.scan(&session, 0).unwrap(), torn.scan(&session, 0).unwrap(), "k={k}");
    }
}

#[test]
fn reopen_twice_is_stable() {
    let session = sid("pi", "det-stable");
    let frames: Vec<Vec<u8>> = (0..3).map(|s| frame_for(s, session)).collect();
    let dir = TempDir::new("det-stable");
    write_raw(&dir.db(), &frames, &[]);

    let first = Store::open(dir.db(), StoreOpts::default()).unwrap();
    let second = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(first.next_seq(), second.next_seq());
    assert_eq!(first.scan(&session, 0).unwrap(), second.scan(&session, 0).unwrap());
}
