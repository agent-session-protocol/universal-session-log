import { messageToolResultLinkage, type AgentApproval, type AgentEventEnvelope, type AgentMessage, type AgentRun, type AgentTool, type AgentTurn, type ContentBlock, type EntityState, type ProvenanceSummary } from "./agent-session-contracts.js";

type Fact = { readonly present: boolean; readonly value?: unknown };
type Candidate = { readonly event: AgentEventEnvelope; readonly value: unknown };

const own = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fact = (present: boolean, value?: unknown): Fact => ({ present, value });
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** The authority cohort is intentionally entity-wide: lower cohorts never fill holes in the winner cohort. */
function cohortRank(event: AgentEventEnvelope): readonly [number, number] {
  const layer = event.source.authenticated && event.source.layer === "L1" ? 3 : event.source.authenticated && event.source.layer === "L2" ? 2 : 1;
  const authority = event.authority === "authoritative" ? 3 : event.authority === "self_reported" ? 2 : 1;
  return [layer, authority];
}
function compareTuple(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function terminalObservation(event: AgentEventEnvelope): boolean { return event.type === "run.settled" || event.type === "turn.completed" || event.type === "message.completed" || event.type === "tool.completed"; }
function compareFieldEvent(a: AgentEventEnvelope, b: AgentEventEnvelope): number {
  const phaseA = terminalObservation(a) ? 1 : 0;
  const phaseB = terminalObservation(b) ? 1 : 0;
  return phaseA - phaseB
    || (a.entityRevision ?? 0) - (b.entityRevision ?? 0)
    || a.confidence - b.confidence
    || Date.parse(a.timestamp) - Date.parse(b.timestamp)
    || lexical(a.eventId, b.eventId);
}
function authorityCohort(observations: readonly AgentEventEnvelope[]): AgentEventEnvelope[] {
  let best = observations[0];
  for (const event of observations.slice(1)) if (compareTuple(cohortRank(event), cohortRank(best!)) > 0) best = event;
  const rank = cohortRank(best!);
  return observations.filter(event => compareTuple(cohortRank(event), rank) === 0);
}
function choose(events: readonly AgentEventEnvelope[], extract: (event: AgentEventEnvelope) => Fact): Candidate | undefined {
  let winner: Candidate | undefined;
  for (const event of events) {
    const extracted = extract(event);
    if (!extracted.present) continue;
    const candidate = { event, value: extracted.value };
    if (!winner || compareFieldEvent(event, winner.event) > 0) winner = candidate;
  }
  return winner;
}
function overallWinner(events: readonly AgentEventEnvelope[]): AgentEventEnvelope {
  return events.reduce((winner, event) => compareFieldEvent(event, winner) > 0 ? event : winner);
}
function provenance(winner: AgentEventEnvelope, observations: readonly AgentEventEnvelope[]): ProvenanceSummary {
  const sourceEventIds = [...new Set(observations.map(event => event.eventId))].sort(lexical);
  return { sourceEventIds, layer: winner.source.layer, adapter: winner.source.adapter, authenticated: winner.source.authenticated, observationCount: sourceEventIds.length };
}
function payload(event: AgentEventEnvelope): Record<string, unknown> { return record(event.payload); }
function messageValue(event: AgentEventEnvelope): unknown {
  const value = payload(event);
  return own(value, "message") ? value.message : event.payload;
}
function messageRecord(event: AgentEventEnvelope): Record<string, unknown> { return record(messageValue(event)); }
function nestedMessageFact(event: AgentEventEnvelope, key: string): Fact {
  const raw = messageValue(event);
  if (key === "content" && typeof raw === "string") return fact(true, raw);
  const message = record(raw);
  return fact(own(message, key), message[key]);
}
function payloadFact(event: AgentEventEnvelope, key: string): Fact { const value = payload(event); return fact(own(value, key), value[key]); }
function correlationFact(event: AgentEventEnvelope, key: keyof NonNullable<AgentEventEnvelope["correlation"]>): Fact {
  const correlation = event.correlation;
  return fact(Boolean(correlation && own(correlation as unknown as Record<string, unknown>, key)), correlation?.[key]);
}
function numberOr(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function stringOr(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function terminalState(value: unknown, fallback: EntityState): EntityState { return ["pending", "running", "completed", "failed", "cancelled"].includes(String(value)) ? value as EntityState : fallback; }
function unknownBlock(nativeType: string, value: unknown): ContentBlock { return { type: "unknown", nativeType, value }; }
function firstOwn(value: Record<string, unknown>, keys: readonly string[], fallback: unknown): unknown {
  for (const key of keys) if (own(value, key)) return value[key];
  return fallback;
}

export function normalizeContent(message: unknown): ContentBlock[] {
  const container = record(message);
  const content = container.content;
  const values = Array.isArray(content) ? content : own(container, "content") ? [content] : typeof message === "string" ? [message] : [];
  return values.map((item): ContentBlock => {
    if (typeof item === "string") return { type: "text", text: item };
    const block = record(item), type = typeof block.type === "string" ? block.type : "unknown";
    if (type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if ((type === "thinking" || type === "reasoning") && typeof (block.thinking ?? block.text) === "string") return { type: "thinking", text: String(block.thinking ?? block.text), ...(typeof block.signature === "string" ? { signature: block.signature } : {}) };
    if (["toolCall", "tool-call", "tool_use"].includes(type) && typeof (block.id ?? block.toolCallId) === "string") return { type: "tool-call", toolCallId: String(block.id ?? block.toolCallId), name: String(block.name ?? block.toolName ?? "unknown"), arguments: firstOwn(block, ["arguments", "args", "input"], null) };
    if (["toolResult", "tool-result", "tool_result"].includes(type) && typeof (block.toolCallId ?? block.tool_use_id) === "string") return { type: "tool-result", toolCallId: String(block.toolCallId ?? block.tool_use_id), toolResultId: String(block.toolResultId ?? block.id ?? `result:${block.toolCallId ?? block.tool_use_id}`), content: firstOwn(block, ["content", "result"], null), isError: Boolean(block.isError) };
    if (type === "image" || type === "image_url") return { type: "image", mimeType: String(block.mimeType ?? block.media_type ?? "application/octet-stream"), ...(typeof block.data === "string" ? { data: block.data } : {}), ...(typeof (block.uri ?? block.url) === "string" ? { uri: String(block.uri ?? block.url) } : {}), ...(typeof block.alt === "string" ? { alt: block.alt } : {}) };
    if (type === "reference" && typeof (block.uri ?? block.url) === "string") return { type: "reference", uri: String(block.uri ?? block.url), ...(typeof block.title === "string" ? { title: block.title } : {}) };
    if (type === "error") return { type: "error", message: String(block.message ?? "unknown error"), detail: item };
    // Idempotency fix (USL spike): an already-canonical unknown block must not
    // be double-wrapped, or its nativeType is lost on materialization.
    if (type === "unknown" && typeof block.nativeType === "string" && own(block, "value")) return item as ContentBlock;
    return unknownBlock(type, item);
  });
}

function role(value: unknown): AgentMessage["role"] {
  const raw = String(value);
  return raw === "toolResult" ? "tool" : ["system", "user", "assistant", "tool"].includes(raw) ? raw as AgentMessage["role"] : "unknown";
}
function stateFact(event: AgentEventEnvelope): Fact {
  const value = payload(event);
  if (event.type === "message.completed" || event.type === "tool.completed") return fact(true, terminalState(value.state, event.type === "tool.completed" && value.isError === true ? "failed" : "completed"));
  return fact(true, "running");
}
function indexFact(event: AgentEventEnvelope, primary: string, fallback?: string): Fact {
  const value = payload(event);
  if (own(value, primary)) return fact(true, value[primary]);
  return fallback && own(value, fallback) ? fact(true, value[fallback]) : fact(false);
}
function linkageFact(event: AgentEventEnvelope, key: "runId" | "turnId" | "parentId" | "toolCallId" | "toolResultId"): Fact {
  const resultLink = messageToolResultLinkage(event);
  if (key === "toolCallId" && resultLink) return fact(true, resultLink.toolCallId);
  if (key === "toolResultId" && resultLink) return fact(true, resultLink.toolResultId);
  const correlated = correlationFact(event, key);
  if (correlated.present) return correlated;
  return fact(false);
}

export function materializeRun(observations: readonly AgentEventEnvelope[], id: string): AgentRun {
  const cohort = authorityCohort(observations), winner = overallWinner(cohort), terminals = cohort.filter(event => event.type === "run.settled");
  const terminalChronologically = terminals.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId));
  const terminal = terminalChronologically.length ? overallWinner(terminalChronologically) : undefined;
  const completed = terminalChronologically.at(-1);
  const chronologically = [...cohort].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId));
  const started = chronologically[0]!;
  const terminalPayload = terminal ? payload(terminal) : {};
  return {
    id, state: terminal ? terminalState(terminalPayload.state, "completed") : "running",
    revision: Math.max(...cohort.map(event => event.entityRevision ?? 1)),
    turnIds: [], messageIds: [], toolCallIds: [], startedAt: started.timestamp,
    ...(completed ? { completedAt: completed.timestamp } : {}),
    provenance: provenance(winner, observations),
  };
}

