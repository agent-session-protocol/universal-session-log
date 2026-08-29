//! Session identity: the content-addressed `SessionId` and its derivation.
//!
//! `session_id(harness, native_session_id, source_sha256)` hashes a
//! **length-prefixed identity tuple**, NOT the bare native id. This is what
//! makes re-import idempotent while keeping the namespace collision-safe
//! across harnesses:
//!
//! - same source → same id (idempotent re-import)
//! - different harness, same native id → different id (no cross-harness
//!   collision; a pi slug `agent-onboard-1` and a claude file with the same
//!   string must not share a key)
//! - same harness + native id, different source bytes → different id
//! - length prefixing makes `("ab","c")` and `("a","bc")` hash differently
//!
//! The engine treats `SessionId` as an opaque fixed-width key; only this
//! module defines its semantics.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Fixed-width canonical session key (32 bytes = SHA-256 output).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub [u8; 32]);

impl SessionId {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }
}

impl AsRef<[u8]> for SessionId {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// SHA-256 of arbitrary source bytes (e.g. a harness's raw session file).
pub fn source_sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Derive the canonical `SessionId` from the identity tuple.
///
/// Each field is length-prefixed (u64 LE) before hashing so that field
/// boundaries cannot be confused across concatenation.
pub fn session_id(harness: &str, native_session_id: &str, source_sha256: &[u8; 32]) -> SessionId {
    let mut hasher = Sha256::new();
    for part in [harness.as_bytes(), native_session_id.as_bytes(), source_sha256.as_slice()] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    SessionId(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(h: &str, n: &str, s: u8) -> SessionId {
        session_id(h, n, &[s; 32])
    }

    #[test]
    fn same_tuple_same_id() {
        assert_eq!(sid("pi", "agent-1", 1), sid("pi", "agent-1", 1));
    }

    #[test]
    fn cross_harness_same_native_id_differs() {
        assert_ne!(sid("pi", "agent-1", 1), sid("claude", "agent-1", 1));
    }

    #[test]
    fn different_source_differs() {
        assert_ne!(sid("pi", "agent-1", 1), sid("pi", "agent-1", 2));
    }

    #[test]
    fn different_native_id_differs() {
        assert_ne!(sid("pi", "agent-1", 1), sid("pi", "agent-2", 1));
    }

    #[test]
    fn length_prefix_prevents_boundary_ambiguity() {
        // Without length-prefixing, ("h","ab") and ("ha","b") both reduce to
        // the byte string "hab" and would collide. With it, they must differ.
        assert_ne!(session_id("h", "ab", &[0u8; 32]), session_id("ha", "b", &[0u8; 32]));
    }
}
