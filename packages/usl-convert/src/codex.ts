import { readFileSync } from "node:fs";
import {
  jsonValue,
  stableId,
  type AgentMessage,
  type AgentSessionEventType,
  type AgentTool,
  type ContentBlock,
} from "./asp-schema/agent-session-contracts.ts";
import { makeBundle, sha256Of, type FidelityAxis, type SessionBundle } from "./bundle.ts";
import { EvidenceBuilder, importSourceFor, type EmitOptions } from "./evidence.ts";
import { buildSnapshot } from "./materialize.ts";

/**
 * Codex CLI rollout file -> e-session-bundle.
 *
 * Codex stores sessions as JSONL under
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * Records are `{timestamp, type, payload}` with type in
 *   session_meta | response_item | event_msg | turn_context
 *
 * Key format semantics discovered on real logs (cli 0.36.0, 2025-09):
 * - DUAL STREAM: `response_item` carries the OpenAI Responses API items
 *   (message / reasoning / function_call / function_call_output) — the
 *   protocol truth — while `event_msg` carries the TUI render stream
 *   (user_message / agent_message / agent_reasoning / token_count /
 *   turn_aborted). Logical events appear in BOTH streams; we dedup with
 *   response_item as authoritative and keep only token_count / turn_aborted
 *   from event_msg (evidence-only).
 * - `reasoning` items carry an OPAQUE `encrypted_content` blob (~1KB) plus a
 *   plaintext `summary[]`. The blob cannot be parsed but MUST round-trip for
 *   a codex-side resume. We project summary -> thinking block and keep the
 *   blob in a typed unknown block of the same message.
 * - `turn_context` records per-turn settings (cwd/approval_policy/
 *   sandbox_policy/model) and doubles as the run boundary signal.
 */

type Record = { [key: string]: unknown };
const record = (value: unknown): Record => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const iso = (value: unknown): string => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString());

const REASONING_UNKNOWN_TYPE = "codex.encrypted_reasoning";

function messageContentToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item): ContentBlock => {
    if (typeof item === "string") return { type: "text", text: item };
    const block = record(item);
    const type = String(block.type ?? "unknown");
    if (type === "input_text" || type === "output_text" || type === "text") return { type: "text", text: String(block.text ?? "") };
    if (type === "input_image" || type === "image") return { type: "image", mimeType: String(block.media_type ?? block.mimeType ?? "application/octet-stream"), ...(typeof (block.image_url ?? block.data) === "string" ? { data: String(block.image_url ?? block.data) } : {}) };
    return { type: "unknown", nativeType: type, value: jsonValue(item) };
  });
}

export interface CodexImportOptions {
  readonly sourcePath?: string;
}

export interface CodexImportResult {
  readonly bundle: SessionBundle;
}

