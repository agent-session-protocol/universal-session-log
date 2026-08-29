import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateBundle, type SessionBundle } from "./bundle.ts";
import { exportPiSession, importPiSessionFile } from "./pi.ts";
import { exportDimagentSession, importDimagentSession, writeDimagentSession } from "./dimagent.ts";
import { importClaudeSessionFile } from "./claude.ts";
import { exportCodexSession, importCodexSessionFile } from "./codex.ts";
import { DatabaseSync } from "node:sqlite";

const usage = `e-session-convert — cross-harness agent session handoff (pi <-> dimagent <-> claude)

Usage:
  e-session-convert import pi <session.jsonl> [--out bundle.json]
  e-session-convert import dimagent <dimcode.sqlite> --session <sessionId> [--out bundle.json]
  e-session-convert import claude <session.jsonl> [--out bundle.json]
  e-session-convert import codex <rollout.jsonl> [--out bundle.json]
  e-session-convert export pi <bundle.json> [--out session.jsonl] [--install-pi]
  e-session-convert export dimagent <bundle.json> [--out rows.json] [--db <sqlite>] [--write]
  e-session-convert export codex <bundle.json> [--out rollout.jsonl]
  e-session-convert convert <from> <to> <input> <output>
  e-session-convert inspect <bundle.json>
  e-session-convert dimagent-list <dimcode.sqlite>
  e-session-convert list-formats`;

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

