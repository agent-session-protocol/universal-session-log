import { readFileSync } from "node:fs";
import {
  jsonValue,
  stableId,
  type AgentEventEnvelope,
  type AgentSessionEventType,
  type ContentBlock,
} from "./asp-schema/agent-session-contracts.ts";
import { makeBundle, sha256Of, type FidelityAxis, type SessionBundle } from "./bundle.ts";
import { EvidenceBuilder, importSourceFor, type EmitOptions } from "./evidence.ts";
import { buildSnapshot } from "./materialize.ts";

/**
 * pi session file <-> asp-bundle.
 *
 * pi stores sessions as JSONL under
 *   ~/.pi/agent/sessions/<cwd-with-dashes>/<ISO-ts>_<uuid>.jsonl
 * Entry types observed in the wild: session, model_change,
 * thinking_level_change, custom, custom_message, message.
 * message roles: user | assistant | toolResult; content blocks: text,
 * thinking, toolCall, toolResult, image.
 */

type Record = { [key: string]: unknown };
const record = (value: unknown): Record => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const iso = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString());

/** Nested-message keys that pass validateMessage's exact-key check. */
const MESSAGE_KEYS = new Set(["role", "content", "toolCallId", "toolResultId", "toolName", "details", "isError", "timestamp", "api", "provider", "model", "usage", "stopReason", "error", "thinking", "contentTypes", "markers", "modelPresent", "usageKeys", "byteLength"]);

function piBlocksToCanonical(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item): ContentBlock => {
    if (typeof item === "string") return { type: "text", text: item };
    const block = record(item);
    const type = String(block.type ?? "unknown");
    if (type === "text") return { type: "text", text: String(block.text ?? "") };
    if (type === "thinking" || type === "reasoning") return { type: "thinking", text: String(block.thinking ?? block.text ?? ""), ...(typeof (block.signature ?? block.thinkingSignature) === "string" ? { signature: String(block.signature ?? block.thinkingSignature) } : {}) };
    if (type === "toolCall") return { type: "tool-call", toolCallId: String(block.id ?? block.toolCallId ?? ""), name: String(block.name ?? block.toolName ?? "unknown"), arguments: jsonValue(block.arguments ?? block.args ?? block.input ?? {}) };
    if (type === "toolResult") return { type: "tool-result", toolCallId: String(block.toolCallId ?? block.tool_use_id ?? ""), toolResultId: String(block.toolResultId ?? block.id ?? `result:${block.toolCallId ?? block.tool_use_id ?? ""}`), content: jsonValue(block.content ?? block.result ?? null), isError: block.isError === true };
    if (type === "image" || type === "image_url") return { type: "image", mimeType: String(block.mimeType ?? block.media_type ?? "application/octet-stream"), ...(typeof block.data === "string" ? { data: block.data } : {}), ...(typeof (block.uri ?? block.url) === "string" ? { uri: String(block.uri ?? block.url) } : {}), ...(typeof block.alt === "string" ? { alt: block.alt } : {}) };
    // Idempotency: an already-canonical unknown block must not be double-
    // wrapped, or its nativeType (e.g. codex.encrypted_reasoning) is lost.
    if (type === "unknown" && typeof block.nativeType === "string" && Object.prototype.hasOwnProperty.call(block, "value")) return { type: "unknown", nativeType: String(block.nativeType), value: jsonValue(block.value) };
    return { type: "unknown", nativeType: type, value: jsonValue(item) };
  });
}

/** Project a pi message into the nested-message payload shape the ASP schema validates. */
function projectPiMessage(value: unknown): Record {
  const source = record(value);
  const output: Record = {};
  for (const key of MESSAGE_KEYS) if (source[key] !== undefined && key !== "content") output[key] = jsonValue(source[key]);
  if (source.content !== undefined) output.content = piBlocksToCanonical(source.content);
  return output;
}

export interface PiImportOptions {
  /** Optional source path for provenance; sha256 is computed from the raw text. */
  readonly sourcePath?: string;
}

export interface PiImportResult {
  readonly bundle: SessionBundle;
}

