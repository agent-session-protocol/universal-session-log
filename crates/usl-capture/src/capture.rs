//! Capture session: framed lines → records in a [`usl_core::Store`].

use std::time::{SystemTime, UNIX_EPOCH};

use usl_core::{Record, SessionId, Store};

use crate::framer::{FrameError, Framer};

/// Record `kind` for a session-header record (provenance, once per capture).
pub const KIND_SESSION_HEADER: u8 = 0;
/// Record `kind` for one raw JSONL line.
pub const KIND_RAW_LINE: u8 = 1;

/// Safety cap for a buffered partial line (a runaway write with no newline).
pub const DEFAULT_MAX_LINE: usize = 256 * 1024 * 1024; // 256 MiB

#[derive(Debug)]
pub enum Error {
    Core(usl_core::Error),
    Frame(FrameError),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Core(e) => write!(f, "usl-core error: {e}"),
            Error::Frame(e) => write!(f, "frame error: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Core(e) => Some(e),
            Error::Frame(e) => Some(e),
        }
    }
}

impl From<usl_core::Error> for Error {
    fn from(e: usl_core::Error) -> Self {
        Error::Core(e)
    }
}

impl From<FrameError> for Error {
    fn from(e: FrameError) -> Self {
        Error::Frame(e)
    }
}

/// One live capture into a store. Owns the store; the caller decides the
/// session identity (`session_id`), which for a live stream cannot include a
/// full `source_sha256` (unknown until the stream ends) — see the research
/// doc's open questions on live-capture identity.
pub struct CaptureSession {
    store: Store,
    session_id: SessionId,
    harness: String,
    native_session_id: String,
    framer: Framer,
    line_count: u64,
}

impl CaptureSession {
    /// Begin a capture. Emits a `KIND_SESSION_HEADER` record carrying the
    /// harness + native session id provenance (the canonical layer uses this
    /// to pick its parser). Fails if the store cannot be appended.
    pub fn start(
        store: Store,
        session_id: SessionId,
        harness: &str,
        native_session_id: &str,
    ) -> Result<Self, Error> {
        let now = now_ms();
        let header = serde_json::json!({
            "harness": harness,
            "native_session_id": native_session_id,
            "started_at_ms": now,
        })
        .to_string()
        .into_bytes();

        let mut session = CaptureSession {
            store,
            session_id,
            harness: harness.to_string(),
            native_session_id: native_session_id.to_string(),
            framer: Framer::new(DEFAULT_MAX_LINE),
            line_count: 0,
        };
        session
            .store
            .append(&Record::new(session.session_id, KIND_SESSION_HEADER, now, header))?;
        Ok(session)
    }

    /// Feed a `write()` payload. Returns the number of non-empty lines
    /// appended as records (empty/whitespace-only lines are skipped).
    pub fn write(&mut self, bytes: &[u8]) -> Result<usize, Error> {
        let lines = self.framer.feed(bytes)?;
        let mut appended = 0;
        for line in lines {
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            self.store
                .append(&Record::new(self.session_id, KIND_RAW_LINE, now_ms(), line))?;
            self.line_count += 1;
            appended += 1;
        }
        Ok(appended)
    }

    /// Flush the trailing partial line (if any) and fsync the store.
    /// Returns the total number of lines captured.
    pub fn finish(&mut self) -> Result<u64, Error> {
        if let Some(partial) = self.framer.finish() {
            if !partial.iter().all(|b| b.is_ascii_whitespace()) {
                self.store
                    .append(&Record::new(self.session_id, KIND_RAW_LINE, now_ms(), partial))?;
                self.line_count += 1;
            }
        }
        self.store.flush()?;
        Ok(self.line_count)
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub fn harness(&self) -> &str {
        &self.harness
    }

    pub fn native_session_id(&self) -> &str {
        &self.native_session_id
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
