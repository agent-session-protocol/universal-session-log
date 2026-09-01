#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serializeBundle, validateBundle, verifyBundleSources, type SessionBundle } from "./bundle.js";
import { writeDimagentSession, type DimagentExportResult } from "./dimagent.js";
import { DatabaseSync } from "node:sqlite";
import { ADAPTER_REGISTRY, adapterFor } from "./registry.js";
import { runConformance } from "./conformance.js";

const usage = `usl-convert — cross-harness agent session handoff (pi <-> dimagent <-> claude)

Usage:
  usl-convert import pi <session.jsonl> [--out bundle.json]
  usl-convert import dimagent <dimcode.sqlite> --session <sessionId> [--out bundle.json]
  usl-convert import claude <session.jsonl> [--out bundle.json]
  usl-convert import codex <rollout.jsonl> [--out bundle.json]
  usl-convert export pi <bundle.json> [--out session.jsonl] [--install-pi]
  usl-convert export dimagent <bundle.json> [--out rows.json] [--db <sqlite>] [--write]
  usl-convert export codex <bundle.json> [--out rollout.jsonl]
  usl-convert convert <from> <to> <input> <output>
  usl-convert inspect <bundle.json>
  usl-convert verify <bundle.json> [--source-root <dir>]
  usl-convert conformance <format> <source> [--session <id>] [--snapshot <path>]
  usl-convert dimagent-list <dimcode.sqlite>
  usl-convert list-formats`;

function fail(message: string): never {
  console.error(message);
  console.error(usage);
  process.exit(1);
}

function argValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
  return value;
}

