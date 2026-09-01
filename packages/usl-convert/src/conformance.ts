import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { adapterFor, type ImportAdapterOptions } from "./registry.js";
import { serializeBundle, verifyBundleSources, type SessionBundle } from "./bundle.js";

export interface ConformanceResult {
  readonly adapter: string;
  readonly sourceRecords: number;
  readonly mappedRecords: number;
  readonly declaredLossRecords: number;
  readonly byteIdentical: boolean;
  readonly verifiedArtifacts: number;
}

function candidates(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) candidates(item, output);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["id", "uuid", "messageId", "claudeMessageId", "call_id", "callId", "eventId", "sessionId"].includes(key) && typeof item === "string") output.add(item);
    candidates(item, output);
  }
  return output;
}

function jsonlCoverage(adapter: string, bundle: SessionBundle, text: string): { records: number; mapped: number; loss: number } {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const evidenceIds = candidates(bundle.evidence);
  for (const event of bundle.evidence) if (event.source.nativeEventId) evidenceIds.add(event.source.nativeEventId);
  const evidenceTimestamps = new Set(bundle.evidence.map(event => event.timestamp));
  const nativeTypes = new Set(bundle.evidence.filter(event => event.type === "unknown.observed").map(event => String((event.payload as Record<string, unknown>)?.nativeType ?? "")));
  let mapped = 0;
  let loss = 0;
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`native record ${index + 1} is malformed`); }
    const record = value as Record<string, unknown>;
    const type = String(record?.type ?? "unknown");
    const payload = record?.payload as Record<string, unknown> | undefined;
    const subtype = String(payload?.type ?? "unknown");
    if (adapter === "codex" && type === "event_msg" && ["user_message", "agent_message", "agent_reasoning"].includes(subtype)) {
      if (!bundle.fidelity.some(axis => axis.axis === "dual-stream" && axis.level !== "preserved")) throw new Error(`native record ${index + 1} (${type}:${subtype}) was dropped without a dual-stream declaration`);
      loss += 1;
      continue;
    }
    const ids = candidates(value);
    const timestamp = typeof record?.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)) ? new Date(record.timestamp).toISOString() : undefined;
    const expectedNativeType = adapter === "codex"
      ? type === "response_item" ? `codex.response_item:${subtype}` : `codex.${type === "event_msg" ? subtype : type}`
      : adapter === "claude" ? `entry:${type}` : undefined;
    if ([...ids].some(id => evidenceIds.has(id)) || (timestamp !== undefined && evidenceTimestamps.has(timestamp)) || (expectedNativeType !== undefined && nativeTypes.has(expectedNativeType))) { mapped += 1; continue; }
    const declared = [...bundle.loss, ...bundle.fidelity.filter(axis => axis.level !== "preserved").map(axis => axis.detail)].some(detail => {
      const normalized = detail.toLowerCase();
      return normalized.includes(type.toLowerCase()) || (subtype !== "unknown" && normalized.includes(subtype.toLowerCase()));
    });
    if (declared) { loss += 1; continue; }
    throw new Error(`native record ${index + 1} (${type}) has no evidence mapping or explicit loss`);
  }
  return { records: lines.length, mapped, loss };
}

function sqliteCoverage(path: string, sessionId: string): { records: number; mapped: number; loss: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tableExists = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    const count = (table: string): number => tableExists(table) ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sessionId = ?`).get(sessionId) as { n: number | bigint }).n) : 0;
    const sessions = count("sessions");
    const states = count("session_states");
    const messages = count("messages");
    const declaredLoss = count("compaction_states") + count("file_checkpoints") + count("permission_decisions");
    return { records: sessions + states + messages + declaredLoss, mapped: sessions + states + messages, loss: declaredLoss };
  } finally { db.close(); }
}

export function runConformance(adapterName: string, input: string, options: ImportAdapterOptions = {}): ConformanceResult {
  const adapter = adapterFor(adapterName);
  const temporaryRoot = adapter.name === "dimagent" && !options.snapshotPath ? mkdtempSync(join(tmpdir(), "usl-conformance-")) : undefined;
  const effectiveOptions = temporaryRoot ? { ...options, snapshotPath: join(temporaryRoot, "dimagent.snapshot.sqlite") } : options;
  try {
    const first = adapter.importFile(input, effectiveOptions);
    const second = adapter.importFile(input, effectiveOptions);
    const firstBytes = serializeBundle(first);
    const byteIdentical = firstBytes === serializeBundle(second);
    if (!byteIdentical) throw new Error("same source set and adapter revision did not produce byte-identical bundle bytes");
    const sourceRoot = adapter.name === "dimagent" ? dirname(effectiveOptions.snapshotPath!) : dirname(input);
    const verifiedArtifacts = verifyBundleSources(first, sourceRoot).verified;
    let coverage: { records: number; mapped: number; loss: number };
    if (adapter.name === "dimagent") {
      if (!effectiveOptions.sessionId) throw new Error("dimagent conformance requires sessionId");
      coverage = sqliteCoverage(effectiveOptions.snapshotPath!, effectiveOptions.sessionId);
      if (coverage.loss > 0 && !first.loss.some(item => item.includes("not reconstructed") || item.includes("not reconstructable"))) throw new Error("SQLite source rows were omitted without explicit loss");
    } else coverage = jsonlCoverage(adapter.name, first, readFileSync(input, "utf8"));
    if (coverage.records !== coverage.mapped + coverage.loss) throw new Error("native record accounting is incomplete");
    return { adapter: adapter.name, sourceRecords: coverage.records, mappedRecords: coverage.mapped, declaredLossRecords: coverage.loss, byteIdentical, verifiedArtifacts };
  } finally {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function assertTamperDetected(bundle: SessionBundle, sourceRoot: string): void {
  if (!bundle.provenance?.sources[0]) throw new Error("bundle has no source artifact");
  const path = `${sourceRoot}/${bundle.provenance.sources[0].logicalPath}`;
  const original = readFileSync(path);
  try {
    writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
    try { verifyBundleSources(bundle, sourceRoot); } catch { return; }
    throw new Error("tampered source unexpectedly verified");
  } finally { writeFileSync(path, original); }
}
