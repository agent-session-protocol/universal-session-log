use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const KIND_EVIDENCE: u8 = 0xF0;
pub const KIND_CANONICAL_EVENT: u8 = 0xF1;
pub const KIND_SOURCE_CHECKPOINT: u8 = 0xF2;
pub const KIND_VISIBILITY: u8 = 0xF3;
pub const KIND_MEMORY: u8 = 0xF4;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEvidence {
    pub version: u8,
    pub provider: String,
    pub source_path: String,
    pub source_generation: u64,
    pub byte_start: u64,
    pub byte_end: u64,
    pub sha256: String,
    pub raw: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEventBody {
    pub version: u8,
    pub provider: String,
    pub native_session_id: String,
    pub source_path: String,
    pub source_generation: u64,
    pub event_id: String,
    pub native_identity: String,
    pub entity_revision: u64,
    pub event: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Value>,
    pub evidence_seqs: Vec<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheckpoint {
    pub version: u8,
    pub provider: String,
    pub source_path: String,
    pub generation: u64,
    pub committed_offset: u64,
    pub snapshot_length: u64,
    pub chunks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityControl {
    pub version: u8,
    pub action: VisibilityAction,
    pub provider: String,
    pub source_path: String,
    pub source_generation: u64,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisibilityAction {
    Supersede,
    Retract,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub version: u8,
    pub memory_id: String,
    pub action: MemoryAction,
    pub content: String,
    pub scope: Value,
    pub evidence_seqs: Vec<u64>,
    pub revision: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryAction {
    Candidate,
    Approve,
    Revoke,
}
