import { createHash, randomUUID } from "node:crypto";

export const AGENT_SESSION_SCHEMA_VERSION = "1.0" as const;
/** Snapshot 1.1 adds materialized approvals while 1.0 evidence stays valid. */
export const AGENT_SESSION_PROJECTION_VERSION = "1.1" as const;
export const AGENT_INGEST_PROTOCOL = "e-agent-session-ingest/1" as const;
export const AGENT_CONTROL_PROTOCOL = "e-agent-session-control/1" as const;
export type ExtractionLayer = "L1" | "L2" | "L3";
export type EventAuthority = "authoritative" | "self_reported" | "inferred";
export const AGENT_EVENT_TYPES = [
  "session.started", "session.ended", "session.bound", "capabilities.changed", "input.observed",
  "run.started", "run.settled", "turn.started", "turn.completed", "message.started", "message.updated",
  "message.completed", "tool.started", "tool.updated", "tool.completed",
  "approval.requested", "approval.resolved", "artifact.observed", "task.updated", "action.intent",
  "action.dispatched", "action.rejected", "action.applied", "action.unknown", "action.accepted",
  "status.changed", "unknown.observed",
] as const;
export type AgentSessionEventType = typeof AGENT_EVENT_TYPES[number];
export interface AgentEventEnvelope<T = unknown> {
  readonly schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION; readonly eventId: string; readonly type: AgentSessionEventType;
  readonly sessionId: string; readonly timestamp: string; readonly entityRevision?: number;
  readonly source: { readonly layer: ExtractionLayer; readonly adapter: string; readonly nativeEventId?: string; readonly authenticated: boolean; readonly generation?: string };
  readonly authority: EventAuthority; readonly confidence: number;
  readonly correlation?: { readonly agentSessionId?: string; readonly runId?: string; readonly turnId?: string; readonly messageId?: string; readonly toolCallId?: string; readonly toolResultId?: string; readonly parentId?: string; readonly clientActionId?: string };
  readonly payload: T;
}
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string; readonly signature?: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly name: string; readonly arguments: unknown }
  | { readonly type: "tool-result"; readonly toolCallId: string; readonly toolResultId: string; readonly content: unknown; readonly isError: boolean }
  | { readonly type: "image"; readonly mimeType: string; readonly data?: string; readonly uri?: string; readonly alt?: string }
  | { readonly type: "reference"; readonly uri: string; readonly title?: string; readonly mediaType?: string }
  | { readonly type: "error"; readonly message: string; readonly code?: string; readonly detail?: unknown }
  | { readonly type: "unknown"; readonly nativeType: string; readonly value: unknown };
export type EntityState = "pending" | "running" | "completed" | "failed" | "cancelled";
export interface ProvenanceSummary { readonly sourceEventIds: readonly string[]; readonly layer: ExtractionLayer; readonly adapter: string; readonly authenticated: boolean; readonly observationCount: number }
export interface AgentMessage { readonly id: string; readonly runId: string; readonly turnId?: string; readonly parentId?: string; readonly toolCallId?: string; readonly toolResultId?: string; readonly order: number; readonly role: "system" | "user" | "assistant" | "tool" | "unknown"; readonly state: EntityState; readonly revision: number; readonly blocks: readonly ContentBlock[]; readonly createdAt: string; readonly updatedAt: string; readonly model?: unknown; readonly thinking?: unknown; readonly usage?: unknown; readonly stopReason?: unknown; readonly error?: unknown; readonly provenance: ProvenanceSummary }
export interface AgentTool { readonly id: string; readonly runId: string; readonly turnId?: string; readonly parentMessageId?: string; readonly toolResultId?: string; readonly order: number; readonly name: string; readonly state: EntityState; readonly revision: number; readonly arguments: unknown; readonly partialResult?: unknown; readonly result?: unknown; readonly isError?: boolean; readonly createdAt: string; readonly updatedAt: string; readonly provenance: ProvenanceSummary }
export interface AgentTurn { readonly id: string; readonly runId: string; readonly index?: number; readonly state: EntityState; readonly revision: number; readonly messageIds: readonly string[]; readonly toolCallIds: readonly string[]; readonly startedAt: string; readonly completedAt?: string; readonly provenance: ProvenanceSummary }
export interface AgentRun { readonly id: string; readonly state: EntityState; readonly revision: number; readonly turnIds: readonly string[]; readonly messageIds: readonly string[]; readonly toolCallIds: readonly string[]; readonly startedAt: string; readonly completedAt?: string; readonly provenance: ProvenanceSummary }
export type AgentApprovalDecision = "approved" | "rejected" | "cancelled";
export interface AgentApproval {
  readonly id: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly kind: string;
  readonly toolName?: string;
  readonly summary?: string;
  readonly state: "pending" | AgentApprovalDecision | "outcome-unknown";
  readonly decision?: AgentApprovalDecision;
  readonly response?: unknown;
  readonly reason?: string;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly revision: number;
  readonly provenance: ProvenanceSummary;
}
export type AgentCapabilityName = "read.messages" | "read.tools" | "read.status" | "send.user-message" | "send.steer" | "send.follow-up" | "abort" | "approval.resolve";
export interface AgentCapability { readonly name: AgentCapabilityName; readonly available: boolean; readonly authority: "authoritative" | "advisory" | "unavailable"; readonly expiresAt?: string; readonly reason?: string }
export interface AgentSessionControlBasis { readonly id: string; readonly nativeSessionId: string; readonly revision: number; readonly status: AgentSessionSnapshot["status"]; readonly capabilities: readonly AgentCapability[]; readonly runningRunIds: readonly string[] }
export interface AgentSessionSnapshot { readonly schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION | typeof AGENT_SESSION_PROJECTION_VERSION; readonly id: string; readonly nativeSessionId: string; readonly cwd?: string; readonly epoch: string; readonly revision: number; readonly seq: number; readonly nextSeq: number; readonly status: "live" | "idle" | "exited" | "degraded"; readonly degradedReasons: readonly string[]; readonly capabilities: readonly AgentCapability[]; readonly runs: readonly AgentRun[]; readonly turns: readonly AgentTurn[]; readonly messages: readonly AgentMessage[]; readonly tools: readonly AgentTool[]; /** Present on 1.1 snapshots; absent 1.0 snapshots migrate as an empty list. */ readonly approvals?: readonly AgentApproval[]; readonly pendingActions: readonly PendingClientAction[] }
export interface AgentSessionEvent { readonly epoch: string; readonly seq: number; readonly revision: number; readonly agentSessionId: string; readonly type: "evidence" | "reset" | "degraded" | "action"; readonly eventId?: string; readonly entityType?: "session" | "run" | "turn" | "message" | "tool" | "approval" | "action"; readonly entityId?: string; readonly reason?: string }
export interface AgentSessionEventPage { readonly epoch: string; readonly events: readonly AgentSessionEvent[]; readonly fromSeq: number; readonly nextSeq: number; readonly gap: boolean; readonly reset: boolean; readonly snapshot?: AgentSessionSnapshot }
export type DeliverAs = "nextTurn" | "steer" | "followUp";
export type ActionDeadlinePolicy = "outcome-unknown";
export interface PendingClientAction { readonly id: string; readonly kind: "send" | "abort" | "approval"; readonly state: "submitted" | "dispatched" | "rejected" | "applied" | "outcome-unknown"; readonly idempotencyKey: string; readonly idempotencyScope?: string; readonly actor: string; readonly principalId?: string; readonly agentSessionId?: string; readonly nativeSessionId?: string; readonly adapterGeneration?: string; readonly targetRunId?: string; readonly targetApprovalId?: string; readonly approvalDecision?: AgentApprovalDecision; readonly approvalResponse?: unknown; readonly requestDigest?: string; readonly requestId?: string; readonly correlationId?: string; readonly expectedRevision?: number; readonly duplicateOrdinal?: number; readonly createdAt: string; readonly deadlineAt?: string; readonly deadlinePolicy?: ActionDeadlinePolicy; readonly settledAt?: string; readonly deliverAs?: DeliverAs; readonly content?: string | readonly ContentBlock[]; readonly contentDigest?: string; readonly reason?: string }
export interface AgentControlRequest { readonly requestId: string; readonly action: "send" | "abort" | "approval.resolve"; readonly sessionId: string; readonly brokerGeneration: string; readonly clientActionId: string; readonly targetRunId?: string; readonly approvalId?: string; readonly decision?: AgentApprovalDecision; readonly response?: unknown; readonly content?: string | readonly ContentBlock[]; readonly contentDigest?: string; readonly deliverAs?: DeliverAs; readonly ordinal?: number; readonly requestDigest: string }
export interface AgentControlResult { readonly requestId: string; readonly clientActionId: string; readonly status: "dispatched" | "rejected" | "outcome-unknown"; readonly correlationId: string; readonly requestDigest: string; readonly reason?: string }
export interface AgentSessionControlInput { readonly agentSessionId: string; readonly idempotencyKey: string; readonly expectedSessionId: string; readonly expectedRevision: number; readonly actor: string; readonly targetRunId?: string; readonly content?: string | readonly ContentBlock[]; readonly deliverAs?: DeliverAs }
export interface AgentApprovalControlInput { readonly agentSessionId: string; readonly idempotencyKey: string; readonly expectedSessionId: string; readonly expectedRevision: number; readonly actor: string; readonly approvalId: string; readonly decision: AgentApprovalDecision; readonly response?: unknown }

