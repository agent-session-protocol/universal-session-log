import { readFileSync } from "node:fs";
import {
  jsonValue,
  type AgentSessionEventType,
  type ContentBlock,
} from "./asp-schema/agent-session-contracts.js";
import { makeBundle, makeSourceArtifact, makeSourceProvenance, sha256Of, type FidelityAxis, type SessionBundle } from "./bundle.js";
import { EvidenceBuilder, importSourceFor, type EmitOptions } from "./evidence.js";
import { buildSnapshot } from "./materialize.js";

/**
 * Claude Code session file -> asp-bundle.
 *
 * Claude Code stores sessions as JSONL under
 *   ~/.claude/projects/<cwd-with-dashes>/<session-uuid>.jsonl
 * Entries form a single chain via uuid/parentUuid. Observed entry types:
 *   assistant, user, attachment, queue-operation, custom-title, ai-title,
 *   last-prompt, mode (plus system/summary in other corpora).
 *
 * Key format semantics discovered on real logs (2026-08, see research doc):
 * - Assistant API messages are journaled at BLOCK granularity: multiple
 *   entries share one `message.id`, each appending one new content block.
 *   The logical message = concatenation of the group's blocks in file order;
 *   `usage` is repeated identically on every entry of the group.
 * - `thinking` blocks carry `signature` (required by the Anthropic API when
 *   the conversation is resumed); we preserve it into the canonical thinking
 *   block, which is the whole point of the spike.
 * - `tool_result` blocks arrive inside *user* entries; the entry level may
 *   also carry a redundant structured `toolUseResult`.
 * - `isSidechain: true` marks sub-agent (Task tool) messages interleaved in
 *   the same file. We keep them in the timeline and preserve the branch via
 *   parentId linkage; the flag itself is declared evidence-only.
 */

type Record = { [key: string]: unknown };
const record = (value: unknown): Record => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const iso = (value: unknown): string => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date(0).toISOString());

interface ParsedEntry {
  readonly index: number;
  readonly entry: Record;
}

/** Timeline item: a plain entry, or a merged assistant block-append group. */
type TimelineItem =
  | { readonly kind: "entry"; readonly entry: Record; readonly index: number }
  | { readonly kind: "assistant-group"; readonly entries: readonly Record[]; readonly index: number };

function claudeBlocksToCanonical(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item): ContentBlock => {
    if (typeof item === "string") return { type: "text", text: item };
    const block = record(item);
    const type = String(block.type ?? "unknown");
    if (type === "text") return { type: "text", text: String(block.text ?? "") };
    if (type === "thinking") return { type: "thinking", text: String(block.thinking ?? block.text ?? ""), ...(typeof block.signature === "string" ? { signature: block.signature } : {}) };
    if (type === "tool_use") return { type: "tool-call", toolCallId: String(block.id ?? ""), name: String(block.name ?? "unknown"), arguments: jsonValue(block.input ?? {}) };
    if (type === "tool_result") return { type: "tool-result", toolCallId: String(block.tool_use_id ?? ""), toolResultId: String(block.id ?? `result:${String(block.tool_use_id ?? "")}`), content: jsonValue(block.content ?? null), isError: block.is_error === true };
    if (type === "image") {
      const source = record(block.source);
      return { type: "image", mimeType: String(source.media_type ?? block.mimeType ?? "application/octet-stream"), ...(typeof source.data === "string" ? { data: source.data } : {}), ...(typeof block.uri === "string" ? { uri: block.uri } : {}) };
    }
    return { type: "unknown", nativeType: type, value: jsonValue(item) };
  });
}

export interface ClaudeImportOptions {
  readonly sourcePath?: string;
}

export interface ClaudeImportResult {
  readonly bundle: SessionBundle;
}