export function materializeTurn(observations: readonly AgentEventEnvelope[], id: string): AgentTurn {
  const cohort = authorityCohort(observations), winner = overallWinner(cohort), terminals = cohort.filter(event => event.type === "turn.completed");
  const terminalChronologically = terminals.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId));
  const terminal = terminalChronologically.length ? overallWinner(terminalChronologically) : undefined;
  const completed = terminalChronologically.at(-1);
  const chronologically = [...cohort].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId));
  const started = chronologically[0]!;
  const run = choose(cohort, event => correlationFact(event, "runId"));
  const index = choose(cohort, event => payloadFact(event, "turnIndex"));
  const terminalPayload = terminal ? payload(terminal) : {};
  return {
    id, runId: stringOr(run?.value, ""), ...(index && typeof index.value === "number" ? { index: index.value } : {}),
    state: terminal ? terminalState(terminalPayload.state, "completed") : "running",
    revision: Math.max(...cohort.map(event => event.entityRevision ?? 1)), messageIds: [], toolCallIds: [],
    startedAt: started.timestamp, ...(completed ? { completedAt: completed.timestamp } : {}),
    provenance: provenance(winner, observations),
  };
}

export function materializeMessage(observations: readonly AgentEventEnvelope[], id: string): AgentMessage {
  const cohort = authorityCohort(observations), winner = overallWinner(cohort);
  const get = (extract: (event: AgentEventEnvelope) => Fact): Candidate | undefined => choose(cohort, extract);
  const runId = stringOr(get(event => linkageFact(event, "runId"))?.value, "");
  const turnId = get(event => linkageFact(event, "turnId"));
  const parentId = get(event => linkageFact(event, "parentId"));
  const toolCallIdFact = get(event => linkageFact(event, "toolCallId"));
  const toolCallId = typeof toolCallIdFact?.value === "string" ? toolCallIdFact.value : undefined;
  const toolResultFact = get(event => linkageFact(event, "toolResultId"));
  const toolResultId = typeof toolResultFact?.value === "string" ? toolResultFact.value : toolCallId ? `result:${toolCallId}` : undefined;
  const order = get(event => indexFact(event, "messageIndex", "turnIndex"));
  const roleValue = role(get(event => nestedMessageFact(event, "role"))?.value);
  const content = get(event => nestedMessageFact(event, "content"));
  const errorFlag = get(event => nestedMessageFact(event, "isError"));
  let blocks = content ? normalizeContent({ content: content.value }) : [];
  if (roleValue === "tool" && toolCallId && toolResultId && !blocks.some(block => block.type === "tool-result")) blocks = [{ type: "tool-result", toolCallId, toolResultId, content: content?.value ?? null, isError: Boolean(errorFlag?.value) }];
  const state = get(stateFact)!;
  const revision = Math.max(...cohort.map(event => event.entityRevision ?? 1));
  const chronologically = [...cohort].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId));
  const earliest = chronologically[0]!, latest = chronologically[chronologically.length - 1]!;
  const value: AgentMessage = {
    id, runId,
    ...(typeof turnId?.value === "string" ? { turnId: turnId.value } : {}),
    ...(typeof parentId?.value === "string" ? { parentId: parentId.value } : {}),
    ...(toolCallId ? { toolCallId } : {}), ...(toolResultId ? { toolResultId } : {}),
    order: numberOr(order?.value, Date.parse(latest.timestamp)), role: roleValue,
    state: state.value as EntityState, revision, blocks,
    createdAt: earliest.timestamp, updatedAt: latest.timestamp,
    ...optionalMessageField(cohort, "model"), ...optionalMessageField(cohort, "thinking"),
    ...optionalMessageField(cohort, "usage"), ...optionalMessageField(cohort, "stopReason"),
    ...optionalMessageField(cohort, "error"), provenance: provenance(winner, observations),
  };
  return value;
}
function optionalMessageField(events: readonly AgentEventEnvelope[], key: "model" | "thinking" | "usage" | "stopReason" | "error"): Record<string, unknown> {
  const selected = choose(events, event => nestedMessageFact(event, key));
  return selected ? { [key]: selected.value } : {};
}