function readBundle(path: string): SessionBundle {
  if (!existsSync(path)) fail(`bundle not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  validateBundle(parsed);
  return parsed;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeBundle(path: string, bundle: SessionBundle): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBundle(bundle));
}

function main(): void {
  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "-h") { console.log(usage); return; }

  if (command === "list-formats") {
    console.log(JSON.stringify({
      intermediate: { format: "asp-bundle", version: 2, storage: "canonical JSON; byte-verifiable source set; evidence array acts as WAL" },
      harnesses: ADAPTER_REGISTRY.map(adapter => ({ name: adapter.name, nativeFormat: adapter.nativeFormat, import: adapter.importDescription, export: adapter.exportDescription })),
    }, null, 2));
    return;
  }

  if (command === "verify") {
    const path = subcommand ?? fail("verify requires a bundle path");
    const bundle = readBundle(path);
    const rootIndex = rest.indexOf("--source-root");
    const sourceRoot = rootIndex >= 0 ? argValue(rest, rootIndex, "--source-root") : dirname(path);
    const sources = verifyBundleSources(bundle, sourceRoot);
    console.log(JSON.stringify({ ok: true, version: bundle.version, integrity: bundle.integrity, sourceRoot, ...sources }, null, 2));
    return;
  }

  if (command === "conformance") {
    const format = subcommand ?? fail("conformance requires a source format");
    const input = rest[0] ?? fail("conformance requires a source path");
    const sessionIndex = rest.indexOf("--session");
    const snapshotIndex = rest.indexOf("--snapshot");
    const result = runConformance(format, input, {
      ...(sessionIndex >= 0 ? { sessionId: argValue(rest, sessionIndex, "--session") } : {}),
      ...(snapshotIndex >= 0 ? { snapshotPath: argValue(rest, snapshotIndex, "--snapshot") } : {}),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  if (command === "inspect") {
    const path = subcommand ?? fail("inspect requires a bundle path");
    const bundle = readBundle(path);
    const { pivot, fidelity, loss, native } = bundle;
    console.log(JSON.stringify({
      native, createdAt: bundle.createdAt,
      pivot: { id: pivot.id, nativeSessionId: pivot.nativeSessionId, cwd: pivot.cwd, status: pivot.status, revision: pivot.revision, runs: pivot.runs.length, turns: pivot.turns.length, messages: pivot.messages.length, tools: pivot.tools.length },
      fidelity, loss,
    }, null, 2));
    return;
  }

  if (command === "dimagent-list") {
    const dbPath = rest[0] ?? fail("dimagent-list requires a database path");
    if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT sessionId, cwd, title, status, createdAt, updatedAt FROM sessions ORDER BY updatedAt DESC").all() as Array<Record<string, unknown>>;
      console.log(JSON.stringify(rows.map(row => ({ sessionId: row.sessionId, cwd: row.cwd, title: row.title, status: row.status, updatedAt: row.updatedAt })), null, 2));
    } finally {
      try { db.close(); } catch { /* closed */ }
    }
    return;
  }

  if (command === "import") {
    const format = subcommand ?? fail("import requires a source format");
    let adapter;
    try { adapter = adapterFor(format); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    const input = rest[0] ?? fail(`import ${format} requires a source file`);
    const sessionIdx = rest.indexOf("--session");
    const sessionId = sessionIdx >= 0 ? argValue(rest, sessionIdx, "--session") : undefined;
    if (format === "dimagent" && !sessionId) fail("import dimagent requires --session <sessionId> (use dimagent-list to find one)");
    const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : format === "dimagent" ? `dimagent-${sessionId}.asp-bundle.json` : `${input}.asp-bundle.json`;
    const bundle = adapter.importFile(input, { ...(sessionId ? { sessionId } : {}), ...(format === "dimagent" ? { snapshotPath: `${out}.dimagent.snapshot.sqlite` } : {}) });
    writeBundle(out, bundle);
    console.log(JSON.stringify({ ok: true, bundle: out, sessionId: bundle.native.sessionId, messages: bundle.pivot.messages.length, tools: bundle.pivot.tools.length, loss: bundle.loss }, null, 2));
    return;
  }

  if (command === "export") {
    const format = subcommand ?? fail("export requires a target format");
    let adapter;
    try { adapter = adapterFor(format); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    const input = rest[0] ?? fail(`export ${format} requires a bundle path`);
    const bundle = readBundle(input);
    let artifact;
    try { artifact = adapter.exportBundle(bundle); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    if (format === "pi" && rest.includes("--install-pi")) {
      const dir = join(homedir(), ".pi", "agent", "sessions", dirname(artifact.suggestedPath ?? "."));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, (artifact.suggestedPath ?? "session.jsonl").split("/").at(-1)!);
      writeFileSync(path, String(artifact.value));
      console.log(JSON.stringify({ ok: true, installed: path, loss: artifact.loss }, null, 2));
      return;
    }
    const suffix = format === "pi" || format === "codex" ? `${format}.jsonl` : `${format}.json`;
    const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.${suffix}`;
    if (artifact.kind === "text") { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, String(artifact.value)); }
    else writeJson(out, artifact.value);
    let written: string | undefined;
    if (format === "dimagent" && rest.includes("--write")) {
      const db = rest.includes("--db") ? argValue(rest, rest.indexOf("--db"), "--db") : join(homedir(), ".dimcode", "v2", "dimcode.sqlite");
      writeDimagentSession(db, artifact.value as DimagentExportResult);
      written = db;
    }
    console.log(JSON.stringify({ ok: true, out, sessionId: bundle.pivot.nativeSessionId, loss: artifact.loss, ...(artifact.suggestedPath ? { suggestedPath: artifact.suggestedPath } : {}), ...(written ? { written } : {}) }, null, 2));
    return;
  }

  if (command === "convert") {
    const [from, to, input, output, ...extra] = [subcommand, ...rest];
    if (!from || !to || !input || !output) fail("convert requires <from> <to> <input> <output>");
    const sessionIdx = extra.indexOf("--session");
    const bundle = adapterFor(from).importFile(input, { ...(sessionIdx >= 0 ? { sessionId: argValue(extra, sessionIdx, "--session") } : {}) });
    let artifact;
    try { artifact = adapterFor(to).exportBundle(bundle); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    if (artifact.kind === "text") { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, String(artifact.value)); }
    else writeJson(output, artifact.value);
    console.log(JSON.stringify({ ok: true, output, fidelity: bundle.fidelity, loss: bundle.loss }, null, 2));
    return;
  }

  fail(`unknown command: ${command}`);
}

main();
