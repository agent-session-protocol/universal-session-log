use std::fmt;

/// Unified error type for usl-core. Kept free of external error crates so the
/// crate stays a leaf with minimal dependencies.
#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// Structural corruption detected (bad magic, CRC mismatch, torn frame).
    Corrupt(String),
    /// A file written by a newer format version.
    UnsupportedVersion(u16),
    /// Payload failed to (de)serialize: written by a different schema.
    Schema(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "io error: {e}"),
            Error::Corrupt(m) => write!(f, "corrupt: {m}"),
            Error::UnsupportedVersion(v) => write!(f, "unsupported format version {v}"),
            Error::Schema(m) => write!(f, "schema error: {m}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
