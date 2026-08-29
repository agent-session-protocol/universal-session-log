import {
  stableId,
  type AgentCapability,
  type AgentEventEnvelope,
  type AgentSessionSnapshot,
} from "./asp-schema/agent-session-contracts.ts";
import {
  materializeMessage,
  materializeRun,
  materializeTool,
  materializeTurn,
} from "./asp-schema/agent-session-materializer.ts";

/**
 * Build a canonical snapshot from an ordered evidence stream without going
 * through the daemon store. Grouping mirrors the ASP winner-key scheme:
 * message:/tool:/run:/turn: prefixes over correlation ids.
 */

const READ_CAPABILITIES = ["read.messages", "read.tools", "read.status"] as const;
const CONTROL_CAPABILITIES = ["send.user-message", "send.steer", "send.follow-up", "abort", "approval.resolve"] as const;

function winnerKey(event: AgentEventEnvelope): string | undefined {
  const c = event.correlation ?? {};
  if (event.type.startsWith("message.") && c.messageId) return `message:${c.messageId}`;
  if (event.type.startsWith("tool.") && c.toolCallId) return `tool:${c.toolCallId}`;
  if (event.type.startsWith("run.") && c.runId) return `run:${c.runId}`;
  if (event.type.startsWith("turn.") && c.turnId) return `turn:${c.turnId}`;
  return undefined;
}

export interface BuildSnapshotInput {
  readonly agentSessionId: string;
  readonly nativeSessionId: string;
  readonly cwd?: string;
  readonly evidence: readonly AgentEventEnvelope[];
  readonly readOnlyReason?: string;
}

export function importedCapabilities(readOnlyReason: string): readonly AgentCapability[] {
  return [
    ...READ_CAPABILITIES.map(name => ({ name, available: true, authority: "advisory" as const, reason: readOnlyReason })),
    ...CONTROL_CAPABILITIES.map(name => ({ name, available: false, authority: "unavailable" as const, reason: readOnlyReason })),
  ];
}

export function buildSnapshot(input: BuildSnapshotInput): AgentSessionSnapshot {
  const { evidence } = input;
  const groups = new Map<string, AgentEventEnvelope[]>();
  for (const event of evidence) {
    const key = winnerKey(event);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }

  const runs = [...groups.entries()].filter(([key]) => key.startsWith("run:")).map(([key, events]) => materializeRun(events, key.slice("run:".length)));
  const turns = [...groups.entries()].filter(([key]) => key.startsWith("turn:")).map(([key, events]) => materializeTurn(events, key.slice("turn:".length)));
  const messages = [...groups.entries()].filter(([key]) => key.startsWith("message:")).map(([key, events]) => materializeMessage(events, key.slice("message:".length)));
  const tools = [...groups.entries()].filter(([key]) => key.startsWith("tool:")).map(([key, events]) => materializeTool(events, key.slice("tool:".length)));

  // Fill child index arrays left empty by the materializer.
  const runMessageIds = (runId: string) => messages.filter(m => m.runId === runId).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(m => m.id);
  const runToolIds = (runId: string) => tools.filter(t => t.runId === runId).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(t => t.id);
  const runTurnIds = (runId: string) => turns.filter(t => t.runId === runId).sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || (a.id < b.id ? -1 : 1)).map(t => t.id);
  const runsFilled = runs.map(run => ({ ...run, turnIds: runTurnIds(run.id), messageIds: runMessageIds(run.id), toolCallIds: runToolIds(run.id) }));
  const turnsFilled = turns.map(turn => ({ ...turn, messageIds: messages.filter(m => m.turnId === turn.id).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(m => m.id), toolCallIds: tools.filter(t => t.turnId === turn.id).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(t => t.id) }));

  const epoch = `import:${stableId([input.nativeSessionId, evidence.map(e => e.eventId).join(",")])}`;
  const readOnlyReason = input.readOnlyReason ?? "imported archive; control plane unavailable";
  return {
    schemaVersion: "1.0",
    id: input.agentSessionId,
    nativeSessionId: input.nativeSessionId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    epoch,
    revision: evidence.length,
    seq: evidence.length - 1,
    nextSeq: evidence.length,
    status: "exited",
    degradedReasons: [readOnlyReason],
    capabilities: importedCapabilities(readOnlyReason),
    runs: runsFilled,
    turns: turnsFilled,
    messages,
    tools,
    pendingActions: [],
  };
}