export function importPiSession(text: string, options: PiImportOptions = {}): PiImportResult {
  const digest = sha256Of(text);
  const loss: string[] = [];
  const lines = text.split("\n").filter(line => line.trim().length > 0);

  const sessionEntry = lines.map(line => { try { return JSON.parse(line) as unknown; } catch { return null; } })
    .find(entry => entry !== null && record(entry).type === "session");
  const session = record(sessionEntry);
  const sessionId = str(session.id);
  if (!sessionId) throw new Error("pi session file has no session entry with an id");
  const source = importSourceFor(sessionId, digest);
  const builder = new EvidenceBuilder(source);
  const cwd = str(session.cwd);

  builder.emit("session.started", { reason: "import", ...(cwd ? { cwd } : {}), ...(str(session.timestamp) ? { } : {}) }, { nativeEventId: str(session.id), timestamp: iso(session.timestamp), correlation: { agentSessionId: source.agentSessionId } });

  let model: { provider?: string; modelId?: string } | undefined;
  let thinkingLevel: string | undefined;
  let currentRun: { runId: string; turnId: string; seed: string; startedAt: string } | undefined;
  let messageIndex = 0;
  let toolIndex = 0;
  const declaredTools = new Map<string, { name: string; arguments: unknown }>();

  const closeRun = (): void => {
    if (!currentRun) return;
    const { runId, turnId } = currentRun;
    const last = builder.events[builder.events.length - 1];
    builder.emit("turn.completed", { turnIndex: 0, state: "completed" }, { timestamp: last?.timestamp, correlation: { runId, turnId }, entityRevision: 2 });
    builder.emit("run.settled", { state: "completed", idle: true }, { timestamp: last?.timestamp, correlation: { runId }, entityRevision: 2 });
  };
  const openRun = (seed: string, startedAt: string): void => {
    const runId = `run:import:${stableId([sessionId, seed])}`;
    const turnId = `turn:${runId}:0`;
    currentRun = { runId, turnId, seed, startedAt };
    builder.emit("run.started", { state: "running", ...(model ? { modelPresent: true } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }, { nativeEventId: `import:${seed}:run:start`, timestamp: startedAt, correlation: { runId }, entityRevision: 1 });
    builder.emit("turn.started", { turnIndex: 0, state: "running" }, { nativeEventId: `import:${seed}:turn:start`, timestamp: startedAt, correlation: { runId, turnId }, entityRevision: 1 });
  };

  const emitFor = (type: AgentSessionEventType, payload: unknown, options: EmitOptions) => builder.emit(type, payload, options);

  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch (error) { throw new Error(`malformed pi session line: ${error instanceof Error ? error.message : String(error)}`); }
    const e = record(entry);
    const type = String(e.type ?? "unknown");
    const entryId = str(e.id);
    const timestamp = iso(e.timestamp);

    if (type === "session") continue; // already emitted
    if (type === "model_change") {
      model = { provider: str(e.provider), modelId: str(e.modelId) };
      emitFor("unknown.observed", { nativeType: "model_change", value: jsonValue({ provider: e.provider, modelId: e.modelId }) }, { nativeEventId: entryId, timestamp });
      continue;
    }
    if (type === "thinking_level_change") {
      thinkingLevel = str(e.thinkingLevel);
      emitFor("unknown.observed", { nativeType: "thinking_level_change", value: jsonValue({ thinkingLevel: e.thinkingLevel }) }, { nativeEventId: entryId, timestamp });
      continue;
    }
    if (type === "custom" || type === "custom_message") {
      const nativeType = `${type}:${String(e.customType ?? "unknown")}`;
      emitFor("unknown.observed", { nativeType, value: jsonValue(e) }, { nativeEventId: entryId, timestamp });
      continue;
    }
    if (type !== "message") {
      emitFor("unknown.observed", { nativeType: `entry:${type}`, value: jsonValue(e) }, { nativeEventId: entryId, timestamp });
      continue;
    }

    const message = record(e.message);
    const role = String(message.role ?? "unknown");
    if (role === "user" || !currentRun) {
      closeRun();
      openRun(entryId ?? `entry:${builder.events.length}`, timestamp);
    }
    if (!entryId) throw new Error("pi message entry missing id");
    const runId = currentRun!.runId;
    const turnId = currentRun!.turnId;
    const messageId = `message:${stableId([sessionId, entryId])}`;
    const toolCallId = role === "toolResult" ? str(message.toolCallId) : undefined;
    const toolIdentity = toolCallId ? { toolCallId, toolResultId: `result:${toolCallId}` } : undefined;

    if (role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        const block = record(item);
        if (String(block.type) !== "toolCall") continue;
        const id = str(block.id ?? block.toolCallId);
        if (id) declaredTools.set(id, { name: String(block.name ?? block.toolName ?? "unknown"), arguments: jsonValue(block.arguments ?? block.args ?? block.input ?? {}) });
      }
    }

    const projected = projectPiMessage(message);
    emitFor("message.completed", { message: projected, messageIndex: messageIndex++, state: "completed" }, { nativeEventId: entryId, timestamp, correlation: { runId, turnId, messageId, ...toolIdentity }, entityRevision: 1 });

    if (toolCallId) {
      const declared = declaredTools.get(toolCallId);
      const resultContent = jsonValue(message.content ?? null);
      const isError = message.isError === true;
      emitFor("tool.completed", { toolName: String(message.toolName ?? declared?.name ?? "unknown"), args: declared?.arguments ?? {}, result: resultContent, isError, state: isError ? "failed" : "completed", toolIndex: toolIndex++ }, { nativeEventId: entryId, timestamp, correlation: { runId, turnId, messageId, toolCallId, toolResultId: `result:${toolCallId}` }, entityRevision: 1 });
    }
  }
  closeRun();
  const last = builder.events[builder.events.length - 1];
  builder.emit("session.ended", { reason: "import complete", state: "exited" }, { timestamp: last?.timestamp });

  const declaredWithoutResult = [...declaredTools.keys()].filter(id => !builder.events.some(e => e.type === "tool.completed" && e.correlation?.toolCallId === id));
  if (declaredWithoutResult.length > 0) loss.push(`${declaredWithoutResult.length} tool call(s) without a matching toolResult entry remain in running state`);

  const snapshot = buildSnapshot({ agentSessionId: source.agentSessionId, nativeSessionId: sessionId, ...(cwd ? { cwd } : {}), evidence: builder.events });
  const fidelity: FidelityAxis[] = [
    { axis: "messages", level: "preserved", detail: "all message entries, content blocks, roles and order" },
    { axis: "content-blocks", level: "preserved", detail: "text/thinking/toolCall/toolResult/image; unmapped blocks kept as typed unknown" },
    { axis: "tool-chain", level: "preserved", detail: "tool call declarations and results with stable native ids" },
    { axis: "thinking", level: "preserved", detail: "thinking text and signature" },
    { axis: "run-boundaries", level: "partial", detail: "runs inferred from user messages; pi static logs do not record run lifecycle" },
    { axis: "turn-boundaries", level: "partial", detail: "one synthesized turn per inferred run" },
    { axis: "model-history", level: "evidence-only", detail: "model_change entries kept as unknown.observed" },
    { axis: "custom-entries", level: "evidence-only", detail: "custom/custom_message kept as unknown.observed" },
    { axis: "approvals", level: "not-in-source", detail: "pi session files do not record approval flows" },
  ];
  const bundle = makeBundle({
    native: { harness: "pi", sessionId, ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}), sourceSha256: digest },
    pivot: snapshot,
    evidence: builder.events,
    fidelity,
    loss,
  });
  return { bundle };
}