export function importCodexSession(text: string, options: CodexImportOptions = {}): CodexImportResult {
  const digest = sha256Of(text);
  const lines = text.split("\n").filter(line => line.trim().length > 0);
  const records = lines.map((line, index) => {
    try { return record(JSON.parse(line)); }
    catch (error) { throw new Error(`malformed codex rollout line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  const meta = records.find(r => String(r.type) === "session_meta");
  const metaPayload = record(meta?.payload);
  const sessionId = str(metaPayload.id);
  if (!sessionId) throw new Error("codex rollout has no session_meta with an id");
  const source = importSourceFor(sessionId, digest);
  const builder = new EvidenceBuilder(source);
  const cwd = str(metaPayload.cwd) ?? records.map(r => str(record(r.payload).cwd)).find(Boolean);

  const loss: string[] = [];
  let messageIndex = 0;
  let toolIndex = 0;
  let currentRun: { runId: string; turnId: string } | undefined;
  const declaredTools = new Map<string, { name: string; arguments: unknown }>();

  builder.emit("session.started", { reason: "import", ...(cwd ? { cwd } : {}) }, { timestamp: iso(meta?.timestamp), correlation: { agentSessionId: source.agentSessionId } });

  const closeRun = (state: "completed" | "cancelled" = "completed"): void => {
    if (!currentRun) return;
    const last = builder.events[builder.events.length - 1];
    builder.emit("turn.completed", { turnIndex: 0, state }, { timestamp: last?.timestamp, correlation: { runId: currentRun.runId, turnId: currentRun.turnId }, entityRevision: 2 });
    builder.emit("run.settled", { state, idle: true, ...(state === "cancelled" ? { abortObserved: true } : {}) }, { timestamp: last?.timestamp, correlation: { runId: currentRun.runId }, entityRevision: 2 });
  };
  const openRun = (seed: string, startedAt: string, modelPresent: boolean): void => {
    const runId = `run:import:${sessionId}:${seed}`;
    const turnId = `turn:${runId}:0`;
    currentRun = { runId, turnId };
    builder.emit("run.started", { state: "running", ...(modelPresent ? { modelPresent } : {}) }, { nativeEventId: `import:${seed}:run:start`, timestamp: startedAt, correlation: { runId }, entityRevision: 1 });
    builder.emit("turn.started", { turnIndex: 0, state: "running" }, { nativeEventId: `import:${seed}:turn:start`, timestamp: startedAt, correlation: { runId, turnId }, entityRevision: 1 });
  };
  const ensureRun = (seed: string, startedAt: string): void => { if (!currentRun) openRun(seed, startedAt, false); };

  const emit = (type: AgentSessionEventType, payload: unknown, options: EmitOptions) => builder.emit(type, payload, options);

  for (const [index, item] of records.entries()) {
    const type = String(item.type ?? "unknown");
    const payload = record(item.payload);
    const timestamp = iso(item.timestamp);
    const seed = `rec:${index}`;

    if (type === "session_meta") {
      // Keep the full native payload as evidence so the exporter can emit it
      // verbatim (cli_version / model_provider / originator / instructions).
      emit("unknown.observed", { nativeType: "codex.session_meta", value: jsonValue(payload) }, { timestamp });
      continue;
    }

    if (type === "turn_context") {
      closeRun();
      openRun(seed, timestamp, str(payload.model) !== undefined);
      // Keep the full native turn_context payload (model / approval_policy /
      // sandbox_policy) for round-trip export, correlated to the new run.
      emit("unknown.observed", { nativeType: "codex.turn_context", value: jsonValue(payload) }, { timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId } });
      continue;
    }

    if (type === "event_msg") {
      const kind = String(payload.type ?? "");
      if (kind === "token_count" || kind === "turn_aborted") {
        ensureRun(seed, timestamp);
        emit("unknown.observed", { nativeType: `codex.${kind}`, value: jsonValue(payload) }, { timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId } });
        if (kind === "turn_aborted") closeRun("cancelled");
      }
      // user_message / agent_message / agent_reasoning duplicate response_item content: skipped by design.
      continue;
    }

    if (type !== "response_item") {
      emit("unknown.observed", { nativeType: `codex.record:${type}`, value: jsonValue(payload) }, { timestamp });
      continue;
    }

    const itemType = String(payload.type ?? "unknown");
    ensureRun(seed, timestamp);

    if (itemType === "message") {
      const role = String(payload.role ?? "unknown");
      const blocks = messageContentToBlocks(payload.content);
      const canonicalRole = role === "user" || role === "assistant" || role === "system" ? role : "unknown";
      const messageId = `message:${sessionId}:${index}`;
      emit("message.completed", { message: { role: canonicalRole, content: blocks, timestamp }, messageIndex: messageIndex++, state: "completed" }, { timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId }, entityRevision: 1 });
      continue;
    }

    if (itemType === "reasoning") {
      // summary -> thinking block; encrypted_content -> typed unknown block in
      // the SAME message so exporters can reassemble the native reasoning item.
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const summaryText = summary.map(s => str(record(s).text) ?? "").filter(Boolean).join("\n");
      const blocks: ContentBlock[] = [];
      if (summaryText) blocks.push({ type: "thinking", text: summaryText });
      if (payload.encrypted_content !== undefined || payload.content !== undefined || summary.length > 0) {
        // summary is stored alongside so the exporter can reassemble the
        // native reasoning item verbatim (not just the merged text).
        blocks.push({ type: "unknown", nativeType: REASONING_UNKNOWN_TYPE, value: jsonValue({ summary, encrypted_content: payload.encrypted_content ?? null, content: payload.content ?? null }) });
      }
      const messageId = `message:${sessionId}:${index}`;
      emit("message.completed", { message: { role: "assistant", content: blocks, details: { codexItem: "reasoning" }, timestamp }, messageIndex: messageIndex++, state: "completed" }, { timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId }, entityRevision: 1 });
      continue;
    }

    if (itemType === "function_call") {
      const callId = str(payload.call_id) ?? `call:${index}`;
      const name = str(payload.name) ?? "unknown";
      let args: unknown = payload.arguments ?? null;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep raw string */ } }
      declaredTools.set(callId, { name, arguments: jsonValue(args) });
      const messageId = `message:${sessionId}:${index}`;
      emit("message.completed", {
        message: { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, name, arguments: jsonValue(args) }], details: { codexItem: "function_call" }, timestamp },
        messageIndex: messageIndex++, state: "completed",
      }, { timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId }, entityRevision: 1 });
      continue;
    }

    if (itemType === "function_call_output") {
      const callId = str(payload.call_id);
      if (!callId) { loss.push("function_call_output without call_id dropped from canonical projection"); continue; }
      const toolResultId = `result:${callId}`;
      const messageId = `message:${sessionId}:${index}`;
      const declared = declaredTools.get(callId);
      const result = payload.output !== undefined ? jsonValue(payload.output) : null;
      const correlation = { runId: currentRun!.runId, turnId: currentRun!.turnId, messageId, toolCallId: callId, toolResultId };
      emit("message.completed", {
        message: { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolResultId, content: result, isError: false }], toolCallId: callId, toolResultId, toolName: declared?.name ?? "unknown", timestamp },
        messageIndex: messageIndex++, state: "completed",
      }, { timestamp, correlation, entityRevision: 1 });
      emit("tool.completed", {
        toolName: declared?.name ?? "unknown", args: declared?.arguments ?? {}, result, isError: false,
        state: "completed", toolIndex: toolIndex++,
      }, { timestamp, correlation, entityRevision: 1 });
      continue;
    }

    // custom_tool_call / local_shell_call / web_search_call / ...
    emit("unknown.observed", { nativeType: `codex.item:${itemType}`, value: jsonValue(payload) }, { timestamp, correlation: { runId: currentRun!.runId, turnId: currentRun!.turnId } });
  }
  closeRun();
  const lastEvent = builder.events[builder.events.length - 1];
  builder.emit("session.ended", { reason: "import complete", state: "exited" }, { timestamp: lastEvent?.timestamp });

  const unresolvedTools = [...declaredTools.keys()].filter(id => !builder.events.some(e => e.type === "tool.completed" && e.correlation?.toolCallId === id));
  if (unresolvedTools.length > 0) loss.push(`${unresolvedTools.length} function call(s) without a matching function_call_output remain without a tool.completed event`);

  const snapshot = buildSnapshot({ agentSessionId: source.agentSessionId, nativeSessionId: sessionId, ...(cwd ? { cwd } : {}), evidence: builder.events });
  const fidelity: FidelityAxis[] = [
    { axis: "messages", level: "preserved", detail: "response_item messages in record order; dual-stream dedup keeps event_msg user/agent_message out" },
    { axis: "content-blocks", level: "preserved", detail: "input_text/output_text/input_image mapped; unmapped blocks kept as typed unknown" },
    { axis: "tool-chain", level: "preserved", detail: "function_call call_id ↔ function_call_output pairing; arguments JSON-parsed when possible" },
    { axis: "reasoning", level: "partial", detail: "summary -> thinking block; encrypted_content preserved via typed unknown block (round-trippable, not rendered as thinking)" },
    { axis: "run-boundaries", level: "preserved", detail: "turn_context records give explicit turn/run boundaries; turn_aborted settles the run as cancelled" },
    { axis: "turn-boundaries", level: "partial", detail: "one synthesized turn per turn_context" },
    { axis: "usage", level: "evidence-only", detail: "event_msg token_count kept as unknown.observed (codex logs have no per-message usage)" },
    { axis: "dual-stream", level: "partial", detail: "event_msg duplicates (user_message/agent_message/agent_reasoning) dropped in favor of response_item; only token_count/turn_aborted retained" },
    { axis: "environment-context", level: "evidence-only", detail: "approval_policy/sandbox_policy from turn_context are not projected (run boundary only)" },
    { axis: "compaction", level: "not-in-source", detail: "no compacted item observed in the sampled corpus" },
    { axis: "approvals", level: "not-in-source", detail: "approval requests are interactive and not recorded in the rollout" },
  ];
  const bundle = makeBundle({
    native: { harness: "codex", sessionId, ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}), sourceSha256: digest },
    pivot: snapshot,
    evidence: builder.events,
    fidelity,
    loss,
  });
  return { bundle };
}

export function importCodexSessionFile(path: string): CodexImportResult {
  return importCodexSession(readFileSync(path, "utf8"), { sourcePath: path });
}

// ---------------------------------------------------------------------------
// Exporter: e-session-bundle -> codex rollout JSONL
// ---------------------------------------------------------------------------

const EXPORTABLE_HARNESSES = ["pi", "dimagent", "claude", "codex"] as const;

export interface CodexExportResult {
  readonly jsonl: string;
  readonly loss: readonly string[];
}

/**
 * Reconstruct a codex rollout from a bundle.
 *
 * Round-trip fidelity depends on the evidence preserved by the importer:
 * `codex.session_meta` / `codex.turn_context` unknown.observed events carry
 * the native payloads verbatim; `codex.encrypted_reasoning` blocks carry
 * `{summary, content, encrypted_content}`. When those are absent (cross-
 * harness import, e.g. pi→codex) the fields are synthesized and declared loss.
 */
export function exportCodexSession(bundle: SessionBundle): CodexExportResult {
  if (!(EXPORTABLE_HARNESSES as readonly string[]).includes(bundle.native.harness)) {
    throw new Error(`unsupported source harness for codex export: ${String(bundle.native.harness)}`);
  }
  const loss: string[] = [];
  const lines: string[] = [];
  const sessionId = bundle.pivot.nativeSessionId;
  const cwd = bundle.pivot.cwd;

  // session_meta: verbatim evidence if present, else synthesized.
  const metaEvent = bundle.evidence.find(e => e.type === "unknown.observed" && record(e.payload).nativeType === "codex.session_meta");
  const metaValue = metaEvent ? record(record(metaEvent.payload).value) : {};
  const started = bundle.evidence.find(e => e.type === "session.started");
  const metaTimestamp = started?.timestamp ?? bundle.createdAt;
  lines.push(JSON.stringify({
    timestamp: metaTimestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: str(metaValue.cwd) ?? cwd ?? null,
      cli_version: str(metaValue.cli_version) ?? null,
      instructions: metaValue.instructions ?? null,
      model_provider: str(metaValue.model_provider) ?? null,
      originator: str(metaValue.originator) ?? "codex_cli_rs",
      timestamp: metaTimestamp,
    },
  }));
  if (!metaEvent) loss.push("session_meta synthesized (no codex.session_meta evidence); cli_version/model_provider unknown");

  // turn_context evidence keyed by runId (first wins).
  const turnCtxByRun = new Map<string, Record>();
  for (const e of bundle.evidence) {
    if (e.type === "unknown.observed" && record(e.payload).nativeType === "codex.turn_context" && e.correlation?.runId) {
      if (!turnCtxByRun.has(e.correlation.runId)) turnCtxByRun.set(e.correlation.runId, record(record(e.payload).value));
    }
  }

  // Group messages by run, in first-appearance order (materializer keeps
  // message order via messageIndex, so this is the original timeline).
  const messages = [...bundle.pivot.messages].sort((a, b) => a.order - b.order);
  const toolByCallId = new Map<string, AgentTool>();
  for (const t of bundle.pivot.tools) toolByCallId.set(t.id, t);
  const runOrder: string[] = [];
  const byRun = new Map<string, AgentMessage[]>();
  for (const m of messages) {
    if (!byRun.has(m.runId)) { byRun.set(m.runId, []); runOrder.push(m.runId); }
    byRun.get(m.runId)!.push(m);
  }

  for (const runId of runOrder) {
    const msgs = byRun.get(runId)!;
    const ctx = turnCtxByRun.get(runId);
    const ctxValue = ctx ?? {};
    lines.push(JSON.stringify({
      timestamp: msgs[0]!.createdAt,
      type: "turn_context",
      payload: {
        cwd: str(ctxValue.cwd) ?? cwd ?? null,
        approval_policy: str(ctxValue.approval_policy) ?? "never",
        sandbox_policy: ctxValue.sandbox_policy ?? { mode: "workspace-write" },
        model: str(ctxValue.model) ?? null,
        summary: str(ctxValue.summary) ?? "auto",
      },
    }));
    if (!ctx) loss.push(`run ${runId}: turn_context synthesized (model unknown)`);

    for (const m of msgs) {
      for (const item of messageToResponseItems(m, loss, toolByCallId)) {
        lines.push(JSON.stringify({ timestamp: m.createdAt, type: "response_item", payload: item }));
      }
    }
  }

  // event_msg (token_count / turn_aborted) from evidence, appended after the
  // response items (their exact interleaving is UI-only and not reconstructed).
  let sawEventMsg = false;
  for (const e of bundle.evidence) {
    if (e.type !== "unknown.observed") continue;
    const p = record(e.payload);
    if (p.nativeType === "codex.token_count" || p.nativeType === "codex.turn_aborted") {
      sawEventMsg = true;
      lines.push(JSON.stringify({ timestamp: e.timestamp, type: "event_msg", payload: record(p.value) }));
    }
  }
  if (sawEventMsg) loss.push("event_msg (token_count/turn_aborted) appended after response_items; relative order not preserved");

  return { jsonl: `${lines.join("\n")}\n`, loss: [...new Set(loss)] };
}

/** Map one canonical message to codex response_items. A message with mixed
 * block kinds (typical of pi) splits into several items: reasoning + message
 * + function_call(s) + function_call_output. */
function messageToResponseItems(msg: AgentMessage, loss: string[], toolByCallId: Map<string, AgentTool>): Record[] {
  const items: Record[] = [];

  // Tool result message → function_call_output. The result comes from the
  // canonical tool entity (not the block shape), because pi imports tool
  // results as text blocks while codex imports them as tool-result blocks.
  if (msg.role === "tool") {
    const tool = msg.toolCallId ? toolByCallId.get(msg.toolCallId) : undefined;
    const result = tool?.result ?? null;
    items.push({
      type: "function_call_output",
      call_id: msg.toolCallId ?? "",
      output: typeof result === "string" ? result : JSON.stringify(result ?? null),
    });
    return items;
  }

  const enc = msg.blocks.find(b => b.type === "unknown" && b.nativeType === REASONING_UNKNOWN_TYPE);
  const thinkingText = msg.blocks.filter(b => b.type === "thinking").map(b => b.text).join("\n");

  if (enc && enc.type === "unknown") {
    const value = record(enc.value);
    items.push({
      type: "reasoning",
      summary: Array.isArray(value.summary) ? value.summary : thinkingText ? [{ type: "summary_text", text: thinkingText }] : [],
      content: value.content ?? null,
      encrypted_content: value.encrypted_content ?? null,
    });
  } else if (thinkingText) {
    items.push({ type: "reasoning", summary: [{ type: "summary_text", text: thinkingText }], content: null, encrypted_content: null });
    loss.push("thinking block exported as codex reasoning without encrypted_content (cross-harness; blob not reproducible)");
  }

  const textBlocks = msg.blocks.filter(b => b.type === "text" || b.type === "image");
  if (textBlocks.length > 0 && (msg.role === "user" || msg.role === "assistant")) {
    items.push({ type: "message", role: msg.role, content: textBlocks.map(b => blockToCodexContent(b, msg.role)) });
  }

  for (const b of msg.blocks) {
    if (b.type === "tool-call") {
      items.push({
        type: "function_call",
        call_id: b.toolCallId,
        name: b.name,
        // importer stores parsed JSON as an object; raw non-JSON strings pass
        // through unchanged — so round-trip stringifies only the object case.
        arguments: typeof b.arguments === "object" && b.arguments !== null ? JSON.stringify(b.arguments) : String(b.arguments ?? ""),
      });
    }
  }
  return items;
}

function blockToCodexContent(b: ContentBlock, role: string): Record {
  if (b.type === "text") return { type: role === "user" ? "input_text" : "output_text", text: b.text };
  if (b.type === "image") return { type: "input_image", media_type: b.mimeType, image_url: b.data ?? b.uri ?? "" };
  return { type: "unknown", value: jsonValue(b) };
}
