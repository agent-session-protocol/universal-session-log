//! Public-API identity assertions (detailed collision logic lives in
//! `src/identity.rs` unit tests).

mod common;

use usl_core::identity::{session_id, source_sha256};

#[test]
fn idempotent_and_stable_across_calls() {
    let src = source_sha256(b"same source bytes");
    let a = session_id("claude", "uuid-1", &src);
    let b = session_id("claude", "uuid-1", &src);
    assert_eq!(a, b);
    assert_eq!(a.to_hex().len(), 64);
    assert_eq!(a.as_bytes().len(), 32);
}

#[test]
fn harness_is_part_of_identity() {
    let src = source_sha256(b"x");
    // Same native id, different harness → different canonical id.
    assert_ne!(session_id("pi", "agent-1", &src), session_id("codex", "agent-1", &src));
}
