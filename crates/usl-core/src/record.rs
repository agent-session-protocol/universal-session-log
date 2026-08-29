//! The engine's record model. `Record` is the public write-side type (no seq:
//! the store assigns it); `StoredRecord` is what is actually framed on disk.

use crate::identity::SessionId;
use serde::{Deserialize, Serialize};

/// A record to append. `seq` is assigned by the store and is not part of this
/// type — the caller never supplies it, so it can never conflict.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub session_id: SessionId,
    /// Opaque record kind tag. The canonical layer assigns semantics; the
    /// engine only stores it (and may later use it to prune indexes).
    pub kind: u8,
    /// Wall-clock timestamp in milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// Opaque payload bytes (e.g. a serialized canonical event).
    pub body: Vec<u8>,
}

/// The on-disk record: a `Record` plus its assigned monotonic `seq`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredRecord {
    pub seq: u64,
    pub session_id: SessionId,
    pub kind: u8,
    pub ts_ms: u64,
    pub body: Vec<u8>,
}

impl Record {
    pub fn new(session_id: SessionId, kind: u8, ts_ms: u64, body: Vec<u8>) -> Self {
        Record { session_id, kind, ts_ms, body }
    }
}

impl StoredRecord {
    pub fn from_record(seq: u64, rec: &Record) -> Self {
        StoredRecord {
            seq,
            session_id: rec.session_id,
            kind: rec.kind,
            ts_ms: rec.ts_ms,
            body: rec.body.clone(),
        }
    }

    /// Serialize to the exact payload bytes that get framed on disk.
    pub fn encode(&self) -> Result<Vec<u8>, crate::error::Error> {
        postcard::to_allocvec(self).map_err(|e| crate::error::Error::Schema(e.to_string()))
    }

    pub fn record(&self) -> Record {
        Record {
            session_id: self.session_id,
            kind: self.kind,
            ts_ms: self.ts_ms,
            body: self.body.clone(),
        }
    }
}
