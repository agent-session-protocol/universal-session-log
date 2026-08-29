//! Append-only immutability: prior frames are never mutated by later appends,
//! and a reader of a stable prefix sees a stable view.

mod common;

use common::{record, sid, TempDir};
use usl_core::{Store, StoreOpts};

#[test]
fn appended_frames_never_mutate_prior_reads() {
    let dir = TempDir::new("conc");
    let session = sid("pi", "conc");

    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();
    for i in 0..3u64 {
        s.append(&record("pi", "conc", &format!("v{i}"))).unwrap();
    }
    s.flush().unwrap();
    let before = s.scan(&session, 0).unwrap();
    assert_eq!(before.len(), 3);

    // more appends (same + a new session)
    for i in 3..5u64 {
        s.append(&record("pi", "conc", &format!("v{i}"))).unwrap();
    }
    s.append(&record("claude", "conc", "other")).unwrap();
    s.flush().unwrap();

    let after = s.scan(&session, 0).unwrap();
    assert_eq!(after.len(), 5);
    assert_eq!(&after[..3], &before[..], "first 3 records must be byte-identical after appends");

    // verify() agrees: 6 frames, no truncation
    let v = Store::verify(dir.db()).unwrap();
    assert_eq!(v.frame_count, 6);
    assert_eq!(v.truncation_offset, None);
    assert_eq!(v.session_count, 2);
}