export function importClaudeSession(text: string, options: ClaudeImportOptions = {}): ClaudeImportResult {
  const digest = sha256Of(text);
  const lines = text.split("\n").filter(line => line.trim().length > 0);
  const parsed: ParsedEntry[] = lines.map((line, index) => {
    try { return { index, entry: record(JSON.parse(line)) }; }
    catch (error) { throw new Error(`malformed claude session line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  if (parsed.length === 0) throw new Error("claude session file is empty");

  const sessionId = parsed.map(p => str(p.entry.sessionId)).find(Boolean);
  if (!sessionId) throw new Error("claude session file has no entry with a sessionId");
  const source = importSourceFor(sessionId, digest);
  const builder = new EvidenceBuilder(source);
  const cwd = parsed.map(p => str(p.entry.cwd)).find(Boolean);

  const firstTimestamp = iso(parsed[0]!.entry.timestamp);
  builder.emit("session.started", { reason: "import", ...(cwd ? { cwd } : {}) }, { nativeEventId: sessionId, timestamp: firstTimestamp, correlation: { agentSessionId: source.agentSessionId } });

  // --- Preprocess: merge assistant block-append groups (same message.id). ---
  const groups = new Map<string, Record[]>(); // message.id -> entries in file order
  const timeline: TimelineItem[] = [];
  for (const { entry } of parsed) {
    if (String(entry.type) === "assistant") {
      const message = record(entry.message);
      const key = str(message.id) ?? str(entry.uuid) ?? `line:${parsed.indexOf({ index: -1, entry })}`;
      const list = groups.get(key);
      if (list) list.push(entry);
      else {
        groups.set(key, [entry]);
        timeline.push({ kind: "assistant-group", entries: groups.get(key)!, index: -1 });
      }
      continue;
    }
    timeline.push({ kind: "entry", entry, index: 0 });
  }
  // Resolve timeline positions: assistant groups sit at their LAST entry's index
  // (the completion point); plain entries at their own index.
  const indexOfEntry = new Map<Record, number>(parsed.map(p => [p.entry, p.index]));
  const positioned: TimelineItem[] = timeline.map(item => {
    if (item.kind === "entry") return { ...item, index: indexOfEntry.get(item.entry)! };
    return { ...item, index: indexOfEntry.get(item.entries[item.entries.length - 1]!)! };
  }).sort((a, b) => a.index - b.index);

  const loss: string[] = [];
  let messageIndex = 0;
  let toolIndex = 0;
  let currentRun: { runId: string; turnId: string } | undefined;
  const declaredTools = new Map<string, { name: string; arguments: unknown }>();
  const messageIdByUuid = new Map<string, string>();
  let supersededBlocks = 0;

  const closeRun = (): void => {
    if (!currentRun) return;
    const last = builder.events[builder.events.length - 1];
    builder.emit("turn.completed", { turnIndex: 0, state: "completed" }, { timestamp: last?.timestamp, correlation: { runId: currentRun.runId, turnId: currentRun.turnId }, entityRevision: 2 });
    builder.emit("run.settled", { state: "completed", idle: true }, { timestamp: last?.timestamp, correlation: { runId: currentRun.runId }, entityRevision: 2 });
  };
  const openRun = (seed: string, startedAt: string): void => {
    const runId = `run:import:${sessionId}:${seed}`;
    const turnId = `turn:${runId}:0`;
    currentRun = { runId, turnId };
    builder.emit("run.started", { state: "running" }, { nativeEventId: `import:${seed}:run:start`, timestamp: startedAt, correlation: { runId }, entityRevision: 1 });
    builder.emit("turn.started", { turnIndex: 0, state: "running" }, { nativeEventId: `import:${seed}:turn:start`, timestamp: startedAt, correlation: { runId, turnId }, entityRevision: 1 });
  };
  const ensureRun = (seed: string, startedAt: string): void => { if (!currentRun) openRun(seed, startedAt); };

  const emit = (type: AgentSessionEventType, payload: unknown, options: EmitOptions) => builder.emit(type, payload, options);

  const parentMessageId = (entry: Record): string | undefined => {
    const parentUuid = str(entry.parentUuid);
    return parentUuid ? messageIdByUuid.get(parentUuid) : undefined;
  };

  const emitToolResult = (block: Record, entry: Record, timestamp: string): void => {
    const toolCallId = str(block.tool_use_id);
    if (!toolCallId) { loss.push("tool_result block without tool_use_id dropped from canonical projection"); return; }
    ensureRun(str(entry.uuid) ?? `line:${indexOfEntry.get(entry) ?? 0}`, timestamp);
    const toolResultId = str(block.id) ?? `result:${toolCallId}`;
    const messageId = `message:${sessionId}:${str(entry.uuid) ?? `line:${indexOfEntry.get(entry) ?? 0}`}:${toolCallId}`;
    const declared = declaredTools.get(toolCallId);
    const entryFallback = record(entry.toolUseResult);
    const resultContent = block.content !== undefined ? jsonValue(block.content) : Object.keys(entryFallback).length > 0 ? jsonValue(entry.toolUseResult) : null;
    const isError = block.is_error === true;
    const correlation = { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId, toolCallId, toolResultId };
    const nestedMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId, toolResultId, content: resultContent, isError }],
      toolCallId, toolResultId, toolName: declared?.name ?? "unknown",
      timestamp,
    };
    emit("message.completed", { message: nestedMessage, messageIndex: messageIndex++, state: "completed" }, { nativeEventId: str(entry.uuid), timestamp, correlation, entityRevision: 1 });
    if (str(entry.uuid)) messageIdByUuid.set(str(entry.uuid)!, messageId);
    emit("tool.completed", {
      toolName: declared?.name ?? "unknown", args: declared?.arguments ?? {}, result: resultContent, isError,
      state: isError ? "failed" : "completed", toolIndex: toolIndex++,
    }, { nativeEventId: str(entry.uuid), timestamp, correlation, entityRevision: 1 });
  };

  for (const item of positioned) {
    if (item.kind === "assistant-group") {
      const entries = item.entries;
      const first = entries[0]!;
      const last = entries[entries.length - 1]!;
      if (entries.length > 1) supersededBlocks += entries.length - 1;
      const timestamp = iso(last.timestamp ?? first.timestamp);
      ensureRun(str(first.uuid) ?? `group:${item.index}`, timestamp);
      const message = record(last.message);
      const blocks = entries.flatMap(e => claudeBlocksToCanonical(record(e.message).content));
      const messageId = `message:${sessionId}:${str(message.id) ?? str(last.uuid) ?? `group:${item.index}`}`;
      const nativeEventId = str(last.uuid) ?? str(first.uuid);
      // tool_use declarations for later tool.completed arg/name resolution.
      for (const e of entries) {
        for (const block of claudeBlocksToCanonical(record(e.message).content)) {
          if (block.type === "tool-call") declaredTools.set(block.toolCallId, { name: block.name, arguments: block.arguments });
        }
      }
      const parentId = parentMessageId(first) ?? parentMessageId(last);
      emit("message.completed", {
        message: {
          role: "assistant",
          content: blocks,
          ...(str(message.model) ? { model: str(message.model) } : {}),
          ...(message.usage !== undefined ? { usage: jsonValue(message.usage) } : {}),
          ...(str(message.stop_reason) ? { stopReason: str(message.stop_reason) } : {}),
          details: { claudeMessageId: str(message.id) ?? null, isSidechain: first.isSidechain === true },
          timestamp,
        },
        messageIndex: messageIndex++, state: "completed",
      }, { nativeEventId, timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId, ...(parentId ? { parentId } : {}) }, entityRevision: 1 });
      for (const e of entries) if (str(e.uuid)) messageIdByUuid.set(str(e.uuid)!, messageId);
      continue;
    }

    const entry = item.entry;
    const type = String(entry.type ?? "unknown");
    const timestamp = iso(entry.timestamp);
    const uuid = str(entry.uuid);

    if (type !== "user") {
      // queue-operation / attachment / custom-title / ai-title / last-prompt /
      // mode / system / anything else: evidence-only.
      emit("unknown.observed", { nativeType: `entry:${type}`, value: jsonValue(entry) }, { nativeEventId: uuid, timestamp });
      continue;
    }

    const message = record(entry.message);
    const content = message.content;
    const blocks = claudeBlocksToCanonical(content);
    const toolResults = Array.isArray(content) ? (content as unknown[]).map(v => record(v)).filter(b => String(b.type) === "tool_result") : [];
    const textBlocks = blocks.filter(b => b.type === "text" || b.type === "image" || b.type === "unknown" || b.type === "reference" || b.type === "error");
    const isMeta = entry.isMeta === true;
    const isPrompt = toolResults.length === 0 && textBlocks.length > 0 && !isMeta && entry.isSidechain !== true;

    if (isPrompt) {
      closeRun();
      openRun(uuid ?? `line:${item.index}`, timestamp);
    }
    ensureRun(uuid ?? `line:${item.index}`, timestamp);

    if (toolResults.length > 0) {
      for (const block of toolResults) emitToolResult(block, entry, timestamp);
      // A user entry that ALSO carries text (rare) emits the text as a user message.
      if (textBlocks.length === 0) continue;
    }

    if (textBlocks.length > 0) {
      const messageId = `message:${sessionId}:${uuid ?? `line:${item.index}`}`;
      emit("message.completed", {
        message: { role: "user", content: textBlocks, details: { isMeta, isSidechain: entry.isSidechain === true, promptId: str(entry.promptId) ?? null }, timestamp },
        messageIndex: messageIndex++, state: "completed",
      }, { nativeEventId: uuid, timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId, ...(parentMessageId(entry) ? { parentId: parentMessageId(entry) } : {}) }, entityRevision: 1 });
      if (uuid) messageIdByUuid.set(uuid, messageId);
      continue;
    }
  }
  closeRun();
  const lastEvent = builder.events[builder.events.length - 1];
  builder.emit("session.ended", { reason: "import complete", state: "exited" }, { timestamp: lastEvent?.timestamp });

  if (supersededBlocks > 0) loss.push(`${supersededBlocks} assistant block-append entries merged into their logical messages (streaming granularity not projected)`);
  const unresolvedTools = [...declaredTools.keys()].filter(id => !builder.events.some(e => e.type === "tool.completed" && e.correlation?.toolCallId === id));
  if (unresolvedTools.length > 0) loss.push(`${unresolvedTools.length} tool call(s) without a matching tool_result remain without a tool.completed event`);

  const snapshot = buildSnapshot({ agentSessionId: source.agentSessionId, nativeSessionId: sessionId, ...(cwd ? { cwd } : {}), evidence: builder.events });
  const fidelity: FidelityAxis[] = [
    { axis: "messages", level: "preserved", detail: "user/assistant/tool messages in chain order; assistant block-append journal merged per message.id" },
    { axis: "content-blocks", level: "preserved", detail: "text/thinking/tool_use/tool_result/image; unmapped blocks kept as typed unknown" },
    { axis: "tool-chain", level: "preserved", detail: "tool_use id ↔ tool_result tool_use_id pairing; args from declaration, result from block (entry toolUseResult as fallback)" },
    { axis: "thinking", level: "preserved", detail: "thinking text AND signature (required for Anthropic-side resume verification)" },
    { axis: "streaming-granularity", level: "partial", detail: "block-append journal merged into complete messages; per-append timestamps not projected" },
    { axis: "run-boundaries", level: "partial", detail: "runs inferred from user prompt entries; claude logs do not record run lifecycle" },
    { axis: "turn-boundaries", level: "partial", detail: "one synthesized turn per inferred run" },
    { axis: "sidechain-structure", level: "partial", detail: "sub-agent branches preserved via parentId linkage; the isSidechain flag itself is message details only" },
    { axis: "model/usage", level: "preserved", detail: "per-message model + full usage object (cache_creation/cache_read/service_tier…) projected into pivot" },
    { axis: "attachments", level: "evidence-only", detail: "attachment entries kept as unknown.observed" },
    { axis: "meta-entries", level: "evidence-only", detail: "queue-operation/custom-title/ai-title/last-prompt/mode kept as unknown.observed" },
    { axis: "compaction", level: "not-in-source", detail: "no compaction boundary observed in the sampled corpus" },
    { axis: "approvals", level: "not-in-source", detail: "permission decisions are not recorded in the session log" },
  ];
  const bundle = makeBundle({
    native: { harness: "claude", sessionId, ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}), sourceSha256: digest },
    provenance: makeSourceProvenance("claude", [makeSourceArtifact({ bytes: text, logicalPath: options.sourcePath, role: "session-log" })]),
    pivot: snapshot,
    evidence: builder.events,
    fidelity,
    loss,
  });
  return { bundle };
}

export function importClaudeSessionFile(path: string): ClaudeImportResult {
  return importClaudeSession(readFileSync(path, "utf8"), { sourcePath: path });
}
