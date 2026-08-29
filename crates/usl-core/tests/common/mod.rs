//! Shared test helpers for usl-core integration tests.
//!
//! Each `tests/*.rs` binary compiles this module in isolation and uses only a
//! subset of the helpers, hence the allow(dead_code).
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use usl_core::format::{encode_frame, Header, DATA_START, DEFAULT_PAGE_SIZE};
use usl_core::identity::{session_id, source_sha256, SessionId};
use usl_core::record::{Record, StoredRecord};

pub struct TempDir {
    pub path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("usl-test-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        TempDir { path }
    }

    pub fn db(&self) -> PathBuf {
        self.path.join("db.usl")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Deterministic session id for `(harness, native)`.
pub fn sid(harness: &str, native: &str) -> SessionId {
    session_id(harness, native, &source_sha256(native.as_bytes()))
}

pub fn record(harness: &str, native: &str, body: &str) -> Record {
    Record::new(sid(harness, native), 1, 0, body.as_bytes().to_vec())
}

/// Build a fully-framed on-disk record (as `Store::append` would write it),
/// without going through the store — so crash tests can tear frames by hand.
pub fn frame_for(seq: u64, session: SessionId) -> Vec<u8> {
    let stored = StoredRecord {
        seq,
        session_id: session,
        kind: 1,
        ts_ms: seq,
        body: format!("b{seq}").into_bytes(),
    };
    encode_frame(&stored.encode().unwrap()).unwrap()
}

/// Write a header (with stale counters, as after a crash before flush) plus
/// `frames` and a `torn_tail` of partial bytes, simulating a torn write.
pub fn write_raw(path: &Path, frames: &[Vec<u8>], torn_tail: &[u8]) {
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path).unwrap();
    let header = Header { page_size: DEFAULT_PAGE_SIZE, flags: 0, data_end: DATA_START, next_seq: 0, session_count: 0 };
    f.write_all(&header.encode()).unwrap();
    for frame in frames {
        f.write_all(frame).unwrap();
    }
    f.write_all(torn_tail).unwrap();
}
