//! Shared implementation for the compatible stdio engine and the local daemon.

pub mod daemon;
pub mod index;
pub mod model;
pub mod provider;

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const RPC_VERSION: &str = "sesdb.engine/v1";
pub const LOCAL_API_VERSION: &str = "sesdb.local/v1";

pub fn canonical_session_id(provider: &str, native_session_id: &str) -> String {
    digest_parts(&[provider.as_bytes(), native_session_id.as_bytes()])
}

pub fn event_id(parts: &[&[u8]]) -> String {
    digest_parts(parts)
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    hex::encode(hash.finalize())
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub home: PathBuf,
    pub log: PathBuf,
    pub sqlite: PathBuf,
    pub config: PathBuf,
    pub descriptor: PathBuf,
}

impl Paths {
    pub fn under(home: impl AsRef<Path>) -> Self {
        let home = home.as_ref().to_path_buf();
        Self {
            log: home.join("sesdb.usl"),
            sqlite: home.join("sesdb.sqlite"),
            config: home.join("config.json"),
            descriptor: home.join("run/daemon.json"),
            home,
        }
    }

    pub fn default_home() -> Self {
        let root = std::env::var_os("SESDB_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                home.join(".sesdb")
            });
        Self::under(root)
    }
}
