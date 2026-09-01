import { importClaudeSessionFile } from "./claude.js";
import { exportCodexSession, importCodexSessionFile } from "./codex.js";
import { exportDimagentSession, importDimagentSession } from "./dimagent.js";
import { exportPiSession, importPiSessionFile } from "./pi.js";
import type { Harness, SessionBundle } from "./bundle.js";

export interface ImportAdapterOptions { readonly sessionId?: string; readonly snapshotPath?: string }
export interface ExportArtifact { readonly kind: "text" | "json"; readonly value: string | unknown; readonly loss: readonly string[]; readonly suggestedPath?: string }
export interface AdapterDefinition {
  readonly name: Harness;
  readonly nativeFormat: string;
  readonly importDescription: string;
  readonly exportDescription: string;
  importFile(path: string, options?: ImportAdapterOptions): SessionBundle;
  exportBundle(bundle: SessionBundle): ExportArtifact;
}

export const ADAPTER_REGISTRY: readonly AdapterDefinition[] = [
  {
    name: "pi", nativeFormat: "session JSONL", importDescription: "~/.pi/agent/sessions/<dir>/<ts>_<uuid>.jsonl", exportDescription: "resumable session JSONL",
    importFile: path => importPiSessionFile(path).bundle,
    exportBundle: bundle => { const result = exportPiSession(bundle); return { kind: "text", value: result.jsonl, loss: result.loss, ...(result.suggestedPath ? { suggestedPath: result.suggestedPath } : {}) }; },
  },
  {
    name: "dimagent", nativeFormat: "SQLite backup", importDescription: "transaction-consistent backup of dimcode.sqlite", exportDescription: "sessions+messages rows",
    importFile: (path, options = {}) => { if (!options.sessionId) throw new Error("dimagent import requires a session id"); return importDimagentSession(path, options.sessionId, { sourcePath: path, snapshotPath: options.snapshotPath }).bundle; },
    exportBundle: bundle => { const rows = exportDimagentSession(bundle); return { kind: "json", value: { session: rows.session, messages: rows.messages, loss: rows.loss }, loss: rows.loss }; },
  },
  {
    name: "claude", nativeFormat: "session JSONL", importDescription: "~/.claude/projects/<dir>/<uuid>.jsonl", exportDescription: "unsupported (use a cross-handoff target)",
    importFile: path => importClaudeSessionFile(path).bundle,
    exportBundle: () => { throw new Error("claude export is unsupported; use pi or codex as a cross-handoff target"); },
  },
  {
    name: "codex", nativeFormat: "rollout JSONL", importDescription: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl", exportDescription: "round-trip rollout JSONL",
    importFile: path => importCodexSessionFile(path).bundle,
    exportBundle: bundle => { const result = exportCodexSession(bundle); return { kind: "text", value: result.jsonl, loss: result.loss }; },
  },
] as const;

export function adapterFor(value: string): AdapterDefinition {
  const adapter = ADAPTER_REGISTRY.find(item => item.name === value);
  if (!adapter) throw new Error(`unsupported adapter: ${value}`);
  return adapter;
}
