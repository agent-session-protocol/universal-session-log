import assert from "node:assert/strict";
import { test } from "node:test";
import { importClaudeSession } from "../src/claude.ts";
import { exportPiSession } from "../src/pi.ts";
import { validateBundle } from "../src/bundle.ts";

/**
 * Synthetic Claude Code session log. Models the real format semantics:
 * - assistant message journaled at block granularity (3 entries share msg_1,
 *   each appending one block: thinking -> text -> tool_use)
 * - tool_result delivered in a *user* entry
 * - a sidechain (sub-agent) branch
 * - meta entries (queue-operation / custom-title) that must stay evidence-only
 */
const FIXTURE = [
  JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-20T16:14:56.562Z", sessionId: "sess-claude-1", content: "fix the bug" }),
  JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "sess-claude-1", cwd: "/tmp/proj", gitBranch: "main", isSidechain: false, userType: "external", version: "1.0.60", promptId: "p1", timestamp: "2026-07-20T16:14:56.600Z", message: { role: "user", content: "fix the bug" } }),
  JSON.stringify({ type: "assistant", uuid: "u2", parentUuid: "u1", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: false, userType: "external", timestamp: "2026-07-20T16:15:01.000Z", message: { id: "msg_1", role: "assistant", model: "claude-opus-4", stop_reason: null, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 }, content: [{ type: "thinking", thinking: "let me look", signature: "sig_abc" }] } }),
  JSON.stringify({ type: "assistant", uuid: "u3", parentUuid: "u2", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: false, userType: "external", timestamp: "2026-07-20T16:15:02.000Z", message: { id: "msg_1", role: "assistant", model: "claude-opus-4", stop_reason: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }, content: [{ type: "text", text: "I will run ls" }] } }),
  JSON.stringify({ type: "assistant", uuid: "u4", parentUuid: "u3", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: false, userType: "external", timestamp: "2026-07-20T16:15:03.000Z", message: { id: "msg_1", role: "assistant", model: "claude-opus-4", stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 50 }, content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } }),
  JSON.stringify({ type: "user", uuid: "u5", parentUuid: "u4", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: false, userType: "external", timestamp: "2026-07-20T16:15:04.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts b.ts", is_error: false }] } }),
  JSON.stringify({ type: "assistant", uuid: "u6", parentUuid: "u4", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: true, userType: "external", timestamp: "2026-07-20T16:15:05.000Z", message: { id: "msg_sub", role: "assistant", model: "claude-opus-4", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "sub-agent says hi" }] } }),
  JSON.stringify({ type: "custom-title", sessionId: "sess-claude-1", timestamp: "2026-07-20T16:15:06.000Z", title: "fix bug" }),
  JSON.stringify({ type: "attachment", uuid: "u7", parentUuid: "u6", sessionId: "sess-claude-1", isSidechain: false, userType: "external", timestamp: "2026-07-20T16:15:07.000Z", attachment: { type: "file", path: "a.ts" } }),
  JSON.stringify({ type: "user", uuid: "u8", parentUuid: "u5", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: false, userType: "external", promptId: "p2", timestamp: "2026-07-20T16:15:10.000Z", message: { role: "user", content: "thanks, now commit" } }),
  JSON.stringify({ type: "assistant", uuid: "u9", parentUuid: "u8", sessionId: "sess-claude-1", cwd: "/tmp/proj", isSidechain: false, userType: "external", timestamp: "2026-07-20T16:15:12.000Z", message: { id: "msg_2", role: "assistant", model: "claude-opus-4", stop_reason: "end_turn", usage: { input_tokens: 200, output_tokens: 8 }, content: [{ type: "text", text: "done" }] } }),
].join("\n") + "\n";

