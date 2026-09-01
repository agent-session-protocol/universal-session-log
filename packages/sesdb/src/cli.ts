#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectSesdb, SesdbQueryError } from "./index.js";
import { DaemonEngine, EngineUnavailableError, ensureDaemon, readDaemonDescriptor, resolveDaemonBinary, SesdbRpcError } from "./engine.js";
import { SessionQLError } from "./query.js";

const usage = `sesdb — local evidence-backed session database

Commands:
  sesdb init | search <text> [filters] | query <sessionql> [--explain] | context <session-id>
  sesdb capabilities | verify | doctor | sessions [filters] | evidence <seq>
  sesdb timeline <session-id> [--from-ms <n>] [--to-ms <n>] [--history]
  sesdb memory list|candidates|get <id>
  sesdb memory propose --content <text> --scope <json> --evidence <seq,...>
  sesdb memory approve|revoke <id> --revision <n>
  sesdb daemon start|run|status|stop
  sesdb provider discover [claude|codex|pi|kimi|deepseek]
  sesdb provider enable|disable <claude|codex|pi|kimi|deepseek> [--root <path>]
  sesdb provider list
  sesdb index status|reconcile|rebuild
  sesdb console`;

type PageArgs = { positionals: string[]; limit?: number; cursor?: string; history?: boolean; provider?: "claude" | "codex" | "pi" | "kimi" | "deepseek"; project?: string; sessionId?: string; fromMs?: number; toMs?: number };
const providers = new Set(["claude", "codex", "pi", "kimi", "deepseek"]);
function pageArgs(args: string[]): PageArgs {
  const result: PageArgs = { positionals: [] };
  const valued: Record<string, keyof PageArgs> = { "--limit": "limit", "--cursor": "cursor", "--provider": "provider", "--project": "project", "--session": "sessionId", "--from-ms": "fromMs", "--to-ms": "toMs" };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--history") { result.history = true; continue; }
    if (arg.startsWith("--")) {
      const key = valued[arg]; if (!key) throw new Error(`unknown filter: ${arg}`);
      const value = args[++index]; if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (key === "limit" || key === "fromMs" || key === "toMs") { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${arg} must be a non-negative integer`); (result as Record<string, unknown>)[key] = number; }
      else (result as Record<string, unknown>)[key] = value;
    } else result.positionals.push(arg);
  }
  if (result.provider && !providers.has(result.provider)) throw new Error(`unknown provider filter: ${result.provider}`);
  if (result.fromMs !== undefined && result.toMs !== undefined && result.fromMs > result.toMs) throw new Error("--from-ms must not exceed --to-ms");
  return result;
}

function output(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function home(): string { return process.env.SESDB_HOME ?? join(homedir(), ".sesdb"); }

async function daemonCommand(action: string | undefined): Promise<void> {
  if (action === "run") {
    const child = spawn(resolveDaemonBinary(), [], { stdio: "inherit", env: process.env });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`sesdbd exited with ${code}`))); });
    return;
  }
  if (action === "status") {
    const descriptor = await readDaemonDescriptor(home());
    if (!descriptor) { output({ running: false }); process.exitCode = 1; return; }
    try { output({ running: true, descriptor: { ...descriptor, token: "[redacted]" }, health: await new DaemonEngine(descriptor).local("/health") }); }
    catch { output({ running: false, staleDescriptor: true }); process.exitCode = 1; }
    return;
  }
  if (action === "start") { const descriptor = await ensureDaemon(); output({ running: true, baseUrl: descriptor.baseUrl, pid: descriptor.pid }); return; }
  if (action === "stop") { const descriptor = await readDaemonDescriptor(home()); if (!descriptor) { output({ running: false }); return; } await new DaemonEngine(descriptor).stop(); output({ stopped: true }); return; }
  throw new Error(`daemon requires start, run, status, or stop\n\n${usage}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") { console.log(usage); return; }
  if (command === "daemon") return daemonCommand(args[0]);

  const db = await connectSesdb();
  try {
    const daemon = db.engine instanceof DaemonEngine ? db.engine : undefined;
    if (command === "init") output({ ok: true, stats: await db.engine.request("stats") });
    else if (command === "search") { const parsed = pageArgs(args); const text = parsed.positionals.join(" "); if (!text) throw new Error("search requires text"); const { positionals: _, ...settings } = parsed; output(daemon ? await db.searchPage(text, settings) : await db.search(text)); }
    else if (command === "query") { const explain = args.includes("--explain"); output(await db.query({ sessionql: args.filter(value => value !== "--explain").join(" "), includeExplain: explain })); }
    else if (command === "context") { if (!args[0]) throw new Error("context requires a session ID"); output(await db.raw(args[0])); }
    else if (command === "capabilities") output(daemon ? await daemon.local("/capabilities") : await db.capabilities());
    else if (command === "verify") output(await db.engine.request("verify"));
    else if (command === "doctor") output({ ok: true, stats: await db.engine.request("stats"), integrity: await db.engine.request("verify"), capabilities: await db.capabilities(), ...(daemon ? { index: await daemon.local("/index/status"), providers: await db.providerHealth() } : {}) });
    else if (command === "sessions") { const parsed = pageArgs(args); if (parsed.positionals.length > 1) throw new Error("sessions accepts at most one legacy numeric limit"); if (parsed.positionals[0] !== undefined) { const limit = Number(parsed.positionals[0]); if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("sessions limit must be a positive integer"); parsed.limit = limit; } const { positionals: _, history: __, ...settings } = parsed; output(await db.sessions(settings)); }
    else if (command === "timeline") { const parsed = pageArgs(args); if (parsed.positionals.length !== 1) throw new Error("timeline requires exactly one session ID"); const sessionId = parsed.positionals[0]; const { positionals: _, provider: __, project: ___, sessionId: ____, ...settings } = parsed; output(await db.timeline(sessionId, settings)); }
    else if (command === "evidence") { if (!daemon) throw new Error("evidence requires daemon transport"); if (args.length !== 1 || !/^\d+$/.test(args[0])) throw new Error("evidence requires one non-negative sequence number"); output(await daemon.local(`/evidence/${args[0]}`)); }
    else if (command === "memory") {
      if (!daemon) throw new Error("memory requires daemon transport");
      const [action, id, ...rest] = args;
      if (action === "list") { if (args.length !== 1) throw new Error("memory list accepts no filters"); output(await daemon.local("/memory")); }
      else if (action === "candidates") { if (args.length !== 1) throw new Error("memory candidates accepts no filters"); output(await daemon.local("/memory/candidates")); }
      else if (action === "get") { if (!id || rest.length) throw new Error("memory get requires exactly one ID"); output(await daemon.local(`/memory/${encodeURIComponent(id)}`)); }
      else if (action === "propose") {
        const values = new Map<string, string>(); for (let index = 1; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!["--content", "--scope", "--evidence"].includes(key) || value === undefined) throw new Error(`unknown or incomplete memory propose option: ${key}`); values.set(key, value); }
        let scope: unknown; try { scope = JSON.parse(values.get("--scope") ?? ""); } catch { throw new Error("--scope must be valid JSON"); }
        const evidenceSeqs = (values.get("--evidence") ?? "").split(",").map(Number); if (!values.get("--content") || evidenceSeqs.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("memory propose requires content, scope, and comma-separated evidence seqs");
        output(await daemon.local("/memory/candidates", { method: "POST", body: JSON.stringify({ content: values.get("--content"), scope, evidenceSeqs }) }));
      } else if (action === "approve" || action === "revoke") {
        if (!id || rest.length !== 2 || rest[0] !== "--revision" || !/^\d+$/.test(rest[1])) throw new Error(`memory ${action} requires an ID and --revision <n>`);
        output(await daemon.local(`/memory/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({ expectedRevision: Number(rest[1]) }) }));
      } else throw new Error("memory requires list, candidates, get, propose, approve, or revoke");
    }
    else if (command === "provider") {
      if (!daemon) throw new Error("provider commands require daemon transport");
      const [action, provider] = args;
      if (action === "list") output(await daemon.local("/providers"));
      else if (action === "discover") output(await daemon.local(provider ? `/providers/discover?provider=${encodeURIComponent(provider)}` : "/providers/discover"));
      else if (action === "enable" || action === "disable") {
        if (!provider || !["claude", "codex", "pi", "kimi", "deepseek"].includes(provider)) throw new Error(`${action} requires a known provider`);
        const rootIndex = args.indexOf("--root"); const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
        output(await daemon.local(`/providers/${provider}/${action}`, { method: "POST", ...(root ? { body: JSON.stringify({ root }) } : {}) }));
      } else throw new Error("provider requires discover, enable, disable, or list");
    } else if (command === "index") {
      if (!daemon) throw new Error("index commands require daemon transport");
      const action = args[0];
      if (action === "status") output(await daemon.local("/index/status"));
      else if (action === "reconcile") output(await db.reconcile());
      else if (action === "rebuild") output(await db.rebuildIndex());
      else throw new Error("index requires status, reconcile, or rebuild");
    } else if (command === "console") {
      if (!daemon) throw new Error("console requires daemon transport");
      output(await daemon.local<{ url: string }>("/browser-session", { method: "POST" }));
    } else throw new Error(`unsupported command: ${command}\n\n${usage}`);
  } finally { await db.engine.close(); }
}

main().catch(error => {
  const body = error instanceof SesdbRpcError || error instanceof SesdbQueryError || error instanceof SessionQLError
    ? { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } }
    : { ok: false, error: { code: error instanceof EngineUnavailableError ? "engine_unavailable" : "client_error", message: error instanceof Error ? error.message : String(error), retryable: false } };
  console.error(JSON.stringify(body, null, 2)); process.exitCode = 1;
});