export function importPiSessionFile(path: string): PiImportResult {
  return importPiSession(readFileSync(path, "utf8"), { sourcePath: path });
}

// ---------------------------------------------------------------------------
// Exporter: asp-bundle -> pi session JSONL
// ---------------------------------------------------------------------------

function canonicalBlocksToPi(content: readonly ContentBlock[] | string): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(block => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") return { type: "thinking", thinking: block.text, ...(block.signature !== undefined ? { thinkingSignature: block.signature } : {}) };
    if (block.type === "tool-call") return { type: "toolCall", id: block.toolCallId, name: block.name, arguments: block.arguments };
    if (block.type === "image") return { type: "image", ...(block.mimeType ? { mimeType: block.mimeType } : {}), ...(block.data !== undefined ? { data: block.data } : {}), ...(block.uri !== undefined ? { uri: block.uri } : {}), ...(block.alt !== undefined ? { alt: block.alt } : {}) };
    if (block.type === "reference") return { type: "reference", uri: block.uri, ...(block.title !== undefined ? { title: block.title } : {}) };
    if (block.type === "unknown") return { type: "unknown", nativeType: block.nativeType, value: jsonValue(block.value) };
    return { type: "unknown", nativeType: block.type, value: jsonValue(block) };
  });
}

/** Tool-result content passthrough: pi toolResult messages embed content as pi
 * blocks; pass those through unchanged instead of re-encoding them. */
function toolResultContentToPi(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === null || content === undefined) return [];
  if (Array.isArray(content)) {
    if (content.every(item => typeof item === "string")) return content.map(text => ({ type: "text", text }));
    return content.map(item => {
      const block = record(item);
      const type = String(block.type ?? "");
      if (type === "text") return { type: "text", text: String(block.text ?? "") };
      if (type === "thinking") return { type: "thinking", thinking: String(block.thinking ?? block.text ?? "") };
      if (type === "toolCall") return { type: "toolCall", id: String(block.id ?? block.toolCallId ?? ""), name: String(block.name ?? "unknown"), arguments: jsonValue(block.arguments ?? {}) };
      if (type === "toolResult") return { type: "toolResult", toolCallId: String(block.toolCallId ?? ""), content: jsonValue(block.content ?? null), isError: block.isError === true };
      return { type: "text", text: JSON.stringify(jsonValue(item)) };
    });
  }
  return [{ type: "text", text: JSON.stringify(jsonValue(content)) }];
}

