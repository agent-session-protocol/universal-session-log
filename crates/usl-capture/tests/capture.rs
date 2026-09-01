//! Capture-level assertions: chunking determinism, header provenance,
//! empty-line skipping, and trailing-partial flush.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use usl_capture::{CaptureSession, KIND_RAW_LINE, KIND_SESSION_HEADER};
use usl_core::identity::{session_id, source_sha256, SessionId};
use usl_core::{Store, StoreOpts};

struct TempDir(PathBuf);
static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);
impl TempDir {
    fn new(tag: &str) -> Self {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let ordinal = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let p =
            std::env::temp_dir().join(format!("uslcap-{tag}-{}-{n}-{ordinal}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn db(&self) -> PathBuf {
        self.0.join("db.usl")
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sid() -> SessionId {
    session_id(
        "claude",
        "sess-live-1",
        &source_sha256(b"live capture test"),
    )
}

/// Run a full capture (chunked writes → finish → reopen) and return the
/// stored `(kind, body)` sequence.
fn run_capture(chunks: &[&[u8]]) -> Vec<(u8, Vec<u8>)> {
    let dir = TempDir::new("cap");
    let store = Store::create(dir.db(), StoreOpts::default()).unwrap();
    let mut cap = CaptureSession::start(store, sid(), "claude", "sess-live-1").unwrap();
    for c in chunks {
        cap.write(c).unwrap();
    }
    cap.finish().unwrap();
    drop(cap);

    let store = Store::open(dir.db(), StoreOpts::default()).unwrap();
    store
        .scan(&sid(), 0)
        .unwrap()
        .into_iter()
        .map(|r| (r.kind, r.body))
        .collect()
}

#[test]
fn chunking_does_not_change_captured_records() {
    let stream = b"{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n{\"type\":\"tool\"}\n";

    let whole = run_capture(&[stream]);
    let bytewise: Vec<Vec<u8>> = stream.iter().map(|b| vec![*b]).collect();
    let bytewise_refs: Vec<&[u8]> = bytewise.iter().map(|v| v.as_slice()).collect();
    let by_byte = run_capture(&bytewise_refs);

    // line records must be identical regardless of write chunking (framing
    // determinism); the header's started_at_ms is wall-clock and legitimately
    // differs between the two runs.
    assert_eq!(&whole[1..], &by_byte[1..]);

    // header provenance: same structure, harness, and native id in both
    assert_eq!(whole[0].0, KIND_SESSION_HEADER);
    assert_eq!(whole[0].0, by_byte[0].0);
    let header = String::from_utf8(whole[0].1.clone()).unwrap();
    assert!(header.contains("\"harness\":\"claude\""));
    assert!(header.contains("\"native_session_id\":\"sess-live-1\""));
    for item in &whole[1..] {
        assert_eq!(item.0, KIND_RAW_LINE);
    }
    assert_eq!(whole[1].1, b"{\"type\":\"user\"}");
    assert_eq!(whole[3].1, b"{\"type\":\"tool\"}");
}

#[test]
fn empty_lines_skipped_and_trailing_partial_flushed() {
    // no trailing newline; an empty line; a partial final line
    let rows = run_capture(&[b"{\"a\":1}\n\n{\"b\":2}\n{\"c\""]);
    // header + 3 non-empty lines (the empty line is skipped)
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[1].1, b"{\"a\":1}");
    assert_eq!(rows[2].1, b"{\"b\":2}");
    assert_eq!(rows[3].1, b"{\"c\""); // trailing partial captured by finish()
}

#[test]
fn mid_line_split_is_joined_across_writes() {
    let rows = run_capture(&[b"{\"x\":", b"1}\n{\"y\":2}"]);
    assert_eq!(rows.len(), 3); // header + 2 lines
    assert_eq!(rows[1].1, b"{\"x\":1}");
    assert_eq!(rows[2].1, b"{\"y\":2}");
}

#[test]
fn write_returns_appended_nonempty_line_count() {
    let dir = TempDir::new("count");
    let store = Store::create(dir.db(), StoreOpts::default()).unwrap();
    let mut cap = CaptureSession::start(store, sid(), "claude", "sess-live-1").unwrap();
    assert_eq!(cap.write(b"a\n\nb\nc").unwrap(), 2); // "a", "b"; "c" partial
    assert_eq!(cap.finish().unwrap(), 3); // + "c"
}
