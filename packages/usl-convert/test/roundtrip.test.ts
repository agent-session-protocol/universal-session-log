import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDimagentFixture, buildScratchDb, DIMAGENT_FIXTURE_SESSION_ID, PI_FIXTURE } from "./fixtures.js";
import { importPiSession, exportPiSession } from "../src/pi.js";
import { importDimagentSession, exportDimagentSession, writeDimagentSession } from "../src/dimagent.js";
import { makeBundle, validateBundle, SESSION_BUNDLE_FORMAT, type SessionBundle } from "../src/bundle.js";

function stripPivot(bundle: SessionBundle) {
  const p = bundle.pivot;
  return {
    messages: [...p.messages].sort((a, b) => a.order - b.order).map(m => ({ role: m.role, blocks: m.blocks })),
    tools: [...p.tools].sort((a, b) => a.order - b.order).map(t => ({ name: t.name, arguments: t.arguments, result: t.result, isError: t.isError, state: t.state })),
    runs: p.runs.length,
    turns: p.turns.length,
  };
}

test("pi -> dimagent -> pi preserves messages and tool chain", () => {
  const piBundle = importPiSession(PI_FIXTURE).bundle;
  const rows = exportDimagentSession(piBundle, { sessionId: "sess_x_1" });
  const dir = mkdtempSync(join(tmpdir(), "usl-convert-cross-"));
  const scratch = join(dir, "dim.sqlite");
  buildScratchDb(scratch);
  writeDimagentSession(scratch, rows);
  const dimBundle = importDimagentSession(scratch, "sess_x_1").bundle;
  const { jsonl } = exportPiSession(dimBundle);
  const back = importPiSession(jsonl).bundle;
  const a = stripPivot(piBundle);
  const b = stripPivot(back);
  // dimagent drops the thinking signature; the rest must survive unchanged.
  const stripSignatures = (x: typeof a) => JSON.parse(JSON.stringify(x, (_k, v) => v && typeof v === "object" && !Array.isArray(v) && v.type === "thinking" ? { ...v, signature: undefined } : v));
  assert.deepEqual(stripSignatures(b), stripSignatures(a));
  assert.ok(rows.loss.some(l => l.includes("signature")));
  rmSync(dir, { recursive: true, force: true });
});

test("dimagent -> pi -> dimagent preserves messages and tool chain (declared loss for structured results)", () => {
  const fixture = buildDimagentFixture();
  try {
    const dimBundle = importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID).bundle;
    const { jsonl, loss } = exportPiSession(dimBundle);
    const piBundle = importPiSession(jsonl).bundle;
    const rows = exportDimagentSession(piBundle, { sessionId: "sess_y_1" });
    const dir = mkdtempSync(join(tmpdir(), "usl-convert-cross2-"));
    const scratch = join(dir, "dim.sqlite");
    buildScratchDb(scratch);
    writeDimagentSession(scratch, rows);
    const back = importDimagentSession(scratch, "sess_y_1").bundle;
    // Messages and roles survive; tool structuredContent is re-encoded as text through pi.
    const a = stripPivot(dimBundle);
    const b = stripPivot(back);
    assert.equal(b.messages.length, a.messages.length);
    assert.deepEqual(b.messages.map(m => m.role), a.messages.map(m => m.role));
    // tool result content shape differs (structured -> text); everything else matches
    assert.deepEqual(b.tools.map(t => ({ name: t.name, arguments: t.arguments, state: t.state })), a.tools.map(t => ({ name: t.name, arguments: t.arguments, state: t.state })));
    assert.notDeepEqual(b.tools.map(t => t.result), a.tools.map(t => t.result));
    rmSync(dir, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

test("bundle validation rejects inconsistent pivots", () => {
  const { bundle } = importPiSession(PI_FIXTURE);
  assert.throws(() => validateBundle({ ...bundle, format: "other" }), /unsupported bundle format/);
  assert.throws(() => validateBundle({ ...bundle, version: 2 }), /unsupported bundle version/);
  assert.throws(() => validateBundle({ ...bundle, pivot: { ...bundle.pivot, revision: bundle.pivot.revision + 1 } }), /revision/);
  assert.throws(() => validateBundle({ ...bundle, evidence: [] }), /revision/);
  assert.throws(() => validateBundle({ ...bundle, native: { ...bundle.native, harness: "gemini" } }), /native identity/);
});

test("makeBundle stamps format and createdAt", () => {
  const { bundle } = importPiSession(PI_FIXTURE);
  const rebuilt = makeBundle({ native: bundle.native, pivot: bundle.pivot, evidence: bundle.evidence, fidelity: bundle.fidelity, loss: bundle.loss });
  assert.equal(rebuilt.format, SESSION_BUNDLE_FORMAT);
  assert.ok(Number.isFinite(Date.parse(rebuilt.createdAt)));
});
