//! File-boundary live capture: follow a file's growth.
//!
//! This is the FUSE-less replacement for `write()` interception. A harness
//! appends to its session log in arbitrary chunks; [`FileFollower::poll`]
//! returns the bytes appended since the last poll, and the caller feeds them
//! into [`crate::capture::CaptureSession::write`]. Line framing across chunk
//! boundaries is handled by the [`crate::framer::Framer`] downstream, so the
//! follower itself is just "new bytes, in order, no gaps".

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum FollowError {
    Io(std::io::Error),
}

impl std::fmt::Display for FollowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FollowError::Io(e) => write!(f, "follow io error: {e}"),
        }
    }
}

impl std::error::Error for FollowError {}

impl From<std::io::Error> for FollowError {
    fn from(e: std::io::Error) -> Self {
        FollowError::Io(e)
    }
}

pub struct FileFollower {
    path: PathBuf,
    offset: u64,
}

impl FileFollower {
    /// Follow from the current end of the file (only future appends).
    pub fn tail(path: impl AsRef<Path>) -> Result<Self, FollowError> {
        let path = path.as_ref().to_path_buf();
        let offset = File::open(&path)?.metadata()?.len();
        Ok(FileFollower { path, offset })
    }

    /// Follow from the start (replay existing content, then future appends).
    pub fn from_start(path: impl AsRef<Path>) -> Result<Self, FollowError> {
        Ok(FileFollower { path: path.as_ref().to_path_buf(), offset: 0 })
    }

    /// Read bytes appended since the last poll. Returns an empty vec when
    /// nothing new arrived. If the file shrank below our offset (truncation /
    /// rotation / compaction), resets to the start and replays.
    pub fn poll(&mut self) -> Result<Vec<u8>, FollowError> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            self.offset = 0; // truncation detected
        }
        if self.offset >= len {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        file.read_to_end(&mut buf)?;
        self.offset = len;
        Ok(buf)
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }
}
