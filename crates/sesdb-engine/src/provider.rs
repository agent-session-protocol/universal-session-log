use crate::{canonical_session_id, event_id};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

pub const CHUNK_SIZE: usize = 64 * 1024;
pub const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Claude,
    Codex,
}

impl ProviderKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSource {
    pub provider: &'static str,
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ParsedNativeEvent {
    pub native_session_id: String,
    pub native_identity: String,
    pub event_type: String,
    pub timestamp_ms: u64,
    pub byte_start: u64,
    pub byte_end: u64,
    pub raw: Vec<u8>,
    pub entity_revision: u64,
    pub event: Value,
}

pub trait ProviderAdapter: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn discover(&self, roots: &[PathBuf]) -> Result<Vec<DiscoveredSource>, String> {
        discover(self.kind(), roots)
    }
    fn parse_snapshot(
        &self,
        path: &Path,
        snapshot: &[u8],
        from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String>;
    fn watch_targets(&self, roots: &[PathBuf]) -> Vec<PathBuf> {
        roots.to_vec()
    }
    fn health(&self) -> Value {
        json!({"status":"ready"})
    }
}

pub struct ClaudeAdapter;
pub struct CodexAdapter;

impl ProviderAdapter for ClaudeAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Claude
    }
    fn parse_snapshot(
        &self,
        _path: &Path,
        snapshot: &[u8],
        from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let lines = complete_lines(snapshot)?;
        let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
        let mut revisions: HashMap<String, u64> = HashMap::new();
        let mut output = Vec::new();
        for line in lines {
            let entry = line.value;
            let native_session_id = string_at(&entry, &["sessionId"])
                .ok_or_else(|| format!("Claude entry at {} has no sessionId", line.start))?;
            let kind = string_at(&entry, &["type"]).unwrap_or_else(|| "unknown".into());
            let timestamp_ms = timestamp(&entry);
            let uuid =
                string_at(&entry, &["uuid"]).unwrap_or_else(|| format!("offset:{}", line.start));
            let (identity, revision, event) = if kind == "assistant" {
                let message_id =
                    string_at(&entry, &["message", "id"]).unwrap_or_else(|| uuid.clone());
                let content = entry
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                groups
                    .entry(message_id.clone())
                    .or_default()
                    .extend(content);
                let revision = revisions.entry(message_id.clone()).or_insert(0);
                *revision += 1;
                let mut message = entry.get("message").cloned().unwrap_or_else(|| json!({}));
                if let Some(object) = message.as_object_mut() {
                    object.insert("content".into(), Value::Array(groups[&message_id].clone()));
                }
                (
                    message_id.clone(),
                    *revision,
                    json!({"schemaVersion":"1.0","type":"message.created","timestampMs":timestamp_ms,"nativeType":kind,"message":message,"uuid":uuid,"parentUuid":entry.get("parentUuid"),"isSidechain":entry.get("isSidechain")}),
                )
            } else {
                (
                    uuid.clone(),
                    1,
                    json!({"schemaVersion":"1.0","type":claude_event_type(&kind),"timestampMs":timestamp_ms,"nativeType":kind,"entry":entry}),
                )
            };
            if line.end <= from_offset {
                continue;
            }
            output.push(ParsedNativeEvent {
                native_session_id,
                native_identity: identity,
                event_type: event["type"].as_str().unwrap_or("native.event").into(),
                timestamp_ms,
                byte_start: line.start,
                byte_end: line.end,
                raw: line.raw,
                entity_revision: revision,
                event,
            });
        }
        Ok(output)
    }
}

