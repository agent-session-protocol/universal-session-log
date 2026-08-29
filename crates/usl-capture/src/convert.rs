//! Demo-grade canonical-layer slice: claude JSONL → pi JSONL.
//!
//! This is NOT the production canonical layer (which will map onto the full
//! AgentEventEnvelope / usl schema). It is a thin, honest demonstration of the
//! "write path import (claude) + read path export (pi)" at a file boundary:
//! the same block-level mapping that `e-session-convert` does offline, shown
//! here incrementally from a live file.
//!
//! Block mapping (claude → pi):
//!   text → text · thinking(+signature) → thinking(+thinkingSignature)
//!   tool_use → toolCall(arguments=input) · tool_result → toolResult(isError)
//!   user entry carrying tool_result blocks → pi role "toolResult"

use std::collections::HashMap;

use serde_json::{json, Map, Value};

#[derive(Debug)]
pub enum ConvertError {
    /// The line is not valid JSON.
    Json(serde_json::Error),
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvertError::Json(e) => write!(f, "invalid claude line: {e}"),
        }
    }
}

impl std::error::Error for ConvertError {}

impl From<serde_json::Error> for ConvertError {
    fn from(e: serde_json::Error) -> Self {
        ConvertError::Json(e)
    }
}

pub struct ClaudeToPi {
    last_id: Option<String>,
    id_by_uuid: HashMap<String, String>,
    pub loss: Vec<String>,
}

impl Default for ClaudeToPi {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeToPi {
    pub fn new() -> Self {
        ClaudeToPi { last_id: None, id_by_uuid: HashMap::new(), loss: Vec::new() }
    }

    /// Convert one raw claude line into a pi entry, or `None` if the entry
    /// type has no pi representation (recorded in `loss`).
    pub fn convert(&mut self, line: &[u8]) -> Result<Option<Value>, ConvertError> {
        let v: Value = serde_json::from_slice(line)?;
        let obj = v.as_object().ok_or_else(|| ConvertError::Json(serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, "claude entry is not an object"))))?;

        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let uuid = obj.get("uuid").and_then(Value::as_str).map(str::to_string);
        let parent_uuid = obj.get("parentUuid").and_then(Value::as_str).map(str::to_string);
        let message = obj.get("message").and_then(Value::as_object);

        let mut entry = match kind {
            "user" => convert_user(message),
            "assistant" => convert_assistant(message),
            other => {
                self.loss.push(format!("claude entry type '{other}' has no pi representation; skipped"));
                return Ok(None);
            }
        };

        let id = uuid
            .as_ref()
            .map(|u| u.chars().take(8).collect::<String>())
            .unwrap_or_else(|| format!("m{:06}", self.loss.len()));
        let parent_id = parent_uuid
            .as_ref()
            .and_then(|p| self.id_by_uuid.get(p).cloned())
            .or_else(|| self.last_id.clone());

        entry["id"] = json!(id);
        entry["parentId"] = json!(parent_id);
        if let Some(ts) = obj.get("timestamp") {
            entry["timestamp"] = ts.clone();
        }

        if let Some(u) = uuid {
            self.id_by_uuid.insert(u, id.clone());
        }
        self.last_id = Some(id);
        Ok(Some(entry))
    }
}

fn convert_user(message: Option<&Map<String, Value>>) -> Value {
    let mut pi_msg = Map::new();
    let content = message.and_then(|m| m.get("content"));
    match content {
        Some(Value::String(s)) => {
            pi_msg.insert("role".into(), json!("user"));
            pi_msg.insert("content".into(), Value::String(s.clone()));
        }
        Some(Value::Array(items)) => {
            let blocks: Vec<Value> = items.iter().map(block_to_pi).collect();
            let all_results = items.iter().all(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"));
            if all_results && !blocks.is_empty() {
                // pi convention: tool results live in a role "toolResult" message
                pi_msg.insert("role".into(), json!("toolResult"));
                if let Some(call) = items[0].get("tool_use_id") {
                    pi_msg.insert("toolCallId".into(), call.clone());
                }
                let is_error = items.iter().any(|b| b.get("is_error").and_then(Value::as_bool) == Some(true));
                pi_msg.insert("isError".into(), json!(is_error));
                pi_msg.insert("content".into(), json!(blocks));
            } else {
                pi_msg.insert("role".into(), json!("user"));
                pi_msg.insert("content".into(), json!(blocks));
            }
        }
        _ => {
            pi_msg.insert("role".into(), json!("user"));
        }
    }
    json!({ "type": "message", "message": pi_msg })
}

fn convert_assistant(message: Option<&Map<String, Value>>) -> Value {
    let mut pi_msg = Map::new();
    pi_msg.insert("role".into(), json!("assistant"));
    if let Some(content) = message.and_then(|m| m.get("content")) {
        let blocks = match content {
            Value::String(s) => vec![json!({"type":"text","text": s})],
            Value::Array(items) => items.iter().map(block_to_pi).collect(),
            _ => Vec::new(),
        };
        pi_msg.insert("content".into(), json!(blocks));
    }
    for (src, dst) in [("model", "model"), ("usage", "usage"), ("stop_reason", "stopReason")] {
        if let Some(v) = message.and_then(|m| m.get(src)) {
            pi_msg.insert(dst.into(), v.clone());
        }
    }
    json!({ "type": "message", "message": pi_msg })
}

fn block_to_pi(block: &Value) -> Value {
    let t = block.get("type").and_then(Value::as_str).unwrap_or("unknown");
    match t {
        "text" => json!({ "type": "text", "text": block.get("text").cloned().unwrap_or(Value::Null) }),
        "thinking" => {
            let mut out = json!({ "type": "thinking", "thinking": block.get("thinking").or_else(|| block.get("text")).cloned().unwrap_or(Value::Null) });
            if let Some(sig) = block.get("signature") {
                out["thinkingSignature"] = sig.clone();
            }
            out
        }
        "tool_use" => json!({
            "type": "toolCall",
            "id": block.get("id").cloned().unwrap_or(Value::Null),
            "name": block.get("name").cloned().unwrap_or(Value::Null),
            "arguments": block.get("input").cloned().unwrap_or(Value::Null),
        }),
        "tool_result" => json!({
            "type": "toolResult",
            "toolCallId": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
            "content": block.get("content").cloned().unwrap_or(Value::Null),
            "isError": block.get("is_error").cloned().unwrap_or(Value::Bool(false)),
        }),
        "image" => {
            let source = block.get("source").and_then(Value::as_object);
            json!({
                "type": "image",
                "mimeType": source.and_then(|s| s.get("media_type")).cloned().unwrap_or(Value::Null),
                "data": source.and_then(|s| s.get("data")).cloned().unwrap_or(Value::Null),
            })
        }
        other => json!({ "type": "unknown", "nativeType": other, "value": block.clone() }),
    }
}