export function materializeTool(observations: readonly AgentEventEnvelope[], id: string): AgentTool {
  const cohort = authorityCohort(observations), winner = overallWinner(cohort);
  const get = (extract: (event: AgentEventEnvelope) => Fact): Candidate | undefined => choose(cohort, extract);
  const runId = get(event => correlationFact(event, "runId"));
  const turnId = get(event => correlationFact(event, "turnId"));
  const parentMessageId = get(event => correlationFact(event, "messageId"));
  const toolResultId = get(event => correlationFact(event, "toolResultId"));
  const order = get(event => indexFact(event, "toolIndex"));
  const name = get(event => payloadFact(event, "toolName"));
  const state = get(stateFact)!;
  const revision = Math.max(...cohort.map(event => event.entityRevision ?? 1));
  const argumentsFact = get(event => payloadFact(event, "args"));
  const chronologically = [...cohort].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId));
  const earliest = chronologically[0]!, latest = chronologically[chronologically.length - 1]!;
  const optional = (key: "partialResult" | "result" | "isError"): Record<string, unknown> => {
    const selected = get(event => payloadFact(event, key));
    if (!selected) return {};
    return { [key]: key === "isError" ? Boolean(selected.value) : selected.value };
  };
  return {
    id, runId: stringOr(runId?.value, ""),
    ...(typeof turnId?.value === "string" ? { turnId: turnId.value } : {}),
    ...(typeof parentMessageId?.value === "string" ? { parentMessageId: parentMessageId.value } : {}),
    ...(typeof toolResultId?.value === "string" ? { toolResultId: toolResultId.value } : {}),
    order: numberOr(order?.value, Date.parse(latest.timestamp)), name: stringOr(name?.value, "unknown"),
    state: state.value as EntityState, revision,
    arguments: argumentsFact ? argumentsFact.value : null,
    ...optional("partialResult"), ...optional("result"), ...optional("isError"),
    createdAt: earliest.timestamp, updatedAt: latest.timestamp, provenance: provenance(winner, observations),
  };
}

