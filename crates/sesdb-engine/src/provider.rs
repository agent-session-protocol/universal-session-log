use crate::{canonical_session_id, event_id};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Cursor;
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
    Pi,
    Kimi,
    Deepseek,
}

impl ProviderKind {
    pub const ALL: [Self; 5] = [
        Self::Claude,
        Self::Codex,
        Self::Pi,
        Self::Kimi,
        Self::Deepseek,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Kimi => "kimi",
            Self::Deepseek => "deepseek",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "pi" => Some(Self::Pi),
            "kimi" => Some(Self::Kimi),
            "deepseek" | "dsh" | "deepseek-harness" => Some(Self::Deepseek),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArtifact {
    pub logical_path: String,
    pub path: PathBuf,
    pub role: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WatchTarget {
    Tree { path: PathBuf },
    ExactFile { path: PathBuf },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUnit {
    pub provider: &'static str,
    pub id: String,
    /// Stable checkpoint identity. For one-file providers this is the exact file path.
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
    pub artifacts: Vec<SourceArtifact>,
    pub watch_targets: Vec<WatchTarget>,
}

#[derive(Clone, Debug)]
pub struct SnapshotArtifact {
    pub source: SourceArtifact,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct SourceSnapshot {
    pub unit: SourceUnit,
    pub artifacts: Vec<SnapshotArtifact>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSpan {
    pub logical_path: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub status: &'static str,
    pub source_units: &'static str,
    pub watch_mode: &'static str,
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
    pub evidence_spans: Vec<EvidenceSpan>,
    pub entity_revision: u64,
    pub event: Value,
}

pub trait ProviderAdapter: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn discover(&self, roots: &[PathBuf]) -> Result<Vec<SourceUnit>, String> {
        discover(self.kind(), roots)
    }
    fn snapshot(&self, source: &SourceUnit) -> Result<SourceSnapshot, String> {
        snapshot_unit(source)
    }
    fn parse(
        &self,
        snapshot: &SourceSnapshot,
        from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let artifact = snapshot
            .artifacts
            .first()
            .ok_or("source snapshot has no artifacts")?;
        let mut events =
            self.parse_snapshot(&artifact.source.path, &artifact.bytes, from_offset)?;
        for event in &mut events {
            if event.evidence_spans.is_empty() {
                event.evidence_spans.push(EvidenceSpan {
                    logical_path: artifact.source.logical_path.clone(),
                    byte_start: event.byte_start,
                    byte_end: event.byte_end,
                    sha256: event_digest(event),
                });
            }
        }
        Ok(events)
    }
    fn parse_snapshot(
        &self,
        path: &Path,
        snapshot: &[u8],
        from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String>;
    fn watch_targets(&self, roots: &[PathBuf]) -> Vec<WatchTarget> {
        roots
            .iter()
            .cloned()
            .map(|path| WatchTarget::Tree { path })
            .collect()
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            status: "ready",
            source_units: "multi-artifact",
            watch_mode: "typed",
        }
    }
}

pub struct ClaudeAdapter;
pub struct CodexAdapter;
pub struct PiAdapter;
pub struct KimiAdapter;
pub struct DeepseekAdapter;

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
                evidence_spans: Vec::new(),
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
                evidence_spans: Vec::new(),
                entity_revision: 1,
                event,
            });
        }
        Ok(output)
    }
}

impl ProviderAdapter for PiAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Pi
    }

    fn parse_snapshot(
        &self,
        path: &Path,
        snapshot: &[u8],
        from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let lines = complete_lines(snapshot)?;
        let native_session_id = lines
            .iter()
            .find(|line| string_at(&line.value, &["type"]).as_deref() == Some("session"))
            .and_then(|line| string_at(&line.value, &["id"]))
            .or_else(|| {
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "unknown".into());
        let mut output = Vec::new();
        for line in lines {
            if line.end <= from_offset {
                continue;
            }
            let kind = string_at(&line.value, &["type"]).unwrap_or_else(|| "unknown".into());
            let identity =
                string_at(&line.value, &["id"]).unwrap_or_else(|| format!("{kind}:{}", line.start));
            let timestamp_ms = timestamp(&line.value);
            let event_type = match kind.as_str() {
                "session" => "session.started",
                "message" => match string_at(&line.value, &["message", "role"]).as_deref() {
                    Some("toolResult") => "tool.completed",
                    _ => "message.created",
                },
                "model_change" => "model.changed",
                "thinking_level_change" => "reasoning.level.changed",
                _ => "native.event",
            }
            .to_string();
            output.push(ParsedNativeEvent {
                native_session_id: native_session_id.clone(), native_identity: identity,
                event_type: event_type.clone(), timestamp_ms, byte_start: line.start, byte_end: line.end,
                raw: line.raw, evidence_spans: Vec::new(), entity_revision: 1,
                event: json!({"schemaVersion":"1.0","type":event_type,"timestampMs":timestamp_ms,"nativeType":kind,"entry":line.value}),
            });
        }
        Ok(output)
    }
}

