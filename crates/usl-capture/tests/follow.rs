//! FileFollower: file-boundary live capture semantics.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use usl_capture::FileFollower;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("uslfollow-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn append(path: &PathBuf, bytes: &[u8]) {
    let mut f = OpenOptions::new().create(true).append(true).open(path).unwrap();
    f.write_all(bytes).unwrap();
    f.flush().unwrap();
}

#[test]
fn tail_sees_only_future_appends() {
    let dir = TempDir::new("tail");
    let p = dir.path("a.jsonl");
    append(&p, b"old\n");
    let mut f = FileFollower::tail(&p).unwrap();
    assert_eq!(f.poll().unwrap(), b"");
    append(&p, b"new\n");
    assert_eq!(f.poll().unwrap(), b"new\n");
}

#[test]
fn from_start_replays_then_follows() {
    let dir = TempDir::new("fromstart");
    let p = dir.path("a.jsonl");
    append(&p, b"one\ntwo\n");
    let mut f = FileFollower::from_start(&p).unwrap();
    assert_eq!(f.poll().unwrap(), b"one\ntwo\n");
    append(&p, b"three\n");
    assert_eq!(f.poll().unwrap(), b"three\n");
}

#[test]
fn poll_returns_empty_when_nothing_new() {
    let dir = TempDir::new("empty");
    let p = dir.path("a.jsonl");
    append(&p, b"x\n");
    let mut f = FileFollower::from_start(&p).unwrap();
    assert_eq!(f.poll().unwrap(), b"x\n");
    assert_eq!(f.poll().unwrap(), b"");
    assert_eq!(f.poll().unwrap(), b"");
}

#[test]
fn truncation_resets_to_start() {
    let dir = TempDir::new("truncate");
    let p = dir.path("a.jsonl");
    append(&p, b"first\nsecond\n");
    let mut f = FileFollower::from_start(&p).unwrap();
    assert_eq!(f.poll().unwrap(), b"first\nsecond\n");
    // harness truncates (rotation/compaction) and starts over
    fs::write(&p, b"fresh\n").unwrap();
    assert_eq!(f.poll().unwrap(), b"fresh\n");
}
