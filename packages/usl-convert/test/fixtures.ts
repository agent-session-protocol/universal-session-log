import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Self-contained pi session file fixture (shape matches real pi captures). */
export const PI_FIXTURE_SESSION_ID = "019fff74-b539-7a7d-90c9-ad8895912e04";

export const PI_FIXTURE = readFileSync(
  join(import.meta.dirname, "../../../fixtures/providers/pi/session.jsonl"),
  "utf8",
);

export const CLAUDE_CONFORMANCE_FIXTURE = [
  { type: "queue-operation", operation: "enqueue", timestamp: "2026-08-14T08:47:45.000Z", sessionId: "claude-conformance", content: "hello" },
  { type: "user", uuid: "claude-u1", parentUuid: null, sessionId: "claude-conformance", cwd: "/tmp/fixture", timestamp: "2026-08-14T08:47:46.000Z", message: { role: "user", content: "hello" } },
  { type: "assistant", uuid: "claude-a1", parentUuid: "claude-u1", sessionId: "claude-conformance", cwd: "/tmp/fixture", timestamp: "2026-08-14T08:47:47.000Z", message: { id: "claude-msg-1", role: "assistant", content: [{ type: "thinking", thinking: "plan" }] } },
  { type: "assistant", uuid: "claude-a2", parentUuid: "claude-a1", sessionId: "claude-conformance", cwd: "/tmp/fixture", timestamp: "2026-08-14T08:47:48.000Z", message: { id: "claude-msg-1", role: "assistant", content: [{ type: "text", text: "done" }] } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

export const CODEX_CONFORMANCE_FIXTURE = [
  { timestamp: "2026-08-14T08:47:45.000Z", type: "session_meta", payload: { id: "codex-conformance", cwd: "/tmp/fixture", timestamp: "2026-08-14T08:47:45.000Z" } },
  { timestamp: "2026-08-14T08:47:46.000Z", type: "turn_context", payload: { cwd: "/tmp/fixture", model: "fixture-model" } },
  { timestamp: "2026-08-14T08:47:47.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
  { timestamp: "2026-08-14T08:47:47.100Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
  { timestamp: "2026-08-14T08:47:48.000Z", type: "event_msg", payload: { type: "token_count", info: { input_tokens: 1 } } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

export const DIMAGENT_FIXTURE_SESSION_ID = "sess_fixture_0001";

export interface DimagentFixture {
  readonly dbPath: string;
  readonly cleanup: () => void;
}

/** Build a dimagent-shaped sqlite fixture with the same schema as the live DB. */
export function buildDimagentFixture(): DimagentFixture {
  const dir = mkdtempSync(join(tmpdir(), "usl-convert-fixture-"));
  const dbPath = join(dir, "dimcode.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '', title TEXT,
      status TEXT NOT NULL, tags TEXT, heldBy TEXT, heldAt TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE session_states (
      sessionId TEXT PRIMARY KEY, selectedProviderId TEXT, selectedModelId TEXT,
      insertionCursor TEXT, settings TEXT, permissionSettings TEXT, currentMode TEXT, version INTEGER NOT NULL
    );
    CREATE TABLE messages (
      messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL,
      parts TEXT NOT NULL, attachments TEXT, toolMetadata TEXT, metadata TEXT,
      orderKey TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE compaction_states (
      sessionId TEXT PRIMARY KEY, cursor TEXT, compactionSegments TEXT NOT NULL, checkpoints TEXT NOT NULL
    );
    CREATE TABLE file_checkpoints (
      checkpointId TEXT NOT NULL, sessionId TEXT NOT NULL, messageId TEXT NOT NULL,
      createdAt TEXT NOT NULL, trackedFileBackups TEXT NOT NULL, sequence INTEGER NOT NULL,
      isUpdate INTEGER NOT NULL, format TEXT, revision INTEGER, kind TEXT, entries TEXT,
      touchedPaths TEXT, captureTreeHash TEXT, observationId TEXT, toolCallId TEXT, path TEXT,
      beforeBackup TEXT, beforeState TEXT, afterState TEXT, PRIMARY KEY (checkpointId, sequence)
    );
    CREATE TABLE permission_decisions (
      decisionId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, toolCallId TEXT, decidedAt TEXT NOT NULL, decision TEXT NOT NULL
    );
  `);
  const insertSession = db.prepare("INSERT INTO sessions (sessionId, cwd, title, status, createdAt, updatedAt, version) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertSession.run(DIMAGENT_FIXTURE_SESSION_ID, "/tmp/fixture", "fixture session", "active", "2026-08-20T05:00:00.000Z", "2026-08-20T05:00:30.000Z", 1);
  const insertMessage = db.prepare("INSERT INTO messages (messageId, sessionId, role, parts, attachments, toolMetadata, metadata, orderKey, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const rows: Array<[string, string, unknown, null, unknown, Record<string, unknown>, string, string, string]> = [
    ["msg_u1", "user", [{ type: "text", text: "hello" }], null, null, { runId: "run_fix_1" }, "01a000000001-0000", "2026-08-20T05:00:01.000Z", "2026-08-20T05:00:01.000Z"],
    ["msg_a1", "assistant", [{ type: "thinking", thinking: "think about ls", startTime: "2026-08-20T05:00:02.000Z", endTime: "2026-08-20T05:00:03.000Z" }, { type: "tool_use", id: "call_1", name: "exec", input: { command: "ls" } }], null, { runId: "run_fix_1", toolCalls: [{ id: "call_1", name: "exec", status: "completed" }] }, { runId: "run_fix_1" }, "01a000000002-0001", "2026-08-20T05:00:02.000Z", "2026-08-20T05:00:04.000Z"],
    ["msg_t1", "tool_result", [{ type: "tool_result", tool_use_id: "call_1", content: "file.txt\n", structuredContent: { type: "finished", status: "completed" } }], null, { runId: "run_fix_1", toolCallId: "call_1", toolName: "exec", status: "success" }, { runId: "run_fix_1" }, "01a000000003-0002", "2026-08-20T05:00:05.000Z", "2026-08-20T05:00:05.000Z"],
    ["msg_a2", "assistant", [{ type: "text", text: "done" }], null, null, { runId: "run_fix_1" }, "01a000000004-0003", "2026-08-20T05:00:06.000Z", "2026-08-20T05:00:06.000Z"],
    ["msg_u2", "user", [{ type: "text", text: "again" }], null, null, { runId: "run_fix_2" }, "01a000000005-0004", "2026-08-20T05:00:07.000Z", "2026-08-20T05:00:07.000Z"],
    ["msg_a3", "assistant", [{ type: "text", text: "ok" }], null, null, { runId: "run_fix_2" }, "01a000000006-0005", "2026-08-20T05:00:08.000Z", "2026-08-20T05:00:08.000Z"],
  ];
  for (const [messageId, role, parts, attachments, toolMetadata, metadata, orderKey, createdAt, updatedAt] of rows) {
    insertMessage.run(messageId, DIMAGENT_FIXTURE_SESSION_ID, role, JSON.stringify(parts), attachments, toolMetadata === null ? null : JSON.stringify(toolMetadata), JSON.stringify(metadata), orderKey, createdAt, updatedAt);
  }
  db.exec(`INSERT INTO compaction_states (sessionId, cursor, compactionSegments, checkpoints) VALUES ('${DIMAGENT_FIXTURE_SESSION_ID}', '', '[]', '[]')`);
  db.prepare("INSERT INTO file_checkpoints (checkpointId, sessionId, messageId, createdAt, trackedFileBackups, sequence, isUpdate) VALUES ('cp_1', ?, 'msg_a2', '2026-08-20T05:00:06.000Z', '{}', 1, 0)").run(DIMAGENT_FIXTURE_SESSION_ID);
  db.prepare("INSERT INTO permission_decisions (decisionId, sessionId, toolCallId, decidedAt, decision) VALUES ('pd_1', ?, 'call_1', '2026-08-20T05:00:02.500Z', 'allowed')").run(DIMAGENT_FIXTURE_SESSION_ID);
  db.close();
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a scratch dimagent-shaped DB containing only what the exporter writes. */
export function buildScratchDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '', title TEXT,
      status TEXT NOT NULL, tags TEXT, heldBy TEXT, heldAt TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE messages (
      messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL,
      parts TEXT NOT NULL, attachments TEXT, toolMetadata TEXT, metadata TEXT,
      orderKey TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
  `);
  db.close();
}

export function writeFixtureFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "usl-convert-file-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