function entryIdFor(bundle: SessionBundle, event: AgentEventEnvelope): string {
  const native = event.source.nativeEventId;
  if (native && /^[0-9a-f]{8,32}$/i.test(native)) return native.slice(0, 8);
  return stableId([bundle.native.sessionId, event.eventId]).slice(0, 8);
}

function uuidFrom(value: string): string {
  const hex = stableId(["uuid", value]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface PiExportResult {
  readonly jsonl: string;
  /** Suggested placement under ~/.pi/agent/sessions/<dir>/<file>.jsonl */
  readonly suggestedPath?: string;
  /** Declared losses of this export direction. */
  readonly loss: readonly string[];
}

export function exportPiSession(bundle: SessionBundle): PiExportResult {
  if (bundle.native.harness !== "pi" && bundle.native.harness !== "dimagent" && bundle.native.harness !== "claude" && bundle.native.harness !== "codex") throw new Error(`unsupported source harness: ${String(bundle.native.harness)}`);
  const loss: string[] = [];
  const lines: string[] = [];
  const sessionId = bundle.pivot.nativeSessionId;
  const sessionEntryId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ? sessionId : uuidFrom(sessionId);
  let lastEntryId: string | undefined;
  const push = (value: Record): void => {
    lastEntryId = str(value.id);
    lines.push(JSON.stringify(value));
  };

  const sessionStarted = bundle.evidence.find(e => e.type === "session.started");
  const sessionPayload = record(sessionStarted?.payload);
  push({
    type: "session", version: 3, id: sessionEntryId,
    timestamp: sessionStarted?.timestamp ?? bundle.createdAt,
    cwd: str(sessionPayload.cwd) ?? bundle.pivot.cwd ?? "",
  });

  const messageById = new Map(bundle.pivot.messages.map(m => [m.id, m]));

  for (const event of bundle.evidence) {
    const entryId = entryIdFor(bundle, event);
    const timestamp = event.timestamp;
    if (event.type === "session.started" || event.type === "session.ended") continue;
    if (event.type === "unknown.observed") {
      const payload = record(event.payload);
      const nativeType = String(payload.nativeType ?? "");
      const value = record(payload.value);
      if (nativeType === "model_change") {
        push({ type: "model_change", id: entryId, parentId: lastEntryId ?? null, timestamp, provider: value.provider, modelId: value.modelId });
      } else if (nativeType === "thinking_level_change") {
        push({ type: "thinking_level_change", id: entryId, parentId: lastEntryId ?? null, timestamp, thinkingLevel: value.thinkingLevel });
      } else if (nativeType.startsWith("custom:")) {
        push({ type: "custom", customType: nativeType.slice("custom:".length), data: jsonValue(value.data ?? payload.value), id: entryId, parentId: lastEntryId ?? null, timestamp });
      } else if (nativeType.startsWith("custom_message:")) {
        push({ type: "custom_message", customType: nativeType.slice("custom_message:".length), ...value, id: entryId, parentId: lastEntryId ?? null, timestamp });
      } else {
        loss.push(`unknown.observed ${nativeType} has no pi representation; skipped`);
      }
      continue;
    }
    if (event.type === "message.completed") {
      const correlation = event.correlation ?? {};
      const message = messageById.get(correlation.messageId ?? "");
      if (!message) { loss.push(`message event without materialized message: ${event.eventId}`); continue; }
      const piMessage: Record = { role: message.role === "tool" ? "toolResult" : message.role };
      if (message.role === "tool") {
        if (message.toolCallId) piMessage.toolCallId = message.toolCallId;
        const result = message.blocks.find(b => b.type === "tool-result");
        piMessage.content = result && result.type === "tool-result" ? toolResultContentToPi(result.content) : [];
        if (result && result.type === "tool-result" && result.isError) piMessage.isError = true;
      } else {
        piMessage.content = canonicalBlocksToPi(message.blocks);
      }
      for (const key of ["model", "usage", "stopReason", "provider", "api", "error"] as const) {
        const value = message[key as keyof typeof message];
        if (value !== undefined) piMessage[key] = jsonValue(value);
      }
      push({ type: "message", id: entryId, parentId: lastEntryId ?? null, timestamp, message: piMessage });
      continue;
    }
    // run./turn./tool. lifecycle events have no native pi file representation;
    // boundaries are re-inferred on re-import.
  }

  const filename = `${bundle.createdAt.replace(/[:.]/g, "-")}_${sessionEntryId}.jsonl`;
  const cwd = bundle.pivot.cwd;
  const suggestedPath = cwd ? `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--/${filename}` : undefined;
  return { jsonl: `${lines.join("\n")}\n`, ...(suggestedPath ? { suggestedPath } : {}), loss: [...new Set(loss)] };
}
