import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_FIXTURE, PI_FIXTURE_SESSION_ID } from "./fixtures.ts";
import { importPiSession, exportPiSession } from "../src/pi.ts";
import { validateBundle } from "../src/bundle.ts";

test("pi import builds the canonical snapshot", () => {
  const { bundle } = importPiSession(PI_FIXTURE);
  validateBundle(bundle);
  const { pivot } = bundle;
  assert.equal(pivot.nativeSessionId, PI_FIXTURE_SESSION_ID);
  assert.equal(pivot.status, "exited");
  assert.equal(pivot.runs.length, 2);
  assert.equal(pivot.turns.length, 2);
  assert.equal(pivot.messages.length, 6);
  assert.equal(pivot.tools.length, 1);
  // read-only capability policy for imported archives
  assert.ok(pivot.capabilities.some(c => c.name === "read.messages" && c.available));
  assert.ok(pivot.capabilities.every(c => c.name.startsWith("send.") || c.name === "abort" || c.name === "approval.resolve" ? !c.available : true));
  // roles in order
  const ordered = [...pivot.messages].sort((a, b) => a.order - b.order);
  assert.deepEqual(ordered.map(m => m.role), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
  // thinking signature preserved
  const assistant = ordered[1]!;
  const thinking = assistant.blocks.find(b => b.type === "thinking");
  assert.ok(thinking && thinking.type === "thinking" && thinking.signature === "reasoning_content");
  // tool chain
  const tool = pivot.tools[0]!;
  assert.equal(tool.name, "bash");
  assert.deepEqual(tool.arguments, { command: "echo hi" });
  assert.equal(tool.state, "completed");
  // tool result content passthrough (array of pi text blocks)
  const toolMessage = ordered[2]!;
  const result = toolMessage.blocks.find(b => b.type === "tool-result");
  assert.ok(result && result.type === "tool-result");
  assert.deepEqual(result.content, [{ type: "text", text: "hi\n" }]);
  // evidence-only extras do not leak into the projection
  assert.equal(bundle.evidence.some(e => e.type === "unknown.observed" && String((e.payload as { nativeType?: unknown }).nativeType).startsWith("model_change")), true);
  assert.equal(bundle.evidence.some(e => e.type === "unknown.observed" && String((e.payload as { nativeType?: unknown }).nativeType).startsWith("custom:")), true);
  // provenance: unauthenticated static import
  assert.ok(bundle.evidence.every(e => e.source.adapter === "usl-convert" && e.source.authenticated === false));
  assert.equal(bundle.fidelity.some(f => f.axis === "run-boundaries" && f.level === "partial"), true);
});

test("pi import is deterministic and idempotent", () => {
  const first = importPiSession(PI_FIXTURE).bundle;
  const second = importPiSession(PI_FIXTURE).bundle;
  assert.deepEqual(first.evidence.map(e => e.eventId), second.evidence.map(e => e.eventId));
  assert.deepEqual(first.pivot.messages.map(m => m.id), second.pivot.messages.map(m => m.id));
  assert.deepEqual(first.pivot.tools.map(t => t.id), second.pivot.tools.map(t => t.id));
  assert.equal(first.pivot.epoch, second.pivot.epoch);
});

test("pi import rejects malformed lines", () => {
  assert.throws(() => importPiSession(`${PI_FIXTURE}not json\n`), /malformed pi session line/);
  assert.throws(() => importPiSession('{"type":"message","id":"x1","timestamp":"2026-08-14T08:47:48.000Z","message":{"role":"user","content":[]}}\n'), /no session entry/);
  assert.throws(() => importPiSession(`${PI_FIXTURE}${JSON.stringify({ type: "message", timestamp: "2026-08-14T08:47:48.000Z", message: { role: "user", content: [] } })}\n`), /missing id/);
});

test("pi export produces resumable session entries with parent chain", () => {
  const { bundle } = importPiSession(PI_FIXTURE);
  const { jsonl, suggestedPath, loss } = exportPiSession(bundle);
  const lines = jsonl.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].type, "session");
  assert.equal(lines[0].id, PI_FIXTURE_SESSION_ID);
  assert.equal(lines[0].cwd, "/tmp/fixture-project");
  // parent chain intact
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].parentId, lines[i - 1].id);
  // message entries preserved with roles
  const roles = lines.filter(l => l.type === "message").map(l => l.message.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
  // toolResult keeps native toolCallId + text content passthrough
  const toolResult = lines.find(l => l.type === "message" && l.message.role === "toolResult");
  assert.equal(toolResult.message.toolCallId, "tool_1");
  assert.deepEqual(toolResult.message.content, [{ type: "text", text: "hi\n" }]);
  // custom entry re-emitted
  assert.ok(lines.some(l => l.type === "custom" && l.customType === "fixture-ext"));
  // model/thinking changes re-emitted
  assert.ok(lines.some(l => l.type === "model_change" && l.modelId === "fixture-model"));
  assert.ok(lines.some(l => l.type === "thinking_level_change" && l.thinkingLevel === "high"));
  assert.equal(loss.length, 0);
  assert.equal(suggestedPath, "--tmp-fixture-project--/" + suggestedPath!.split("/").at(-1));
});

test("pi -> pi roundtrip preserves the pivot", () => {
  const first = importPiSession(PI_FIXTURE).bundle;
  const { jsonl } = exportPiSession(first);
  const second = importPiSession(jsonl).bundle;
  const strip = (p: typeof first.pivot) => ({
    messages: [...p.messages].sort((a, b) => a.order - b.order).map(m => ({ role: m.role, blocks: m.blocks })),
    tools: [...p.tools].sort((a, b) => a.order - b.order).map(t => ({ name: t.name, arguments: t.arguments, result: t.result, isError: t.isError, state: t.state })),
    runs: p.runs.length,
    turns: p.turns.length,
  });
  assert.deepEqual(strip(second.pivot), strip(first.pivot));
  assert.deepEqual(second.evidence.map(e => e.eventId), first.evidence.map(e => e.eventId));
});
