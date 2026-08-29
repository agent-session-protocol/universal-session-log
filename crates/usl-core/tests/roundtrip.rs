//! append → flush → reopen → scan/get roundtrip across multiple sessions.

mod common;

use common::{record, sid, TempDir};
use usl_core::record::Record;
use usl_core::{Store, StoreOpts};

#[test]
fn append_scan_get_roundtrip_multisession() {
    let dir = TempDir::new("roundtrip");
    let mut s = Store::create(dir.db(), StoreOpts::default()).unwrap();

    let a = sid("pi", "sess-a");
    let b = sid("claude", "sess-a"); // same native id, different harness ⇒ distinct key
    s.append(&record("pi", "sess-a", "hello")).unwrap();
    s.append(&Record::new(b, 1, 101, b"world".to_vec())).unwrap();
    s.append(&Record::new(a, 2, 102, b"again".to_vec())).unwrap();
    s.flush().unwrap();
    drop(s);

    let s = Store::open(dir.db(), StoreOpts::default()).unwrap();
    assert_eq!(s.session_count(), 2);
    assert_eq!(s.next_seq(), 3);
    assert_eq!(s.data_end() > 64, true);
    assert_eq!(s.session_ids().len(), 2);

    let all = s.scan_all(1).unwrap();
    assert_eq!(all.iter().map(|record| record.seq).collect::<Vec<_>>(), vec![1, 2]);

    let ra = s.scan(&a, 0).unwrap();
    assert_eq!(ra.len(), 2);
    assert_eq!(ra[0].seq, 0);
    assert_eq!(ra[0].body, b"hello");
    assert_eq!(ra[1].seq, 2);
    assert_eq!(ra[1].body, b"again");

    let rb = s.scan(&b, 0).unwrap();
    assert_eq!(rb.len(), 1);
    assert_eq!(rb[0].body, b"world");

    // get by seq ("again" is seq 2; seq 1 belongs to session b)
    assert_eq!(s.get(&a, 2).unwrap().unwrap().body, b"again");
    assert!(s.get(&a, 1).unwrap().is_none());
    assert!(s.get(&a, 99).unwrap().is_none());

    // from_seq filter
    assert_eq!(s.scan(&a, 1).unwrap().len(), 1);
}

#[test]
fn create_fails_if_exists_and_open_missing_fails() {
    let dir = TempDir::new("create");
    let path = dir.db();
    let _ = Store::create(&path, StoreOpts::default()).unwrap();
    assert!(Store::create(&path, StoreOpts::default()).is_err());

    let dir2 = TempDir::new("open-missing");
    assert!(Store::open(dir2.db(), StoreOpts::default()).is_err());
}
