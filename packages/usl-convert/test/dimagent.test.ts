import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDimagentFixture, buildScratchDb, DIMAGENT_FIXTURE_SESSION_ID } from "./fixtures.ts";
import { exportDimagentSession, importDimagentSession, writeDimagentSession } from "../src/dimagent.ts";
import { validateBundle } from "../src/bundle.ts";

test("dimagent import builds the canonical snapshot", () => {
  const fixture = buildDimagentFixture();
  try {
    const { bundle } = importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID);
    validateBundle(bundle);
    const { pivot } = bundle;
    assert.equal(pivot.nativeSessionId, DIMAGENT_FIXTURE_SESSION_ID);
    assert.equal(pivot.status, "exited");
    assert.equal(pivot.runs.length, 2); // metadata.runId groups
    assert.equal(pivot.messages.length, 6);
    assert.equal(pivot.tools.length, 1);
    const ordered = [...pivot.messages].sort((a, b) => a.order - b.order);
    assert.deepEqual(ordered.map(m => m.role), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
    // tool chain with structuredContent result
    const tool = pivot.tools[0]!;
    assert.equal(tool.name, "exec");
    assert.deepEqual(tool.arguments, { command: "ls" });
    assert.equal(tool.state, "completed");
    assert.deepEqual(tool.result, { type: "finished", status: "completed" });
    // loss declarations for dropped dimagent structures
    assert.ok(bundle.loss.some(l => l.includes("compaction_states")));
    assert.ok(bundle.loss.some(l => l.includes("file_checkpoints")));
    assert.ok(bundle.loss.some(l => l.includes("permission_decisions")));
    assert.ok(bundle.loss.some(l => l.includes("thinking startTime/endTime")));
  } finally {
    fixture.cleanup();
  }
});

test("dimagent import does not mutate the source database", () => {
  const fixture = buildDimagentFixture();
  try {
    const before = readFileSync(fixture.dbPath);
    importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID);
    const after = readFileSync(fixture.dbPath);
    assert.ok(before.equals(after), "source database must remain byte-identical");
    // And importing again is still deterministic.
    const second = importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID).bundle;
    assert.equal(second.pivot.messages.length, 6);
  } finally {
    fixture.cleanup();
  }
});

test("dimagent exporter maps canonical entities back to rows", () => {
  const fixture = buildDimagentFixture();
  try {
    const { bundle } = importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID);
    const rows = exportDimagentSession(bundle, { sessionId: "sess_exported_1" });
    assert.equal(rows.session.sessionId, "sess_exported_1");
    assert.equal(rows.session.status, "active");
    assert.equal(rows.messages.length, 6);
    const roles = rows.messages.map(m => m.role);
    assert.deepEqual(roles, ["user", "assistant", "tool_result", "assistant", "user", "assistant"]);
    // tool_use part carries id/name/input
    const assistant = rows.messages.find(m => m.role === "assistant" && m.toolMetadata !== null)!;
    const parts = JSON.parse(assistant.parts) as Array<{ type: string; id?: string; name?: string }>;
    const toolUse = parts.find(p => p.type === "tool_use")!;
    assert.equal(toolUse.id, "call_1");
    assert.equal(toolUse.name, "exec");
    // tool_result row pairs via tool_use_id with structuredContent preserved
    const toolRow = rows.messages.find(m => m.role === "tool_result")!;
    const toolPart = (JSON.parse(toolRow.parts) as Array<{ type: string; tool_use_id?: string; structuredContent?: unknown }>)[0]!;
    assert.equal(toolPart.type, "tool_result");
    assert.equal(toolPart.tool_use_id, "call_1");
    assert.deepEqual(toolPart.structuredContent, { type: "finished", status: "completed" });
    // deterministic orderKeys
    const keys = rows.messages.map(m => m.orderKey);
    assert.deepEqual(keys, [...keys].sort());
    // round-trip through a scratch db preserves content
    const dir = mkdtempSync(join(tmpdir(), "usl-convert-rt-"));
    const scratch = join(dir, "dim.sqlite");
    buildScratchDb(scratch);
    writeDimagentSession(scratch, rows);
    const reimported = importDimagentSession(scratch, "sess_exported_1").bundle;
    const strip = (p: typeof bundle.pivot) => ({
      messages: [...p.messages].sort((a, b) => a.order - b.order).map(m => ({ role: m.role, blocks: m.blocks })),
      tools: [...p.tools].sort((a, b) => a.order - b.order).map(t => ({ name: t.name, arguments: t.arguments, result: t.result, isError: t.isError, state: t.state })),
    });
    assert.deepEqual(strip(reimported.pivot), strip(bundle.pivot));
    rmSync(dir, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

test("dimagent import tolerates missing optional tables", () => {
  const fixture = buildDimagentFixture();
  try {
    const dir = mkdtempSync(join(tmpdir(), "usl-convert-min-"));
    const scratch = join(dir, "min.sqlite");
    buildScratchDb(scratch);
    const { bundle } = importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID);
    writeDimagentSession(scratch, exportDimagentSession(bundle, { sessionId: "sess_min_1" }));
    const minimal = importDimagentSession(scratch, "sess_min_1").bundle;
    assert.equal(minimal.pivot.messages.length, 6);
    assert.equal(minimal.pivot.tools.length, 1);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

test("dimagent import rejects unknown sessions", () => {
  const fixture = buildDimagentFixture();
  try {
    assert.throws(() => importDimagentSession(fixture.dbPath, "sess_does_not_exist"), /session not found/);
  } finally {
    fixture.cleanup();
  }
});