impl ProviderAdapter for KimiAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Kimi
    }

    fn parse(
        &self,
        snapshot: &SourceSnapshot,
        _from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let state_artifact = snapshot
            .artifacts
            .iter()
            .find(|artifact| artifact.source.role == "state");
        let state = state_artifact
            .map(|artifact| {
                serde_json::from_slice::<Value>(&artifact.bytes)
                    .map_err(|error| format!("malformed Kimi state.json: {error}"))
            })
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let native_session_id = string_at(&state, &["sessionId"])
            .or_else(|| string_at(&state, &["id"]))
            .or_else(|| {
                Path::new(&snapshot.unit.path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| snapshot.unit.id.clone());
        let parent_by_agent = kimi_agent_parents(&state);
        let mut output = Vec::new();

        if let Some(artifact) = state_artifact {
            let raw = artifact.bytes.clone();
            output.push(ParsedNativeEvent {
                native_session_id: native_session_id.clone(), native_identity: format!("{native_session_id}:state"),
                event_type: "session.metadata".into(), timestamp_ms: kimi_state_timestamp(&state),
                byte_start: 0, byte_end: raw.len() as u64, raw: raw.clone(),
                evidence_spans: vec![evidence_span(&artifact.source.logical_path, 0, raw.len() as u64, &raw)],
                entity_revision: 1,
                event: json!({"schemaVersion":"1.0","type":"session.metadata","nativeType":"kimi.state","state":state}),
            });
        }

        for artifact in snapshot
            .artifacts
            .iter()
            .filter(|artifact| artifact.source.role == "wire")
        {
            let agent_id = kimi_agent_id(&artifact.source.logical_path);
            for line in complete_lines(&artifact.bytes)? {
                let kind = string_at(&line.value, &["type"]).unwrap_or_else(|| "unknown".into());
                let normalized = kind
                    .to_ascii_lowercase()
                    .replace('_', ".")
                    .replace('/', ".");
                let event_type = if normalized.contains("tool") && normalized.contains("result") {
                    "tool.completed"
                } else if normalized.contains("tool")
                    && (normalized.contains("call") || normalized.contains("use"))
                {
                    "tool.called"
                } else if normalized.contains("summary") || normalized.contains("compact") {
                    "session.summary"
                } else if normalized.contains("user")
                    || normalized.contains("assistant")
                    || normalized.contains("message")
                {
                    "message.created"
                } else if normalized.contains("llm.request") {
                    "model.requested"
                } else {
                    "native.event"
                };
                let identity = native_record_identity(&line.value)
                    .unwrap_or_else(|| format!("{agent_id}:{}", line.start));
                let timestamp_ms = timestamp(&line.value);
                let raw = line.raw;
                output.push(ParsedNativeEvent {
                    native_session_id: native_session_id.clone(), native_identity: format!("{agent_id}:{identity}"),
                    event_type: event_type.into(), timestamp_ms, byte_start: line.start, byte_end: line.end,
                    evidence_spans: vec![evidence_span(&artifact.source.logical_path, line.start, line.end, &raw)],
                    raw, entity_revision: 1,
                    event: json!({"schemaVersion":"1.0","type":event_type,"timestampMs":timestamp_ms,"nativeType":kind,"agentId":agent_id,"parentAgentId":parent_by_agent.get(&agent_id),"entry":line.value}),
                });
            }
        }
        output.sort_by(|a, b| {
            a.timestamp_ms
                .cmp(&b.timestamp_ms)
                .then_with(|| a.native_identity.cmp(&b.native_identity))
        });
        Ok(output)
    }

    fn parse_snapshot(
        &self,
        _path: &Path,
        _snapshot: &[u8],
        _from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        Err("Kimi requires a multi-artifact SourceSnapshot".into())
    }
}

impl ProviderAdapter for DeepseekAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Deepseek
    }

    fn parse(
        &self,
        snapshot: &SourceSnapshot,
        _from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let artifact = snapshot
            .artifacts
            .first()
            .ok_or("DeepSeek snapshot has no artifact")?;
        let logical = if artifact.source.path.to_string_lossy().ends_with(".zstd") {
            zstd::stream::decode_all(Cursor::new(&artifact.bytes))
                .map_err(|error| format!("cannot decompress DeepSeek session: {error}"))?
        } else {
            artifact.bytes.clone()
        };
        self.parse_dsh_log(&artifact.source.logical_path, &logical)
    }

    fn parse_snapshot(
        &self,
        path: &Path,
        snapshot: &[u8],
        _from_offset: u64,
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        self.parse_dsh_log(&path.to_string_lossy(), snapshot)
    }
}

