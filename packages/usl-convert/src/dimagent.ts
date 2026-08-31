import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  jsonValue,
  stableId,
  type ContentBlock,
} from "./asp-schema/agent-session-contracts.js";
import { makeBundle, sha256Of, type FidelityAxis, type SessionBundle } from "./bundle.js";
import { EvidenceBuilder, importSourceFor } from "./evidence.js";
import { buildSnapshot } from "./materialize.js";

/**
 * dimagent session <-> asp-bundle.
 *
 * dimagent stores sessions in ~/.dimcode/v2/dimcode.sqlite (WAL mode):
 *   sessions(sessionId, cwd, title, status, createdAt, updatedAt, version)
 *   session_states(sessionId, selectedProviderId, selectedModelId, ...)
 *   messages(messageId, sessionId, role, parts, attachments, toolMetadata,
 *            metadata, orderKey, createdAt, updatedAt)
 * parts blocks: text | thinking | tool_use | tool_result.
 * messages.metadata.runId groups rows into runs; tool_result rows pair with
 * assistant tool_use blocks via tool_use_id.
 */

type Record = { [key: string]: unknown };
const record = (value: unknown): Record => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

interface DimMessageRow {
  readonly messageId: string;
  readonly role: string;
  readonly parts: Record[];
  readonly attachments: unknown;
  readonly toolMetadata: Record;
  readonly metadata: Record;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Open a WAL-safe read-only view of a live sqlite DB by copying db+wal+shm. */
function openDbCopy(dbPath: string): { db: DatabaseSync; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "usl-convert-"));
  const copy = join(dir, "db.sqlite");
  copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${dbPath}${suffix}`;
    if (existsSync(side)) copyFileSync(side, `${copy}${suffix}`);
  }
  const db = new DatabaseSync(copy);
  return { db, cleanup: () => { try { db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

function parseRows(db: DatabaseSync, sessionId: string): { session: Record; states: Record; messages: DimMessageRow[] } {
  const session = db.prepare("SELECT sessionId, cwd, title, status, createdAt, updatedAt, version FROM sessions WHERE sessionId = ?").get(sessionId) as Record | undefined;
  if (!session) throw new Error(`dimagent session not found: ${sessionId}`);
  const hasStates = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_states'").get() !== undefined;
  const states = hasStates ? ((db.prepare("SELECT selectedProviderId, selectedModelId FROM session_states WHERE sessionId = ?").get(sessionId) as Record | undefined) ?? {}) : {};
  const rows = db.prepare("SELECT messageId, role, parts, attachments, toolMetadata, metadata, orderKey, createdAt, updatedAt FROM messages WHERE sessionId = ? ORDER BY orderKey ASC").all(sessionId) as Record[];
  const messages = rows.map((row): DimMessageRow => ({
    messageId: String(row.messageId),
    role: String(row.role),
    parts: JSON.parse(String(row.parts)) as Record[],
    attachments: row.attachments === null ? undefined : JSON.parse(String(row.attachments)),
    toolMetadata: row.toolMetadata === null ? {} : record(JSON.parse(String(row.toolMetadata))),
    metadata: row.metadata === null ? {} : record(JSON.parse(String(row.metadata))),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  }));
  return { session, states, messages };
}

function dimPartsToCanonical(parts: unknown, loss: string[]): ContentBlock[] {
  if (!Array.isArray(parts)) return [];
  return parts.map((item): ContentBlock => {
    if (typeof item === "string") return { type: "text", text: item };
    const block = record(item);
    const type = String(block.type ?? "unknown");
    if (type === "text") return { type: "text", text: String(block.text ?? "") };
    if (type === "thinking") {
      if (block.startTime !== undefined || block.endTime !== undefined) loss.push("thinking startTime/endTime dropped");
      return { type: "thinking", text: String(block.thinking ?? block.text ?? "") };
    }
    if (type === "tool_use") return { type: "tool-call", toolCallId: String(block.id ?? ""), name: String(block.name ?? "unknown"), arguments: jsonValue(block.input ?? {}) };
    if (type === "tool_result") {
      const callId = String(block.tool_use_id ?? "");
      const structured = block.structuredContent;
      const isError = record(structured).status === "error" || block.isError === true;
      const content = structured !== undefined && structured !== null ? jsonValue(structured) : jsonValue(block.content ?? null);
      return { type: "tool-result", toolCallId: callId, toolResultId: `result:${callId}`, content, isError };
    }
    return { type: "unknown", nativeType: type, value: jsonValue(item) };
  });
}

export interface DimagentImportResult {
  readonly bundle: SessionBundle;
}

export function importDimagentSession(dbPath: string, sessionId: string, options: { sourcePath?: string } = {}): DimagentImportResult {
  const { db, cleanup } = openDbCopy(dbPath);
  let result: DimagentImportResult;
  try {
    const { session, states, messages } = parseRows(db, sessionId);
    const loss: string[] = [];
    const digest = sha256Of(`${sessionId}|${String(session.createdAt)}|${messages.length}`);
    const source = importSourceFor(sessionId, digest);
    const builder = new EvidenceBuilder(source);
    const cwd = str(session.cwd);
    const modelPresent = str(states.selectedModelId) !== undefined;

    builder.emit("session.started", { reason: "import", ...(cwd ? { cwd } : {}), ...(modelPresent ? { modelPresent } : {}) }, { nativeEventId: sessionId, timestamp: String(session.createdAt), correlation: { agentSessionId: source.agentSessionId } });
    if (str(states.selectedProviderId) || str(states.selectedModelId)) {
      builder.emit("unknown.observed", { nativeType: "provider_selection", value: jsonValue({ providerId: states.selectedProviderId, modelId: states.selectedModelId }) }, { nativeEventId: sessionId, timestamp: String(session.createdAt) });
    }

    let currentRun: { runId: string; turnId: string } | undefined;
    let messageIndex = 0;
    let toolIndex = 0;

    const closeRun = (timestamp: string): void => {
      if (!currentRun) return;
      const { runId, turnId } = currentRun;
      builder.emit("turn.completed", { turnIndex: 0, state: "completed" }, { timestamp, correlation: { runId, turnId }, entityRevision: 2 });
      builder.emit("run.settled", { state: "completed", idle: true }, { timestamp, correlation: { runId }, entityRevision: 2 });
    };
    const openRun = (nativeRunId: string, timestamp: string): void => {
      const runId = `run:import:${stableId([sessionId, nativeRunId])}`;
      const turnId = `turn:${runId}:0`;
      currentRun = { runId, turnId };
      builder.emit("run.started", { state: "running", ...(modelPresent ? { modelPresent } : {}) }, { nativeEventId: nativeRunId, timestamp, correlation: { runId }, entityRevision: 1 });
      builder.emit("turn.started", { turnIndex: 0, state: "running" }, { nativeEventId: nativeRunId, timestamp, correlation: { runId, turnId }, entityRevision: 1 });
    };

    const startedTools = new Map<string, { name: string; arguments: unknown }>();

    for (const row of messages) {
      const nativeRunId = str(row.metadata.runId) ?? str(row.toolMetadata.runId);
      if (nativeRunId && currentRun === undefined) {
        openRun(nativeRunId, row.createdAt);
      } else if (nativeRunId && currentRun) {
        const currentKey = currentRun.runId.slice("run:import:".length);
        const expectedCurrent = stableId([sessionId, nativeRunId]);
        if (currentKey !== expectedCurrent) {
          closeRun(row.createdAt);
          openRun(nativeRunId, row.createdAt);
        }
      } else if (!nativeRunId && !currentRun) {
        openRun(`nolabel:${row.messageId}`, row.createdAt);
      }

      const runId = currentRun!.runId;
      const turnId = currentRun!.turnId;
      const canonicalRole = row.role === "tool_result" ? "tool" : ["user", "assistant", "system"].includes(row.role) ? row.role : "unknown";
      const messageId = `message:${stableId([sessionId, row.messageId])}`;

      // tool_result rows carry the tool-call pairing.
      let toolIdentity: { toolCallId: string; toolResultId: string } | undefined;
      let toolResultContent: unknown;
      let toolIsError = false;
      if (canonicalRole === "tool") {
        for (const part of row.parts) {
          if (String(part.type) === "tool_result") {
            const callId = str(part.tool_use_id);
            if (callId) {
              toolIdentity = { toolCallId: callId, toolResultId: `result:${callId}` };
              const structured = part.structuredContent;
              toolIsError = record(structured).status === "error" || part.isError === true;
              toolResultContent = structured !== undefined && structured !== null ? jsonValue(structured) : jsonValue(part.content ?? null);
            }
          }
        }
      }

      const blocks = dimPartsToCanonical(row.parts, loss);
      const nested: Record = { role: canonicalRole, content: blocks };
      if (row.attachments !== undefined) {
        builder.emit("unknown.observed", { nativeType: "attachment", value: jsonValue(row.attachments) }, { nativeEventId: row.messageId, timestamp: row.createdAt, correlation: { runId, turnId, messageId } });
      }
      builder.emit("message.started", { message: nested, messageIndex: messageIndex++, state: "running" }, { nativeEventId: row.messageId, timestamp: row.createdAt, correlation: { runId, turnId, messageId, ...toolIdentity }, entityRevision: 1 });
      builder.emit("message.completed", { message: nested, state: "completed" }, { nativeEventId: row.messageId, timestamp: row.updatedAt, correlation: { runId, turnId, messageId, ...toolIdentity }, entityRevision: 2 });

      if (canonicalRole === "assistant") {
        for (const part of row.parts) {
          if (String(part.type) !== "tool_use") continue;
          const callId = str(part.id);
          if (!callId) continue;
          const name = String(part.name ?? "unknown");
          const args = jsonValue(part.input ?? {});
          startedTools.set(callId, { name, arguments: args });
          builder.emit("tool.started", { toolName: name, args, toolIndex: toolIndex++, state: "running" }, { nativeEventId: row.messageId, timestamp: row.createdAt, correlation: { runId, turnId, messageId, toolCallId: callId }, entityRevision: 1 });
        }
      }
      if (canonicalRole === "tool" && toolIdentity) {
        const declared = startedTools.get(toolIdentity.toolCallId);
        const toolName = str(row.toolMetadata.toolName) ?? declared?.name ?? "unknown";
        builder.emit("tool.completed", { toolName, args: declared?.arguments ?? {}, result: toolResultContent, isError: toolIsError, state: toolIsError ? "failed" : "completed", toolIndex: toolIndex++ }, { nativeEventId: row.messageId, timestamp: row.updatedAt, correlation: { runId, turnId, ...(declared ? {} : { messageId }), toolCallId: toolIdentity.toolCallId, toolResultId: toolIdentity.toolResultId }, entityRevision: 1 });
      }
    }
    const finalTimestamp = messages.length ? messages[messages.length - 1]!.updatedAt : String(session.updatedAt);
    closeRun(finalTimestamp);
    builder.emit("session.ended", { reason: "import complete", state: "exited" }, { timestamp: finalTimestamp });

    // Cross-check what exists but is not reconstructed.
    const tableExists = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    if (tableExists("compaction_states") && db.prepare("SELECT 1 FROM compaction_states WHERE sessionId = ?").get(sessionId)) loss.push("compaction_states exist but pre-compaction transcript is not reconstructable from the static log");
    if (tableExists("file_checkpoints")) {
      const checkpoints = db.prepare("SELECT COUNT(*) AS n FROM file_checkpoints WHERE sessionId = ?").get(sessionId) as Record | undefined;
      if (checkpoints && Number(checkpoints.n) > 0) loss.push(`file_checkpoints (${String(checkpoints.n)}) not reconstructed`);
    }
    if (tableExists("permission_decisions")) {
      const permissions = db.prepare("SELECT COUNT(*) AS n FROM permission_decisions WHERE sessionId = ?").get(sessionId) as Record | undefined;
      if (permissions && Number(permissions.n) > 0) loss.push(`permission_decisions (${String(permissions.n)}) not reconstructed`);
    }
    const startedWithoutResult = [...startedTools.keys()].filter(id => !builder.events.some(e => e.type === "tool.completed" && e.correlation?.toolCallId === id));
    if (startedWithoutResult.length > 0) loss.push(`${startedWithoutResult.length} tool call(s) without a tool_result row remain in running state`);

    const snapshot = buildSnapshot({ agentSessionId: source.agentSessionId, nativeSessionId: sessionId, ...(cwd ? { cwd } : {}), evidence: builder.events });
    const fidelity: FidelityAxis[] = [
      { axis: "messages", level: "preserved", detail: "all message rows with parts, roles and order" },
      { axis: "content-blocks", level: "preserved", detail: "text/thinking/tool_use/tool_result; unmapped parts kept as typed unknown" },
      { axis: "tool-chain", level: "preserved", detail: "tool_use/tool_result pairing via native ids" },
      { axis: "thinking", level: "partial", detail: "thinking text preserved; startTime/endTime dropped" },
      { axis: "run-boundaries", level: "preserved", detail: "metadata.runId groups rows into runs" },
      { axis: "turn-boundaries", level: "not-in-source", detail: "dimagent does not record turns; one synthesized per run" },
      { axis: "attachments", level: "evidence-only", detail: "attachments kept as unknown.observed" },
      { axis: "model/usage", level: "evidence-only", detail: "provider selection kept as unknown.observed" },
      { axis: "compaction", level: "dropped", detail: "compaction_states are not reconstructable" },
      { axis: "file-checkpoints", level: "dropped", detail: "file_change snapshots are not reconstructed" },
      { axis: "permissions", level: "dropped", detail: "permission_decisions are not reconstructed" },
    ];
    const bundle = makeBundle({
      native: { harness: "dimagent", sessionId, ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}), sourceSha256: digest },
      pivot: snapshot,
      evidence: builder.events,
      fidelity,
      loss: [...new Set(loss)],
    });
    result = { bundle };
  } finally {
    cleanup();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exporter: asp-bundle -> dimagent session/messages rows
// ---------------------------------------------------------------------------

export interface DimagentSessionRow {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly status: string;
  readonly tags: null;
  readonly heldBy: null;
  readonly heldAt: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface DimagentMessageRow {
  readonly messageId: string;
  readonly sessionId: string;
  readonly role: string;
  readonly parts: string;
  readonly attachments: null;
  readonly toolMetadata: string | null;
  readonly metadata: string;
  readonly orderKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DimagentExportOptions {
  /** Target session id; defaults to a fresh sess_<ts>_<rand> identity. */
  readonly sessionId?: string;
}

export interface DimagentExportResult {
  readonly session: DimagentSessionRow;
  readonly messages: DimagentMessageRow[];
  /** Declared losses of this export direction. */
  readonly loss: readonly string[];
}

function freshSessionId(now: Date): string {
  return `sess_${now.getTime()}_${randomBytes(5).toString("hex")}`;
}

function orderKey(timestamp: string, seq: number): string {
  const ms = Date.parse(timestamp);
  const hex = Number.isFinite(ms) ? ms.toString(16).padStart(12, "0").slice(0, 12) : "000000000000";
  return `01${hex}-${String(seq % 10000).padStart(4, "0")}`;
}

function firstUserText(bundle: SessionBundle): string | undefined {
  for (const message of bundle.pivot.messages) {
    if (message.role !== "user") continue;
    for (const block of message.blocks) if (block.type === "text") return block.text;
  }
  return undefined;
}

export function exportDimagentSession(bundle: SessionBundle, options: DimagentExportOptions = {}): DimagentExportResult {
  const now = new Date();
  const sessionId = options.sessionId ?? freshSessionId(now);
  const runs = [...bundle.pivot.runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.id < b.id ? -1 : 1));
  const ordered = runs.flatMap(run => bundle.pivot.messages.filter(m => m.runId === run.id).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)));
  // Message ids are derived from the TARGET session id so repeated exports into
  // the same database never collide and re-imports stay deterministic per session.
  const nativeIdFor = (canonicalId: string): string => `msg_${stableId([sessionId, canonicalId])}`;

  const title = (firstUserText(bundle) ?? bundle.native.sessionId).slice(0, 80);
  const earliest = ordered[0]?.createdAt ?? bundle.createdAt;
  const latest = ordered[ordered.length - 1]?.updatedAt ?? bundle.createdAt;
  const session: DimagentSessionRow = {
    sessionId,
    cwd: bundle.pivot.cwd ?? "",
    title,
    status: "active",
    tags: null, heldBy: null, heldAt: null,
    createdAt: earliest, updatedAt: latest, version: 1,
  };

  const messages: DimagentMessageRow[] = [];
  const loss = new Set<string>();
  let seq = 0;
  for (const message of ordered) {
    const messageId = nativeIdFor(message.id);
    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type !== "tool-result") continue;
        const part: Record = { type: "tool_result", tool_use_id: block.toolCallId };
        if (typeof block.content === "string") part.content = block.content;
        else if (block.content !== null && block.content !== undefined) part.structuredContent = jsonValue(block.content);
        else part.content = "";
        messages.push({
          messageId, sessionId, role: "tool_result",
          parts: JSON.stringify([part]), attachments: null,
          toolMetadata: JSON.stringify({ runId: message.runId, toolCallId: block.toolCallId, toolResultId: block.toolResultId, toolName: "", status: block.isError ? "error" : "success" }),
          metadata: JSON.stringify({ runId: message.runId }),
          orderKey: orderKey(message.createdAt, seq++), createdAt: message.createdAt, updatedAt: message.updatedAt,
        });
      }
      continue;
    }
    const parts: Record[] = [];
    const toolCalls: Record[] = [];
    for (const block of message.blocks) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "thinking") {
        parts.push({ type: "thinking", thinking: block.text });
        if (block.signature !== undefined) loss.add("thinking signature dropped (dimagent parts carry no signature field)");
      }
      else if (block.type === "tool-call") { parts.push({ type: "tool_use", id: block.toolCallId, name: block.name, input: jsonValue(block.arguments) }); toolCalls.push({ id: block.toolCallId, name: block.name, status: "completed" }); }
      else if (block.type === "image") parts.push({ type: "image", ...(block.mimeType ? { mimeType: block.mimeType } : {}), ...(block.data !== undefined ? { data: block.data } : {}), ...(block.uri !== undefined ? { uri: block.uri } : {}) });
      else if (block.type === "reference") parts.push({ type: "reference", uri: block.uri });
      else if (block.type === "error") parts.push({ type: "error", message: block.message });
      else parts.push({ type: "unknown", nativeType: block.type, value: jsonValue(block) });
    }
    const role = message.role === "user" || message.role === "assistant" ? message.role : "unknown";
    messages.push({
      messageId, sessionId, role,
      parts: JSON.stringify(parts), attachments: null,
      toolMetadata: toolCalls.length ? JSON.stringify({ runId: message.runId, toolCalls }) : null,
      metadata: JSON.stringify({ runId: message.runId }),
      orderKey: orderKey(message.createdAt, seq++), createdAt: message.createdAt, updatedAt: message.updatedAt,
    });
  }
  return { session, messages, loss: [...loss] };
}

/** Apply exported rows into a dimagent sqlite database (transactional). */
export function writeDimagentSession(dbPath: string, rows: DimagentExportResult): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const insertSession = db.prepare("INSERT INTO sessions (sessionId, cwd, title, status, tags, heldBy, heldAt, createdAt, updatedAt, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const s = rows.session;
    insertSession.run(s.sessionId, s.cwd, s.title, s.status, s.tags, s.heldBy, s.heldAt, s.createdAt, s.updatedAt, s.version);
    const insertMessage = db.prepare("INSERT INTO messages (messageId, sessionId, role, parts, attachments, toolMetadata, metadata, orderKey, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const m of rows.messages) insertMessage.run(m.messageId, m.sessionId, m.role, m.parts, m.attachments, m.toolMetadata, m.metadata, m.orderKey, m.createdAt, m.updatedAt);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* rollback failed */ }
    throw error;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Digest helper re-export for CLI provenance reporting. */
export function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