impl ProviderAdapter for CodexAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }
    fn parse_snapshot(
        &self,
        path: &Path,
        snapshot: &[u8],
        from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let lines = complete_lines(snapshot)?;
        let mut native_session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let mut turn_context = Value::Null;
        let mut output = Vec::new();
        for line in lines {
            let entry = line.value;
            let kind = string_at(&entry, &["type"]).unwrap_or_default();
            if kind == "session_meta" {
                if let Some(id) = string_at(&entry, &["payload", "id"]) {
                    native_session_id = id;
                }
            }
            if kind == "turn_context" {
                turn_context = entry.get("payload").cloned().unwrap_or(Value::Null);
                continue;
            }
            // response_item is authoritative. These two lifecycle records carry
            // information not duplicated by the UI event stream.
            let payload = entry.get("payload").cloned().unwrap_or(Value::Null);
            let native_type = payload.get("type").and_then(Value::as_str).unwrap_or(&kind);
            let lifecycle =
                kind == "event_msg" && matches!(native_type, "token_count" | "turn_aborted");
            if !(kind == "response_item"
                || lifecycle
                || matches!(kind.as_str(), "token_count" | "turn_aborted"))
                || line.end <= from_offset
            {
                continue;
            }
            let identity = payload
                .get("id")
                .or_else(|| payload.get("call_id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:{}", kind, line.start));
            let timestamp_ms = timestamp(&entry);
            let event_type = codex_event_type(native_type).to_string();
            let event = json!({"schemaVersion":"1.0","type":event_type,"timestampMs":timestamp_ms,"nativeType":native_type,"payload":payload,"turnContext":turn_context});
            output.push(ParsedNativeEvent {
                native_session_id: native_session_id.clone(),
                native_identity: identity,
                event_type,
                timestamp_ms,
                byte_start: line.start,
                byte_end: line.end,
                raw: line.raw,
                entity_revision: 1,
                event,
            });
        }
        Ok(output)
    }
}

pub fn adapter(kind: ProviderKind) -> Box<dyn ProviderAdapter> {
    match kind {
        ProviderKind::Claude => Box::new(ClaudeAdapter),
        ProviderKind::Codex => Box::new(CodexAdapter),
    }
}

pub fn discover(kind: ProviderKind, roots: &[PathBuf]) -> Result<Vec<DiscoveredSource>, String> {
    let mut output = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|v| v.to_str()) != Some("jsonl")
            {
                continue;
            }
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                .map(|v| v.as_millis() as u64)
                .unwrap_or(0);
            output.push(DiscoveredSource {
                provider: kind.name(),
                path: entry.path().to_string_lossy().into_owned(),
                size: metadata.len(),
                modified_ms,
            });
        }
    }
    output.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(output)
}

pub fn snapshot(path: &Path) -> Result<Vec<u8>, String> {
    let length = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if length > MAX_SOURCE_BYTES {
        return Err(format!("source exceeds {MAX_SOURCE_BYTES} bytes"));
    }
    let mut bytes = fs::read(path).map_err(|e| e.to_string())?;
    bytes.truncate(length as usize); // fixed length even if the file grows during read
    Ok(bytes)
}

pub fn complete_offset(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0)
}

pub fn fingerprints(bytes: &[u8]) -> Vec<String> {
    bytes
        .chunks(CHUNK_SIZE)
        .map(|chunk| hex::encode(Sha256::digest(chunk)))
        .collect()
}

pub fn is_append(previous_length: u64, previous_chunks: &[String], bytes: &[u8]) -> bool {
    if (bytes.len() as u64) < previous_length {
        return false;
    }
    let full_chunks = previous_length as usize / CHUNK_SIZE;
    let now = fingerprints(bytes);
    previous_chunks
        .iter()
        .take(full_chunks)
        .eq(now.iter().take(full_chunks))
        && if previous_length as usize % CHUNK_SIZE == 0 {
            true
        } else {
            let start = full_chunks * CHUNK_SIZE;
            hex::encode(Sha256::digest(&bytes[start..previous_length as usize]))
                == previous_chunks
                    .get(full_chunks)
                    .cloned()
                    .unwrap_or_default()
        }
}

pub fn event_digest(event: &ParsedNativeEvent) -> String {
    hex::encode(Sha256::digest(&event.raw))
}
pub fn canonical_id(provider: ProviderKind, event: &ParsedNativeEvent, generation: u64) -> String {
    let digest = event_digest(event);
    event_id(&[
        provider.name().as_bytes(),
        event.native_session_id.as_bytes(),
        &generation.to_le_bytes(),
        event.native_identity.as_bytes(),
        event.event_type.as_bytes(),
        digest.as_bytes(),
    ])
}
pub fn session_id(provider: ProviderKind, native: &str) -> String {
    canonical_session_id(provider.name(), native)
}