impl DeepseekAdapter {
    fn parse_dsh_log(
        &self,
        logical_path: &str,
        bytes: &[u8],
    ) -> Result<Vec<ParsedNativeEvent>, String> {
        let lines = complete_lines(bytes)?;
        let header = lines.first().ok_or("DeepSeek session log is empty")?;
        if string_at(&header.value, &["type"]).as_deref() != Some("session") {
            return Err("DeepSeek session log has no header record".into());
        }
        let native_session_id =
            string_at(&header.value, &["id"]).ok_or("DeepSeek session header has no id")?;
        let header_timestamp_ms = timestamp(&header.value);
        let mut output = Vec::new();
        let mut chunks: BTreeMap<String, DshChunkAssembly> = BTreeMap::new();
        for line in lines {
            let expanded = expand_dsh_record(&line.value);
            for (sub_index, entry) in expanded.into_iter().enumerate() {
                let kind = string_at(&entry, &["type"]).unwrap_or_else(|| "unknown".into());
                let data = entry.get("data").cloned().unwrap_or(Value::Null);
                if kind == "assistant/chunk" {
                    let chunk = data.get("chunk").cloned().unwrap_or_else(|| data.clone());
                    let key = string_at(&entry, &["messageId"])
                        .or_else(|| string_at(&data, &["messageId"]))
                        .unwrap_or_else(|| "current".into());
                    chunks.entry(key).or_default().apply(&chunk);
                }
                let timestamp_ms = timestamp(&entry).max(header_timestamp_ms);
                let event_type = dsh_event_type(&kind);
                let call_id = string_at(&data, &["callId"])
                    .or_else(|| string_at(&data, &["message", "source", "callId"]))
                    .or_else(|| {
                        data.pointer("/message/content/0/toolCallId")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    });
                let identity = native_record_identity(&entry)
                    .or(call_id.clone())
                    .unwrap_or_else(|| format!("{}:{sub_index}", line.start));
                let raw = line.raw.clone();
                output.push(ParsedNativeEvent {
                    native_session_id: native_session_id.clone(), native_identity: identity,
                    event_type: event_type.into(), timestamp_ms, byte_start: line.start, byte_end: line.end,
                    evidence_spans: vec![evidence_span(logical_path, line.start, line.end, &raw)], raw,
                    entity_revision: 1,
                    event: json!({"schemaVersion":"1.0","type":event_type,"timestampMs":timestamp_ms,"nativeType":kind,"callId":call_id,"entry":entry}),
                });
            }
        }
        for (message_id, assembly) in chunks {
            if assembly.is_empty() {
                continue;
            }
            output.push(ParsedNativeEvent {
                native_session_id: native_session_id.clone(), native_identity: format!("chunk-message:{message_id}"),
                event_type: "message.partial".into(), timestamp_ms: 0, byte_start: 0, byte_end: bytes.len() as u64,
                evidence_spans: vec![evidence_span(logical_path, 0, bytes.len() as u64, bytes)], raw: Vec::new(), entity_revision: 1,
                event: json!({"schemaVersion":"1.0","type":"message.partial","nativeType":"dsh.chunk-assembly","messageId":message_id,"content":assembly.content()}),
            });
        }
        Ok(output)
    }
}

pub fn adapter(kind: ProviderKind) -> Box<dyn ProviderAdapter> {
    match kind {
        ProviderKind::Claude => Box::new(ClaudeAdapter),
        ProviderKind::Codex => Box::new(CodexAdapter),
        ProviderKind::Pi => Box::new(PiAdapter),
        ProviderKind::Kimi => Box::new(KimiAdapter),
        ProviderKind::Deepseek => Box::new(DeepseekAdapter),
    }
}

