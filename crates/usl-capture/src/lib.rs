//! USL capture layer: turn append-only byte streams into framed records.
//!
//! This is the FUSE-agnostic core of live ingestion. A harness appends to its
//! session log in arbitrary `write()` chunks; the [`framer::Framer`] splits
//! those bytes into complete JSONL lines regardless of where the chunk
//! boundaries fall, and [`capture::CaptureSession`] appends each line into a
//! [`usl_core::Store`] as an opaque record.
//!
//! The FUSE mount (a separate crate) is a thin adapter that feeds `write()`
//! payloads into [`CaptureSession::write`] and serves synthesized reads back.

pub mod capture;
pub mod convert;
pub mod follow;
pub mod framer;

pub use capture::{CaptureSession, Error, KIND_RAW_LINE, KIND_SESSION_HEADER};
pub use convert::{ClaudeToPi, ConvertError};
pub use follow::{FileFollower, FollowError};
pub use framer::{Framer, FrameError};
