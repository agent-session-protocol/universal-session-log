#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiCorpus, fileBytes, git, hardware, parseArgs, percentile, repoRoot, writeJson } from "./lib.mjs";

const options = parseArgs(process.argv.slice(2));
const daemon = join(repoRoot, "target/release/sesdbd");
const fixtureLine = index => JSON.stringify({ type: "message", id: `benchmark-${index}`, parentId: "22222222", timestamp: new Date(Date.UTC(2026, 7, 15, 0, 0, index)).toISOString(), message: { role: "user", content: [{ type: "text", text: `benchmark-token-${index}` }] } }) + "\n";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitDescriptor(path) { for (let i = 0; i < 200; i++) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { await sleep(25); } } throw new Error("SESDB daemon did not start"); }
async function api(descriptor, path, init = {}) {
  const response = await fetch(`${descriptor.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${descriptor.token}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
  const body = await response.json(); if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`); return body;
}

const buildStarted = performance.now();
await import("node:child_process").then(({ execFileSync }) => execFileSync("cargo", ["build", "--release", "-p", "sesdb-engine", "--bin", "sesdbd"], { cwd: repoRoot, stdio: "inherit" }));
const buildMs = performance.now() - buildStarted;
const result = { schemaVersion: "sesdb.i0-benchmark/v1", product: "sesdb", revision: git(repoRoot, "rev-parse", "HEAD"), hardware: hardware(), startedAt: new Date().toISOString(), buildMs, runs: [] };

for (const sessions of options.sizes) {
  const home = mkdtempSync(join(tmpdir(), `sesdb-i0-${sessions}-`));
  const sourceRoot = createPiCorpus(home, sessions);
  const sesdbHome = join(home, ".sesdb");
  const daemonProcess = spawn(daemon, [], { detached: false, stdio: "ignore", env: { ...process.env, HOME: home, SESDB_HOME: sesdbHome } });
  try {
    const descriptor = await waitDescriptor(join(sesdbHome, "run/daemon.json"));
    await api(descriptor, "/providers/pi/enable", { method: "POST", body: JSON.stringify({ root: sourceRoot }) });
    let started = performance.now(); const cold = await api(descriptor, "/providers/pi/reconcile", { method: "POST" }); const coldIndexMs = performance.now() - started;
    started = performance.now(); const noop = await api(descriptor, "/providers/pi/reconcile", { method: "POST" }); const noopReconcileMs = performance.now() - started;
    const target = join(sourceRoot, "i0-pi-00000000.jsonl"); const latencies = [];
    for (let index = 0; index < 20; index++) {
      appendFileSync(target, fixtureLine(index)); started = performance.now();
      await api(descriptor, "/providers/pi/reconcile", { method: "POST" });
      const search = await api(descriptor, `/search?q=${encodeURIComponent(`benchmark-token-${index}`)}&limit=1`);
      if (!search.items?.length) throw new Error(`appended token ${index} was not queryable`);
      latencies.push(performance.now() - started);
    }
    const statusBeforeRebuild = await api(descriptor, "/index/status");
    started = performance.now(); await api(descriptor, "/index/rebuild", { method: "POST" }); const rebuildMs = performance.now() - started;
    const status = await api(descriptor, "/index/status");
    let rssBytes = 0; try { const { execFileSync } = await import("node:child_process"); rssBytes = Number(execFileSync("ps", ["-o", "rss=", "-p", String(daemonProcess.pid)], { encoding: "utf8" }).trim()) * 1024; } catch {}
    result.runs.push({ sessions, coldIndexMs, noopReconcileMs, appendToSearch: { samples: latencies.length, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) }, rebuildMs, rssBytes, l1Bytes: fileBytes(join(sesdbHome, "sesdb.usl")), sidecarBytes: fileBytes(join(sesdbHome, "sesdb.sqlite")) + fileBytes(join(sesdbHome, "sesdb.sqlite-wal")) + fileBytes(join(sesdbHome, "sesdb.sqlite-shm")), sqliteWriteChanges: statusBeforeRebuild.sqliteWriteChanges, events: cold.events, noopEvents: noop.events, status });
    await api(descriptor, "/daemon/stop", { method: "POST" });
  } finally { if (!daemonProcess.killed) daemonProcess.kill("SIGTERM"); rmSync(home, { recursive: true, force: true }); }
}
result.finishedAt = new Date().toISOString();
const output = options.output ?? join(repoRoot, "benchmarks/i0/results/sesdb.json"); writeJson(output, result); console.log(output);
