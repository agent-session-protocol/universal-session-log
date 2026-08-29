//! Live capture + cross-harness conversion demo (file boundary, no FUSE).
//!
//! Pipeline: a fake harness appends claude-format JSONL to a file in chunks
//! → `FileFollower` observes the growth → `CaptureSession` frames + stores
//! raw lines in usl-core → `ClaudeToPi` re-encodes them as resumable pi JSONL.
//!
//! Run: `cargo run --example live_convert`

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use usl_capture::{CaptureSession, ClaudeToPi, FileFollower, KIND_RAW_LINE};
use usl_core::identity::{session_id, source_sha256};
use usl_core::{Store, StoreOpts};

/// A claude-format session the fake harness will stream, chunk by chunk.
const CLAUDE_STREAM: &[&str] = &[
    r#"{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"sess-demo","timestamp":"2026-08-29T08:00:00Z","message":{"role":"user","content":"fix the bug"}}"#,
    r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","sessionId":"sess-demo","timestamp":"2026-08-29T08:00:01Z","message":{"id":"msg_1","role":"assistant","model":"claude-opus-4","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"let me look","signature":"sig_abc"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#,
    r#"{"type":"user","uuid":"u3","parentUuid":"u2","sessionId":"sess-demo","timestamp":"2026-08-29T08:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.ts b.ts","is_error":false}]}}"#,
    r#"{"type":"assistant","uuid":"u4","parentUuid":"u3","sessionId":"sess-demo","timestamp":"2026-08-29T08:00:03Z","message":{"id":"msg_2","role":"assistant","model":"claude-opus-4","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}"#,
];

fn main() {
    let dir = std::env::temp_dir().join(format!("usl-demo-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let log_path: PathBuf = dir.join("claude.jsonl");
    let db_path: PathBuf = dir.join("session.usl");

    // ---- fake harness: stream claude lines in arbitrary chunks ----
    let writer_path = log_path.clone();
    let harness = thread::spawn(move || {
        let mut file = OpenOptions::new().create(true).append(true).open(&writer_path).unwrap();
        for line in CLAUDE_STREAM {
            // write each line split across 2-3 chunks with a pause, to prove
            // the follower+framer don't care about chunk boundaries
            let bytes = format!("{line}\n").into_bytes();
            for chunk in bytes.chunks(17) {
                file.write_all(chunk).unwrap();
                file.flush().unwrap();
                thread::sleep(Duration::from_millis(30));
            }
        }
        drop(file);
    });

    // ---- capture side: follow the file, frame, store ----
    let session_id = session_id("claude", "sess-demo", &source_sha256(b"live demo stream"));
    let store = Store::create(&db_path, StoreOpts::default()).unwrap();
    let mut capture = CaptureSession::start(store, session_id, "claude", "sess-demo").unwrap();
    let mut follower = FileFollower::from_start(&log_path).unwrap();

    loop {
        let bytes = follower.poll().unwrap();
        if !bytes.is_empty() {
            capture.write(&bytes).unwrap();
        }
        if harness.is_finished() && bytes.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let lines = capture.finish().unwrap();
    drop(capture);
    harness.join().unwrap();

    // ---- read side: convert claude records -> resumable pi JSONL ----
    let store = Store::open(&db_path, StoreOpts::default()).unwrap();
    let rows = store.scan(&session_id, 0).unwrap();
    let raw_lines: Vec<Vec<u8>> = rows
        .iter()
        .filter(|r| r.kind == KIND_RAW_LINE)
        .map(|r| r.body.clone())
        .collect();

    let mut converter = ClaudeToPi::new();
    let mut pi_entries: Vec<String> = Vec::new();
    for line in &raw_lines {
        if let Some(entry) = converter.convert(line).unwrap() {
            pi_entries.push(serde_json::to_string(&entry).unwrap());
        }
    }

    println!("== captured {lines} claude lines into usl-core ==");
    println!("== converted to {} resumable pi entries ==", pi_entries.len());
    for e in &pi_entries {
        println!("{e}");
    }
    for loss in &converter.loss {
        println!("[loss] {loss}");
    }

    fs::remove_dir_all(&dir).ok();
}