function main(): void {
  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "-h") { console.log(usage); return; }

  if (command === "list-formats") {
    console.log(JSON.stringify({
      intermediate: { format: "e-session-bundle", version: 1, storage: "copy-on-write; evidence array acts as WAL" },
      harnesses: [
        { name: "pi", import: "session JSONL (~/.pi/agent/sessions/<dir>/<ts>_<uuid>.jsonl)", export: "same format, resumable session file" },
        { name: "dimagent", import: "dimcode.sqlite messages/sessions tables (WAL-safe copy)", export: "sessions+messages rows (JSON payload or direct --write)" },
        { name: "claude", import: "session JSONL (~/.claude/projects/<dir>/<uuid>.jsonl); block-append journal merged per message.id", export: "via pi export (cross-handoff)" },
        { name: "codex", import: "rollout JSONL (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl); dual-stream dedup, encrypted reasoning passthrough", export: "rollout JSONL (round-trip; session_meta/turn_context verbatim from evidence)" },
      ],
    }, null, 2));
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
    if (subcommand === "pi") {
      const input = rest[0] ?? fail("import pi requires a session file");
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.e-session.json`;
      const { bundle } = importPiSessionFile(input);
      writeJson(out, bundle);
      console.log(JSON.stringify({ ok: true, bundle: out, sessionId: bundle.native.sessionId, messages: bundle.pivot.messages.length, tools: bundle.pivot.tools.length, loss: bundle.loss }, null, 2));
      return;
    }
    if (subcommand === "dimagent") {
      const input = rest[0] ?? fail("import dimagent requires a database path");
      const sessionIdx = rest.indexOf("--session");
      const sessionId = sessionIdx >= 0 ? argValue(rest, sessionIdx, "--session") : fail("import dimagent requires --session <sessionId> (use dimagent-list to find one)");
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `dimagent-${sessionId}.e-session.json`;
      const { bundle } = importDimagentSession(input, sessionId, { sourcePath: input });
      writeJson(out, bundle);
      console.log(JSON.stringify({ ok: true, bundle: out, sessionId: bundle.native.sessionId, messages: bundle.pivot.messages.length, tools: bundle.pivot.tools.length, loss: bundle.loss }, null, 2));
      return;
    }
    if (subcommand === "claude") {
      const input = rest[0] ?? fail("import claude requires a session file");
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.e-session.json`;
      const { bundle } = importClaudeSessionFile(input);
      writeJson(out, bundle);
      console.log(JSON.stringify({ ok: true, bundle: out, sessionId: bundle.native.sessionId, messages: bundle.pivot.messages.length, tools: bundle.pivot.tools.length, loss: bundle.loss }, null, 2));
      return;
    }
    if (subcommand === "codex") {
      const input = rest[0] ?? fail("import codex requires a rollout file");
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.e-session.json`;
      const { bundle } = importCodexSessionFile(input);
      writeJson(out, bundle);
      console.log(JSON.stringify({ ok: true, bundle: out, sessionId: bundle.native.sessionId, messages: bundle.pivot.messages.length, tools: bundle.pivot.tools.length, loss: bundle.loss }, null, 2));
      return;
    }
    fail(`unsupported import source: ${String(subcommand)}`);
  }

  if (command === "export") {
    if (subcommand === "pi") {
      const input = rest[0] ?? fail("export pi requires a bundle path");
      const bundle = readBundle(input);
      const { jsonl, suggestedPath, loss } = exportPiSession(bundle);
      if (rest.includes("--install-pi")) {
        const dir = join(homedir(), ".pi", "agent", "sessions", dirname(suggestedPath ?? "."));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, (suggestedPath ?? "session.jsonl").split("/").at(-1)!);
        writeFileSync(path, jsonl);
        console.log(JSON.stringify({ ok: true, installed: path, loss }, null, 2));
        return;
      }
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.pi.jsonl`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, jsonl);
      console.log(JSON.stringify({ ok: true, out, suggestedPath, loss }, null, 2));
      return;
    }
    if (subcommand === "dimagent") {
      const input = rest[0] ?? fail("export dimagent requires a bundle path");
      const bundle = readBundle(input);
      const rows = exportDimagentSession(bundle);
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.dimagent.json`;
      writeJson(out, { session: rows.session, messages: rows.messages, loss: rows.loss });
      let written: string | undefined;
      if (rest.includes("--write")) {
        const db = rest.includes("--db") ? argValue(rest, rest.indexOf("--db"), "--db") : join(homedir(), ".dimcode", "v2", "dimcode.sqlite");
        writeDimagentSession(db, rows);
        written = db;
      }
      console.log(JSON.stringify({ ok: true, out, sessionId: rows.session.sessionId, messageRows: rows.messages.length, loss: rows.loss, ...(written ? { written } : {}) }, null, 2));
      return;
    }
    if (subcommand === "codex") {
      const input = rest[0] ?? fail("export codex requires a bundle path");
      const bundle = readBundle(input);
      const { jsonl, loss } = exportCodexSession(bundle);
      const out = rest.includes("--out") ? argValue(rest, rest.indexOf("--out"), "--out") : `${input}.codex.jsonl`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, jsonl);
      console.log(JSON.stringify({ ok: true, out, sessionId: bundle.pivot.nativeSessionId, loss }, null, 2));
      return;
    }
    fail(`unsupported export target: ${String(subcommand)}`);
  }

  if (command === "convert") {
    const [from, to, input, output, ...extra] = [subcommand, ...rest];
    if (!from || !to || !input || !output) fail("convert requires <from> <to> <input> <output>");
    let bundle: SessionBundle;
    if (from === "pi") bundle = importPiSessionFile(input).bundle;
    else if (from === "claude") bundle = importClaudeSessionFile(input).bundle;
    else if (from === "codex") bundle = importCodexSessionFile(input).bundle;
    else if (from === "dimagent") {
      const sessionIdx = extra.indexOf("--session");
      const sessionId = sessionIdx >= 0 ? argValue(extra, sessionIdx, "--session") : fail("convert from dimagent requires --session <sessionId>");
      bundle = importDimagentSession(input, sessionId, { sourcePath: input }).bundle;
    } else fail(`unsupported source harness: ${from}`);
    if (to === "pi") {
      const { jsonl } = exportPiSession(bundle);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, jsonl);
    } else if (to === "dimagent") {
      const rows = exportDimagentSession(bundle);
      writeJson(output, { session: rows.session, messages: rows.messages, loss: rows.loss });
    } else if (to === "codex") {
      const { jsonl } = exportCodexSession(bundle);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, jsonl);
    } else fail(`unsupported target harness: ${to}`);
    console.log(JSON.stringify({ ok: true, output, fidelity: bundle.fidelity, loss: bundle.loss }, null, 2));
    return;
  }

  fail(`unknown command: ${command}`);
}

main();
