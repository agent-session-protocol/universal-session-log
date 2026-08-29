import assert from "node:assert/strict";
import { test } from "node:test";
import { exportCodexSession, importCodexSession } from "../src/codex.ts";
import { exportPiSession, importPiSession } from "../src/pi.ts";
import { validateBundle } from "../src/bundle.ts";
import { PI_FIXTURE } from "./fixtures.ts";

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** Synthetic codex rollout: dual stream, encrypted reasoning, one tool chain, two turns. */
const FIXTURE = [
  JSON.stringify({ timestamp: "2025-09-17T15:13:38.569Z", type: "session_meta", payload: { id: "codex-sess-1", cli_version: "0.36.0", cwd: "/tmp/demo", instructions: null, model_provider: "openai", originator: "codex_cli_rs", timestamp: "2025-09-17T15:13:38.569Z" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:40.000Z", type: "turn_context", payload: { cwd: "/tmp/demo", approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" }, model: "gpt-5-codex", summary: "auto" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:41.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:41.100Z", type: "event_msg", payload: { type: "user_message", message: "list files" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:42.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Preparing to list files" }], content: null, encrypted_content: "ENCRYPTED_BLOB_abc123" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:42.100Z", type: "event_msg", payload: { type: "agent_reasoning", text: "Preparing to list files" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:43.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":\"ls\"}", call_id: "call_1" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:44.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "a.ts b.ts" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:45.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "found a.ts and b.ts" }] } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:45.100Z", type: "event_msg", payload: { type: "agent_message", message: "found a.ts and b.ts" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:13:45.200Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, output_tokens: 42 } } } }),
  JSON.stringify({ timestamp: "2025-09-17T15:14:00.000Z", type: "turn_context", payload: { cwd: "/tmp/demo", approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" }, model: "gpt-5-codex", summary: "auto" } }),
  JSON.stringify({ timestamp: "2025-09-17T15:14:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] } }),
  JSON.stringify({ timestamp: "2025-09-17T15:14:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "anytime" }] } }),
  JSON.stringify({ timestamp: "2025-09-17T15:14:03.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }),
].join("\n") + "\n";

test("codex import builds the canonical snapshot", () => {
  const { bundle } = importCodexSession(FIXTURE);
  validateBundle(bundle);
  const { pivot } = bundle;
  assert.equal(pivot.nativeSessionId, "codex-sess-1");
  assert.equal(pivot.cwd, "/tmp/demo");
  // two turn_context records -> two runs; second run cancelled by turn_aborted
  assert.equal(pivot.runs.length, 2);
  assert.equal(pivot.runs[0]!.state, "completed");
  assert.equal(pivot.runs[1]!.state, "cancelled");
  // dual-stream dedup: user_message/agent_message/agent_reasoning event_msg
  // must NOT create duplicate messages
  const ordered = [...pivot.messages].sort((a, b) => a.order - b.order);
  assert.deepEqual(ordered.map(m => m.role), ["user", "assistant", "assistant", "tool", "assistant", "user", "assistant"]);
  // reasoning item: summary as thinking + encrypted blob as unknown block
  const reasoning = ordered[1]!;
  assert.deepEqual(reasoning.blocks.map(b => b.type), ["thinking", "unknown"]);
  const thinking = reasoning.blocks[0]!;
  if (thinking.type === "thinking") assert.equal(thinking.text, "Preparing to list files");
  const opaque = reasoning.blocks[1]!;
  if (opaque.type === "unknown") {
    assert.equal(opaque.nativeType, "codex.encrypted_reasoning");
    assert.equal((opaque.value as Record<string, unknown>).encrypted_content, "ENCRYPTED_BLOB_abc123");
  }
  // tool chain: function_call declaration + output
  assert.equal(pivot.tools.length, 1);
  assert.deepEqual(pivot.tools[0]!.arguments, { command: "ls" });
  assert.equal(pivot.tools[0]!.result, "a.ts b.ts");
  assert.equal(pivot.tools[0]!.state, "completed");
});

test("codex import keeps token_count evidence-only and declares dual-stream loss", () => {
  const { bundle } = importCodexSession(FIXTURE);
  const unknowns = bundle.evidence.filter(e => e.type === "unknown.observed");
  assert.ok(unknowns.some(e => String((e.payload as Record<string, unknown>).nativeType) === "codex.token_count"));
  assert.ok(unknowns.some(e => String((e.payload as Record<string, unknown>).nativeType) === "codex.turn_aborted"));
  assert.ok(bundle.fidelity.some(f => f.axis === "reasoning" && f.level === "partial"));
  assert.ok(bundle.fidelity.some(f => f.axis === "dual-stream" && f.level === "partial"));
});

test("codex import is deterministic and rejects malformed input", () => {
  const first = importCodexSession(FIXTURE).bundle;
  const second = importCodexSession(FIXTURE).bundle;
  assert.deepEqual(first.evidence.map(e => e.eventId), second.evidence.map(e => e.eventId));
  assert.throws(() => importCodexSession("{\"type\":\"response_item\"\n"), /malformed codex rollout line 1/);
  assert.throws(() => importCodexSession(JSON.stringify({ timestamp: "2025-09-17T15:13:38.569Z", type: "response_item", payload: { type: "message", role: "user", content: [] } })), /no session_meta/);
});

test("codex export roundtrips the rollout (codex → codex)", () => {
  const bundle = importCodexSession(FIXTURE).bundle;
  const { jsonl } = exportCodexSession(bundle);
  const back = importCodexSession(jsonl).bundle;
  validateBundle(back);
  assert.equal(back.pivot.messages.length, 7);
  assert.equal(back.pivot.tools.length, 1);
  assert.equal(back.pivot.runs.length, 2);
  // encrypted reasoning survives verbatim
  const reasoning = back.pivot.messages.find(m => m.blocks.some(b => b.type === "unknown"))!;
  const enc = reasoning.blocks.find(b => b.type === "unknown")! as { value: Record<string, unknown> };
  assert.equal(enc.value.encrypted_content, "ENCRYPTED_BLOB_abc123");
  // session_meta + turn_context preserved verbatim (cli_version / model)
  const metaEv = back.evidence.find(e => e.type === "unknown.observed" && record(e.payload).nativeType === "codex.session_meta")!;
  assert.equal(record(record(metaEv.payload).value).cli_version, "0.36.0");
  assert.equal(record(record(metaEv.payload).value).model_provider, "openai");
  const turnEv = back.evidence.find(e => e.type === "unknown.observed" && record(e.payload).nativeType === "codex.turn_context")!;
  assert.equal(record(record(turnEv.payload).value).model, "gpt-5-codex");
});

test("codex → pi → codex preserves messages, tool chain, and encrypted reasoning", () => {
  const codexBundle = importCodexSession(FIXTURE).bundle;
  const piJsonl = exportPiSession(codexBundle).jsonl;
  const piBundle = importPiSession(piJsonl).bundle;
  const backJsonl = exportCodexSession(piBundle).jsonl;
  const back = importCodexSession(backJsonl).bundle;
  validateBundle(back);
  assert.equal(back.pivot.messages.length, 7);
  assert.equal(back.pivot.tools.length, 1);
  assert.equal(back.pivot.tools[0]!.name, "shell");
  assert.ok(String(back.pivot.tools[0]!.result).includes("a.ts b.ts"), "tool result value survives (pi re-encodes it as a text block)");
  const reasoning = back.pivot.messages.find(m => m.blocks.some(b => b.type === "unknown"))!;
  const enc = reasoning.blocks.find(b => b.type === "unknown")! as { value: Record<string, unknown> };
  assert.equal(enc.value.encrypted_content, "ENCRYPTED_BLOB_abc123");
});

test("pi → codex handoff preserves tool chain and declares cross-harness losses", () => {
  const piBundle = importPiSession(PI_FIXTURE).bundle;
  const { jsonl, loss } = exportCodexSession(piBundle);
  const back = importCodexSession(jsonl).bundle;
  validateBundle(back);
  assert.equal(back.pivot.tools.length, piBundle.pivot.tools.length);
  assert.equal(back.pivot.tools[0]!.name, "bash");
  assert.deepEqual(back.pivot.tools[0]!.arguments, { command: "echo hi" });
  assert.ok(String(back.pivot.tools[0]!.result).includes("hi"), "tool result value survives (pi re-encodes it as a text block)");
  assert.ok(loss.some(l => l.includes("session_meta synthesized")));
  assert.ok(loss.some(l => l.includes("turn_context synthesized")));
  assert.ok(loss.some(l => l.includes("without encrypted_content")));
});