pub fn discover(kind: ProviderKind, roots: &[PathBuf]) -> Result<Vec<SourceUnit>, String> {
    if kind == ProviderKind::Kimi {
        return discover_kimi(roots);
    }
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
            if !entry.file_type().is_file() || !provider_file_matches(kind, entry.path()) {
                continue;
            }
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                .map(|v| v.as_millis() as u64)
                .unwrap_or(0);
            let path = entry.path().to_path_buf();
            let path_text = path.to_string_lossy().into_owned();
            let logical_path = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("source.native")
                .to_owned();
            let artifact = SourceArtifact {
                logical_path,
                path: path.clone(),
                role: provider_artifact_role(kind).into(),
                size: metadata.len(),
                modified_ms,
            };
            output.push(SourceUnit {
                provider: kind.name(),
                id: path_text.clone(),
                path: path_text,
                size: metadata.len(),
                modified_ms,
                artifacts: vec![artifact],
                watch_targets: vec![WatchTarget::ExactFile { path }],
            });
        }
    }
    output.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(output)
}

fn provider_file_matches(kind: ProviderKind, path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match kind {
        ProviderKind::Deepseek => name.ends_with(".jsonl.zstd") || name.ends_with(".jsonl"),
        ProviderKind::Claude | ProviderKind::Codex | ProviderKind::Pi => name.ends_with(".jsonl"),
        ProviderKind::Kimi => false,
    }
}

fn provider_artifact_role(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Claude | ProviderKind::Pi => "session-log",
        ProviderKind::Codex => "rollout-log",
        ProviderKind::Deepseek => "compressed-session-log",
        ProviderKind::Kimi => "wire",
    }
}

fn discover_kimi(roots: &[PathBuf]) -> Result<Vec<SourceUnit>, String> {
    let mut groups: BTreeMap<PathBuf, Vec<SourceArtifact>> = BTreeMap::new();
    let mut state_dirs = Vec::new();
    let mut wires = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_str().unwrap_or_default();
            if name == "state.json" {
                state_dirs.push(entry.path().parent().unwrap_or(root).to_path_buf());
            } else if name == "wire.jsonl" {
                wires.push(entry.path().to_path_buf());
            }
        }
    }
    state_dirs.sort();
    state_dirs.dedup();
    for dir in &state_dirs {
        let path = dir.join("state.json");
        groups
            .entry(dir.clone())
            .or_default()
            .push(source_artifact(&path, dir, "state")?);
    }
    for wire in wires {
        let unit = state_dirs
            .iter()
            .filter(|dir| wire.starts_with(dir))
            .max_by_key(|dir| dir.components().count())
            .cloned()
            .unwrap_or_else(|| {
                wire.parent()
                    .and_then(Path::parent)
                    .and_then(Path::parent)
                    .unwrap_or_else(|| wire.parent().unwrap_or(Path::new(".")))
                    .to_path_buf()
            });
        groups
            .entry(unit.clone())
            .or_default()
            .push(source_artifact(&wire, &unit, "wire")?);
    }
    let mut output = Vec::new();
    for (path, mut artifacts) in groups {
        artifacts.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
        let size = artifacts.iter().map(|artifact| artifact.size).sum();
        let modified_ms = artifacts
            .iter()
            .map(|artifact| artifact.modified_ms)
            .max()
            .unwrap_or(0);
        let path_text = path.to_string_lossy().into_owned();
        let watch_targets = artifacts
            .iter()
            .map(|artifact| WatchTarget::ExactFile {
                path: artifact.path.clone(),
            })
            .collect();
        output.push(SourceUnit {
            provider: "kimi",
            id: path_text.clone(),
            path: path_text,
            size,
            modified_ms,
            artifacts,
            watch_targets,
        });
    }
    Ok(output)
}

fn source_artifact(path: &Path, root: &Path, role: &str) -> Result<SourceArtifact, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    let logical_path = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(SourceArtifact {
        logical_path,
        path: path.to_path_buf(),
        role: role.into(),
        size: metadata.len(),
        modified_ms,
    })
}

