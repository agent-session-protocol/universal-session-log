//! USL-core: a schema-agnostic, append-only, crash-recoverable session-log
//! storage engine.
//!
//! The engine stores opaque records keyed by a fixed-width content-addressed
//! `SessionId`. It deliberately knows nothing about agent-runner envelopes;
//! the canonical schema is a separate layer that maps onto these records.
//!
//! Correctness comes from the append log alone: every frame carries a length
//! prefix + CRC32, and recovery truncates to the last complete frame. The
//! header is a redundant hint that can be rebuilt from the data region.

pub mod error;
pub mod format;
pub mod identity;
pub mod index;
pub mod record;
pub mod recover;
pub mod store;

pub use error::Error;
pub use identity::{source_sha256, session_id, SessionId};
pub use record::{Record, StoredRecord};
pub use store::{Store, StoreOpts, Verification};
