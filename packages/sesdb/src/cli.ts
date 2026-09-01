#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectSesdb, SesdbQueryError } from "./index.js";
import { DaemonEngine, EngineUnavailableError, ensureDaemon, readDaemonDescriptor, resolveDaemonBinary, SesdbRpcError } from "./engine.js";
import { SessionQLError } from "./query.js";

const usage = `sesdb — local evidence-backed session database

Commands:
  sesdb init | search <text> | query <sessionql> [--explain] | context <session-id>
  sesdb capabilities | verify | doctor | sessions
  sesdb daemon start|run|status|stop
  sesdb provider discover [claude|codex|pi|kimi|deepseek]
  sesdb provider enable|disable <claude|codex|pi|kimi|deepseek> [--root <path>]
  sesdb provider list
  sesdb index status|reconcile|rebuild
  sesdb console`;

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
    else if (command === "search") output(daemon ? await db.searchPage(args.join(" ")) : await db.search(args.join(" ")));
    else if (command === "query") { const explain = args.includes("--explain"); output(await db.query({ sessionql: args.filter(value => value !== "--explain").join(" "), includeExplain: explain })); }
    else if (command === "context") { if (!args[0]) throw new Error("context requires a session ID"); output(await db.raw(args[0])); }
    else if (command === "capabilities") output(daemon ? await daemon.local("/capabilities") : await db.capabilities());
    else if (command === "verify") output(await db.engine.request("verify"));
    else if (command === "doctor") output({ ok: true, stats: await db.engine.request("stats"), integrity: await db.engine.request("verify"), capabilities: await db.capabilities(), ...(daemon ? { index: await daemon.local("/index/status"), providers: await db.providerHealth() } : {}) });
    else if (command === "sessions") output(await db.sessions(Number(args[0] ?? 100)));
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