pub fn snapshot_unit(source: &SourceUnit) -> Result<SourceSnapshot, String> {
    let mut artifacts = Vec::new();
    for artifact in &source.artifacts {
        artifacts.push(SnapshotArtifact {
            source: artifact.clone(),
            bytes: snapshot(&artifact.path)?,
        });
    }
    Ok(SourceSnapshot {
        unit: source.clone(),
        artifacts,
    })
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

fn evidence_span(logical_path: &str, byte_start: u64, byte_end: u64, raw: &[u8]) -> EvidenceSpan {
    EvidenceSpan {
        logical_path: logical_path.into(),
        byte_start,
        byte_end,
        sha256: hex::encode(Sha256::digest(raw)),
    }
}

fn native_record_identity(value: &Value) -> Option<String> {
    for path in [
        &["id"][..],
        &["uuid"][..],
        &["eventId"][..],
        &["messageId"][..],
        &["callId"][..],
        &["data", "id"][..],
        &["data", "message", "id"][..],
        &["data", "callId"][..],
    ] {
        if let Some(value) = string_at(value, path) {
            return Some(value);
        }
    }
    value
        .get("seq")
        .and_then(Value::as_u64)
        .map(|seq| format!("seq:{seq}"))
}

fn kimi_agent_id(logical_path: &str) -> String {
    let components = logical_path.split('/').collect::<Vec<_>>();
    components
        .windows(2)
        .find(|parts| parts[1] == "wire.jsonl")
        .map(|parts| parts[0].to_owned())
        .unwrap_or_else(|| "main".into())
}

fn kimi_agent_parents(state: &Value) -> BTreeMap<String, String> {
    let mut output = BTreeMap::new();
    if let Some(agents) = state.get("agents").and_then(Value::as_object) {
        for (id, value) in agents {
            if let Some(parent) =
                string_at(value, &["parentAgentId"]).or_else(|| string_at(value, &["parentId"]))
            {
                output.insert(id.clone(), parent);
            }
        }
    } else if let Some(agents) = state.get("agents").and_then(Value::as_array) {
        for value in agents {
            if let (Some(id), Some(parent)) = (
                string_at(value, &["id"]),
                string_at(value, &["parentAgentId"]).or_else(|| string_at(value, &["parentId"])),
            ) {
                output.insert(id, parent);
            }
        }
    }
    output
}

fn kimi_state_timestamp(state: &Value) -> u64 {
    for key in ["updatedAt", "createdAt"] {
        if let Some(value) = state.get(key) {
            if let Some(number) = value.as_u64() {
                return number;
            }
            if let Some(parsed) = value.as_str().and_then(parse_timestamp_ms) {
                return parsed;
            }
        }
    }
    0
}

#[derive(Default)]
struct DshChunkAssembly {
    text: String,
    reasoning: String,
    tool_arguments: BTreeMap<String, String>,
}
impl DshChunkAssembly {
    fn apply(&mut self, chunk: &Value) {
        let kind = string_at(chunk, &["type"]).unwrap_or_default();
        let delta = string_at(chunk, &["text"])
            .or_else(|| string_at(chunk, &["delta"]))
            .unwrap_or_default();
        match kind.as_str() {
            "text-delta" => self.text.push_str(&delta),
            "reasoning-delta" => self.reasoning.push_str(&delta),
            "tool-call-delta" => {
                let id = string_at(chunk, &["id"])
                    .or_else(|| string_at(chunk, &["callId"]))
                    .unwrap_or_else(|| "unknown".into());
                self.tool_arguments
                    .entry(id)
                    .or_default()
                    .push_str(&string_at(chunk, &["arguments"]).unwrap_or(delta));
            }
            _ => {}
        }
    }
    fn is_empty(&self) -> bool {
        self.text.is_empty() && self.reasoning.is_empty() && self.tool_arguments.is_empty()
    }
    fn content(&self) -> Value {
        let mut blocks = Vec::new();
        if !self.reasoning.is_empty() {
            blocks.push(json!({"type":"reasoning","text":self.reasoning}));
        }
        if !self.text.is_empty() {
            blocks.push(json!({"type":"text","text":self.text}));
        }
        for (id, arguments) in &self.tool_arguments {
            blocks.push(json!({"type":"tool-call","id":id,"arguments":arguments}));
        }
        Value::Array(blocks)
    }
}

fn expand_dsh_record(value: &Value) -> Vec<Value> {
    let kind = string_at(value, &["type"]).unwrap_or_default();
    if !kind.ends_with("-chunks") {
        return vec![value.clone()];
    }
    let Some(chunks) = value
        .pointer("/data/chunks")
        .or_else(|| value.get("chunks"))
        .and_then(Value::as_array)
    else {
        return vec![value.clone()];
    };
    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let mut expanded = value.clone();
            if let Some(object) = expanded.as_object_mut() {
                object.insert("type".into(), Value::String("assistant/chunk".into()));
                object.insert("data".into(), json!({"chunk":chunk,"packedIndex":index}));
            }
            expanded
        })
        .collect()
}

fn dsh_event_type(kind: &str) -> &'static str {
    match kind {
        "session" => "session.started",
        "user/message" | "assistant/message" => "message.created",
        "assistant/chunk" => "message.chunk",
        "tool/call" => "tool.called",
        "tool/result" => "tool.completed",
        "turn/start" => "turn.started",
        "turn/end" => "turn.completed",
        "compaction/summary" => "session.summary",
        _ => "native.event",
    }
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