test("claude import builds the canonical snapshot", () => {
  const { bundle } = importClaudeSession(FIXTURE);
  validateBundle(bundle);
  const { pivot } = bundle;
  assert.equal(pivot.nativeSessionId, "sess-claude-1");
  assert.equal(pivot.status, "exited");
  assert.equal(pivot.cwd, "/tmp/proj");
  // two user prompts -> two inferred runs
  assert.equal(pivot.runs.length, 2);
  // messages: u1 prompt, msg_1 merged assistant, tool_result(tool), sidechain text, u8 prompt, msg_2
  const ordered = [...pivot.messages].sort((a, b) => a.order - b.order);
  assert.deepEqual(ordered.map(m => m.role), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
  // block-append journal merged: msg_1 has thinking+text+tool-call in order
  const merged = ordered[1]!;
  assert.deepEqual(merged.blocks.map(b => b.type), ["thinking", "text", "tool-call"]);
  // thinking signature survives into the pivot (resume fidelity)
  const thinking = merged.blocks[0]!;
  assert.equal(thinking.type, "thinking");
  if (thinking.type === "thinking") assert.equal(thinking.signature, "sig_abc");
  // usage/model/stopReason projected from the last entry of the group
  assert.equal(merged.model, "claude-opus-4");
  assert.equal(merged.stopReason, "tool_use");
  assert.deepEqual(merged.usage, { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 50 });
  // tool chain complete: declaration args from tool_use, result from user entry
  assert.equal(pivot.tools.length, 1);
  const tool = pivot.tools[0]!;
  assert.equal(tool.name, "Bash");
  assert.deepEqual(tool.arguments, { command: "ls" });
  assert.equal(tool.state, "completed");
  assert.equal(tool.result, "a.ts b.ts");
  // sidechain assistant present, parented to the tool_use message (branch linkage)
  const sidechain = ordered[3]!;
  assert.equal(sidechain.parentId, merged.id);
  // second prompt is parented to the tool_result entry's message
  const secondPrompt = ordered[4]!;
  assert.equal(secondPrompt.parentId, ordered[2]!.id);
});

test("claude import keeps meta entries evidence-only", () => {
  const { bundle } = importClaudeSession(FIXTURE);
  const unknowns = bundle.evidence.filter(e => e.type === "unknown.observed");
  const nativeTypes = unknowns.map(e => String((e.payload as Record<string, unknown>).nativeType));
  assert.ok(nativeTypes.includes("entry:queue-operation"));
  assert.ok(nativeTypes.includes("entry:custom-title"));
  assert.ok(nativeTypes.includes("entry:attachment"));
  assert.ok(bundle.fidelity.some(f => f.axis === "attachments" && f.level === "evidence-only"));
  assert.ok(bundle.fidelity.some(f => f.axis === "thinking" && f.level === "preserved"));
});

test("claude import is deterministic (idempotent re-import)", () => {
  const first = importClaudeSession(FIXTURE).bundle;
  const second = importClaudeSession(FIXTURE).bundle;
  assert.deepEqual(first.evidence.map(e => e.eventId), second.evidence.map(e => e.eventId));
  assert.equal(first.pivot.revision, second.pivot.revision);
  assert.equal(first.native.sourceSha256, second.native.sourceSha256);
});

test("claude import rejects malformed lines", () => {
  assert.throws(() => importClaudeSession("{\"type\":\"user\"\n"), /malformed claude session line 1/);
  assert.throws(() => importClaudeSession(JSON.stringify({ type: "user", uuid: "x", message: { role: "user", content: "hi" } })), /no entry with a sessionId/);
});

test("claude bundle exports to a resumable pi session (cross-handoff)", () => {
  const { bundle } = importClaudeSession(FIXTURE);
  const { jsonl, suggestedPath, loss } = exportPiSession(bundle);
  assert.ok(suggestedPath?.includes("--tmp-proj--"));
  const lines = jsonl.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]!.type, "session");
  const messages = lines.filter(l => l.type === "message");
  // user, assistant(merged), toolResult, sidechain assistant, user, assistant
  assert.equal(messages.length, 6);
  // parent chain intact
  for (let i = 1; i < messages.length; i++) assert.equal(messages[i]!.parentId, messages[i - 1]!.id);
  // thinking signature round-trips into pi's thinkingSignature field
  const assistant = messages[1]!.message as Record<string, unknown>;
  const blocks = assistant.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0]!.type, "thinking");
  assert.equal(blocks[0]!.thinkingSignature, "sig_abc");
  // meta entries declare their loss
  assert.ok(loss.some(l => l.includes("entry:queue-operation")));
});