export function materializeApproval(observations: readonly AgentEventEnvelope[], id: string): AgentApproval {
  const cohort = authorityCohort(observations), winner = overallWinner(cohort);
  const requested = [...cohort].filter(event => event.type === "approval.requested").sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || lexical(a.eventId, b.eventId))[0];
  if (!requested) throw new Error(`approval ${id} has no request observation`);
  const resolutions = cohort.filter(event => event.type === "approval.resolved");
  const resolved = resolutions.length ? overallWinner(resolutions) : undefined;
  const requestPayload = payload(requested), resolutionPayload = resolved ? payload(resolved) : {};
  const decision = resolved && ["approved", "rejected", "cancelled"].includes(String(resolutionPayload.decision)) ? resolutionPayload.decision as AgentApproval["decision"] : undefined;
  return {
    id,
    ...(requested.correlation?.runId ? { runId: requested.correlation.runId } : {}),
    ...(requested.correlation?.turnId ? { turnId: requested.correlation.turnId } : {}),
    ...(requested.correlation?.toolCallId ? { toolCallId: requested.correlation.toolCallId } : {}),
    kind: stringOr(requestPayload.kind, "permission"),
    ...(typeof requestPayload.toolName === "string" ? { toolName: requestPayload.toolName } : {}),
    ...(typeof requestPayload.summary === "string" ? { summary: requestPayload.summary } : {}),
    state: decision ?? "pending",
    ...(decision ? { decision } : {}),
    ...(resolved && own(resolutionPayload, "response") ? { response: resolutionPayload.response } : {}),
    ...(typeof resolutionPayload.reason === "string" ? { reason: resolutionPayload.reason } : {}),
    requestedAt: requested.timestamp,
    ...(resolved ? { resolvedAt: resolved.timestamp } : {}),
    revision: Math.max(...cohort.map(event => event.entityRevision ?? 1)),
    provenance: provenance(winner, observations),
  };
}
