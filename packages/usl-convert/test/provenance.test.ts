import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDimagentFixture, CLAUDE_CONFORMANCE_FIXTURE, CODEX_CONFORMANCE_FIXTURE, DIMAGENT_FIXTURE_SESSION_ID, PI_FIXTURE, writeFixtureFile } from "./fixtures.js";
import { importDimagentSession } from "../src/dimagent.js";
import { importPiSessionFile } from "../src/pi.js";
import { assertTamperDetected, runConformance } from "../src/conformance.js";
import { bundleIntegrityDigest, makeBundle, makeSourceArtifact, makeSourceProvenance, serializeBundle, validateBundle, verifyBundleSources, type SessionBundle } from "../src/bundle.js";

test("v2 single-file provenance is portable, tamper-evident, and byte-identical", () => {
  const root = mkdtempSync(join(tmpdir(), "usl-provenance-"));
  const moved = mkdtempSync(join(tmpdir(), "usl-provenance-moved-"));
  try {
    const source = join(root, "session.jsonl");
    writeFileSync(source, PI_FIXTURE);
    const first = importPiSessionFile(source).bundle;
    const second = importPiSessionFile(source).bundle;
    assert.equal(first.version, 2);
    assert.equal(serializeBundle(first), serializeBundle(second));
    assert.equal(first.createdAt, "2026-08-14T08:47:46.489Z");
    assert.doesNotMatch(serializeBundle(first), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(verifyBundleSources(first, root).verified, 1);
    assertTamperDetected(first, root);
    cpSync(source, join(moved, "session.jsonl"));
    assert.equal(verifyBundleSources(first, moved).verified, 1);
    const result = runConformance("pi", source);
    assert.equal(result.byteIdentical, true);
    assert.equal(result.sourceRecords, result.mappedRecords + result.declaredLossRecords);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});

test("v2 supports a sorted multi-file source set", () => {
  const root = mkdtempSync(join(tmpdir(), "usl-provenance-multi-"));
  try {
    writeFileSync(join(root, "a.jsonl"), PI_FIXTURE);
    mkdirSync(join(root, "metadata"));
    writeFileSync(join(root, "metadata", "state.json"), "{\"active\":true}\n");
    const base = importPiSessionFile(join(root, "a.jsonl")).bundle;
    const provenance = makeSourceProvenance("pi", [
      makeSourceArtifact({ bytes: readFileSync(join(root, "metadata", "state.json")), logicalPath: "metadata/state.json", role: "state" }),
      makeSourceArtifact({ bytes: readFileSync(join(root, "a.jsonl")), logicalPath: "a.jsonl", role: "session-log" }),
    ]);
    const bundle = makeBundle({ native: base.native, provenance, pivot: base.pivot, evidence: base.evidence, fidelity: base.fidelity, loss: base.loss });
    assert.deepEqual(bundle.provenance?.sources.map(source => source.logicalPath), ["a.jsonl", "metadata/state.json"]);
    assert.equal(verifyBundleSources(bundle, root).verified, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v1 remains readable while v2 integrity rejects mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "usl-provenance-v1-"));
  try {
    const source = join(root, "session.jsonl");
    writeFileSync(source, PI_FIXTURE);
    const v2 = importPiSessionFile(source).bundle;
    const { provenance: _provenance, integrity: _integrity, ...common } = v2;
    const v1 = { ...common, version: 1, native: { ...common.native, sourcePath: "/Users/example/.pi/session.jsonl" } } as SessionBundle;
    validateBundle(v1);
    assert.throws(() => verifyBundleSources(v1, root), /no byte-verifiable source set/);
    assert.throws(() => validateBundle({ ...v2, createdAt: "2026-01-01T00:00:00.000Z" }), /integrity digest mismatch/);
    const mismatched = { ...v2, provenance: { ...v2.provenance!, nativeFormat: "codex" } };
    assert.throws(() => validateBundle({ ...mismatched, integrity: { ...v2.integrity!, digest: bundleIntegrityDigest(mismatched as SessionBundle) } }), /native format mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SQLite provenance attests a retained transaction-consistent backup", () => {
  const fixture = buildDimagentFixture();
  const root = mkdtempSync(join(tmpdir(), "usl-provenance-sqlite-"));
  try {
    const snapshot = join(root, "dimagent.snapshot.sqlite");
    const bundle = importDimagentSession(fixture.dbPath, DIMAGENT_FIXTURE_SESSION_ID, { snapshotPath: snapshot }).bundle;
    assert.equal(bundle.provenance?.sources[0]?.captureMode, "sqlite-backup");
    assert.match(bundle.provenance?.snapshotSemantics ?? "", /backup artifact, not the byte identity/);
    assert.equal(verifyBundleSources(bundle, root).verified, 1);
    const moved = join(root, "moved"); mkdirSync(moved); cpSync(snapshot, join(moved, "dimagent.snapshot.sqlite"));
    assert.equal(verifyBundleSources(bundle, moved).verified, 1);
  } finally { fixture.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("shared conformance runner accounts for every native record in all adapters", () => {
  const sources = [
    ["pi", PI_FIXTURE],
    ["claude", CLAUDE_CONFORMANCE_FIXTURE],
    ["codex", CODEX_CONFORMANCE_FIXTURE],
  ] as const;
  for (const [adapter, content] of sources) {
    const fixture = writeFixtureFile(content);
    try {
      const result = runConformance(adapter, fixture.path);
      assert.equal(result.sourceRecords, result.mappedRecords + result.declaredLossRecords, adapter);
      assert.equal(result.byteIdentical, true, adapter);
      assert.equal(result.verifiedArtifacts, 1, adapter);
    } finally { fixture.cleanup(); }
  }
  const sqlite = buildDimagentFixture();
  try {
    const result = runConformance("dimagent", sqlite.dbPath, { sessionId: DIMAGENT_FIXTURE_SESSION_ID });
    assert.equal(result.sourceRecords, result.mappedRecords + result.declaredLossRecords);
    assert.ok(result.declaredLossRecords >= 3);
    assert.equal(result.verifiedArtifacts, 1);
  } finally { sqlite.cleanup(); }
});

test("conformance fails deterministically for malformed native records", () => {
  const fixture = writeFixtureFile(`${PI_FIXTURE}{not-json}\n`);
  try {
    assert.throws(() => runConformance("pi", fixture.path), /malformed pi session line/);
    assert.throws(() => runConformance("pi", fixture.path), /malformed pi session line/);
  } finally { fixture.cleanup(); }
});

test("CLI registry dispatch writes and verifies a v2 bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "usl-cli-provenance-"));
  try {
    const source = join(root, "session.jsonl");
    const bundle = join(root, "session.bundle.json");
    writeFileSync(source, PI_FIXTURE);
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "import", "pi", source, "--out", bundle], { cwd: join(import.meta.dirname, "..") });
    const verified = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "verify", bundle, "--source-root", root], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" })) as { ok: boolean; verified: number };
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, 1);
    const formats = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "list-formats"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" })) as { harnesses: Array<{ name: string }> };
    assert.deepEqual(formats.harnesses.map(item => item.name), ["pi", "dimagent", "claude", "codex"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
