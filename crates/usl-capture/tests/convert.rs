//! ClaudeToPi: claude JSONL → pi JSONL conversion (block-level mapping).

use serde_json::json;
use usl_capture::ClaudeToPi;

fn convert_all(lines: &[&str]) -> Vec<serde_json::Value> {
    let mut c = ClaudeToPi::new();
    let mut out = Vec::new();
    for l in lines {
        if let Some(v) = c.convert(l.as_bytes()).unwrap() {
            out.push(v);
        }
    }
    out
}

#[test]
fn user_string_content_maps_to_user_message() {
    let out = convert_all(&[r#"{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"hi"}}"#]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["type"], "message");
    assert_eq!(out[0]["message"]["role"], "user");
    assert_eq!(out[0]["message"]["content"], "hi");
}

#[test]
fn thinking_signature_maps_to_thinking_signature() {
    let out = convert_all(&[r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"sig_1"}]}}"#]);
    let blocks = out[0]["message"]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "thinking");
    assert_eq!(blocks[0]["thinking"], "hmm");
    assert_eq!(blocks[0]["thinkingSignature"], "sig_1");
}

#[test]
fn tool_use_maps_to_tool_call_with_arguments() {
    let out = convert_all(&[r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#]);
    let blocks = out[0]["message"]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "toolCall");
    assert_eq!(blocks[0]["id"], "toolu_1");
    assert_eq!(blocks[0]["name"], "Bash");
    assert_eq!(blocks[0]["arguments"], json!({"command": "ls"}));
}

#[test]
fn tool_result_user_entry_maps_to_tool_result_role() {
    let out = convert_all(&[r#"{"type":"user","uuid":"u3","parentUuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok","is_error":false}]}}"#]);
    assert_eq!(out[0]["message"]["role"], "toolResult");
    assert_eq!(out[0]["message"]["toolCallId"], "toolu_1");
    assert_eq!(out[0]["message"]["isError"], false);
    let blocks = out[0]["message"]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "toolResult");
    assert_eq!(blocks[0]["toolCallId"], "toolu_1");
}

#[test]
fn id_and_parent_chain_follow_uuids() {
    let out = convert_all(&[
        r#"{"type":"user","uuid":"aaaaaaaa-0000","parentUuid":null,"message":{"role":"user","content":"a"}}"#,
        r#"{"type":"assistant","uuid":"bbbbbbbb-0000","parentUuid":"aaaaaaaa-0000","message":{"role":"assistant","content":[]}}"#,
    ]);
    assert_eq!(out[0]["id"], "aaaaaaaa");
    assert_eq!(out[0]["parentId"], serde_json::Value::Null);
    assert_eq!(out[1]["id"], "bbbbbbbb");
    assert_eq!(out[1]["parentId"], "aaaaaaaa");
}

#[test]
fn unsupported_entry_types_are_skipped_and_declared() {
    let mut c = ClaudeToPi::new();
    assert!(c.convert(br#"{"type":"custom-title","title":"x"}"#).unwrap().is_none());
    assert!(c.convert(br#"{"type":"queue-operation","operation":"enqueue"}"#).unwrap().is_none());
    assert_eq!(c.loss.len(), 2);
}

#[test]
fn model_usage_stop_reason_are_carried() {
    let out = convert_all(&[r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","message":{"role":"assistant","model":"claude-opus-4","stop_reason":"tool_use","usage":{"input_tokens":10},"content":[]}}"#]);
    assert_eq!(out[0]["message"]["model"], "claude-opus-4");
    assert_eq!(out[0]["message"]["stopReason"], "tool_use");
    assert_eq!(out[0]["message"]["usage"], json!({"input_tokens": 10}));
}
