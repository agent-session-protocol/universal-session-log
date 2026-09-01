import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { validateAgentEnvelope, type AgentEventEnvelope, type AgentSessionSnapshot } from "./asp-schema/agent-session-contracts.js";

export const SESSION_BUNDLE_FORMAT = "asp-bundle" as const;
export const SESSION_BUNDLE_VERSION = 2 as const;
export const ADAPTER_VERSION = "0.2.0-alpha.0" as const;
export const HARNESSES = ["pi", "dimagent", "claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];
export type FidelityLevel = "preserved" | "partial" | "evidence-only" | "dropped" | "not-in-source";
export type CaptureMode = "exact-file" | "sqlite-backup" | "generated-snapshot";

export interface FidelityAxis { readonly axis: string; readonly level: FidelityLevel; readonly detail: string }
export interface SourceArtifact { readonly logicalPath: string; readonly role: string; readonly size: number; readonly sha256: string; readonly captureMode: CaptureMode }
export interface SourceProvenance {
  readonly nativeFormat: Harness;
  readonly sources: readonly SourceArtifact[];
  readonly adapter: { readonly id: string; readonly version: string; readonly revision: string };
  /** A SQLite digest identifies the transaction-consistent backup, not a racing live file. */
  readonly snapshotSemantics?: string;
}
export interface BundleIntegrity { readonly algorithm: "sha256"; readonly canonicalization: "canonical-json/v1"; readonly digest: string }

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** v2 is written by default. Version 1 remains accepted by readers. */
export interface SessionBundle {
  readonly format: typeof SESSION_BUNDLE_FORMAT;
  readonly version: 1 | typeof SESSION_BUNDLE_VERSION;
  readonly createdAt: string;
  readonly native: { readonly harness: Harness; readonly sessionId: string; readonly sourcePath?: string; readonly sourceSha256?: string };
  readonly provenance?: SourceProvenance;
  readonly integrity?: BundleIntegrity;
  readonly pivot: AgentSessionSnapshot;
  readonly evidence: readonly AgentEventEnvelope[];
  readonly fidelity: readonly FidelityAxis[];
  readonly loss: readonly string[];
}

export function sha256Of(value: string | Buffer | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function portableLogicalPath(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).replaceAll("\\", "/");
  const candidate = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
    ? normalized.split("/").filter(Boolean).at(-1) ?? fallback
    : normalized.replace(/^\.\//, "");
  if (!candidate || candidate === "." || candidate.includes("\0") || candidate.split("/").includes("..")) throw new Error("invalid source logicalPath");
  return candidate;
}

export function makeSourceArtifact(input: { readonly bytes: string | Buffer | Uint8Array; readonly logicalPath?: string; readonly role?: string; readonly captureMode?: CaptureMode }): SourceArtifact {
  const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes) : Buffer.from(input.bytes);
  return { logicalPath: portableLogicalPath(input.logicalPath, "source.native"), role: input.role ?? "primary", size: bytes.byteLength, sha256: sha256Of(bytes), captureMode: input.captureMode ?? "exact-file" };
}

export function makeSourceProvenance(nativeFormat: Harness, sources: readonly SourceArtifact[], input: { readonly adapterId?: string; readonly adapterVersion?: string; readonly adapterRevision?: string; readonly snapshotSemantics?: string } = {}): SourceProvenance {
  if (sources.length === 0) throw new Error("source provenance requires at least one artifact");
  const sorted = [...sources].sort((a, b) => compareText(a.logicalPath, b.logicalPath) || compareText(a.role, b.role) || compareText(a.sha256, b.sha256));
  return { nativeFormat, sources: sorted, adapter: { id: input.adapterId ?? `usl-convert/${nativeFormat}`, version: input.adapterVersion ?? ADAPTER_VERSION, revision: input.adapterRevision ?? "asp-bundle/v2" }, ...(input.snapshotSemantics ? { snapshotSemantics: input.snapshotSemantics } : {}) };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => compareText(a, b)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
function integrityPayload(bundle: SessionBundle): unknown { const { integrity: _integrity, ...payload } = bundle; return payload; }
export function bundleIntegrityDigest(bundle: SessionBundle): string { return sha256Of(canonicalJson(integrityPayload(bundle))); }
function derivedCreatedAt(evidence: readonly AgentEventEnvelope[]): string { const timestamps = evidence.map(event => Date.parse(event.timestamp)).filter(Number.isFinite); return new Date(timestamps.length ? Math.min(...timestamps) : 0).toISOString(); }

type BundleInput = Omit<SessionBundle, "format" | "version" | "createdAt" | "integrity" | "provenance" | "native"> & { readonly native: SessionBundle["native"]; readonly provenance: SourceProvenance };
export function makeBundle(input: BundleInput): SessionBundle {
  const unsigned: SessionBundle = { format: SESSION_BUNDLE_FORMAT, version: SESSION_BUNDLE_VERSION, createdAt: derivedCreatedAt(input.evidence), native: { harness: input.native.harness, sessionId: input.native.sessionId, ...(input.native.sourceSha256 ? { sourceSha256: input.native.sourceSha256 } : {}) }, provenance: input.provenance, pivot: input.pivot, evidence: input.evidence, fidelity: input.fidelity, loss: input.loss };
  const bundle: SessionBundle = { ...unsigned, integrity: { algorithm: "sha256", canonicalization: "canonical-json/v1", digest: bundleIntegrityDigest(unsigned) } };
  validateBundle(bundle);
  return bundle;
}
export function serializeBundle(bundle: SessionBundle): string { validateBundle(bundle); return `${canonicalJson(bundle)}\n`; }

function validateCommon(b: Record<string, unknown>): void {
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
  if (b.evidence.length && pivot.seq !== b.evidence.length - 1) throw new Error("pivot seq does not match evidence count");
  if (pivot.nextSeq !== pivot.seq + 1) throw new Error("invalid pivot nextSeq");
  const first = b.evidence[0] as AgentEventEnvelope | undefined;
  if (first && first.correlation?.agentSessionId !== pivot.id) throw new Error("pivot id does not match evidence agentSessionId");
}

export function validateBundle(value: unknown): asserts value is SessionBundle {
  if (typeof value !== "object" || value === null) throw new Error("bundle must be an object");
  const b = value as Record<string, unknown>;
  if (b.format !== SESSION_BUNDLE_FORMAT) throw new Error(`unsupported bundle format: ${String(b.format)}`);
  if (b.version !== 1 && b.version !== SESSION_BUNDLE_VERSION) throw new Error(`unsupported bundle version: ${String(b.version)}`);
  validateCommon(b);
  if (b.version === 1) return;
  const provenance = b.provenance as SourceProvenance | undefined;
  if (!provenance || !HARNESSES.includes(provenance.nativeFormat) || !Array.isArray(provenance.sources) || provenance.sources.length === 0) throw new Error("invalid source provenance");
  const native = b.native as SessionBundle["native"];
  if (provenance.nativeFormat !== native.harness) throw new Error("source provenance native format mismatch");
  if (!provenance.adapter || !provenance.adapter.id || !provenance.adapter.version || !provenance.adapter.revision) throw new Error("invalid source provenance adapter identity");
  const sorted = [...provenance.sources].sort((a, z) => compareText(a.logicalPath, z.logicalPath) || compareText(a.role, z.role) || compareText(a.sha256, z.sha256));
  if (canonicalJson(provenance.sources) !== canonicalJson(sorted)) throw new Error("source artifacts are not sorted");
  const logicalPaths = new Set<string>();
  for (const artifact of provenance.sources) {
    if (!artifact.logicalPath || artifact.logicalPath.includes("\\") || isAbsolute(artifact.logicalPath) || artifact.logicalPath.split("/").includes("..")) throw new Error("source logicalPath must be portable and relative");
    if (logicalPaths.has(artifact.logicalPath)) throw new Error(`duplicate source logicalPath: ${artifact.logicalPath}`);
    logicalPaths.add(artifact.logicalPath);
    if (!artifact.role || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !/^[0-9a-f]{64}$/.test(artifact.sha256) || !["exact-file", "sqlite-backup", "generated-snapshot"].includes(artifact.captureMode)) throw new Error("invalid source artifact");
  }
  if (native.sourcePath !== undefined) throw new Error("asp-bundle/v2 must not serialize native sourcePath");
  const integrity = b.integrity as BundleIntegrity | undefined;
  if (!integrity || integrity.algorithm !== "sha256" || integrity.canonicalization !== "canonical-json/v1" || integrity.digest !== bundleIntegrityDigest(value as SessionBundle)) throw new Error("bundle integrity digest mismatch");
}

export function verifyBundleSources(bundle: SessionBundle, sourceRoot: string): { verified: number } {
  validateBundle(bundle);
  if (bundle.version === 1 || !bundle.provenance) throw new Error("asp-bundle/v1 has no byte-verifiable source set");
  for (const artifact of bundle.provenance.sources) {
    const bytes = readFileSync(resolve(sourceRoot, artifact.logicalPath));
    if (bytes.byteLength !== artifact.size || sha256Of(bytes) !== artifact.sha256) throw new Error(`source artifact verification failed: ${artifact.logicalPath}`);
  }
  return { verified: bundle.provenance.sources.length };
}
