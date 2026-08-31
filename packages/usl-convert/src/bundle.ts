import { createHash } from "node:crypto";
import {
  validateAgentEnvelope,
  type AgentEventEnvelope,
  type AgentSessionSnapshot,
} from "./asp-schema/agent-session-contracts.js";

/**
 * asp-bundle — the intermediate format for cross-harness session handoff.
 *
 * Storage model (per design decision): copy-on-write. Importers never mutate
 * the source session log; every conversion writes a new immutable bundle.
 * The `evidence` array inside the bundle plays the role of the WAL: it is the
 * full ordered event stream, and the `pivot` snapshot is always derivable
 * from it. `native.sourceSha256` pins the source file for provenance.
 *
 * Round-trip guarantees are declared, not promised: `fidelity` lists every
 * fidelity axis and its level; `loss` is the human-readable list of what the
 * converter dropped or degraded and why.
 */

export const SESSION_BUNDLE_FORMAT = "asp-bundle" as const;
export const SESSION_BUNDLE_VERSION = 1 as const;
export const HARNESSES = ["pi", "dimagent", "claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** preserved = survives round-trip; partial = degraded; evidence-only = kept in
 * evidence but not in the pivot projection; dropped = lost with a declared reason;
 * not-in-source = the source harness does not record this axis at all. */
export type FidelityLevel = "preserved" | "partial" | "evidence-only" | "dropped" | "not-in-source";

export interface FidelityAxis {
  readonly axis: string;
  readonly level: FidelityLevel;
  readonly detail: string;
}

export interface SessionBundle {
  readonly format: typeof SESSION_BUNDLE_FORMAT;
  readonly version: typeof SESSION_BUNDLE_VERSION;
  readonly createdAt: string;
  readonly native: {
    readonly harness: Harness;
    readonly sessionId: string;
    readonly sourcePath?: string;
    readonly sourceSha256?: string;
  };
  /** Canonical projection (ASP AgentSessionSnapshot). */
  readonly pivot: AgentSessionSnapshot;
  /** Ordered event stream; the pivot is derivable from this. */
  readonly evidence: readonly AgentEventEnvelope[];
  readonly fidelity: readonly FidelityAxis[];
  /** Human-readable loss declarations. */
  readonly loss: readonly string[];
}

export function sha256Of(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeBundle(input: Omit<SessionBundle, "format" | "version" | "createdAt"> & { createdAt?: string }): SessionBundle {
  const bundle: SessionBundle = { format: SESSION_BUNDLE_FORMAT, version: SESSION_BUNDLE_VERSION, createdAt: input.createdAt ?? new Date().toISOString(), ...input };
  validateBundle(bundle);
  return bundle;
}

/** Cross-check bundle invariants. Throws on structural violation. */
export function validateBundle(value: unknown): asserts value is SessionBundle {
  if (typeof value !== "object" || value === null) throw new Error("bundle must be an object");
  const b = value as Record<string, unknown>;
  if (b.format !== SESSION_BUNDLE_FORMAT) throw new Error(`unsupported bundle format: ${String(b.format)}`);
  if (b.version !== SESSION_BUNDLE_VERSION) throw new Error(`unsupported bundle version: ${String(b.version)}`);
  if (typeof b.createdAt !== "string" || !Number.isFinite(Date.parse(b.createdAt))) throw new Error("invalid bundle createdAt");
  const native = b.native as Record<string, unknown> | undefined;
  if (!native || !HARNESSES.includes(native.harness as Harness) || typeof native.sessionId !== "string" || !native.sessionId) throw new Error("invalid bundle native identity");
  if (!Array.isArray(b.evidence)) throw new Error("bundle evidence must be an array");
  if (b.evidence.length > 1_000_000) throw new Error("bundle evidence too large");
  for (const event of b.evidence) validateAgentEnvelope(event);
  if (!Array.isArray(b.fidelity) || !Array.isArray(b.loss)) throw new Error("bundle fidelity/loss must be arrays");
  const pivot = b.pivot as AgentSessionSnapshot | undefined;
  if (!pivot || pivot.schemaVersion !== "1.0") throw new Error("invalid bundle pivot");
  if (pivot.revision !== b.evidence.length) throw new Error(`pivot revision ${pivot.revision} does not match evidence count ${b.evidence.length}`);
  const last = b.evidence[b.evidence.length - 1];
  if (last && pivot.seq !== b.evidence.length - 1) throw new Error("pivot seq does not match evidence count");
  if (pivot.nextSeq !== pivot.seq + 1) throw new Error("invalid pivot nextSeq");
  const first = b.evidence[0];
  if (first && first.correlation?.agentSessionId !== pivot.id) throw new Error("pivot id does not match evidence agentSessionId");
}
