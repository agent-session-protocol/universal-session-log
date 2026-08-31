import {
  envelope,
  stableId,
  validateAgentEnvelope,
  type AgentEventEnvelope,
  type AgentSessionEventType,
} from "./asp-schema/agent-session-contracts.js";

/**
 * Ordered evidence builder shared by all importers.
 *
 * Every imported event is marked:
 *   - layer: "L1" (it is a first-hand recording of what the harness did)
 *   - adapter: "usl-convert" (distinct from live e-pi-adapter ingest)
 *   - authenticated: false (a static log is not verified against a live daemon)
 *   - authority: "authoritative", confidence: 1 (the log is the source of truth
 *     about its own session, but only for read/archive purposes)
 *
 * eventIds are deterministic (stableId over session + native id + event kind),
 * so re-importing the same log produces the same evidence and is idempotent.
 */

export interface ImportSource {
  readonly sessionId: string; // native session id
  readonly agentSessionId: string; // as:<stableId([sessionId])>
  readonly generation: string; // import:<sha256 of source>
}

export function importSourceFor(sessionId: string, sourceDigest: string): ImportSource {
  return {
    sessionId,
    agentSessionId: `as:${stableId([sessionId])}`,
    generation: `import:${sourceDigest}`,
  };
}

export interface EmitOptions {
  readonly nativeEventId?: string;
  readonly correlation?: AgentEventEnvelope["correlation"];
  readonly timestamp?: string;
  readonly entityRevision?: number;
}

export class EvidenceBuilder {
  readonly events: AgentEventEnvelope[] = [];
  readonly #source: ImportSource;

  constructor(source: ImportSource) {
    this.#source = source;
  }

  emit(type: AgentSessionEventType, payload: unknown, options: EmitOptions = {}): AgentEventEnvelope {
    const { sessionId, agentSessionId, generation } = this.#source;
    const eventId = `im:${stableId([sessionId, options.nativeEventId ?? `${type}:${this.events.length}`, type])}`;
    const event = envelope({
      eventId,
      type,
      sessionId,
      source: {
        layer: "L1",
        adapter: "usl-convert",
        authenticated: false,
        generation,
        ...(options.nativeEventId === undefined ? {} : { nativeEventId: options.nativeEventId }),
      },
      authority: "authoritative",
      confidence: 1,
      ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
      ...(options.entityRevision === undefined ? {} : { entityRevision: options.entityRevision }),
      payload,
    });
    // Fail fast at import time instead of writing an invalid bundle.
    validateAgentEnvelope(event);
    this.events.push(event);
    return event;
  }
}
