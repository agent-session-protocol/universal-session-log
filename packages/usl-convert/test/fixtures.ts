import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Self-contained pi session file fixture (shape matches real pi captures). */
export const PI_FIXTURE_SESSION_ID = "019fff74-b539-7a7d-90c9-ad8895912e04";

export const PI_FIXTURE = [
  { type: "session", version: 3, id: PI_FIXTURE_SESSION_ID, timestamp: "2026-08-14T08:47:46.489Z", cwd: "/tmp/fixture-project" },
  { type: "model_change", id: "aaaaaaaa", parentId: null, timestamp: "2026-08-14T08:47:47.780Z", provider: "fixture", modelId: "fixture-model" },
  { type: "thinking_level_change", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "2026-08-14T08:47:47.780Z", thinkingLevel: "high" },
  { type: "message", id: "cccccccc", parentId: "bbbbbbbb", timestamp: "2026-08-14T08:47:48.000Z", message: { role: "user", content: [{ type: "text", text: "hello agent" }] } },
  { type: "message", id: "dddddddd", parentId: "cccccccc", timestamp: "2026-08-14T08:47:49.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan: use a tool", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "tool_1", name: "bash", arguments: { command: "echo hi" } }, { type: "text", text: "running..." }] } },
  { type: "message", id: "eeeeeeee", parentId: "dddddddd", timestamp: "2026-08-14T08:47:50.000Z", message: { role: "toolResult", toolCallId: "tool_1", content: [{ type: "text", text: "hi\n" }] } },
  { type: "message", id: "ffffffff", parentId: "eeeeeeee", timestamp: "2026-08-14T08:47:51.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "done" }, { type: "text", text: "all done" }] } },
  { type: "custom", customType: "fixture-ext", data: { phase: "idle" }, id: "99999999", parentId: "ffffffff", timestamp: "2026-08-14T08:47:52.000Z" },
  { type: "message", id: "11111111", parentId: "99999999", timestamp: "2026-08-14T08:47:53.000Z", message: { role: "user", content: [{ type: "text", text: "second question" }] } },
  { type: "message", id: "22222222", parentId: "11111111", timestamp: "2026-08-14T08:47:54.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

export const DIMAGENT_FIXTURE_SESSION_ID = "sess_fixture_0001";

export interface DimagentFixture {
  readonly dbPath: string;
  readonly cleanup: () => void;
}

/** Build a dimagent-shaped sqlite fixture with the same schema as the live DB. */
export function buildDimagentFixture(): DimagentFixture {
  const dir = mkdtempSync(join(tmpdir(), "e-session-convert-fixture-"));
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
  const dir = mkdtempSync(join(tmpdir(), "e-session-convert-file-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