export function migrateAgentSessionSnapshot(value: AgentSessionSnapshot): AgentSessionSnapshot {
  if (value.schemaVersion === AGENT_SESSION_PROJECTION_VERSION) return structuredClone(value);
  return { ...structuredClone(value), schemaVersion: AGENT_SESSION_PROJECTION_VERSION, approvals: [] };
}
export function jsonValue(value: unknown): unknown { const seen = new WeakSet<object>(); const encoded = JSON.stringify(value, (_key, item: unknown) => { if (typeof item === "bigint") return item.toString(); if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }; if (typeof item === "object" && item !== null) { if (seen.has(item)) return "[Circular]"; seen.add(item); } return item; }); return encoded === undefined ? null : JSON.parse(encoded); }
export function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; if (value === undefined) return "undefined"; return JSON.stringify(value); }
export function stableId(parts: unknown[]): string { return createHash("sha256").update(stable(parts)).digest("hex").slice(0, 32); }
function normalizeControlContent(value: unknown): unknown { return typeof value === "string" ? [{ type: "text", text: value }] : value; }
export function envelope<T>(input: Omit<AgentEventEnvelope<T>, "schemaVersion" | "eventId" | "timestamp"> & { eventId?: string; timestamp?: string }): AgentEventEnvelope<T> { return { schemaVersion: AGENT_SESSION_SCHEMA_VERSION, eventId: input.eventId ?? randomUUID(), timestamp: input.timestamp ?? new Date().toISOString(), type: input.type, sessionId: input.sessionId, source: input.source, authority: input.authority, confidence: input.confidence, ...(input.entityRevision === undefined ? {} : { entityRevision: input.entityRevision }), ...(input.correlation ? { correlation: input.correlation } : {}), payload: input.payload }; }
const ids = ["agentSessionId", "runId", "turnId", "messageId", "toolCallId", "toolResultId", "parentId", "clientActionId"] as const;
export interface ToolResultLinkage { readonly toolCallId: string; readonly toolResultId: string }
export interface MessageToolCallDeclarations { readonly messageId: string; readonly toolCallIds: readonly string[] }
function aliasedId(value: Record<string, unknown>, keys: readonly string[], label: string): string | undefined {
  const values = new Set(keys.map(key => value[key]).filter((item): item is string => typeof item === "string"));
  if (values.size > 1) throw new Error(`contradictory ${label} linkage`);
  return [...values][0];
}
function toolCallBlockId(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !["toolCall", "tool-call", "tool_use"].includes(String(value.type))) return undefined;
  return aliasedId(value, ["id", "toolCallId"], "tool-call");
}
function toolResultBlockLink(value: unknown): { call?: string; result?: string } | undefined {
  if (!isPlainRecord(value) || !["toolResult", "tool-result", "tool_result"].includes(String(value.type))) return undefined;
  const call = aliasedId(value, ["toolCallId", "tool_use_id"], "tool-result"), result = aliasedId(value, ["toolResultId", "id"], "tool-result");
  return { ...(call ? { call } : {}), ...(result ? { result } : {}) };
}
export function messageToolCallDeclarations(value: AgentEventEnvelope): MessageToolCallDeclarations | undefined {
  if (!value.type.startsWith("message.") || !value.correlation?.messageId) return undefined;
  const body = isPlainRecord(value.payload) ? value.payload : {}, message = isPlainRecord(body.message) ? body.message : {}, update = isPlainRecord(body.update) ? body.update : {};
  const blockIds = new Set<string>();
  if (Array.isArray(message.content)) for (const item of message.content) { const id = toolCallBlockId(item); if (id) blockIds.add(id); }
  const updateId = toolCallBlockId(update.toolCall); if (updateId) blockIds.add(updateId);
  const resultSemantic = ["tool", "toolResult"].includes(String(message.role)) || (Array.isArray(message.content) && message.content.some(item => toolResultBlockLink(item))) || typeof value.correlation.toolResultId === "string" || typeof message.toolResultId === "string";
  const scalarIds = new Set<string>();
  for (const item of [value.correlation.toolCallId, message.toolCallId]) if (typeof item === "string") scalarIds.add(item);
  if (scalarIds.size > 1) throw new Error("contradictory tool-call linkage");
  const scalarId = [...scalarIds][0];
  if (scalarId && blockIds.size && !blockIds.has(scalarId)) throw new Error("contradictory tool-call linkage");
  if (resultSemantic) return undefined;
  if (scalarId) blockIds.add(scalarId);
  return blockIds.size ? { messageId: value.correlation.messageId, toolCallIds: [...blockIds] } : undefined;
}
export function messageToolResultLinkage(value: AgentEventEnvelope): ToolResultLinkage | undefined {
  if (!value.type.startsWith("message.")) return undefined;
  const correlation = value.correlation ?? {}, body = isPlainRecord(value.payload) ? value.payload : {}, message = isPlainRecord(body.message) ? body.message : {};
  const blockPairs: Array<{ call?: string; result?: string }> = [];
  if (Array.isArray(message.content)) for (const item of message.content) { const pair = toolResultBlockLink(item); if (pair) blockPairs.push(pair); }
  const resultSemantic = ["tool", "toolResult"].includes(String(message.role)) || blockPairs.length > 0 || typeof correlation.toolResultId === "string" || typeof message.toolResultId === "string";
  if (!resultSemantic) return undefined;
  const pairs: Array<{ call?: unknown; result?: unknown }> = [{ call: correlation.toolCallId, result: correlation.toolResultId }, { call: message.toolCallId, result: message.toolResultId }, ...blockPairs];
  const calls = new Set(pairs.map(pair => pair.call).filter((item): item is string => typeof item === "string"));
  const results = new Set(pairs.map(pair => pair.result).filter((item): item is string => typeof item === "string"));
  if (calls.size > 1 || results.size > 1) throw new Error("contradictory tool-result linkage");
  const toolCallId = [...calls][0], explicitResult = [...results][0];
  if (!toolCallId) { if (explicitResult) throw new Error("toolResultId requires toolCallId"); return undefined; }
  return { toolCallId, toolResultId: explicitResult ?? `result:${toolCallId}` };
}
export function canonicalAgentEnvelope(value: unknown): AgentEventEnvelope {
  const snapshot = detachedCanonicalJson(value);
  if (isPlainRecord(snapshot) && typeof snapshot.timestamp === "string" && Number.isFinite(Date.parse(snapshot.timestamp))) (snapshot as { timestamp: string }).timestamp = new Date(snapshot.timestamp).toISOString();
  validateAgentEnvelope(snapshot);
  return snapshot;
}
export function validateAgentEnvelope(value: unknown): asserts value is AgentEventEnvelope {
  assertCanonicalJson(value);
  if (!plain(value)) throw new Error("event must be an object");
  const e = value as unknown as Record<string, unknown>;
  exact(e, ["schemaVersion", "eventId", "type", "sessionId", "timestamp", "entityRevision", "source", "authority", "confidence", "correlation", "payload"], "event");
  if (e.schemaVersion !== AGENT_SESSION_SCHEMA_VERSION || !AGENT_EVENT_TYPES.includes(e.type as AgentSessionEventType)) throw new Error("unsupported event schema/type");
  if (!bounded(e.eventId, 256) || !bounded(e.sessionId, 1024) || typeof e.timestamp !== "string" || !Number.isFinite(Date.parse(e.timestamp))) throw new Error("invalid event identity");
  if (e.entityRevision !== undefined && (!Number.isSafeInteger(e.entityRevision) || (e.entityRevision as number) < 0)) throw new Error("invalid entityRevision");
  if (!plain(e.source)) throw new Error("invalid event source");
  const s = e.source as Record<string, unknown>; exact(s, ["adapter", "layer", "authenticated", "nativeEventId", "generation"], "event source");
  if (!bounded(s.adapter, 256) || !["L1", "L2", "L3"].includes(String(s.layer)) || typeof s.authenticated !== "boolean" || (s.nativeEventId !== undefined && !bounded(s.nativeEventId, 1024)) || (s.generation !== undefined && !bounded(s.generation, 256))) throw new Error("invalid event source");
  if (!["authoritative", "self_reported", "inferred"].includes(String(e.authority)) || typeof e.confidence !== "number" || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) throw new Error("invalid authority/confidence");
  const c = e.correlation === undefined ? {} : e.correlation as Record<string, unknown>;
  if (!plain(c)) throw new Error("invalid correlation"); exact(c, [...ids], "correlation");
  if (Object.values(c).some(v => !bounded(v, 1024))) throw new Error("invalid correlation");
  if (!Object.prototype.hasOwnProperty.call(e, "payload")) throw new Error("payload required"); assertBoundedJson(e.payload);
  validateEventShape(e.type as AgentSessionEventType, c, e.payload);
  if (e.type === "capabilities.changed") { const generation = (e.payload as Record<string, unknown>).generation; if (generation !== undefined && s.generation !== undefined && generation !== s.generation) throw new Error("capability generation contradicts authenticated source"); }
  messageToolResultLinkage(e as unknown as AgentEventEnvelope);
  messageToolCallDeclarations(e as unknown as AgentEventEnvelope);
}
export function validateControlRequest(value: unknown): asserts value is AgentControlRequest {
  if (!plain(value)) throw new Error("invalid control request"); const r = value as Record<string, unknown>;
  exact(r, ["requestId", "action", "sessionId", "brokerGeneration", "clientActionId", "targetRunId", "approvalId", "decision", "response", "content", "contentDigest", "deliverAs", "ordinal", "requestDigest"], "control request");
  if (!bounded(r.requestId, 256) || !bounded(r.clientActionId, 256) || !bounded(r.sessionId, 1024) || !bounded(r.brokerGeneration, 256) || !bounded(r.requestDigest, 128) || !["send", "abort", "approval.resolve"].includes(String(r.action))) throw new Error("invalid control request");
  if (r.ordinal !== undefined && (!Number.isSafeInteger(r.ordinal) || (r.ordinal as number) < 0)) throw new Error("invalid control ordinal");
  if (r.targetRunId !== undefined && !bounded(r.targetRunId, 1024)) throw new Error("invalid target run");
  if (r.action === "send") {
    if (r.content === undefined || r.targetRunId !== undefined || r.approvalId !== undefined || r.decision !== undefined || r.response !== undefined) throw new Error("send requires content and cannot target a run/approval");
    validateControlContent(r.content);
    if (!bounded(r.contentDigest, 128) || r.contentDigest !== stableId([normalizeControlContent(r.content)])) throw new Error("invalid content digest");
    if (r.deliverAs !== undefined && !["nextTurn", "steer", "followUp"].includes(String(r.deliverAs))) throw new Error("invalid delivery mode");
  } else if (r.action === "abort") {
    if (r.content !== undefined || r.contentDigest !== undefined || r.deliverAs !== undefined || r.targetRunId === undefined || r.approvalId !== undefined || r.decision !== undefined || r.response !== undefined) throw new Error("abort requires only a target run");
  } else {
    if (!bounded(r.approvalId, 1024) || !["approved", "rejected", "cancelled"].includes(String(r.decision)) || r.targetRunId !== undefined || r.content !== undefined || r.contentDigest !== undefined || r.deliverAs !== undefined) throw new Error("approval.resolve requires approvalId and decision");
  }
}
export function validateControlResult(value: unknown, request: AgentControlRequest): asserts value is AgentControlResult {
  if (!plain(value)) throw new Error("malformed adapter control response"); const r = value as Record<string, unknown>;
  exact(r, ["requestId", "clientActionId", "status", "correlationId", "requestDigest", "reason"], "control result");
  if (r.requestId !== request.requestId || r.clientActionId !== request.clientActionId || r.requestDigest !== request.requestDigest || !bounded(r.correlationId, 256) || !["dispatched", "rejected", "outcome-unknown"].includes(String(r.status)) || (r.reason !== undefined && !bounded(r.reason, 4096))) throw new Error("mismatched adapter control response");
  if (r.status === "dispatched" && r.reason !== undefined) throw new Error("dispatched result cannot carry a reason");
  if (r.status !== "dispatched" && r.reason === undefined) throw new Error("non-dispatched result requires a reason");
}
export function validateControlContent(value: unknown): void {
  if (typeof value === "string") { if (Buffer.byteLength(value) > 1_000_000) throw new Error("content too large"); return; }
  if (!Array.isArray(value) || value.length > 256) throw new Error("content must be text or supported blocks");
  for (const block of value) { if (!plain(block)) throw new Error("invalid content block"); const b = block as Record<string, unknown>;
    if (b.type === "text") { exact(b, ["type", "text"], "text block"); if (typeof b.text === "string" && Buffer.byteLength(b.text) <= 1_000_000) continue; }
    if (b.type === "image") { exact(b, ["type", "data", "mimeType"], "image block"); if (typeof b.data === "string" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(b.mimeType)) && canonicalBase64(b.data) && Buffer.from(b.data, "base64").byteLength <= 5_000_000) continue; }
    throw new Error("unsupported control content block");
  }
}
function validateEventShape(type: AgentSessionEventType, c: Record<string, unknown>, payload: unknown): void {
  const need = (...names: readonly string[]) => { if (names.some(name => !bounded(c[name], 1024))) throw new Error(`${type} missing required correlation`); };
  const correlationOnly = (...names: readonly string[]) => { const allowed = new Set(names); if (Object.keys(c).some(name => !allowed.has(name))) throw new Error(`${type} has invalid correlation`); };
  const requireRunForChildren = () => { if ((c.turnId !== undefined || c.messageId !== undefined || c.toolCallId !== undefined || c.toolResultId !== undefined) && c.runId === undefined) throw new Error(`${type} child correlation requires runId`); };
  if (type.startsWith("run.")) { need("runId"); validateRunEvent(type, payload); }
  if (type.startsWith("turn.")) { need("runId", "turnId"); validateTurnEvent(type, payload); }
  if (type.startsWith("message.")) { need("runId", "messageId"); validateMessageEvent(type, payload); }
  if (type.startsWith("tool.")) { need("runId", "toolCallId"); validateToolEvent(type, payload); }
  if (type.startsWith("action.")) { need("clientActionId"); validateActionEvent(type, c, payload); }
  if (type === "session.started") validateSessionStarted(payload);
  if (type === "session.ended") validateSessionEnded(payload);
  if (type === "session.bound") {
    need("agentSessionId"); correlationOnly("agentSessionId");
    const p = payloadRecord(payload); exact(p, ["nativeSessionId", "bindingVersion"], "session.bound payload");
    if (!bounded(p.nativeSessionId, 1024) || p.bindingVersion !== 1) throw new Error("invalid session.bound payload");
  }
  if (type === "capabilities.changed") validateCapabilities(payload);
  if (type === "input.observed") {
    correlationOnly("agentSessionId", "runId", "turnId", "clientActionId"); requireRunForChildren();
    const p = payloadRecord(payload); exact(p, ["source", "streamingBehavior", "imageCount", "textByteLength"], "input.observed payload");
    if (!bounded(p.source, 256) || p.streamingBehavior !== undefined && p.streamingBehavior !== null && !bounded(p.streamingBehavior, 256) || !nonNegativeInteger(p.imageCount) || !nonNegativeInteger(p.textByteLength)) throw new Error("invalid input.observed payload");
  }
  if (type === "approval.requested" || type === "approval.resolved") {
    correlationOnly("agentSessionId", "runId", "turnId", "toolCallId", "clientActionId"); requireRunForChildren();
    validateApprovalEvent(type, payload);
  }
  if (type === "artifact.observed") {
    correlationOnly("agentSessionId", "runId", "turnId", "messageId", "toolCallId"); requireRunForChildren();
    const p = payloadRecord(payload); exact(p, ["artifactId", "kind", "uri", "digest", "sizeBytes"], "artifact.observed payload");
    if (!bounded(p.artifactId, 1024) || !bounded(p.kind, 256) || p.uri !== undefined && !bounded(p.uri, 2_000_000) || p.digest !== undefined && !bounded(p.digest, 256) || p.sizeBytes !== undefined && !nonNegativeInteger(p.sizeBytes)) throw new Error("invalid artifact.observed payload");
  }
  if (type === "task.updated") {
    correlationOnly("agentSessionId", "runId", "turnId"); requireRunForChildren();
    const p = payloadRecord(payload); exact(p, ["taskId", "state", "title", "detail", "progress"], "task.updated payload");
    if (!bounded(p.taskId, 1024) || !["pending", "running", "completed", "failed", "cancelled", "blocked"].includes(String(p.state)) || p.title !== undefined && !bounded(p.title, 4096) || p.detail !== undefined && !bounded(p.detail, 65_536) || p.progress !== undefined && (typeof p.progress !== "number" || !Number.isFinite(p.progress) || p.progress < 0 || p.progress > 1)) throw new Error("invalid task.updated payload");
  }
  if (type === "status.changed") { const p = payloadRecord(payload); exact(p, ["state", "reason"], "status.changed payload"); if (p.state !== undefined && !["working", "live", "idle", "exited", "degraded"].includes(String(p.state)) || p.reason !== undefined && !bounded(p.reason, 4096)) throw new Error("invalid status payload"); }
  if (type === "unknown.observed") { const p = payloadRecord(payload); exact(p, ["nativeType", "value"], "unknown.observed payload"); if (!bounded(p.nativeType, 256) || !("value" in p)) throw new Error("invalid unknown observation"); }
}
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validateApprovalEvent(type: "approval.requested" | "approval.resolved", payload: unknown): void {
  const p = payloadRecord(payload);
  if (type === "approval.requested") {
    exact(p, ["approvalId", "kind", "toolName", "summary", "options"], "approval.requested payload");
    if (!bounded(p.approvalId, 1024) || !bounded(p.kind, 256) || p.toolName !== undefined && !bounded(p.toolName, 1024) || p.summary !== undefined && !bounded(p.summary, 65_536)) throw new Error("invalid approval.requested payload");
    return;
  }
  exact(p, ["approvalId", "decision", "reason", "response"], "approval.resolved payload");
  if (!bounded(p.approvalId, 1024) || !["approved", "rejected", "cancelled"].includes(String(p.decision)) || p.reason !== undefined && !bounded(p.reason, 4096)) throw new Error("invalid approval.resolved payload");
}
function validateRunEvent(type: AgentSessionEventType, payload: unknown): void {
  const p = payloadRecord(payload), started = type === "run.started";
  exact(p, started ? ["state", "thinkingLevel", "modelPresent"] : ["state", "idle", "abortObserved", "fromL1", "fromL2", "fromL3", "l1Only", "l2Only", "l3Only"], `${type} payload`);
  if (started) {
    if (p.state !== undefined && p.state !== "running" || p.thinkingLevel !== undefined && !bounded(p.thinkingLevel, 256) || p.modelPresent !== undefined && typeof p.modelPresent !== "boolean") throw new Error("invalid run.started payload");
  } else if (!["completed", "failed", "cancelled", "settled", "running"].includes(String(p.state)) || p.idle !== undefined && typeof p.idle !== "boolean" || p.abortObserved !== undefined && typeof p.abortObserved !== "boolean" || ["fromL1", "fromL2", "fromL3", "l1Only", "l2Only", "l3Only"].some(key => p[key] !== undefined && typeof p[key] !== "boolean")) throw new Error("invalid run.settled payload");
}
function validateTurnEvent(type: AgentSessionEventType, payload: unknown): void {
  const p = payloadRecord(payload), completed = type === "turn.completed";
  exact(p, completed ? ["turnIndex", "state", "messageByteLength", "toolResultCount"] : ["turnIndex", "state"], `${type} payload`);
  if (p.turnIndex !== undefined && (!Number.isSafeInteger(p.turnIndex) || (p.turnIndex as number) < 0)) throw new Error("invalid turnIndex");
  if (completed) {
    if (!["completed", "failed", "cancelled"].includes(String(p.state))) throw new Error("invalid turn.completed state");
    for (const key of ["messageByteLength", "toolResultCount"] as const) if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || (p[key] as number) < 0)) throw new Error(`invalid turn ${key}`);
  } else if (p.state !== undefined && p.state !== "running") throw new Error("invalid turn.started state");
}
function validateSessionStarted(payload: unknown): void {
  const p = payloadRecord(payload); exact(p, ["reason", "thinkingLevel", "modelPresent", "previousSessionFile", "cwd", "state"], "session.started payload");
  for (const key of ["reason", "thinkingLevel", "previousSessionFile", "cwd"] as const) if (p[key] !== undefined && !bounded(p[key], 4096)) throw new Error(`invalid session.started ${key}`);
  if (p.modelPresent !== undefined && typeof p.modelPresent !== "boolean" || p.state !== undefined && !["running", "live"].includes(String(p.state))) throw new Error("invalid session.started payload");
}
function validateSessionEnded(payload: unknown): void {
  const p = payloadRecord(payload); exact(p, ["reason", "state", "targetSessionFile"], "session.ended payload");
  if (p.reason !== undefined && !bounded(p.reason, 4096) || p.state !== undefined && p.state !== "exited" || p.targetSessionFile !== undefined && !bounded(p.targetSessionFile, 4096)) throw new Error("invalid session.ended payload");
}
function validateCapabilities(payload: unknown): void {
  const p = payloadRecord(payload); exact(p, ["available", "ttlMs", "generation"], "capabilities.changed payload");
  const names: readonly string[] = ["read.messages", "read.tools", "read.status", "send.user-message", "send.steer", "send.follow-up", "abort", "approval.resolve"];
  if (!Array.isArray(p.available) || p.available.some(v => typeof v !== "string" || !names.includes(v)) || new Set(p.available).size !== p.available.length || !Number.isSafeInteger(p.ttlMs) || (p.ttlMs as number) < 1 || (p.generation !== undefined && !bounded(p.generation, 256))) throw new Error("invalid capability payload");
}
function validateActionEvent(type: AgentSessionEventType, c: Record<string, unknown>, payload: unknown): void {
  const p = payloadRecord(payload); exact(p, ["action"], `${type} payload`); const a = payloadRecord(p.action);
  exact(a, ["id", "kind", "state", "idempotencyKey", "idempotencyScope", "actor", "principalId", "agentSessionId", "nativeSessionId", "adapterGeneration", "targetRunId", "targetApprovalId", "approvalDecision", "approvalResponse", "requestDigest", "requestId", "correlationId", "expectedRevision", "duplicateOrdinal", "createdAt", "deadlineAt", "deadlinePolicy", "settledAt", "deliverAs", "content", "contentDigest", "reason"], "action");
  const expected = type === "action.intent" ? ["submitted"] : type === "action.dispatched" ? ["dispatched"] : type === "action.applied" ? ["applied"] : type === "action.rejected" ? ["rejected"] : type === "action.unknown" ? ["outcome-unknown"] : ["submitted", "accepted"];
  if (!bounded(a.id, 256) || a.id !== c.clientActionId || !bounded(a.idempotencyKey, 1024) || !bounded(a.actor, 1024) || !["send", "abort", "approval"].includes(String(a.kind)) || !expected.includes(String(a.state)) || !bounded(a.createdAt, 64) || !Number.isFinite(Date.parse(String(a.createdAt)))) throw new Error("invalid action payload");
  for (const key of ["principalId", "agentSessionId", "nativeSessionId", "adapterGeneration", "targetRunId", "targetApprovalId", "requestId", "correlationId", "contentDigest"] as const) if (a[key] !== undefined && !bounded(a[key], 1024)) throw new Error(`invalid action ${key}`);
  if (a.idempotencyScope !== undefined && !bounded(a.idempotencyScope, 4096) || a.requestDigest !== undefined && !bounded(a.requestDigest, 128) || a.expectedRevision !== undefined && !nonNegativeInteger(a.expectedRevision) || a.duplicateOrdinal !== undefined && !nonNegativeInteger(a.duplicateOrdinal) || a.deadlineAt !== undefined && (!bounded(a.deadlineAt, 64) || !Number.isFinite(Date.parse(String(a.deadlineAt)))) || a.deadlinePolicy !== undefined && a.deadlinePolicy !== "outcome-unknown" || a.settledAt !== undefined && (!bounded(a.settledAt, 64) || !Number.isFinite(Date.parse(String(a.settledAt)))) || a.deliverAs !== undefined && !["nextTurn", "steer", "followUp"].includes(String(a.deliverAs)) || a.reason !== undefined && !bounded(a.reason, 4096)) throw new Error("invalid action payload");
  const legacy = type === "action.accepted" || a.idempotencyScope === undefined;
  if (!legacy && (!bounded(a.idempotencyScope, 4096) || !bounded(a.principalId, 1024) || !bounded(a.agentSessionId, 1024) || !bounded(a.nativeSessionId, 1024) || !bounded(a.adapterGeneration, 256) || !bounded(a.requestDigest, 128) || !bounded(a.requestId, 256) || !nonNegativeInteger(a.expectedRevision) || !nonNegativeInteger(a.duplicateOrdinal) || !bounded(a.deadlineAt, 64) || a.deadlinePolicy !== "outcome-unknown")) throw new Error("incomplete action intent identity");
  if (["rejected", "applied", "outcome-unknown"].includes(String(a.state)) !== (a.settledAt !== undefined)) throw new Error("action settlement mismatch");
  if (!legacy && (a.state === "dispatched" && !bounded(a.correlationId, 256) || a.state === "rejected" && (!bounded(a.correlationId, 256) || !bounded(a.reason, 4096)) || a.state === "outcome-unknown" && !bounded(a.reason, 4096))) throw new Error("invalid action outcome");
  if (a.content !== undefined) validateControlContent(a.content);
  if (a.kind === "abort" && (a.content !== undefined || a.deliverAs !== undefined || a.contentDigest !== undefined || !legacy && !bounded(a.targetRunId, 1024))) throw new Error("abort action requires a target run and cannot carry send content");
  if (a.kind === "send" && (!legacy && (a.content === undefined || !bounded(a.contentDigest, 1024)) || a.targetRunId !== undefined)) throw new Error("send action requires content and cannot target a run");
  if (a.kind === "approval" && (!bounded(a.targetApprovalId, 1024) || !["approved", "rejected", "cancelled"].includes(String(a.approvalDecision)) || a.targetRunId !== undefined || a.content !== undefined || a.contentDigest !== undefined || a.deliverAs !== undefined)) throw new Error("approval action requires targetApprovalId and decision");
}
function validateMessageEvent(type: AgentSessionEventType, payload: unknown): void {
  const p = payloadRecord(payload);
  const allowed = type === "message.started" ? ["message", "messageIndex", "state"] : type === "message.updated" ? ["message", "update", "updateType", "state", "messageIndex"] : ["message", "state", "messageIndex"];
  exact(p, allowed, `${type} payload`);
  if (p.messageIndex !== undefined && (!Number.isSafeInteger(p.messageIndex) || (p.messageIndex as number) < 0)) throw new Error("invalid messageIndex");
  if (p.state !== undefined) {
    const legal = type === "message.completed" ? ["completed", "failed", "cancelled"] : ["running"];
    if (!legal.includes(String(p.state))) throw new Error("message phase/state mismatch");
  }
  if (p.message !== undefined) validateMessage(p.message);
  if (p.update !== undefined) { if (type !== "message.updated") throw new Error("update outside message.updated"); validateMessageUpdate(p.update); }
  if (p.updateType !== undefined && (type !== "message.updated" || !bounded(p.updateType, 256))) throw new Error("invalid message updateType");
}
function validateMessage(value: unknown): void {
  if (!plain(value)) throw new Error("invalid nested message");
  exact(value, ["role", "content", "toolCallId", "toolResultId", "toolName", "details", "isError", "timestamp", "api", "provider", "model", "usage", "stopReason", "error", "thinking", "contentTypes", "markers", "modelPresent", "usageKeys", "byteLength"], "message");
  if (value.role !== undefined && !["system", "user", "assistant", "tool", "toolResult", "unknown"].includes(String(value.role))) throw new Error("invalid message role");
  for (const key of ["toolCallId", "toolResultId", "toolName", "api", "provider", "stopReason"] as const) if (value[key] !== undefined && !bounded(value[key], 1024)) throw new Error(`invalid message ${key}`);
  if (value.model !== undefined && typeof value.model !== "string" && !plain(value.model)) throw new Error("invalid message model");
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error("invalid message isError");
  if (value.modelPresent !== undefined && typeof value.modelPresent !== "boolean") throw new Error("invalid message modelPresent");
  if (value.timestamp !== undefined && !(typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) && !(typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)))) throw new Error("invalid message timestamp");
  if (value.content !== undefined) validateMessageContent(value.content);
  for (const key of ["contentTypes", "markers", "usageKeys"] as const) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== "string"))) throw new Error(`invalid message ${key}`);
  if (value.byteLength !== undefined && (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0)) throw new Error("invalid message byteLength");
}
function validateMessageUpdate(value: unknown): void {
  if (!plain(value)) throw new Error("invalid message update");
  exact(value, ["type", "contentIndex", "delta", "content", "thinking", "toolCall", "partial"], "message update");
  if (!bounded(value.type, 256)) throw new Error("invalid message update type");
  if (value.contentIndex !== undefined && (!Number.isSafeInteger(value.contentIndex) || (value.contentIndex as number) < 0)) throw new Error("invalid contentIndex");
  for (const key of ["delta", "content", "thinking"] as const) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`invalid message update ${key}`);
  if (value.toolCall !== undefined) validateContentBlock(value.toolCall);
  if (value.partial !== undefined && typeof value.partial !== "string") validateMessage(value.partial);
}
function validateMessageContent(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value) || value.length > 4096) throw new Error("invalid message content");
  for (const block of value) validateContentBlock(block);
}
function validateContentBlock(value: unknown): void {
  if (typeof value === "string") return; // retained captures may contain the canonical "[Circular]" sentinel
  if (!plain(value) || !bounded(value.type, 256)) throw new Error("invalid content block");
  const type = String(value.type);
  if (type === "text") { exact(value, ["type", "text"], "text block"); if (typeof value.text !== "string") throw new Error("invalid text block"); return; }
  if (["thinking", "reasoning"].includes(type)) { exact(value, ["type", "thinking", "text", "signature"], "thinking block"); if (typeof (value.thinking ?? value.text) !== "string" || (value.signature !== undefined && typeof value.signature !== "string")) throw new Error("invalid thinking block"); return; }
  if (["toolCall", "tool-call", "tool_use"].includes(type)) { exact(value, ["type", "id", "toolCallId", "name", "toolName", "arguments", "args", "input", "partialArgs"], "tool-call block"); if (!bounded(value.id ?? value.toolCallId, 1024) || !bounded(value.name ?? value.toolName, 1024) || (value.partialArgs !== undefined && typeof value.partialArgs !== "string")) throw new Error("invalid tool-call block"); return; }
  if (["toolResult", "tool-result", "tool_result"].includes(type)) { exact(value, ["type", "toolCallId", "tool_use_id", "id", "toolResultId", "content", "result", "isError"], "tool-result block"); if (!bounded(value.toolCallId ?? value.tool_use_id, 1024) || (value.id !== undefined && !bounded(value.id, 1024)) || (value.toolResultId !== undefined && !bounded(value.toolResultId, 1024)) || typeof value.isError !== "boolean") throw new Error("invalid tool-result block"); return; }
  if (["image", "image_url"].includes(type)) { exact(value, ["type", "mimeType", "media_type", "data", "uri", "url", "alt"], "image block"); if (value.data !== undefined && typeof value.data !== "string" || value.uri !== undefined && typeof value.uri !== "string" || value.url !== undefined && typeof value.url !== "string" || value.alt !== undefined && typeof value.alt !== "string") throw new Error("invalid image block"); return; }
  if (type === "reference") { exact(value, ["type", "uri", "url", "title", "mediaType"], "reference block"); if (!bounded(value.uri ?? value.url, 2_000_000) || value.title !== undefined && typeof value.title !== "string" || value.mediaType !== undefined && typeof value.mediaType !== "string") throw new Error("invalid reference block"); return; }
  if (type === "error") { exact(value, ["type", "message", "code", "detail"], "error block"); if (typeof value.message !== "string" || value.code !== undefined && typeof value.code !== "string") throw new Error("invalid error block"); return; }
  if (type === "unknown") { exact(value, ["type", "nativeType", "value"], "unknown block"); if (!bounded(value.nativeType, 256) || !own(value, "value")) throw new Error("invalid unknown block"); return; }
  throw new Error("unknown content belongs in unknown.observed");
}
function validateToolEvent(type: AgentSessionEventType, payload: unknown): void {
  const p = payloadRecord(payload);
  const allowed = type === "tool.started" ? ["toolName", "args", "toolIndex", "state", "argKeys"] : type === "tool.updated" ? ["toolName", "args", "partialResult", "toolIndex", "state", "argKeys"] : ["toolName", "args", "result", "isError", "toolIndex", "state", "resultByteLength", "resultMarkers"];
  exact(p, allowed, `${type} payload`);
  if (p.toolName !== undefined && !bounded(p.toolName, 1024)) throw new Error("invalid toolName");
  if (p.toolIndex !== undefined && (!Number.isSafeInteger(p.toolIndex) || (p.toolIndex as number) < 0)) throw new Error("invalid toolIndex");
  if (p.argKeys !== undefined && (!Array.isArray(p.argKeys) || p.argKeys.some(item => typeof item !== "string"))) throw new Error("invalid tool argKeys");
  if (p.resultMarkers !== undefined && (!Array.isArray(p.resultMarkers) || p.resultMarkers.some(item => typeof item !== "string"))) throw new Error("invalid tool resultMarkers");
  if (p.resultByteLength !== undefined && (!Number.isSafeInteger(p.resultByteLength) || (p.resultByteLength as number) < 0)) throw new Error("invalid tool resultByteLength");
  if (p.isError !== undefined && typeof p.isError !== "boolean") throw new Error("invalid tool isError");
  if (p.state !== undefined) { const legal = type === "tool.completed" ? ["completed", "failed", "cancelled"] : ["running"]; if (!legal.includes(String(p.state))) throw new Error("tool phase/state mismatch"); }
  if (type === "tool.completed" && p.isError === true && p.state !== undefined && p.state !== "failed") throw new Error("tool error/state mismatch");
  if (type === "tool.completed" && p.isError === false && p.state === "failed") throw new Error("tool error/state mismatch");
  if (type === "tool.started" && p.args === undefined && p.argKeys === undefined) throw new Error("tool.started requires args");
  if (type === "tool.updated" && p.partialResult === undefined && p.argKeys === undefined) throw new Error("tool.updated requires partialResult");
  if (type === "tool.completed" && p.result === undefined && p.isError === undefined) throw new Error("tool.completed requires an outcome");
}
function payloadRecord(value: unknown): Record<string, unknown> { if (!plain(value)) throw new Error("event payload must be an object"); return value; }
function detachedCanonicalJson(value: unknown): AgentEventEnvelope {
  const seen = new Set<object>(); let nodes = 0;
  const copy = (item: unknown): unknown => {
    if (++nodes > 25_000) throw new Error("event exceeds canonical JSON bounds");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!Number.isFinite(item) || Object.is(item, -0)) throw new Error("event contains a non-canonical JSON number"); return item; }
    if (typeof item !== "object") throw new Error("event contains a non-canonical JSON value");
    if (seen.has(item)) throw new Error("event contains a JSON cycle"); seen.add(item);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item), keys = Reflect.ownKeys(item);
    if (array) {
      if (prototype !== Array.prototype || keys.some(key => typeof key !== "string") || !keys.includes("length")) throw new Error("event contains a non-canonical JSON array");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(item, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 25_000) throw new Error("event contains a non-canonical JSON array");
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1) throw new Error("event contains a non-canonical JSON array");
      const output: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const key = String(index);
        if (!keys.includes(key)) throw new Error("event contains a non-canonical JSON array");
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("event contains a non-canonical JSON property");
        output.push(copy(descriptor.value));
      }
      return output;
    }
    if (prototype !== Object.prototype || keys.some(key => typeof key !== "string")) throw new Error("event contains a non-plain JSON object");
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("event contains a non-canonical JSON property");
      Object.defineProperty(output, key, { value: copy(descriptor.value), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return copy(value) as AgentEventEnvelope;
}
function assertCanonicalJson(value: unknown): void {
  const seen = new Set<object>(); let nodes = 0;
  const walk = (item: unknown): void => {
    if (++nodes > 25_000) throw new Error("event exceeds canonical JSON bounds");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item) || Object.is(item, -0)) throw new Error("event contains a non-canonical JSON number"); return; }
    if (typeof item !== "object") throw new Error("event contains a non-canonical JSON value");
    if (seen.has(item)) throw new Error("event contains a JSON cycle"); seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) || Object.keys(item).length !== item.length) throw new Error("event contains a non-canonical JSON array");
      for (let index = 0; index < item.length; index++) walk(item[index]);
    } else {
      if (!isPlainRecord(item)) throw new Error("event contains a non-plain JSON object");
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== "string")) throw new Error("event contains a symbol-keyed value");
      for (const key of keys as string[]) { const descriptor = Object.getOwnPropertyDescriptor(item, key)!; if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("event contains a non-canonical JSON property"); walk(descriptor.value); }
    }
  };
  walk(value);
}
function assertBoundedJson(value: unknown): void { let nodes = 0; const walk = (item: unknown, depth: number): void => { if (++nodes > 20_000 || depth > 32) throw new Error("event payload exceeds structural bounds"); if (typeof item === "string" && Buffer.byteLength(item) > 2_000_000) throw new Error("event payload string too large"); if (Array.isArray(item)) { if (item.length > 4096) throw new Error("event payload array too large"); for (const v of item) walk(v, depth + 1); } else if (plain(item)) { const entries = Object.entries(item); if (entries.length > 1024) throw new Error("event payload object too large"); for (const [, v] of entries) walk(v, depth + 1); } }; walk(value, 0); if (Buffer.byteLength(JSON.stringify(value)) > 4_000_000) throw new Error("event payload too large"); }
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void { const set = new Set(allowed); if (Object.keys(value).some(key => !set.has(key))) throw new Error(`unexpected ${label} field`); }
function own(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function canonicalBase64(value: string): boolean { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false; return Buffer.from(value, "base64").toString("base64") === value; }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function plain(value: unknown): value is Record<string, unknown> { return isPlainRecord(value); }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
export const UNAVAILABLE_APPROVAL_CAPABILITY: AgentCapability = { name: "approval.resolve", available: false, authority: "unavailable", reason: "pi exposes no typed approval resolution API" };
