//! In-memory index: session → its frames' locations, rebuilt on open by
//! replaying the log. Derived state only; the log is the source of truth.

use std::collections::HashMap;

use crate::identity::SessionId;

/// Location + identity of one framed record on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameMeta {
    pub seq: u64,
    /// Byte offset of the frame's `[len]` field.
    pub offset: u64,
    pub payload_len: u32,
}

/// `session_id → [FrameMeta]` in append order (hence ascending seq).
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct Index {
    by_session: HashMap<SessionId, Vec<FrameMeta>>,
}

impl Index {
    /// Insert a frame meta. Returns `true` if this is the first frame seen for
    /// that session (so callers can count distinct sessions).
    pub fn push(&mut self, session: SessionId, meta: FrameMeta) -> bool {
        let list = self.by_session.entry(session).or_default();
        let is_new = list.is_empty();
        list.push(meta);
        is_new
    }

    pub fn frames(&self, session: &SessionId) -> Option<&[FrameMeta]> {
        self.by_session.get(session).map(|v| v.as_slice())
    }

    pub fn sessions(&self) -> impl Iterator<Item = &SessionId> {
        self.by_session.keys()
    }

    pub fn session_count(&self) -> u64 {
        self.by_session.len() as u64
    }

    pub fn total_frames(&self) -> u64 {
        self.by_session.values().map(|v| v.len() as u64).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.by_session.is_empty()
    }
}