struct Line {
    start: u64,
    end: u64,
    raw: Vec<u8>,
    value: Value,
}
fn complete_lines(snapshot: &[u8]) -> Result<Vec<Line>, String> {
    let end = complete_offset(snapshot);
    let mut output = Vec::new();
    let mut start = 0;
    while start < end {
        let relative = snapshot[start..end]
            .iter()
            .position(|b| *b == b'\n')
            .unwrap();
        let finish = start + relative + 1;
        if finish - start > MAX_LINE_BYTES {
            return Err(format!(
                "JSONL line at byte {start} exceeds {MAX_LINE_BYTES} bytes"
            ));
        }
        let raw = snapshot[start..finish].to_vec();
        if raw.iter().any(|b| !b.is_ascii_whitespace()) {
            let value = serde_json::from_slice(raw.strip_suffix(b"\n").unwrap_or(&raw))
                .map_err(|e| format!("malformed JSONL at byte {start}: {e}"))?;
            output.push(Line {
                start: start as u64,
                end: finish as u64,
                raw,
                value,
            });
        }
        start = finish;
    }
    Ok(output)
}
fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for part in path {
        current = current.get(*part)?;
    }
    current.as_str().map(str::to_owned)
}
fn timestamp(value: &Value) -> u64 {
    string_at(value, &["timestamp"])
        .and_then(|s| parse_timestamp_ms(&s))
        .or_else(|| value.get("timestamp").and_then(Value::as_u64))
        .unwrap_or(0)
}
fn parse_timestamp_ms(value: &str) -> Option<u64> {
    if let Ok(number) = value.parse() {
        return Some(number);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|value| u64::try_from(value.timestamp_millis()).ok())
}
fn claude_event_type(kind: &str) -> &str {
    match kind {
        "user" => "message.created",
        "system" => "system.notice",
        "summary" => "session.summary",
        "custom-title" | "ai-title" => "session.title.updated",
        _ => "native.event",
    }
}
fn codex_event_type(kind: &str) -> &str {
    match kind {
        "message" => "message.created",
        "function_call" | "custom_tool_call" => "tool.called",
        "function_call_output" | "custom_tool_call_output" => "tool.completed",
        "reasoning" => "reasoning.created",
        "token_count" => "usage.updated",
        "turn_aborted" => "turn.aborted",
        _ => "native.event",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_line_is_deferred() {
        assert_eq!(complete_offset(b"{}\n{\"x\":"), 3)
    }
    #[test]
    fn same_size_rewrite_is_not_append() {
        let old = b"one\n";
        assert!(!is_append(old.len() as u64, &fingerprints(old), b"two\n"));
    }
    #[test]
    fn claude_merges_block_append() {
        let input=br#"{"type":"assistant","sessionId":"s","uuid":"u1","message":{"id":"m","content":[{"type":"text","text":"a"}]}}
{"type":"assistant","sessionId":"s","uuid":"u2","message":{"id":"m","content":[{"type":"thinking","thinking":"b","signature":"sig"}]}}
"#;
        let events = ClaudeAdapter
            .parse_snapshot(Path::new("x"), input, 0)
            .unwrap();
        assert_eq!(events[1].entity_revision, 2);
        assert_eq!(
            events[1]
                .event
                .pointer("/message/content/1/signature")
                .and_then(Value::as_str),
            Some("sig")
        );
    }
    #[test]
    fn codex_ignores_ui_double_stream() {
        let input=br#"{"type":"session_meta","payload":{"id":"s"}}
{"type":"turn_context","payload":{"cwd":"/repo","approval_policy":"never"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"duplicate"}}
{"type":"response_item","payload":{"type":"reasoning","id":"m","encrypted_content":"opaque-verbatim"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":42}}}}
{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}
"#;
        let events = CodexAdapter
            .parse_snapshot(Path::new("x"), input, 0)
            .unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(
            events[0].event["payload"]["encrypted_content"],
            "opaque-verbatim"
        );
        assert_eq!(events[0].event["turnContext"]["cwd"], "/repo");
        assert_eq!(events[1].event_type, "usage.updated");
        assert_eq!(events[2].event_type, "turn.aborted");
    }
}
